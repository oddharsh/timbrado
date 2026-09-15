// TRY: install a candidate into an isolated checkout of your HEAD and run
// YOUR gate command against it. The tool owns the isolation; the project
// owns the verdict.
//
// A detached worktree in the temp directory, outside the repository, so
// nothing resolves from the parent's node_modules (a nested worktree walks up
// into it, which is how a removal reads green). A frozen install of what is
// committed, then the candidate added on top with the package manager the
// lockfile names, then the gate. The worktree is removed in a finally.
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

export type Manager = "bun" | "npm" | "pnpm" | "yarn";
export type Gate = { name: string; ok: boolean; detail: string; notes?: string[] };
export type TryResult = { ok: boolean; gates: Gate[]; worktree: string | null };

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
  if (isFloating(opts.spec) && !opts.allowFloating) {
    gates.push({ name: "candidate is pinnable", ok: false, detail: `${opts.spec} floats; pass --allow-floating to try it anyway (it must never be pinned)` });
    return { ok: false, gates, worktree: null };
  }
  const manager = opts.manager ?? managerOf(root);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "timbrado-try-")));
  const wt = join(scratch, "tree");
  const run = (cmd: string, args: string[], cwd: string, timeout?: number) => spawnSync(cmd, args, { cwd, encoding: "utf8", timeout });
  try {
    const add = run("git", ["worktree", "add", "--detach", wt, "HEAD"], root);
    if (add.status !== 0) {
      gates.push({ name: "isolated checkout of HEAD", ok: false, detail: tail(add).join(" ") });
      return { ok: false, gates, worktree: null };
    }
    const frozen = run(manager, COMMANDS[manager].frozen, wt, 10 * 60_000);
    if (frozen.status !== 0) {
      gates.push({ name: `frozen ${manager} install of HEAD`, ok: false, detail: "the committed tree does not install, which is the project's problem rather than the candidate's", notes: tail(frozen) });
      return { ok: false, gates, worktree: opts.keep ? wt : null };
    }
    gates.push({ name: `frozen ${manager} install of HEAD`, ok: true, detail: "ok" });

    const added = run(manager, COMMANDS[manager].add(opts.spec), wt, 10 * 60_000);
    if (added.status !== 0) {
      const text = tail(added, 3).join(" ");
      const age = releaseAgeSeconds(root);
      const tooYoung = manager === "bun" && age && /failed to resolve/.test(text);
      gates.push({
        name: `add ${opts.spec}`,
        ok: false,
        detail: tooYoung
          ? `${text.slice(0, 160)} — bunfig.toml sets minimumReleaseAge = ${age}s (${(age / 3600).toFixed(0)}h); a package published inside that window reads exactly like this. Exempt it by name or wait.`
          : text.slice(0, 200),
      });
      return { ok: false, gates, worktree: opts.keep ? wt : null };
    }
    gates.push({ name: `add ${opts.spec}`, ok: true, detail: "installed" });

    const gate = spawnSync(opts.gate, { cwd: wt, encoding: "utf8", shell: true, timeout: opts.timeoutMs ?? 20 * 60_000 });
    const timedOut = gate.signal === "SIGTERM";
    const ok = !timedOut && gate.status === 0;
    gates.push({ name: `gate: ${opts.gate}`, ok, detail: timedOut ? "timed out" : `exit ${gate.status}`, notes: ok ? [] : tail(gate, 12) });
    return { ok, gates, worktree: opts.keep ? wt : null };
  } finally {
    if (!opts.keep) {
      run("git", ["worktree", "remove", "--force", wt], root);
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
