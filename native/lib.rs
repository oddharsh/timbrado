//! The canonical measurement engine. Resolvers and reporters consume its evidence.
//!
//! Scratch directories separate files; they are not a security sandbox. Commands
//! are trusted project code and inherit the caller's environment.
#[cfg(not(unix))]
compile_error!("Timbrado's process-group supervisor currently supports macOS and Linux only.");

pub mod opportunity;
pub mod process;

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

pub use process::{CommandSpec, Measurement, Protocol, measure};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Subject {
    /// A caller-supplied label. Probe evidence should record the observed build.
    pub id: String,
    #[serde(default)]
    pub setup: Vec<CommandSpec>,
    pub command: CommandSpec,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Experiment {
    pub schema_version: u32,
    pub name: String,
    pub protocol: Protocol,
    pub baseline: Subject,
    pub candidate: Subject,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Unchanged,
    Improvement,
    Regression,
    Blocked,
    Instrument,
}

/// An unmeasured side can never establish a change, or a recovery.
pub fn outcome(baseline: Option<bool>, candidate: Option<bool>) -> Outcome {
    match (baseline, candidate) {
        (Some(true), Some(true)) => Outcome::Unchanged,
        (Some(false), Some(true)) => Outcome::Improvement,
        (Some(true), Some(false)) => Outcome::Regression,
        (Some(false), Some(false)) => Outcome::Blocked,
        _ => Outcome::Instrument,
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SideResult {
    pub id: String,
    pub setup: Vec<Measurement>,
    pub measurement: Measurement,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentResult {
    pub schema_version: u32,
    pub name: String,
    pub observed_at_unix_ms: u128,
    pub baseline: SideResult,
    pub candidate: SideResult,
    pub outcome: Outcome,
}

impl Experiment {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(format!("unsupported schemaVersion {}", self.schema_version));
        }
        if self.name.trim().is_empty() {
            return Err("experiment name must not be empty".into());
        }
        for side in [&self.baseline, &self.candidate] {
            if side.id.trim().is_empty() {
                return Err("each subject needs a nonempty id".into());
            }
            for command in side.setup.iter().chain([&side.command]) {
                command.validate()?;
            }
        }
        Ok(())
    }

    pub fn run(&self) -> Result<ExperimentResult, String> {
        self.validate()?;
        let baseline = run_side(&self.baseline, self.protocol);
        let candidate = run_side(&self.candidate, self.protocol);
        Ok(ExperimentResult {
            schema_version: SCHEMA_VERSION,
            name: self.name.clone(),
            observed_at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_millis(),
            outcome: outcome(baseline.measurement.value, candidate.measurement.value),
            baseline,
            candidate,
        })
    }
}

fn run_side(side: &Subject, protocol: Protocol) -> SideResult {
    let mut setup = Vec::new();
    for command in &side.setup {
        let result = measure(command, Protocol::ExitCode);
        let failed = result.value != Some(true);
        let detail = result.detail.clone();
        setup.push(result);
        if failed {
            return SideResult {
                id: side.id.clone(),
                setup,
                measurement: Measurement::unavailable(
                    &side.command,
                    format!("setup failed: {detail}"),
                ),
            };
        }
    }
    SideResult {
        id: side.id.clone(),
        setup,
        measurement: measure(&side.command, protocol),
    }
}
