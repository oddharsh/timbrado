#!/usr/bin/env bun
// timbrado: run your own gates against the heads, nightlies, nexts and
// canaries of what you depend on; watch for the upstream fixes you are
// waiting on; read what a pin adopts before you move it. Proposes nothing.
//
//   timbrado survey [package.json]                      which dependencies have a head at all
//   timbrado resolve <target> [--registry timbrado.json] the exact candidate a target names today
//   timbrado fetch <target> --into <dir>                 download a runtime candidate's binary, integrity checked
//   timbrado try <target|spec> --gate "<cmd>" [--repo .] [--allow-floating] [--keep] [--json out]
//   timbrado digest --repo <owner/name> --from <sha> --to <sha> [--prefer wrangler,miniflare] [--out file]
//   timbrado watch --pinned <exe> --candidate <exe> [--watches ./timbrado.watches.ts] [--json out]
//   timbrado report --target <name> --json <report> [--exit <n>] [--repo owner/name] [--label x]
//
// Exit codes, everywhere: 0 green or nothing to do, 1 a finding (red or
// changed), 2 the instrument could not run.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { compare, renderDigest } from "./digest.ts";
import { tryCandidate } from "./isolate.ts";
import { type Registry, validateRegistry } from "./registry.ts";
import { type Action, type Report, apply, findOpen, plan, render, verdictOf } from "./report.ts";
import { ageHours, resolve } from "./resolve.ts";
import { renderSurvey, survey } from "./survey.ts";
import { type WatchResult, loadWatches, runWatch, watchRow } from "./watch.ts";

const USAGE = `timbrado: run your own gates against the heads, nightlies, nexts and
canaries of what you depend on; watch for the upstream fixes you are
waiting on; read what a pin adopts before you move it. Proposes nothing.

  timbrado survey [package.json]                      which dependencies have a head at all
  timbrado resolve <target> [--registry timbrado.json] the exact candidate a target names today
  timbrado fetch <target> --into <dir>                 download a runtime candidate's binary, integrity checked
  timbrado try <target|spec> --gate "<cmd>" [--repo .] [--allow-floating] [--keep] [--json out]
  timbrado digest --repo <owner/name> --from <sha> --to <sha> [--prefer wrangler,miniflare] [--out file]
  timbrado watch --pinned <exe> --candidate <exe> [--watches ./timbrado.watches.ts] [--json out]
  timbrado report --target <name> --json <report> [--exit <n>] [--repo owner/name] [--label x]

Exit codes: 0 green or nothing to do, 1 a finding, 2 the instrument could not run.`;

const argv = process.argv.slice(2);
const cmd = argv[0];
const has = (name: string) => argv.includes(name);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? null;
};
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));

function loadRegistry(): Registry {
  const path = flag("--registry") ?? "timbrado.json";
  if (!existsSync(path)) throw new Error(`no registry at ${path}; pass --registry or create timbrado.json`);
  return validateRegistry(JSON.parse(readFileSync(path, "utf8")));
}

