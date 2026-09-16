import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryCandidate } from "../src/isolate.ts";

// Real git worktrees and real processes, with a local package-manager fixture:
// no registry or user's npm configuration is needed to exercise state isolation.
function fixture(run: (root: string) => void, failInstall = false) {
  const scratch = mkdtempSync(join(tmpdir(), "timbrado-conformance-"));
  const root = join(scratch, "repo");
  const bin = join(scratch, "bin");
  mkdirSync(root); mkdirSync(bin);
  const git = (...args: string[]) => {
    const p = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (p.status !== 0) throw new Error(p.stderr);
    return p.stdout;
  };
  writeFileSync(join(bin, "npm"), `#!/bin/sh
set -eu
case "$1" in
  ci) touch .installed ;;
  install) test ! -e fail-add; touch .candidate ;;
  *) exit 127 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}');
  if (failInstall) writeFileSync(join(root, "fail-add"), "");
  git("init", "--quiet");
  git("add", "package.json", ...(failInstall ? ["fail-add"] : []));
  git("-c", "user.name=Timbrado Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  writeFileSync(join(root, "user-wip"), "preserve me");
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    run(root);
    expect(readFileSync(join(root, "user-wip"), "utf8")).toBe("preserve me");
    expect(git("status", "--porcelain").trim()).toBe("?? user-wip");
    expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length).toBe(1);
  } finally {
    process.env.PATH = previousPath;
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("paired project gates", () => {
  for (const [gate, outcome, verdict] of [
    ["test ! -e .candidate", "regression", "red"],
    ["test -e .candidate", "improvement", "changed"],
    ["exit 1", "blocked", "instrument"],
    ["test -e .installed", "unchanged", "green"],
  ] as const) {
    test(`${outcome}: ${gate}`, () => fixture((root) => {
      const r = tryCandidate({ root, spec: "fixture@2.0.0", gate });
      expect(r.experiment?.outcome).toBe(outcome);
      expect(r.verdict).toBe(verdict);
      expect(r.worktree).toBeNull();
    }));
  }

  test("both gates start with independent files and the same committed revision", () => fixture((root) => {
    const r = tryCandidate({ root, spec: "fixture@2.0.0", gate: "test ! -e user-wip && test ! -e gate-artifact && touch gate-artifact" });
    expect(r.verdict).toBe("green");
    expect(r.experiment?.candidate.id).toStartWith(`${r.experiment?.baseline.id} + `);
  }));

  test("failed candidate setup is an instrument failure with the baseline evidence retained", () => fixture((root) => {
    const r = tryCandidate({ root, spec: "fixture@2.0.0", gate: "exit 0" });
    expect(r.verdict).toBe("instrument");
    expect(r.experiment?.baseline.measurement.value).toBe(true);
    expect(r.experiment?.candidate.measurement.value).toBeNull();
    expect(r.experiment?.candidate.measurement.detail).toMatch(/setup failed/);
  }, true));

  test("gate timeout cannot be reported as a candidate regression", () => fixture((root) => {
    const r = tryCandidate({ root, spec: "fixture@2.0.0", gate: "sleep 1", timeoutMs: 30 });
    expect(r.verdict).toBe("instrument");
    expect(r.experiment?.candidate.measurement.detail).toContain("timed out");
  }));

  test("CLI emits the paired evidence and returns 1 for an improvement", () => fixture((root) => {
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const out = join(root, "report.json");
    const p = spawnSync(process.execPath, [cli, "try", "fixture@2.0.0", "--repo", root, "--gate", "test -e .candidate", "--json", out], { encoding: "utf8" });
    expect(p.status).toBe(1);
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report.verdict).toBe("changed");
    expect(report.experiment.outcome).toBe("improvement");
    rmSync(out);
  }));
});
