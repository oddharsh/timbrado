// TRY: install a candidate into an isolated checkout of your HEAD and run
// YOUR gate command against it. The tool owns the isolation; the project
// owns the verdict.
//
// Two detached worktrees in the temp directory, outside the repository, so
// nothing resolves from the parent's node_modules (a nested worktree walks up
// into it, which is how a removal reads green). A frozen install of what is
// committed on each side, then the candidate added on its side with the package
// manager the lockfile names. Rust runs the same gate on both. Both checkouts
// name the same captured HEAD, and neither gate can contaminate the other's files.
//
// Two refusals are the tool's, because they are about the candidate rather
// than the project:
//
//   - a FLOATING spec (a branch name, `latest`, a dist-tag) may be tried and
//     may never be pinned: the lockfile records a sha512 of what it got, and
//     the next frozen install refuses it the morning the ref moves. `try`
//     accepts it with `--allow-floating`; `pin` does not exist here on purpose.
//   - a candidate YOUNGER than the project's install policy allows will fail
//     to resolve in the frozen install, and the message names the package
//     rather than the policy. `try` reads bunfig's minimumReleaseAge when the
//     project is bun's and says which it was.
//
// It reports the tail of whatever failed, never the whole log: the gate
// command is the project's, and the project knows how to read it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experiment, type ExperimentResult, type Measurement, type Subject } from "./native.ts";

export type Manager = "bun" | "npm" | "pnpm" | "yarn";
export type Gate = { name: string; ok: boolean; detail: string; notes?: string[] };
export type TryResult = {
  ok: boolean; gates: Gate[]; worktree: string | null;
  verdict: "green" | "changed" | "red" | "instrument"; signature: string;
  reason?: string; experiment?: ExperimentResult;
};

export function managerOf(root: string): Manager {
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

const COMMANDS: Record<Manager, { frozen: string[]; add: (spec: string) => string[] }> = {
  bun: { frozen: ["install", "--frozen-lockfile"], add: (s) => ["add", "--dev", s] },
  npm: { frozen: ["ci"], add: (s) => ["install", "--save-dev", s] },
  pnpm: { frozen: ["install", "--frozen-lockfile"], add: (s) => ["add", "--save-dev", s] },
  yarn: { frozen: ["install", "--immutable"], add: (s) => ["add", "--dev", s] },
};

/** A spec that names bytes which can move: a dist-tag, a branch, a bare name. */
export function isFloating(spec: string): boolean {
  const m = /^(?:https:\/\/pkg\.pr\.new\/[^@]+@|@?[^@]+@)(.+)$/.exec(spec);
  if (!m) return true; // a bare name resolves to latest
  const ref = m[1];
  if (/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(ref)) return false; // an exact version
  if (/^[0-9a-f]{7,40}$/.test(ref)) return false; // a sha
  return true;
}

export function releaseAgeSeconds(root: string): number | null {
  const p = join(root, "bunfig.toml");
  if (!existsSync(p)) return null;
  const m = /^\s*minimumReleaseAge\s*=\s*(\d+)/m.exec(readFileSync(p, "utf8"));
  return m ? Number(m[1]) : null;
}

const tail = (out: { stdout?: string | null; stderr?: string | null }, n = 4) => `${out.stderr || ""}\n${out.stdout || ""}`.trim().split("\n").slice(-n);

export function tryCandidate(opts: { root: string; spec: string; gate: string; allowFloating?: boolean; keep?: boolean; timeoutMs?: number; manager?: Manager }): TryResult {
  const gates: Gate[] = [];
  const root = realpathSync(opts.root);
  const unavailable = (reason: string, worktree: string | null = null): TryResult => ({
    ok: false, gates, worktree, verdict: "instrument", signature: "instrument", reason,
  });
  if (isFloating(opts.spec) && !opts.allowFloating) {
    return unavailable(`${opts.spec} floats; pass --allow-floating to try it anyway (it must never be pinned)`);
  }
  const manager = opts.manager ?? managerOf(root);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "timbrado-try-")));
  const baseline = join(scratch, "baseline");
  const candidate = join(scratch, "candidate");
  const created: string[] = [];
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 60_000 });
  try {
    const head = run(["rev-parse", "--verify", "HEAD"]);
    if (head.status !== 0) return unavailable(`cannot read HEAD: ${tail(head).join(" ")}`);
    const revision = head.stdout.trim();
    for (const tree of [baseline, candidate]) {
      const add = run(["worktree", "add", "--detach", tree, revision]);
      if (add.status !== 0) return unavailable(`cannot create isolated checkout: ${tail(add).join(" ")}`, opts.keep ? scratch : null);
      created.push(tree);
    }
    const subject = (cwd: string, isCandidate: boolean): Subject => ({
      id: isCandidate ? `${revision} + ${opts.spec}` : revision,
      setup: [
        { argv: [manager, ...COMMANDS[manager].frozen], cwd, timeoutMs: 10 * 60_000 },
        ...(isCandidate ? [{ argv: [manager, ...COMMANDS[manager].add(opts.spec)], cwd, timeoutMs: 10 * 60_000 }] : []),
      ],
      command: { argv: ["/bin/sh", "-c", opts.gate], cwd, timeoutMs: opts.timeoutMs ?? 20 * 60_000 },
    });
    const result = experiment("project-gate", subject(baseline, false), subject(candidate, true), "exit-code");
    const addGate = (name: string, reading: Measurement) => gates.push({
      name, ok: reading.value === true, detail: reading.detail,
      notes: reading.value === true ? [] : tail(reading, 12),
    });
    for (const [name, side] of [["baseline", result.baseline], ["candidate", result.candidate]] as const) {
      side.setup.forEach((reading, i) => addGate(`${name}: ${i === 0 ? `frozen ${manager} install` : `add ${opts.spec}`}`, reading));
      addGate(`${name} gate: ${opts.gate}`, side.measurement);
    }
    const verdict = result.outcome === "unchanged" ? "green" : result.outcome === "improvement" ? "changed"
      : result.outcome === "regression" ? "red" : "instrument";
    let reason = result.outcome === "blocked" ? "The gate fails on both subjects; no candidate regression or recovery was established."
      : result.outcome === "instrument" ? "At least one subject could not be measured." : undefined;
    const install = result.candidate.setup[1];
    const age = releaseAgeSeconds(root);
    if (manager === "bun" && age && install?.value !== true && /failed to resolve/.test(`${install?.stderr ?? ""}\n${install?.stdout ?? ""}`)) {
      reason = `${reason ?? "Candidate setup failed."} bunfig.toml sets minimumReleaseAge = ${age}s; check whether a required package is inside that window.`;
    }
    return {
      ok: result.candidate.measurement.value === true && verdict !== "instrument", gates,
      worktree: opts.keep ? candidate : null, experiment: result, verdict, reason,
      signature: verdict === "red" ? `red:gate:${opts.gate}:t>f` : verdict === "changed" ? `changed:gate:${opts.gate}:f>t` : verdict,
    };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error), opts.keep ? scratch : null);
  } finally {
    if (!opts.keep) {
      const failures: string[] = [];
      for (const tree of created) {
        const removed = run(["worktree", "remove", "--force", tree]);
        if (removed.status !== 0) failures.push(`could not remove worktree ${tree}: ${tail(removed).join(" ")}`);
      }
      if (failures.length) throw new Error(failures.join("\n"));
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
