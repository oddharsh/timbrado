use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    thread,
    time::{Duration, Instant},
};
use timbrado::{
    CommandSpec, Experiment, Outcome, Protocol, measure, opportunity::Manifest, outcome,
};

fn command(script: &str) -> CommandSpec {
    serde_json::from_value(json!({"argv": ["/bin/sh", "-c", script]})).unwrap()
}

fn probe(value: bool) -> CommandSpec {
    command(&format!(
        "printf '%s' '{{\"landed\":{value},\"detail\":\"measured behavior\",\"evidence\":{{\"build\":\"abc\"}}}}'"
    ))
}

fn manifest(baseline: bool, candidate: bool) -> Value {
    json!({"schemaVersion": 1, "target": "browser-capabilities", "opportunities": [{
        "name": "remove-workaround", "intention": "Remove the workaround",
        "affected": ["src/layout.css"], "sources": ["https://example.com/spec"],
        "verification": "The behavior works", "adoption": "Review the supported browser matrix",
        "baseline": {"id": "stable", "command": probe(baseline)},
        "candidate": {"id": "canary", "command": probe(candidate)}
    }]})
}

#[test]
fn every_comparison_requires_two_measurements() {
    for (b, c, want) in [
        (Some(true), Some(true), Outcome::Unchanged),
        (Some(false), Some(true), Outcome::Improvement),
        (Some(true), Some(false), Outcome::Regression),
        (Some(false), Some(false), Outcome::Blocked),
        (None, Some(true), Outcome::Instrument),
        (Some(false), None, Outcome::Instrument),
        (Some(true), None, Outcome::Instrument),
        (None, Some(false), Outcome::Instrument),
        (None, None, Outcome::Instrument),
    ] {
        assert_eq!(outcome(b, c), want);
    }
}

#[test]
fn valid_probe_records_evidence_and_process_status() {
    let r = measure(&probe(true), Protocol::Probe);
    assert_eq!(r.value, Some(true));
    assert_eq!(r.exit_code, Some(0));
    assert_eq!(r.evidence["build"], "abc");
    assert!(!r.output_truncated);
}

#[test]
fn crashed_signalled_or_malformed_probes_never_measure_a_boolean() {
    for script in [
        "printf '%s' '{\"landed\":true,\"detail\":\"claimed success\"}'; exit 3",
        "printf '%s' '{\"landed\":true,\"detail\":\"claimed success\"}'; kill -TERM $$",
        "printf '%s' '{\"landed\":\"false\",\"detail\":\"wrong type\"}'",
        "printf '%s' '{\"landed\":true,\"detail\":\"\"}'",
        "printf '%s\n' 'noise' '{\"landed\":true,\"detail\":\"extra stdout\"}'",
        "printf '%s' '{\"landed\":true}'",
    ] {
        assert_eq!(
            measure(&command(script), Protocol::Probe).value,
            None,
            "{script}"
        );
    }
    let mut missing = command("unused");
    missing.argv = vec!["/timbrado-missing-executable".into()];
    assert_eq!(measure(&missing, Protocol::Probe).value, None);
}

#[test]
fn exit_code_protocol_separates_failed_gates_from_unavailable_commands() {
    assert_eq!(
        measure(&command("exit 1"), Protocol::ExitCode).value,
        Some(false)
    );
    assert_eq!(
        measure(&command("exit 0"), Protocol::ExitCode).value,
        Some(true)
    );
    for script in ["exit 127", "exit 126", "kill -TERM $$"] {
        assert_eq!(measure(&command(script), Protocol::ExitCode).value, None);
    }
}

#[test]
fn timeout_kills_the_process_group_and_cannot_accept_early_json() {
    let dir = tempfile::tempdir().unwrap();
    let mut spec = command(
        "printf '%s' '{\"landed\":true,\"detail\":\"too early\"}'; (sleep 0.3; touch escaped) & wait",
    );
    spec.cwd = Some(dir.path().to_path_buf());
    spec.timeout_ms = 40;
    let start = Instant::now();
    let r = measure(&spec, Protocol::Probe);
    assert_eq!(r.value, None);
    assert!(r.detail.contains("timed out"));
    assert!(start.elapsed() < Duration::from_secs(2));
    thread::sleep(Duration::from_millis(400));
    assert!(!dir.path().join("escaped").exists());
}

#[test]
fn descendants_are_cleaned_up_even_when_the_parent_exits_successfully() {
    let dir = tempfile::tempdir().unwrap();
    let mut spec = command("(sleep 0.3; touch escaped) & exit 0");
    spec.cwd = Some(dir.path().to_path_buf());
    assert_eq!(measure(&spec, Protocol::ExitCode).value, Some(true));
    thread::sleep(Duration::from_millis(400));
    assert!(!dir.path().join("escaped").exists());
}

