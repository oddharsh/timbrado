// The JS API is a transport adapter. Process execution and comparison live in Rust.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";

export type CommandSpec = { argv: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number };
export type Measurement = {
  value: boolean | null; detail: string; argv: string[]; exitCode: number | null;
  elapsedMs: number; stdout: string; stderr: string; outputTruncated: boolean; evidence: unknown;
};
export type Subject = { id: string; command: CommandSpec; setup?: CommandSpec[] };
export type ExperimentResult = {
  schemaVersion: 1; name: string; observedAtUnixMs: number;
  baseline: { id: string; setup: Measurement[]; measurement: Measurement };
  candidate: { id: string; setup: Measurement[]; measurement: Measurement };
  outcome: "unchanged" | "improvement" | "regression" | "blocked" | "instrument";
};
export type OpportunityFinding = {
  name: string; intention: string; affected: string[]; sources: string[];
  verification: string; adoption: string; status: string; nextStep: string;
  experiment: ExperimentResult;
};

export function nativeBinary(): string {
  const binary = process.env.TIMBRADO_BIN ?? fileURLToPath(new URL("../target/release/timbrado", import.meta.url));
  if (!isAbsolute(binary)) throw new Error("TIMBRADO_BIN must be an absolute path");
  if (!existsSync(binary)) throw new Error("Timbrado's Rust engine is missing. Run `cargo build --release --locked` in the timbrado package, or set TIMBRADO_BIN to the built executable.");
  return binary;
}

function request<T>(operation: string, input: object): T {
  const run = spawnSync(nativeBinary(), [operation], {
    input: JSON.stringify({ schemaVersion: 1, ...input }), encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) throw new Error(`Rust engine: ${run.error?.message ?? (run.stderr.trim() || `exit ${run.status}`)}`);
  const result = JSON.parse(run.stdout);
  if (result.schemaVersion !== 1) throw new Error("unsupported Rust engine response schemaVersion");
  return result;
}

export function measure(command: CommandSpec, protocol: "probe" | "exit-code"): Measurement {
  return request<{ schemaVersion: 1; measurement: Measurement }>("measure", { command, protocol }).measurement;
}

export function experiment(name: string, baseline: Subject, candidate: Subject, protocol: "probe" | "exit-code"): ExperimentResult {
  return request("experiment", { name, baseline, candidate, protocol });
}
