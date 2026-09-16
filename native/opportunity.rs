use crate::{Experiment, ExperimentResult, Outcome, Protocol, SCHEMA_VERSION, Subject};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::{Component, Path},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub target: String,
    pub opportunities: Vec<Opportunity>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Opportunity {
    pub name: String,
    /// What a maintainer could do when the capability is available.
    pub intention: String,
    /// Repository-relative paths whose design depends on this capability.
    pub affected: Vec<String>,
    pub sources: Vec<String>,
    /// What a true probe establishes, narrower than the adoption decision.
    pub verification: String,
    /// A human-owned adoption condition. A green probe does not satisfy it.
    pub adoption: String,
    pub baseline: Subject,
    pub candidate: Subject,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub name: String,
    pub intention: String,
    pub affected: Vec<String>,
    pub sources: Vec<String>,
    pub verification: String,
    pub adoption: String,
    pub status: String,
    pub next_step: String,
    pub experiment: ExperimentResult,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub schema_version: u32,
    pub target: String,
    pub verdict: String,
    pub signature: String,
    pub subject: Value,
    pub opportunities: Vec<Finding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

fn slug(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

impl Manifest {
    /// Validate the whole manifest before running any project command.
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != SCHEMA_VERSION {
            return Err("unsupported schemaVersion".into());
        }
        if !slug(&self.target) {
            return Err("target must be a nonempty kebab-case name".into());
        }
        if self.opportunities.is_empty() {
            return Err("opportunities must not be empty".into());
        }
        let mut seen = BTreeSet::new();
        for o in &self.opportunities {
            if !slug(&o.name) || !seen.insert(&o.name) {
                return Err(format!("invalid or duplicate opportunity name: {}", o.name));
            }
            if [&o.intention, &o.verification, &o.adoption]
                .iter()
                .any(|s| s.trim().is_empty())
            {
                return Err(format!(
                    "{} needs intention, verification, and adoption",
                    o.name
                ));
            }
            if o.affected.is_empty()
                || o.affected.iter().any(|p| {
                    p.trim().is_empty()
                        || Path::new(p).is_absolute()
                        || Path::new(p)
                            .components()
                            .any(|c| matches!(c, Component::ParentDir))
                })
            {
                return Err(format!(
                    "{} needs affected paths relative to the repository",
                    o.name
                ));
            }
            if o.sources.is_empty()
                || o.sources.iter().any(|s| {
                    !(s.starts_with("https://") || s.starts_with("http://"))
                        || s.split("://")
                            .nth(1)
                            .is_none_or(|s| s.is_empty() || s.starts_with('/'))
                        || s.chars().any(char::is_whitespace)
                })
            {
                return Err(format!("{} needs http(s) source URLs", o.name));
            }
            o.experiment().validate()?;
        }
        Ok(())
    }

    pub fn observe(mut self, path: &Path) -> Result<Observation, String> {
        self.validate()?;
        let parent = path.parent().ok_or("manifest has no parent")?;
        let mut findings = Vec::new();
        for o in &mut self.opportunities {
            for side in [&mut o.baseline, &mut o.candidate] {
                for command in side.setup.iter_mut().chain([&mut side.command]) {
                    for arg in &mut command.argv {
                        *arg = arg.replace("{manifest}", &parent.to_string_lossy());
                    }
                    if let Some(cwd) = &mut command.cwd {
                        if cwd.is_relative() {
                            *cwd = parent.join(&*cwd);
                        }
                    }
                }
            }
            let experiment = o.experiment().run()?;
            let (status, next_step) = match experiment.outcome {
                Outcome::Improvement => (
                    "newly_available",
                    format!(
                        "Evaluate: {} Adoption still requires: {}",
                        o.intention, o.adoption
                    ),
                ),
                Outcome::Regression => (
                    "lost",
                    "Investigate the capability lost in the candidate before adopting it.".into(),
                ),
                Outcome::Unchanged => (
                    "available_in_baseline",
                    format!(
                        "Review whether this watch can be retired. Adoption still requires: {}",
                        o.adoption
                    ),
                ),
                Outcome::Blocked => (
                    "pending",
                    "Keep watching; neither subject satisfies the behavioral probe.".into(),
                ),
                Outcome::Instrument => (
                    "inconclusive",
                    "Repair the probe or its environment and rerun both subjects.".into(),
                ),
            };
            findings.push(Finding {
                name: o.name.clone(),
                intention: o.intention.clone(),
                affected: o.affected.clone(),
                sources: o.sources.clone(),
                verification: o.verification.clone(),
                adoption: o.adoption.clone(),
                status: status.into(),
                next_step,
                experiment,
            });
        }
        // Incomplete evidence must not close an existing finding as green.
        let verdict = if findings
            .iter()
            .any(|f| f.experiment.outcome == Outcome::Instrument)
        {
            "instrument"
        } else if findings
            .iter()
            .any(|f| f.experiment.outcome == Outcome::Regression)
        {
            "red"
        } else if findings
            .iter()
            .any(|f| f.experiment.outcome == Outcome::Improvement)
        {
            "changed"
        } else {
            "green"
        };
        let mut changes: Vec<_> = findings
            .iter()
            .filter_map(|f| match f.experiment.outcome {
                Outcome::Improvement => Some(format!("opportunity:{}:f>t", f.name)),
                Outcome::Regression => Some(format!("opportunity:{}:t>f", f.name)),
                _ => None,
            })
            .collect();
        changes.sort();
        let signature = if changes.is_empty() {
            verdict.into()
        } else {
            format!("{verdict}:{}", changes.join("|"))
        };
        Ok(Observation {
            schema_version: SCHEMA_VERSION,
            target: self.target,
            verdict: verdict.into(),
            signature,
            subject: json!({"manifest": path}),
            opportunities: findings,
            reason: (verdict == "instrument")
                .then(|| "at least one opportunity could not be measured".into()),
        })
    }
}

impl Opportunity {
    fn experiment(&self) -> Experiment {
        Experiment {
            schema_version: SCHEMA_VERSION,
            name: self.name.clone(),
            protocol: Protocol::Probe,
            baseline: self.baseline.clone(),
            candidate: self.candidate.clone(),
        }
    }
}
