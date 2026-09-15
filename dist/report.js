import { spawnSync } from "node:child_process";
import { watchMoved } from "./watch.js";
export const title = (target) => `timbrado: ${target}`;
export const marker = (target, signature) => `<!-- timbrado:${target} signature:${signature} -->`;
export function plan(report, open) {
  if (report.verdict === "instrument")
    return { kind: "none" };
  if (report.verdict === "green")
    return open ? { kind: "close", number: open.number } : { kind: "none" };
  if (!open)
    return { kind: "create" };
  if (open.text.includes(marker(report.target, report.signature)))
    return { kind: "none" };
  return { kind: "comment", number: open.number };
}
export function verdictOf(gates, watches, reason) {
  const failing = gates.filter((g) => !g.ok);
  const hard = failing.filter((g) => g.hard !== false).map((g) => g.name);
  const soft = failing.filter((g) => g.hard === false).map((g) => g.name);
  const moved = watches.filter(watchMoved).map((w) => `watch:${w.name}:${w.pinned ? "t" : "f"}>${w.candidate ? "t" : "f"}`);
  if (hard.length)
    return { verdict: "red", signature: `red:${[...hard, ...soft, ...moved].join("|")}` };
  if (soft.length || moved.length)
    return { verdict: "changed", signature: `changed:${[...soft, ...moved].join("|")}` };
  return { verdict: "green", signature: reason ? `green:${reason}` : "green" };
}
const cell = (s) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
export function render(report, runUrl, reproduce) {
  const lines = [];
  lines.push(`**${report.verdict.toUpperCase()}** for ${report.target}.`, "");
  for (const [k, v] of Object.entries(report.subject))
    lines.push(`- **${k}**: \`${String(v)}\``);
  lines.push("");
  if (report.gates?.length) {
    lines.push("| gate | result | detail |", "|---|---|---|");
    for (const g of report.gates)
      lines.push(`| ${cell(g.name)} | ${g.ok ? "ok" : g.hard === false ? "DIFF" : "FAIL"} | ${cell(g.detail)} |`);
    for (const g of report.gates)
      for (const n of g.notes ?? [])
        lines.push(`    ${n}`);
    lines.push("");
  }
  if (report.watches?.length) {
    lines.push("| watch | pinned | candidate | reading |", "|---|---|---|---|");
    const mark = (v) => v === null ? "did not run" : v ? "landed" : "not yet";
    for (const w of report.watches) {
      const tag = watchMoved(w) ? " **MOVED**" : w.pinned && w.candidate ? " (in the pin too: retire this watch)" : "";
      lines.push(`| [\`${w.name}\`](${w.issue}) | ${mark(w.pinned)} | ${mark(w.candidate)}${tag} | ${cell(w.detail)} |`);
    }
    lines.push("");
    for (const w of report.watches)
      if (watchMoved(w))
        lines.push(`- \`${w.name}\` landed means: ${w.landed}`);
    if (report.watches.some(watchMoved))
      lines.push("");
  }
  for (const t of report.tables ?? []) {
    if (!t.rows.length)
      continue;
    if (t.caption)
      lines.push(t.caption, "");
    lines.push(`| ${t.columns.map(cell).join(" | ")} |`, `|${t.columns.map(() => "---").join("|")}|`);
    for (const r of t.rows)
      lines.push(`| ${r.map(cell).join(" | ")} |`);
    lines.push("");
  }
  if (report.reason)
    lines.push(`Reason: ${report.reason}`, "");
  lines.push(`${reproduce ? `Reproduce with \`${reproduce}\`. ` : ""}Filed by timbrado${runUrl ? ` from [this run](${runUrl})` : ""}; it proposes nothing.`, "", marker(report.target, report.signature));
  return lines.join(`
`);
}
const gh = (args) => {
  const out = spawnSync("gh", args, { encoding: "utf8" });
  if (out.status !== 0)
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(out.stderr || out.stdout || "").trim().split(`
`).slice(-2).join(" ")}`);
  return out.stdout;
};
export function findOpen(target, repo) {
  const want = title(target);
  const scope = repo ? ["--repo", repo] : [];
  const list = JSON.parse(gh(["issue", "list", ...scope, "--state", "open", "--search", `"${want}" in:title`, "--json", "number,title"]));
  const hit = list.find((i) => i.title === want);
  if (!hit)
    return null;
  const view = JSON.parse(gh(["issue", "view", String(hit.number), ...scope, "--json", "body,comments"]));
  return { number: hit.number, text: [view.body, ...view.comments.map((c) => c.body)].join(`
`) };
}
export function apply(action, report, body, repo, labels = []) {
  const scope = repo ? ["--repo", repo] : [];
  switch (action.kind) {
    case "none":
      return `nothing to file (${report.verdict})`;
    case "create": {
      const url = gh(["issue", "create", ...scope, "--title", title(report.target), "--body", body, ...labels.flatMap((l) => ["--label", l])]).trim();
      return `filed ${url}`;
    }
    case "comment":
      gh(["issue", "comment", String(action.number), ...scope, "--body", body]);
      return `commented on #${action.number} (new signature)`;
    case "close":
      gh(["issue", "close", String(action.number), ...scope, "--comment", `Green again.

${body}`]);
      return `closed #${action.number}`;
  }
}