async function main(): Promise<number> {
  switch (cmd) {
    case "survey": {
      const path = positional[0] ?? "package.json";
      const rows = await survey(JSON.parse(readFileSync(path, "utf8")));
      if (flag("--json")) writeFileSync(flag("--json")!, JSON.stringify(rows, null, 2) + "\n");
      console.log(renderSurvey(rows));
      return 0;
    }
    case "resolve": {
      const reg = loadRegistry();
      const names = positional.length ? positional : Object.keys(reg.targets);
      let code = 0;
      for (const name of names) {
        const t = reg.targets[name];
        if (!t) { console.error(`no target ${name} in the registry`); code = 2; continue; }
        try {
          const c = await resolve(name, t);
          const age = ageHours(c.publishedAt);
          console.log(`${name.padEnd(16)} ${c.id.padEnd(40)} ${c.immutable ? "pinnable" : "FLOATING"}${age !== null ? `  ${age.toFixed(0)}h old` : ""}${t.pinned ? (t.pinned === c.id ? "  = pin" : `  pin ${t.pinned}`) : ""}`);
          console.log(`${"".padEnd(16)} ${c.note}${c.install ? `\n${"".padEnd(16)} install: ${c.install}` : ""}${c.binary ? `\n${"".padEnd(16)} binary:  ${c.binary.url}` : ""}`);
          if (has("--json")) console.log(JSON.stringify(c));
        } catch (err) {
          console.error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
          code = 2;
        }
      }
      return code;
    }
    case "fetch": {
      const reg = loadRegistry();
      const name = positional[0];
      const into = flag("--into");
      if (!name || !into) throw new Error("usage: timbrado fetch <target> --into <dir>");
      const c = await resolve(name, reg.targets[name]);
      if (!c.binary) throw new Error(`${name} resolves to no binary (kind ${c.kind})`);
      const res = await fetch(c.binary.url);
      if (!res.ok) throw new Error(`download answered ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (c.binary.integrity) {
        const got = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
        if (got !== c.binary.integrity) throw new Error(`integrity mismatch: registry says ${c.binary.integrity}, downloaded ${got}`);
      }
      mkdirSync(into, { recursive: true });
      const file = join(into, c.binary.url.split("/").pop() ?? "candidate");
      writeFileSync(file, bytes);
      console.log(`${file}  (${bytes.length} B${c.binary.integrity ? ", sha512 verified" : ", no integrity on record"})${c.binary.path ? `; the executable is ${c.binary.path} inside it` : ""}`);
      return 0;
    }
    case "try": {
      const what = positional[0];
      const gate = flag("--gate");
      if (!what || !gate) throw new Error('usage: timbrado try <target|spec> --gate "<cmd>"');
      const root = resolvePath(flag("--repo") ?? ".");
      let spec = what;
      let subject: Record<string, unknown> = { spec: what };
      if (existsSync(flag("--registry") ?? "timbrado.json")) {
        const reg = loadRegistry();
        if (reg.targets[what]) {
          const c = await resolve(what, reg.targets[what]);
          if (!c.install) throw new Error(`${what} resolves to nothing installable (kind ${c.kind})`);
          spec = c.install;
          subject = { target: what, candidate: c.id, install: spec, published: c.publishedAt ?? "?" };
        }
      }
      const started = Date.now();
      const r = tryCandidate({ root, spec, gate, allowFloating: has("--allow-floating"), keep: has("--keep") });
      for (const g of r.gates) {
        console.log(`${g.ok ? "  ok  " : " FAIL "} ${g.name} — ${g.detail}`);
        for (const n of g.notes ?? []) console.log(`       ${n}`);
      }
      const v = verdictOf(r.gates, []);
      const report: Report = { target: String(subject.target ?? what), ...v, subject, gates: r.gates, ms: Date.now() - started };
      if (flag("--json")) writeFileSync(flag("--json")!, JSON.stringify(report, null, 2) + "\n");
      if (r.worktree) console.log(`kept ${r.worktree}`);
      return r.ok ? 0 : 1;
    }
    case "digest": {
      const repo = flag("--repo"); const from = flag("--from"); const to = flag("--to");
      if (!repo || !from || !to) throw new Error("usage: timbrado digest --repo <owner/name> --from <sha> --to <sha>");
      let text: string;
      try {
        text = renderDigest(repo, from, to, await compare(repo, from, to), (flag("--prefer") ?? "").split(",").filter(Boolean));
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        if (process.env.GITHUB_ACTIONS) console.error(`::warning title=digest unavailable::${why}`);
        text = `_Upstream digest unavailable: ${why}. Compare by hand: https://github.com/${repo}/compare/${from}...${to}_\n`;
      }
      if (flag("--out")) writeFileSync(flag("--out")!, text); else process.stdout.write(text);
      return 0;
    }
    case "watch": {
      const pinned = flag("--pinned"); const candidate = flag("--candidate");
      if (!pinned || !candidate) throw new Error("usage: timbrado watch --pinned <exe> --candidate <exe> [--watches file]");
      const list = await loadWatches(pathToFileURL(resolvePath(flag("--watches") ?? "timbrado.watches.ts")).href);
      const rows: WatchResult[] = [];
      const mark = (v: boolean | null) => (v === null ? "?" : v ? "landed" : "not yet");
      for (const w of list) {
        const row = watchRow(w, runWatch(pinned, w), runWatch(candidate, w));
        rows.push(row);
        const note = row.pinned !== row.candidate && row.pinned !== null && row.candidate !== null ? "  <-- moved" : row.pinned && row.candidate ? "  (in the pin too: retire this watch)" : "";
        console.log(`  ${row.name.padEnd(46)} ${mark(row.pinned).padEnd(8)} -> ${mark(row.candidate).padEnd(8)}${note}`);
        if (row.pinned === null || row.candidate === null || note.includes("moved")) console.log(`       ${row.detail}`);
      }
      const v = verdictOf([], rows);
      const report: Report = { target: flag("--target") ?? "watches", ...v, subject: { pinned, candidate }, watches: rows };
      if (flag("--json")) writeFileSync(flag("--json")!, JSON.stringify(report, null, 2) + "\n");
      return v.verdict === "green" ? 0 : 1;
    }
    case "report": {
      const target = flag("--target"); const jsonPath = flag("--json");
      if (!target || !jsonPath) throw new Error("usage: timbrado report --target <name> --json <report> [--exit <n>]");
      const exit = Number(flag("--exit") ?? "0");
      let report: Report;
      try { report = JSON.parse(readFileSync(jsonPath, "utf8")); } catch { console.error(`::error title=${target} wrote no report::exit ${exit}`); return 2; }
      if (report.verdict === "instrument" || (exit !== 0 && exit !== 1)) { console.error(`::error title=${target} could not run::${report.reason ?? `exit ${exit}`}`); return 2; }
      const repo = flag("--repo") ?? undefined;
      const open = findOpen(target, repo);
      const action: Action = plan({ ...report, target }, open);
      const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
      console.log(apply(action, { ...report, target }, render({ ...report, target }, runUrl, flag("--reproduce") ?? undefined), repo, argv.filter((_, i) => argv[i - 1] === "--label")));
      return 0;
    }
    default:
      console.error(USAGE);
      return cmd ? 2 : 0;
  }
}

try {
  process.exit(await main());
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
