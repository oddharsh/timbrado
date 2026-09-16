// REPORT: at most one open issue per target, kept quiet.
//
//   red or changed, no open issue      create it, with the tables and a signature
//   red or changed, issue already open comment ONLY if the signature is new
//   green, issue open                  comment "green again" and close it
//   green, nothing open                nothing
//   instrument                         no issue; the caller reds its own job
//
// The signature is WHAT failed or moved (gate names, watch names with their
// direction), never which build did it, so a fresh head carrying yesterday's
// broken gate adds nothing and a second gate failing adds one comment. An
// instrument failure files nothing on purpose: "the runner had no unzip" is
// not a finding about the upstream, and an issue saying so trains the reader
// to close these unread.
//
// `plan()` is the decision and is pure. The gh calls are the only side effects.

import { spawnSync } from "node:child_process";
import type { Gate } from "./isolate.ts";
import { type WatchResult, watchMoved } from "./watch.ts";
import type { ExperimentResult, OpportunityFinding } from "./native.ts";

export type Verdict = "green" | "changed" | "red" | "instrument";
export type Report = {
  target: string;
  verdict: Verdict;
  subject: Record<string, unknown>;
  signature: string;
  gates?: (Gate & { hard?: boolean })[];
  watches?: WatchResult[];
  /** any other structured finding a leg wants in the issue: a caption, columns, rows. Cells are escaped for the table. */
  tables?: { caption?: string; columns: string[]; rows: string[][] }[];
  reason?: string;
  ms?: number;
  schemaVersion?: 1;
  experiment?: ExperimentResult;
  opportunities?: OpportunityFinding[];
};
export type Open = { number: number; text: string } | null;
export type Action = { kind: "none" } | { kind: "create" } | { kind: "comment"; number: number } | { kind: "close"; number: number };

export const title = (target: string) => `timbrado: ${target}`;
export const marker = (target: string, signature: string) => `<!-- timbrado:${target} signature:${signature} -->`;

export function plan(report: Pick<Report, "target" | "verdict" | "signature">, open: Open): Action {
  if (report.verdict === "instrument") return { kind: "none" };
  if (report.verdict === "green") return open ? { kind: "close", number: open.number } : { kind: "none" };
  if (!open) return { kind: "create" };
  if (open.text.includes(marker(report.target, report.signature))) return { kind: "none" };
  return { kind: "comment", number: open.number };
}

/** A verdict and signature from gates and watches, the way every leg computes them. */
export function verdictOf(gates: (Gate & { hard?: boolean })[], watches: WatchResult[], reason?: string): { verdict: Verdict; signature: string } {
  if (watches.some((w) => w.pinned === null || w.candidate === null)) return { verdict: "instrument", signature: "instrument" };
  const failing = gates.filter((g) => !g.ok);
  const hard = failing.filter((g) => g.hard !== false).map((g) => g.name);
  const soft = failing.filter((g) => g.hard === false).map((g) => g.name);
  const moved = watches.filter(watchMoved).map((w) => `watch:${w.name}:${w.pinned ? "t" : "f"}>${w.candidate ? "t" : "f"}`);
  if (hard.length) return { verdict: "red", signature: `red:${[...hard, ...soft, ...moved].join("|")}` };
  if (soft.length || moved.length) return { verdict: "changed", signature: `changed:${[...soft, ...moved].join("|")}` };
  return { verdict: "green", signature: reason ? `green:${reason}` : "green" };
}

const cell = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

