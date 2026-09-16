use clap::{Parser, Subcommand};
use serde::Deserialize;
use std::{
    fs,
    io::{self, Read},
    path::PathBuf,
    process::ExitCode,
};
use timbrado::{CommandSpec, Experiment, Protocol, SCHEMA_VERSION, measure, opportunity::Manifest};

#[derive(Parser)]
#[command(
    version,
    about = "Measure which upstream changes make a different engineering decision possible"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Measure declared opportunities against baseline and candidate commands.
    Observe {
        manifest: PathBuf,
        #[arg(long)]
        json: Option<PathBuf>,
    },
    /// Run one command from a schema-versioned JSON request on stdin.
    Measure,
    /// Run a baseline/candidate experiment from JSON on stdin.
    Experiment,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MeasureRequest {
    schema_version: u32,
    command: CommandSpec,
    protocol: Protocol,
}

fn stdin_json<T: serde::de::DeserializeOwned>() -> Result<T, String> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("request exceeds 1 MiB".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn run() -> Result<u8, String> {
    let (json, code, output) = match Cli::parse().command {
        Commands::Measure => {
            let r: MeasureRequest = stdin_json()?;
            if r.schema_version != SCHEMA_VERSION {
                return Err("unsupported schemaVersion".into());
            }
            r.command.validate()?;
            (
                serde_json::to_string_pretty(
                    &serde_json::json!({"schemaVersion": SCHEMA_VERSION, "measurement": measure(&r.command, r.protocol)}),
                ),
                0,
                None,
            )
        }
        Commands::Experiment => {
            let r: Experiment = stdin_json()?;
            (serde_json::to_string_pretty(&r.run()?), 0, None)
        }
        Commands::Observe { manifest, json } => {
            let path = fs::canonicalize(manifest).map_err(|e| e.to_string())?;
            let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let m: Manifest = serde_json::from_str(&data).map_err(|e| e.to_string())?;
            let report = m.observe(&path)?;
            let code = match report.verdict.as_str() {
                "instrument" => 2,
                "red" | "changed" => 1,
                _ => 0,
            };
            (serde_json::to_string_pretty(&report), code, json)
        }
    };
    let text = format!("{}\n", json.map_err(|e| e.to_string())?);
    if let Some(path) = output {
        fs::write(path, &text).map_err(|e| e.to_string())?;
    }
    print!("{text}");
    Ok(code)
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("timbrado: {error}");
            ExitCode::from(2)
        }
    }
}
