use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::os::unix::process::CommandExt;
use std::{
    collections::BTreeMap,
    io::Read,
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const OUTPUT_LIMIT: usize = 64 * 1024;
const MAX_TIMEOUT_MS: u64 = 60 * 60 * 1000;
fn default_timeout() -> u64 {
    60_000
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Protocol {
    Probe,
    ExitCode,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandSpec {
    /// Executable and arguments. A shell is used only when explicitly named here.
    pub argv: Vec<String>,
    /// Omitted means a fresh, disposable directory for this command.
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
}

impl CommandSpec {
    pub fn validate(&self) -> Result<(), String> {
        if self.argv.is_empty() || self.argv[0].trim().is_empty() {
            return Err("command.argv must name an executable".into());
        }
        if self.timeout_ms == 0 || self.timeout_ms > MAX_TIMEOUT_MS {
            return Err("command.timeoutMs must be between 1 and 3600000".into());
        }
        if self.argv.iter().any(|s| s.contains('\0'))
            || self
                .env
                .iter()
                .any(|(k, v)| k.is_empty() || k.contains(['=', '\0']) || v.contains('\0'))
        {
            return Err("invalid command argument or environment entry".into());
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    pub value: Option<bool>,
    pub detail: String,
    pub argv: Vec<String>,
    pub exit_code: Option<i32>,
    pub elapsed_ms: u128,
    pub stdout: String,
    pub stderr: String,
    pub output_truncated: bool,
    /// Probe-supplied evidence, such as the browser version and measured geometry.
    pub evidence: Value,
}

impl Measurement {
    pub fn unavailable(command: &CommandSpec, detail: String) -> Self {
        Self {
            value: None,
            detail,
            argv: command.argv.clone(),
            exit_code: None,
            elapsed_ms: 0,
            stdout: String::new(),
            stderr: String::new(),
            output_truncated: false,
            evidence: Value::Null,
        }
    }
}

// Keep draining after reaching the limit so verbose children cannot deadlock.
fn capture(mut stream: impl Read) -> std::io::Result<(String, bool)> {
    let mut kept = Vec::new();
    let mut truncated = false;
    let mut buffer = [0; 8192];
    loop {
        let n = stream.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        let take = n.min(OUTPUT_LIMIT - kept.len());
        kept.extend_from_slice(&buffer[..take]);
        truncated |= take < n;
    }
    Ok((String::from_utf8_lossy(&kept).into_owned(), truncated))
}

fn kill_group(pid: u32) {
    // The child was created with process_group(0): its pid names a group owned
    // by this run. Kill descendants too, including after the leader exits.
    if let Ok(pid) = i32::try_from(pid) {
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Probe {
    landed: bool,
    detail: String,
    #[serde(default)]
    evidence: Value,
}

pub fn measure(spec: &CommandSpec, protocol: Protocol) -> Measurement {
    let started = Instant::now();
    let mut result = Measurement::unavailable(spec, String::new());
    let run = || -> Result<Measurement, String> {
        spec.validate()?;
        let scratch = if spec.cwd.is_none() {
            Some(
                tempfile::Builder::new()
                    .prefix("timbrado-probe-")
                    .tempdir()
                    .map_err(|e| e.to_string())?,
            )
        } else {
            None
        };
        let cwd = spec
            .cwd
            .as_deref()
            .or_else(|| scratch.as_ref().map(|d| d.path()))
            .unwrap();
        let mut child = Command::new(&spec.argv[0])
            .args(&spec.argv[1..])
            .current_dir(cwd)
            .envs(&spec.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .map_err(|e| format!("could not start {}: {e}", spec.argv[0]))?;
        let pid = child.id();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let out_reader = thread::spawn(move || capture(stdout));
        let err_reader = thread::spawn(move || capture(stderr));
        let mut timed_out = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) if started.elapsed() < Duration::from_millis(spec.timeout_ms) => {
                    thread::sleep(Duration::from_millis(5));
                }
                Ok(None) => {
                    timed_out = true;
                    kill_group(pid);
                    break child.wait();
                }
                Err(error) => {
                    kill_group(pid);
                    let _ = child.wait();
                    break Err(error);
                }
            }
        };
        kill_group(pid);
        let (stdout, out_cut) = out_reader
            .join()
            .map_err(|_| "stdout reader panicked")?
            .map_err(|e| e.to_string())?;
        let (stderr, err_cut) = err_reader
            .join()
            .map_err(|_| "stderr reader panicked")?
            .map_err(|e| e.to_string())?;
        let status = status.map_err(|e| e.to_string())?;
        let mut r = Measurement {
            value: None,
            detail: String::new(),
            argv: spec.argv.clone(),
            exit_code: status.code(),
            elapsed_ms: started.elapsed().as_millis(),
            stdout,
            stderr,
            output_truncated: out_cut || err_cut,
            evidence: Value::Null,
        };
        if timed_out {
            r.detail = format!("timed out after {}ms", spec.timeout_ms);
        } else if status.code().is_none() {
            r.detail = "terminated by signal".into();
        } else {
            match protocol {
                Protocol::ExitCode => {
                    if matches!(status.code(), Some(126 | 127)) {
                        r.detail = format!("command unavailable: exit {}", status.code().unwrap());
                    } else {
                        r.value = Some(status.success());
                        r.detail = format!("exit {}", status.code().unwrap());
                    }
                }
                Protocol::Probe if !status.success() => r.detail = format!("probe exited {}", status.code().unwrap()),
                Protocol::Probe if out_cut => r.detail = "probe output exceeded 64 KiB".into(),
                Protocol::Probe => match serde_json::from_str::<Probe>(r.stdout.trim()) {
                    Ok(probe) if !probe.detail.trim().is_empty() => {
                        r.value = Some(probe.landed); r.detail = probe.detail; r.evidence = probe.evidence;
                    }
                    _ => r.detail = "probe must emit one JSON object with landed:boolean and nonempty detail:string".into(),
                },
            }
        }
        Ok(r)
    };
    match run() {
        Ok(measurement) => measurement,
        Err(error) => {
            result.detail = error;
            result.elapsed_ms = started.elapsed().as_millis();
            result
        }
    }
}
