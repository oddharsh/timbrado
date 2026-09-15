// WATCH: the fixes you are waiting on, each as a probe that reads FALSE on
// your pinned toolchain today and TRUE the day the fix lands.
//
// A gate diffs a moving target against a pin and reports a regression. A
// watch is that turned inside out: a control expected to fail, where the
// interesting event is the first green. Every entry names the upstream
// thread, what `landed` means in one sentence, and the reading on the day it
// was written, because a probe that reads true on its first run is watching
// nothing.
//
// Three rules, enforced by `checkWatch` and by the conformance suite:
//
//   1. it names a thread (an issue or PR URL) and a measured-false date
//   2. it probes the BEHAVIOUR the thread is about, never a version string:
//      bun ships fixes in canaries whose --version is the next release
//   3. it prints one JSON line, `{ landed, detail }`, and nothing else, so a
//      probe that crashes reads as `landed: null` (did not run) rather than
//      as either answer. `null` never moves a verdict.
//
// Scripts run under a runtime executable you name (`bun -e`, `node -e`), in
// a scratch directory the runner creates and removes, so a probe may write
// files there and nowhere else. `runWatch` takes the executable so the same
// list is read under the PIN and under the CANDIDATE; a row that differs is
// the finding, a row landed in both is the cue to retire it.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Watch = {
  /** kebab-case, stable: it is part of the issue signature */
  name: string;
  /** the upstream issue or PR this waits on */
  issue: string;
  /** what `landed: true` means, one sentence */
  landed: string;
  /** `YYYY-MM-DD, <runtime>: <reading>` on the pinned toolchain the day the watch was written */
  measured: string;
  /** which executable runs it: "bun" or "node", each with `-e` */
  runtime?: "bun" | "node";
  /** the probe; prints exactly one JSON line `{ landed, detail }` */
  script: string;
};

export type Reading = { landed: boolean | null; detail: string };
export type WatchResult = Pick<Watch, "name" | "issue" | "landed"> & { pinned: boolean | null; candidate: boolean | null; detail: string };

const THREAD = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+(\/(issues|pull)\/\d+)?$/;

export function checkWatch(w: Watch): string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9-]+$/.test(w.name)) problems.push(`name ${JSON.stringify(w.name)} must be kebab-case (it is part of a signature)`);
  if (!THREAD.test(w.issue)) problems.push(`issue ${JSON.stringify(w.issue)} must be a GitHub issue, PR, or repository URL`);
  if (!/^\d{4}-\d{2}-\d{2}, /.test(w.measured)) problems.push(`measured must start with the date it was read false, "YYYY-MM-DD, ..."`);
  if (!w.landed?.trim()) problems.push("landed must say what true means");
  if (!w.script?.trim()) problems.push("script is empty");
  if (w.runtime && w.runtime !== "bun" && w.runtime !== "node") problems.push(`runtime ${JSON.stringify(w.runtime)} is neither bun nor node`);
  return problems;
}

/** Runs one watch under an executable, in a scratch directory it removes. `landed: null` means the probe did not run. */
export function runWatch(exe: string, watch: Watch, timeoutMs = 60_000): Reading {
  const cwd = mkdtempSync(join(tmpdir(), "timbrado-watch-"));
  try {
    const run = spawnSync(exe, ["-e", watch.script], { cwd, encoding: "utf8", timeout: timeoutMs });
    const line = (run.stdout || "").trim().split("\n").filter(Boolean).pop() ?? "";
    try {
      const parsed = JSON.parse(line) as { landed?: boolean; detail?: string };
      if (parsed.landed !== true && parsed.landed !== false) throw new Error("no landed boolean");
      return { landed: parsed.landed, detail: parsed.detail ?? "" };
    } catch {
      const why = (run.stderr || run.stdout || "").trim().split("\n").filter(Boolean).pop() ?? `exit ${run.status}`;
      return { landed: null, detail: `did not run: ${why.slice(0, 120)}` };
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

export function watchRow(w: Pick<Watch, "name" | "issue" | "landed">, pinned: Reading, candidate: Reading): WatchResult {
  const detail = pinned.landed === candidate.landed ? candidate.detail : `pinned: ${pinned.detail}; candidate: ${candidate.detail}`;
  return { name: w.name, issue: w.issue, landed: w.landed, pinned: pinned.landed, candidate: candidate.landed, detail };
}

/** Moved means both readings are real and differ. `null` never moves anything. */
export const watchMoved = (w: Pick<WatchResult, "pinned" | "candidate">) => w.pinned !== null && w.candidate !== null && w.pinned !== w.candidate;
export const watchSignature = (w: WatchResult) => `watch:${w.name}:${w.pinned ? "t" : "f"}>${w.candidate ? "t" : "f"}`;

/** Loads a watch module (a `.ts`/`.js` file exporting `watches: Watch[]` or a default array) and checks every entry. */
export async function loadWatches(path: string): Promise<Watch[]> {
  const mod = (await import(path)) as { watches?: Watch[]; default?: Watch[] };
  const list = mod.watches ?? mod.default;
  if (!Array.isArray(list)) throw new Error(`${path} exports no \`watches\` array`);
  const seen = new Set<string>();
  for (const w of list) {
    const problems = checkWatch(w);
    if (seen.has(w.name)) problems.push("declared twice");
    seen.add(w.name);
    if (problems.length) throw new Error(`watch ${w.name}: ${problems.join("; ")}`);
  }
  return list;
}