export function render(report: Report, runUrl?: string, reproduce?: string): string {
  const lines: string[] = [];
  lines.push(`**${report.verdict.toUpperCase()}** for ${report.target}.`, "");
  for (const [k, v] of Object.entries(report.subject)) lines.push(`- **${k}**: \`${String(v)}\``);
  lines.push("");
  if (report.gates?.length) {
    lines.push("| gate | result | detail |", "|---|---|---|");
    for (const g of report.gates) lines.push(`| ${cell(g.name)} | ${g.ok ? "ok" : g.hard === false ? "DIFF" : "FAIL"} | ${cell(g.detail)} |`);
    for (const g of report.gates) for (const n of g.notes ?? []) lines.push(`    ${n}`);
    lines.push("");
  }
  if (report.watches?.length) {
    lines.push("| watch | pinned | candidate | reading |", "|---|---|---|---|");
    const mark = (v: boolean | null) => (v === null ? "did not run" : v ? "landed" : "not yet");
    for (const w of report.watches) {
      const tag = watchMoved(w) ? " **MOVED**" : w.pinned && w.candidate ? " (in the pin too: retire this watch)" : "";
      lines.push(`| [\`${w.name}\`](${w.issue}) | ${mark(w.pinned)} | ${mark(w.candidate)}${tag} | ${cell(w.detail)} |`);
    }
    lines.push("");
    for (const w of report.watches) if (watchMoved(w)) lines.push(`- \`${w.name}\` landed means: ${w.landed}`);
    if (report.watches.some(watchMoved)) lines.push("");
  }
  if (report.experiment) {
    lines.push(`Experiment: **${report.experiment.outcome}**. Baseline and candidate were measured independently.`, "");
  }
  for (const finding of report.opportunities ?? []) {
    lines.push(`**${cell(finding.name)}: ${cell(finding.status)}**`, "",
      `Intention: ${cell(finding.intention)}`, "",
      `Affected paths: ${finding.affected.map((p) => `\`${cell(p)}\``).join(", ")}`, "",
      `Probe establishes: ${cell(finding.verification)}`, "",
      "| subject | result | detail |", "|---|---|---|");
    for (const side of [finding.experiment.baseline, finding.experiment.candidate]) {
      const m = side.measurement;
      lines.push(`| ${cell(side.id)} | ${m.value === null ? "did not run" : String(m.value)} | ${cell(m.detail)} |`);
    }
    lines.push("", `Adoption condition: ${cell(finding.adoption)}`, "", `Next step: ${cell(finding.nextStep)}`, "",
      `Sources: ${finding.sources.map((s) => `<${s}>`).join(", ")}`, "");
  }
  for (const t of report.tables ?? []) {
    if (!t.rows.length) continue;
    if (t.caption) lines.push(t.caption, "");
    lines.push(`| ${t.columns.map(cell).join(" | ")} |`, `|${t.columns.map(() => "---").join("|")}|`);
    for (const r of t.rows) lines.push(`| ${r.map(cell).join(" | ")} |`);
    lines.push("");
  }
  if (report.reason) lines.push(`Reason: ${report.reason}`, "");
  lines.push(`${reproduce ? `Reproduce with \`${reproduce}\`. ` : ""}Filed by timbrado${runUrl ? ` from [this run](${runUrl})` : ""}; it proposes nothing.`, "", marker(report.target, report.signature));
  return lines.join("\n");
}

const gh = (args: string[]) => {
  const out = spawnSync("gh", args, { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(out.stderr || out.stdout || "").trim().split("\n").slice(-2).join(" ")}`);
  return out.stdout;
};

export function findOpen(target: string, repo?: string): Open {
  const want = title(target);
  const scope = repo ? ["--repo", repo] : [];
  const list = JSON.parse(gh(["issue", "list", ...scope, "--state", "open", "--search", `"${want}" in:title`, "--json", "number,title"])) as { number: number; title: string }[];
  const hit = list.find((i) => i.title === want);
  if (!hit) return null;
  const view = JSON.parse(gh(["issue", "view", String(hit.number), ...scope, "--json", "body,comments"])) as { body: string; comments: { body: string }[] };
  return { number: hit.number, text: [view.body, ...view.comments.map((c) => c.body)].join("\n") };
}

export function apply(action: Action, report: Report, body: string, repo?: string, labels: string[] = []): string {
  const scope = repo ? ["--repo", repo] : [];
  switch (action.kind) {
    case "none": return `nothing to file (${report.verdict})`;
    case "create": {
      const url = gh(["issue", "create", ...scope, "--title", title(report.target), "--body", body, ...labels.flatMap((l) => ["--label", l])]).trim();
      return `filed ${url}`;
    }
    case "comment": gh(["issue", "comment", String(action.number), ...scope, "--body", body]); return `commented on #${action.number} (new signature)`;
    case "close": gh(["issue", "close", String(action.number), ...scope, "--comment", `Green again.\n\n${body}`]); return `closed #${action.number}`;
  }
}
