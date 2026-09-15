import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export function managerOf(root) {
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")))
    return "bun";
  if (existsSync(join(root, "pnpm-lock.yaml")))
    return "pnpm";
  if (existsSync(join(root, "yarn.lock")))
    return "yarn";
  return "npm";
}
const COMMANDS = {
  bun: { frozen: ["install", "--frozen-lockfile"], add: (s) => ["add", "--dev", s] },
  npm: { frozen: ["ci"], add: (s) => ["install", "--save-dev", s] },
  pnpm: { frozen: ["install", "--frozen-lockfile"], add: (s) => ["add", "--save-dev", s] },
  yarn: { frozen: ["install", "--immutable"], add: (s) => ["add", "--dev", s] }
};
export function isFloating(spec) {
  const m = /^(?:https:\/\/pkg\.pr\.new\/[^@]+@|@?[^@]+@)(.+)$/.exec(spec);
  if (!m)
    return true;
  const ref = m[1];
  if (/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(ref))
    return false;
  if (/^[0-9a-f]{7,40}$/.test(ref))
    return false;
  return true;
}
export function releaseAgeSeconds(root) {
  const p = join(root, "bunfig.toml");
  if (!existsSync(p))
    return null;
  const m = /^\s*minimumReleaseAge\s*=\s*(\d+)/m.exec(readFileSync(p, "utf8"));
  return m ? Number(m[1]) : null;
}
const tail = (out, n = 4) => `${out.stderr || ""}
${out.stdout || ""}`.trim().split(`
`).slice(-n);
export function tryCandidate(opts) {
  const gates = [];
  const root = realpathSync(opts.root);
  if (isFloating(opts.spec) && !opts.allowFloating) {
    gates.push({ name: "candidate is pinnable", ok: false, detail: `${opts.spec} floats; pass --allow-floating to try it anyway (it must never be pinned)` });
    return { ok: false, gates, worktree: null };
  }
  const manager = opts.manager ?? managerOf(root);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "timbrado-try-")));
  const wt = join(scratch, "tree");
  const run = (cmd, args, cwd, timeout) => spawnSync(cmd, args, { cwd, encoding: "utf8", timeout });
  try {
    const add = run("git", ["worktree", "add", "--detach", wt, "HEAD"], root);
    if (add.status !== 0) {
      gates.push({ name: "isolated checkout of HEAD", ok: false, detail: tail(add).join(" ") });
      return { ok: false, gates, worktree: null };
    }
    const frozen = run(manager, COMMANDS[manager].frozen, wt, 10 * 60000);
    if (frozen.status !== 0) {
      gates.push({ name: `frozen ${manager} install of HEAD`, ok: false, detail: "the committed tree does not install, which is the project's problem rather than the candidate's", notes: tail(frozen) });
      return { ok: false, gates, worktree: opts.keep ? wt : null };
    }
    gates.push({ name: `frozen ${manager} install of HEAD`, ok: true, detail: "ok" });
    const added = run(manager, COMMANDS[manager].add(opts.spec), wt, 10 * 60000);
    if (added.status !== 0) {
      const text = tail(added, 3).join(" ");
      const age = releaseAgeSeconds(root);
      const tooYoung = manager === "bun" && age && /failed to resolve/.test(text);
      gates.push({
        name: `add ${opts.spec}`,
        ok: false,
        detail: tooYoung ? `${text.slice(0, 160)} — bunfig.toml sets minimumReleaseAge = ${age}s (${(age / 3600).toFixed(0)}h); a package published inside that window reads exactly like this. Exempt it by name or wait.` : text.slice(0, 200)
      });
      return { ok: false, gates, worktree: opts.keep ? wt : null };
    }
    gates.push({ name: `add ${opts.spec}`, ok: true, detail: "installed" });
    const gate = spawnSync(opts.gate, { cwd: wt, encoding: "utf8", shell: true, timeout: opts.timeoutMs ?? 20 * 60000 });
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
