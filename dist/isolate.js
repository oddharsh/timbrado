import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experiment } from "./native.js";
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
  const unavailable = (reason, worktree = null) => ({
    ok: false,
    gates,
    worktree,
    verdict: "instrument",
    signature: "instrument",
    reason
  });
  if (isFloating(opts.spec) && !opts.allowFloating) {
    return unavailable(`${opts.spec} floats; pass --allow-floating to try it anyway (it must never be pinned)`);
  }
  const manager = opts.manager ?? managerOf(root);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "timbrado-try-")));
  const baseline = join(scratch, "baseline");
  const candidate = join(scratch, "candidate");
  const created = [];
  const run = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 60000 });
  try {
    const head = run(["rev-parse", "--verify", "HEAD"]);
    if (head.status !== 0)
      return unavailable(`cannot read HEAD: ${tail(head).join(" ")}`);
    const revision = head.stdout.trim();
    for (const tree of [baseline, candidate]) {
      const add = run(["worktree", "add", "--detach", tree, revision]);
      if (add.status !== 0)
        return unavailable(`cannot create isolated checkout: ${tail(add).join(" ")}`, opts.keep ? scratch : null);
      created.push(tree);
    }
    const subject = (cwd, isCandidate) => ({
      id: isCandidate ? `${revision} + ${opts.spec}` : revision,
      setup: [
        { argv: [manager, ...COMMANDS[manager].frozen], cwd, timeoutMs: 10 * 60000 },
        ...isCandidate ? [{ argv: [manager, ...COMMANDS[manager].add(opts.spec)], cwd, timeoutMs: 10 * 60000 }] : []
      ],
      command: { argv: ["/bin/sh", "-c", opts.gate], cwd, timeoutMs: opts.timeoutMs ?? 20 * 60000 }
    });
    const result = experiment("project-gate", subject(baseline, false), subject(candidate, true), "exit-code");
    const addGate = (name, reading) => gates.push({
      name,
      ok: reading.value === true,
      detail: reading.detail,
      notes: reading.value === true ? [] : tail(reading, 12)
    });
    for (const [name, side] of [["baseline", result.baseline], ["candidate", result.candidate]]) {
      side.setup.forEach((reading, i) => addGate(`${name}: ${i === 0 ? `frozen ${manager} install` : `add ${opts.spec}`}`, reading));
      addGate(`${name} gate: ${opts.gate}`, side.measurement);
    }
    const verdict = result.outcome === "unchanged" ? "green" : result.outcome === "improvement" ? "changed" : result.outcome === "regression" ? "red" : "instrument";
    let reason = result.outcome === "blocked" ? "The gate fails on both subjects; no candidate regression or recovery was established." : result.outcome === "instrument" ? "At least one subject could not be measured." : undefined;
    const install = result.candidate.setup[1];
    const age = releaseAgeSeconds(root);
    if (manager === "bun" && age && install?.value !== true && /failed to resolve/.test(`${install?.stderr ?? ""}
${install?.stdout ?? ""}`)) {
      reason = `${reason ?? "Candidate setup failed."} bunfig.toml sets minimumReleaseAge = ${age}s; check whether a required package is inside that window.`;
    }
    return {
      ok: result.candidate.measurement.value === true && verdict !== "instrument",
      gates,
      worktree: opts.keep ? candidate : null,
      experiment: result,
      verdict,
      reason,
      signature: verdict === "red" ? `red:gate:${opts.gate}:t>f` : verdict === "changed" ? `changed:gate:${opts.gate}:f>t` : verdict
    };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error), opts.keep ? scratch : null);
  } finally {
    if (!opts.keep) {
      const failures = [];
      for (const tree of created) {
        const removed = run(["worktree", "remove", "--force", tree]);
        if (removed.status !== 0)
          failures.push(`could not remove worktree ${tree}: ${tail(removed).join(" ")}`);
      }
      if (failures.length)
        throw new Error(failures.join(`
`));
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
