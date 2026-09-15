// DIGEST: what a pin ADOPTS when it moves, as Markdown for a PR body.
//
// The upstream commits between two shas, and for a repository that ships
// changesets, the release notes those commits carry before any release has
// been cut. cloudflare/workers-sdk commits `.changeset/<name>.md` beside each
// user-facing change, naming the package and the bump level, so between two
// commits of main those files are exactly the unreleased changelog. The
// compare API returns an added file's whole content in its patch, so this
// costs one request. A repository without changesets gets its commit
// subjects, with the bot share counted, because on bun's main most of them
// are robobun's and a reader wants to know that before reading 70 lines.
//
// Advisory by construction: the caller decides what to do when GitHub will
// not answer; `renderDigest` is pure and never touches the network.

import { ghJson } from "./resolve.ts";

type Commit = { sha: string; commit: { message: string; author?: { name?: string } }; author?: { login?: string } | null };
type File = { filename: string; status: string; patch?: string };
export type Compare = { total_commits: number; commits: Commit[]; files?: File[]; html_url?: string };

export const MAX_SUBJECTS = 40;

export function changesets(files: File[] | undefined) {
  const out: { file: string; packages: { name: string; bump: string }[]; note: string }[] = [];
  for (const f of files ?? []) {
    if (!/^\.changeset\/[^/]+\.md$/.test(f.filename) || f.status !== "added" || !f.patch) continue;
    const body = f.patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
    const fences = body.map((l, i) => (l.trim() === "---" ? i : -1)).filter((i) => i >= 0);
    if (fences.length < 2) continue;
    const front = body.slice(fences[0] + 1, fences[1]);
    const packages = front
      .map((l) => /^"?([^":]+)"?\s*:\s*(\w+)\s*$/.exec(l.trim()))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ name: m[1], bump: m[2] }));
    const note = body.slice(fences[1] + 1).join("\n").trim();
    if (packages.length) out.push({ file: f.filename, packages, note });
  }
  return out;
}

/** `prefer` lists the packages the reader installs, so their changesets sort first. */
export function renderDigest(repo: string, from: string, to: string, cmp: Compare, prefer: string[] = []): string {
  const lines: string[] = [];
  const total = cmp.total_commits ?? cmp.commits.length;
  const url = cmp.html_url ?? `https://github.com/${repo}/compare/${from}...${to}`;
  lines.push(`**What \`${to}\` carries that \`${from}\` did not** ([${total} commit${total === 1 ? "" : "s"}](${url}))`, "");

  const sets = changesets(cmp.files);
  const major = sets.filter((s) => s.packages.some((p) => p.bump === "major"));
  if (major.length) lines.push(`**${major.length === 1 ? "1 changeset declares" : `${major.length} changesets declare`} a MAJOR bump.** Read ${major.length === 1 ? "it" : "those"} first.`, "");
  if (sets.length) {
    lines.push(`${sets.length} changeset${sets.length === 1 ? "" : "s"}, which is the unreleased changelog:`, "");
    const rank = (s: (typeof sets)[number]) => {
      const i = prefer.findIndex((p) => s.packages.some((x) => x.name === p));
      return i === -1 ? prefer.length : i;
    };
    for (const s of [...sets].sort((a, b) => rank(a) - rank(b))) {
      const who = s.packages.map((p) => `**${p.name}** ${p.bump}`).join(", ");
      const first = s.note.split("\n").find((l) => l.trim()) ?? "(no note)";
      lines.push(`- ${who}: ${first.trim()}`);
    }
    lines.push("");
  } else if (cmp.files?.some((f) => f.filename.startsWith(".changeset/"))) {
    lines.push("No changeset was added between the two, so nothing in this range is a user-facing change by the upstream's own accounting.", "");
  }

  const subjects = cmp.commits.map((c) => ({ subject: c.commit.message.split("\n")[0].trim(), who: c.author?.login ?? c.commit.author?.name ?? "?" }));
  const bots = subjects.filter((s) => /\[bot\]$|^robobun$|^dependabot|^renovate/.test(s.who)).length;
  if (subjects.length) {
    const shown = subjects.slice(0, MAX_SUBJECTS);
    lines.push(`<details><summary>${subjects.length} commit subject${subjects.length === 1 ? "" : "s"}${bots ? `, ${bots} by bots` : ""}${total > cmp.commits.length ? ` (the API returned ${cmp.commits.length} of ${total})` : ""}</summary>`, "");
    for (const s of shown) lines.push(`- ${s.subject.replace(/[<>]/g, "")} (${s.who})`);
    if (subjects.length > shown.length) lines.push(`- and ${subjects.length - shown.length} more`);
    lines.push("", "</details>", "");
  }
  return lines.join("\n");
}

export async function compare(repo: string, from: string, to: string): Promise<Compare> {
  return ghJson<Compare>(`repos/${repo}/compare/${from}...${to}?per_page=250`);
}
