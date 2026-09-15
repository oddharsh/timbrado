import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const THREAD = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+(\/(issues|pull)\/\d+)?$/;
export function checkWatch(w) {
  const problems = [];
  if (!/^[a-z0-9-]+$/.test(w.name))
    problems.push(`name ${JSON.stringify(w.name)} must be kebab-case (it is part of a signature)`);
  if (!THREAD.test(w.issue))
    problems.push(`issue ${JSON.stringify(w.issue)} must be a GitHub issue, PR, or repository URL`);
  if (!/^\d{4}-\d{2}-\d{2}, /.test(w.measured))
    problems.push(`measured must start with the date it was read false, "YYYY-MM-DD, ..."`);
  if (!w.landed?.trim())
    problems.push("landed must say what true means");
  if (!w.script?.trim())
    problems.push("script is empty");
  if (w.runtime && w.runtime !== "bun" && w.runtime !== "node")
    problems.push(`runtime ${JSON.stringify(w.runtime)} is neither bun nor node`);
  return problems;
}
export function runWatch(exe, watch, timeoutMs = 60000) {
  const cwd = mkdtempSync(join(tmpdir(), "timbrado-watch-"));
  try {
    const run = spawnSync(exe, ["-e", watch.script], { cwd, encoding: "utf8", timeout: timeoutMs });
    const line = (run.stdout || "").trim().split(`
`).filter(Boolean).pop() ?? "";
    try {
      const parsed = JSON.parse(line);
      if (parsed.landed !== true && parsed.landed !== false)
        throw new Error("no landed boolean");
      return { landed: parsed.landed, detail: parsed.detail ?? "" };
    } catch {
      const why = (run.stderr || run.stdout || "").trim().split(`
`).filter(Boolean).pop() ?? `exit ${run.status}`;
      return { landed: null, detail: `did not run: ${why.slice(0, 120)}` };
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
export function watchRow(w, pinned, candidate) {
  const detail = pinned.landed === candidate.landed ? candidate.detail : `pinned: ${pinned.detail}; candidate: ${candidate.detail}`;
  return { name: w.name, issue: w.issue, landed: w.landed, pinned: pinned.landed, candidate: candidate.landed, detail };
}
export const watchMoved = (w) => w.pinned !== null && w.candidate !== null && w.pinned !== w.candidate;
export const watchSignature = (w) => `watch:${w.name}:${w.pinned ? "t" : "f"}>${w.candidate ? "t" : "f"}`;
export async function loadWatches(path) {
  const mod = await import(path);
  const list = mod.watches ?? mod.default;
  if (!Array.isArray(list))
    throw new Error(`${path} exports no \`watches\` array`);
  const seen = new Set;
  for (const w of list) {
    const problems = checkWatch(w);
    if (seen.has(w.name))
      problems.push("declared twice");
    seen.add(w.name);
    if (problems.length)
      throw new Error(`watch ${w.name}: ${problems.join("; ")}`);
  }
  return list;
}
