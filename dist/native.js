import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
export function nativeBinary() {
  const binary = process.env.TIMBRADO_BIN ?? fileURLToPath(new URL("../target/release/timbrado", import.meta.url));
  if (!isAbsolute(binary))
    throw new Error("TIMBRADO_BIN must be an absolute path");
  if (!existsSync(binary))
    throw new Error("Timbrado's Rust engine is missing. Run `cargo build --release --locked` in the timbrado package, or set TIMBRADO_BIN to the built executable.");
  return binary;
}
function request(operation, input) {
  const run = spawnSync(nativeBinary(), [operation], {
    input: JSON.stringify({ schemaVersion: 1, ...input }),
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
  if (run.error || run.status !== 0)
    throw new Error(`Rust engine: ${run.error?.message ?? (run.stderr.trim() || `exit ${run.status}`)}`);
  const result = JSON.parse(run.stdout);
  if (result.schemaVersion !== 1)
    throw new Error("unsupported Rust engine response schemaVersion");
  return result;
}
export function measure(command, protocol) {
  return request("measure", { command, protocol }).measurement;
}
export function experiment(name, baseline, candidate, protocol) {
  return request("experiment", { name, baseline, candidate, protocol });
}
