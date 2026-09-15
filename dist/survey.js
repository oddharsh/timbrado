import { ghJson } from "./resolve.js";
const ua = { "user-agent": "timbrado" };
function repoOf(doc) {
  const r = doc.repository;
  const url = typeof r === "string" ? r : r?.url ?? "";
  const m = /github\.com[/:]([^/]+)\/([^/#.]+?)(?:\.git)?(?:[/#].*)?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}
export async function surveyOne(name, pinned) {
  const row = { name, pinned, latest: null, tags: {}, repo: null, pkgPrNew: null, rollingTag: null };
  try {
    const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, { headers: { ...ua, accept: "application/json" } });
    if (!res.ok)
      throw new Error(`npm ${res.status}`);
    const doc = await res.json();
    row.latest = doc["dist-tags"].latest ?? null;
    for (const [tag, v] of Object.entries(doc["dist-tags"]))
      if (tag !== "latest")
        row.tags[tag] = v;
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
        } catch {}
      }
    }
  } catch (err) {
    row.error = err instanceof Error ? err.message : String(err);
  }
  return row;
}
export async function survey(pkg, concurrency = 6) {
  const entries = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).sort(([a], [b]) => a.localeCompare(b));
  const rows = new Array(entries.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (next < entries.length) {
      const i = next++;
      rows[i] = await surveyOne(entries[i][0], entries[i][1]);
    }
  }));
  return rows;
}
export function newerThanLatest(version, latest) {
  if (!latest)
    return true;
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(v);
    return m ? { triple: [Number(m[1]), Number(m[2]), Number(m[3])], rest: m[4] } : null;
  };
  const a = parse(version);
  const b = parse(latest);
  if (!a || !b)
    return version !== latest;
  for (let i = 0;i < 3; i++)
    if (a.triple[i] !== b.triple[i])
      return a.triple[i] > b.triple[i];
  return false;
}
export const liveTags = (r) => Object.fromEntries(Object.entries(r.tags).filter(([, v]) => newerThanLatest(v, r.latest)));
export const hasHead = (r) => Object.keys(liveTags(r)).length > 0 || r.pkgPrNew === true || r.rollingTag !== null;
export function renderSurvey(rows) {
  const lines = ["| package | pinned | live dist-tags | pkg.pr.new | rolling tag |", "|---|---|---|---|---|"];
  for (const r of rows) {
    const live = liveTags(r);
    const stale = Object.keys(r.tags).length - Object.keys(live).length;
    const tags = (Object.entries(live).map(([t, v]) => `${t} ${v}`).join(", ") || "-") + (stale ? ` (${stale} stale)` : "");
    lines.push(`| ${r.name} | ${r.pinned} | ${tags} | ${r.pkgPrNew === null ? "?" : r.pkgPrNew ? "yes" : "no"} | ${r.rollingTag ?? "-"} |${r.error ? ` (${r.error})` : ""}`);
  }
  const with_ = rows.filter(hasHead).length;
  lines.push("", `${with_} of ${rows.length} have a head this tool can reach.`);
  return lines.join(`
`);
}
