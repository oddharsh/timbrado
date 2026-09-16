import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryCandidate } from "../src/isolate.ts";

test("real offline npm installs compare two local package versions without changing the checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "timbrado-npm-"));
  const root = join(dir, "repo");
  mkdirSync(root);
  const settings = { npm_config_cache: join(dir, "cache"), npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false" };
  const before = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const run = (cmd: string, args: string[], cwd = root) => {
    const p = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 15_000 });
    if (p.status !== 0) throw new Error(`${cmd}: ${p.error?.message ?? p.stderr}`);
    return p.stdout;
  };
  try {
    const archives = ["1.0.0", "2.0.0"].map((version) => {
      const pkg = join(dir, `package-${version}`);
      mkdirSync(pkg);
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "timbrado-fixture-dependency", version }));
      const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", dir], pkg));
      return join(dir, packed[0].filename);
    });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", devDependencies: { "timbrado-fixture-dependency": `file:${archives[0]}` } }));
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    run("npm", ["install"]);
    run("git", ["init", "--quiet"]);
    run("git", ["add", "package.json", "package-lock.json", ".gitignore"]);
    run("git", ["-c", "user.name=Timbrado Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
    const lock = readFileSync(join(root, "package-lock.json"), "utf8");
    const result = tryCandidate({
      root, spec: `file:${archives[1]}`, allowFloating: true,
      gate: `node -e 'process.exit(require("timbrado-fixture-dependency/package.json").version === "2.0.0" ? 0 : 1)'`,
    });
    expect(result.reason).toBeUndefined();
    expect(result.experiment?.outcome).toBe("improvement");
    expect(result.verdict).toBe("changed");
    expect(readFileSync(join(root, "package-lock.json"), "utf8")).toBe(lock);
    expect(JSON.parse(readFileSync(join(root, "node_modules/timbrado-fixture-dependency/package.json"), "utf8")).version).toBe("1.0.0");
    expect(run("git", ["status", "--porcelain"]).trim()).toBe("");
    expect(run("git", ["worktree", "list", "--porcelain"]).match(/^worktree /gm)?.length).toBe(1);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
