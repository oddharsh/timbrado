// SURVEY: which of your dependencies have a head at all.
//
// The first honest output of this tool on any repository is a table, because
// most packages have no prerelease channel and the tool should say so rather
// than invent one. Three questions per package, all read-only:
//
//   1. does npm carry a dist-tag beyond `latest`? (`next`, `canary`, `beta`,
//      `nightly`, `rc`, `dev`, `experimental`, whatever the maintainer chose)
//   2. does the repository publish to pkg.pr.new? (HEAD of `<pkg>@main` on
//      the repository npm's `repository` field names)
//   3. does the repository carry a rolling release tag named `canary` or
//      `nightly`?
//
// A package with all three answers "no" has no head this tool can reach, and
// the row says so. That is the row worth reading: it is the dependency whose
// next release will be the first you hear of it.

import { ghJson } from "./resolve.ts";

export type Row = {
  name: string;
  pinned: string;
  latest: string | null;
  tags: Record<string, string>;
  repo: string | null;
  pkgPrNew: boolean | null;
  rollingTag: string | null;
  error?: string;
};

const ua = { "user-agent": "timbrado" };

function repoOf(doc: { repository?: string | { url?: string } }): string | null {
  const r = doc.repository;
  const url = typeof r === "string" ? r : r?.url ?? "";
  const m = /github\.com[/:]([^/]+)\/([^/#.]+?)(?:\.git)?(?:[/#].*)?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function surveyOne(name: string, pinned: string): Promise<Row> {
  const row: Row = { name, pinned, latest: null, tags: {}, repo: null, pkgPrNew: null, rollingTag: null };
  try {
    const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, { headers: { ...ua, accept: "application/json" } });
    if (!res.ok) throw new Error(`npm ${res.status}`);
    const doc = (await res.json()) as { "dist-tags": Record<string, string>; repository?: string | { url?: string } };
    row.latest = doc["dist-tags"].latest ?? null;
    for (const [tag, v] of Object.entries(doc["dist-tags"])) if (tag !== "latest") row.tags[tag] = v;
    row.repo = repoOf(doc);
    if (row.repo) {
      const [owner, repo] = row.repo.split("/");
      const head = await fetch(`https://pkg.pr.new/${owner}/${repo}/${name}@main`, { method: "HEAD", redirect: "follow", headers: ua });
      row.pkgPrNew = head.ok && /^[a-z]+:[^:]+:[0-9a-f]{40}$/.test(head.headers.get("x-commit-key") ?? "");
      for (const tag of ["canary", "nightly"]) {
        try {
          await ghJson(`repos/${owner}/${repo}/releases/tags/${tag}`);
          row.rollingTag = tag;
          break;
        } catch { /* no such tag */ }
      }
    }
  } catch (err) {
    row.error = err instanceof Error ? err.message : String(err);
  }
  return row;
}

/** Every dependency of a package.json, surveyed with bounded concurrency. */
export async function survey(pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }, concurrency = 6): Promise<Row[]> {
  const entries = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).sort(([a], [b]) => a.localeCompare(b));
  const rows: Row[] = new Array(entries.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (next < entries.length) {
      const i = next++;
      rows[i] = await surveyOne(entries[i][0], entries[i][1]);
    }
  }));
  return rows;
}

/**
 * A dist-tag is a HEAD only when it points past `latest`. Registries keep tags
 * forever, so `dev 3.9.4` on typescript and `rc 1.18.0` on playwright-core are
 * archaeology rather than channels, and `beta 1.63.0-beta` on a latest of
 * 1.63.0 is the prerelease of the release you already have. Measured on one
 * repository's 12 dependencies: 4 packages carry tags, 3 carry a live one.
 */
export function newerThanLatest(version: string, latest: string | null): boolean {
  if (!latest) return true;
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(v);
    return m ? { triple: [Number(m[1]), Number(m[2]), Number(m[3])], rest: m[4] } : null;
  };
  const a = parse(version);
  const b = parse(latest);
  if (!a || !b) return version !== latest;
  for (let i = 0; i < 3; i++) if (a.triple[i] !== b.triple[i]) return a.triple[i] > b.triple[i];
  // Same triple: a prerelease of the current release is not ahead of it.
  return false;
}

export const liveTags = (r: Row) => Object.fromEntries(Object.entries(r.tags).filter(([, v]) => newerThanLatest(v, r.latest)));
export const hasHead = (r: Row) => Object.keys(liveTags(r)).length > 0 || r.pkgPrNew === true || r.rollingTag !== null;

export function renderSurvey(rows: Row[]): string {
  const lines = ["| package | pinned | live dist-tags | pkg.pr.new | rolling tag |", "|---|---|---|---|---|"];
  for (const r of rows) {
    const live = liveTags(r);
    const stale = Object.keys(r.tags).length - Object.keys(live).length;
    const tags = (Object.entries(live).map(([t, v]) => `${t} ${v}`).join(", ") || "-") + (stale ? ` (${stale} stale)` : "");
    lines.push(`| ${r.name} | ${r.pinned} | ${tags} | ${r.pkgPrNew === null ? "?" : r.pkgPrNew ? "yes" : "no"} | ${r.rollingTag ?? "-"} |${r.error ? ` (${r.error})` : ""}`);
  }
  const with_ = rows.filter(hasHead).length;
  lines.push("", `${with_} of ${rows.length} have a head this tool can reach.`);
  return lines.join("\n");
}