#[test]
fn stdout_is_bounded_and_a_truncated_probe_is_inconclusive() {
    let r = measure(&command("head -c 100000 /dev/zero"), Protocol::Probe);
    assert_eq!(r.value, None);
    assert!(r.output_truncated);
    assert_eq!(r.stdout.len(), 65536);
}

#[test]
fn default_scratch_directory_is_removed_after_the_measurement() {
    let r = measure(&command("pwd; touch created-by-probe"), Protocol::ExitCode);
    assert_eq!(r.value, Some(true));
    assert!(!Path::new(r.stdout.trim()).exists());
}

#[test]
fn failed_setup_skips_the_gate_and_does_not_look_like_a_regression() {
    let dir = tempfile::tempdir().unwrap();
    let mut gate = command("touch must-not-run");
    gate.cwd = Some(dir.path().to_path_buf());
    let e: Experiment = serde_json::from_value(json!({"schemaVersion": 1, "name": "setup",
        "protocol": "exit-code", "baseline": {"id": "base", "command": command("exit 0")},
        "candidate": {"id": "next", "setup": [command("exit 1")], "command": gate}}))
    .unwrap();
    let r = e.run().unwrap();
    assert_eq!(r.outcome, Outcome::Instrument);
    assert!(!dir.path().join("must-not-run").exists());
}

#[test]
fn opportunities_connect_evidence_to_an_action_without_approving_adoption() {
    let m: Manifest = serde_json::from_value(manifest(false, true)).unwrap();
    let report = m.observe(Path::new("/tmp/opportunities.json")).unwrap();
    assert_eq!(report.verdict, "changed");
    assert_eq!(
        report.signature,
        "changed:opportunity:remove-workaround:f>t"
    );
    let f = &report.opportunities[0];
    assert_eq!(f.status, "newly_available");
    assert!(f.next_step.contains("Adoption still requires"));
    assert_eq!(f.experiment.candidate.measurement.evidence["build"], "abc");
}

#[test]
fn signatures_track_behavior_and_ignore_subject_build_names() {
    let mut v = manifest(false, true);
    let first = serde_json::from_value::<Manifest>(v.clone())
        .unwrap()
        .observe(Path::new("/tmp/a.json"))
        .unwrap();
    v["opportunities"][0]["candidate"]["id"] = json!("tomorrows-canary");
    let second = serde_json::from_value::<Manifest>(v)
        .unwrap()
        .observe(Path::new("/tmp/a.json"))
        .unwrap();
    assert_eq!(first.signature, second.signature);
}

#[test]
fn one_inconclusive_opportunity_prevents_a_green_recovery() {
    let mut v = manifest(true, true);
    v["opportunities"][0]["candidate"]["command"] = json!({"argv": ["/missing-timbrado"]});
    let r = serde_json::from_value::<Manifest>(v)
        .unwrap()
        .observe(Path::new("/tmp/a.json"))
        .unwrap();
    assert_eq!(r.verdict, "instrument");
    assert_eq!(r.opportunities[0].status, "inconclusive");
}

#[test]
fn whole_manifest_validation_precedes_every_execution() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = manifest(false, true);
    v["opportunities"][0]["baseline"]["command"] =
        json!({"argv": ["touch", dir.path().join("must-not-run")]});
    let duplicate = v["opportunities"][0].clone();
    v["opportunities"].as_array_mut().unwrap().push(duplicate);
    let r = serde_json::from_value::<Manifest>(v)
        .unwrap()
        .observe(Path::new("/tmp/a.json"));
    assert!(r.is_err());
    assert!(fs::read_dir(dir.path()).unwrap().next().is_none());
}

#[test]
fn cli_rejects_unknown_schema_and_reports_instrument_exit_code() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("opportunities.json");
    let mut v = manifest(false, true);
    v["schemaVersion"] = json!(2);
    fs::write(&path, v.to_string()).unwrap();
    let r = std::process::Command::new(env!("CARGO_BIN_EXE_timbrado"))
        .arg("observe")
        .arg(&path)
        .output()
        .unwrap();
    assert_eq!(r.status.code(), Some(2));
    assert!(r.stdout.is_empty());
    v["schemaVersion"] = json!(1);
    v["opportunities"][0]["candidate"]["command"] = json!({"argv": ["/missing-timbrado"]});
    fs::write(&path, v.to_string()).unwrap();
    let r = std::process::Command::new(env!("CARGO_BIN_EXE_timbrado"))
        .arg("observe")
        .arg(&path)
        .output()
        .unwrap();
    assert_eq!(r.status.code(), Some(2));
    assert_eq!(
        serde_json::from_slice::<Value>(&r.stdout).unwrap()["verdict"],
        "instrument"
    );
}
