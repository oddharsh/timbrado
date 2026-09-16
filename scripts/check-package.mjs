// Check the source distribution as an installed consumer, without publishing.
// Run after `bun run test` so the locked Rust dependencies are cached.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "timbrado-package-"));
const run = (cmd, args, cwd = root, env = process.env) => {
  const result = spawnSync(cmd, args, { cwd, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
  if (result.status !== 0) throw new Error(`${cmd}: ${result.stderr || result.error}`);
  return result.stdout;
};
try {
  const env = { ...process.env, npm_config_cache: join(scratch, "npm-cache") };
  const pack = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", scratch], root, env))[0];
  if (pack.files.some((f) => f.path.includes("node_modules/") || f.path.startsWith("target/"))) {
    throw new Error("dependencies or platform artifacts included in the source package");
  }
  for (const required of ["Cargo.toml", "Cargo.lock", "native/main.rs", "dist/native.js", "docs/experiments.md", "examples/browser/opportunities.json"]) {
    if (!pack.files.some((f) => f.path === required)) throw new Error(`missing package file ${required}`);
  }
  run("tar", ["-xzf", join(scratch, pack.filename), "-C", scratch]);
  const pkg = join(scratch, "package");
  run("cargo", ["build", "--offline", "--release", "--locked", "--manifest-path", join(pkg, "Cargo.toml"), "--target-dir", join(pkg, "target")]);
  if (!existsSync(join(pkg, "target/release/timbrado"))) throw new Error("package engine missing");
  const watchUrl = pathToFileURL(join(pkg, "dist/watch.js")).href;
  const script = `import {runWatch} from ${JSON.stringify(watchUrl)};
    const reading = runWatch(process.execPath, {script:'console.log(JSON.stringify({landed:true,detail:"packed source installation works"}))'});
    console.log(JSON.stringify(reading)); if (reading.landed !== true) process.exit(2);`;
  // Test default discovery inside the package, independently of caller overrides.
  const installedEnv = { ...process.env };
  delete installedEnv.TIMBRADO_BIN;
  const measurement = JSON.parse(run("node", ["--input-type=module", "-e", script], pkg, installedEnv));
  console.log(JSON.stringify({ files: pack.files.length, packageBytes: pack.size, nativeBuiltFromPackedSource: true, measurement }));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
