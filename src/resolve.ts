// Resolve a registry target to ONE candidate: exact, addressable, and honest
// about whether it can be pinned.
//
// Every kind lands on the same shape. `install` is what a package manager
// would be told, when there is such a thing; `binary` is a downloadable
// executable with the integrity the registry recorded, when the target is a
// runtime rather than a library. `immutable` is the pinnability verdict, and
// `publishedAt` is the age, which matters because a project's install policy
// (bun's minimumReleaseAge, pnpm's, Renovate's minimumReleaseAge) can refuse
// a head that resolved perfectly well.
//
// Network: the npm registry and api.github.com and pkg.pr.new, read-only.
// GITHUB_TOKEN raises the per-IP limit when set and is never required.

import { type Channel, type Target, hostKey } from "./registry.ts";

export type Candidate = {
  name: string;
  kind: Channel["kind"];
  /** the exact version (npm) or sha (pkg.pr.new, github) */
  id: string;
  /** what `bun add` / `npm i` would be given, when the candidate is installable */
  install: string | null;
  /** a downloadable executable for this host, when the target is a runtime */
  binary: { url: string; integrity: string | null; path: string } | null;
  immutable: boolean;
  publishedAt: string | null;
  /** the upstream commit, when the channel records one (bun's `+sha` build metadata; pkg.pr.new's x-commit-key) */
  commit: string | null;
  note: string;
};

const ua = { "user-agent": "timbrado" };

async function npmDoc(pkg: string) {
  const res = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}`, { headers: { ...ua, accept: "application/json" } });
  if (!res.ok) throw new Error(`npm answered ${res.status} for ${pkg}`);
  return (await res.json()) as {
    "dist-tags": Record<string, string>;
    time?: Record<string, string>;
    versions: Record<string, { dist?: { tarball?: string; integrity?: string }; optionalDependencies?: Record<string, string> }>;
  };
}

export async function ghJson<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { ...ua, accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path}`);
  return (await res.json()) as T;
}

export async function resolve(name: string, t: Target, host = hostKey()): Promise<Candidate> {
  switch (t.kind) {
    case "npm-dist-tag": {
      const doc = await npmDoc(t.package);
      const version = doc["dist-tags"][t.tag];
      if (!version) throw new Error(`${t.package} has no dist-tag \`${t.tag}\` (has: ${Object.keys(doc["dist-tags"]).join(", ")})`);
      return {
        name, kind: t.kind, id: version, install: `${t.package}@${version}`, binary: null, immutable: true,
        publishedAt: doc.time?.[version] ?? null, commit: null,
        note: `npm dist-tag ${t.tag} -> ${version}`,
      };
    }
    case "npm-dated-canary": {
      const doc = await npmDoc(t.package);
      const version = doc["dist-tags"][t.tag];
      if (!version) throw new Error(`${t.package} has no dist-tag \`${t.tag}\``);
      const platformPkg = t.binary.platforms[host];
      if (!platformPkg) throw new Error(`${name}: no platform package declared for ${host} (has ${Object.keys(t.binary.platforms).join(", ")})`);
      // The build sha rides as `+sha` on the platform dependency's version,
      // which is how a canary binary that reports the NEXT release's number to
      // --version can still prove it is this build (bun: --revision).
      const dep = doc.versions[version]?.optionalDependencies?.[platformPkg] ?? "";
      const commit = /\+([0-9a-f]{7,40})$/.exec(dep)?.[1] ?? null;
      const bin = await npmDoc(platformPkg);
      const dist = bin.versions[version]?.dist;
      if (!dist?.tarball) throw new Error(`${platformPkg}@${version} is not on the registry`);
      return {
        name, kind: t.kind, id: commit ? `${version}+${commit}` : version, install: `${t.package}@${version}`,
        binary: { url: dist.tarball, integrity: dist.integrity ?? null, path: t.binary.path },
        immutable: true, publishedAt: doc.time?.[version] ?? null, commit,
        note: `npm dist-tag ${t.tag} -> ${version}${commit ? ` (build ${commit})` : ""}, binary ${platformPkg}`,
      };
    }
    case "pkg-pr-new": {
      // pkg.pr.new builds every commit and PR of a repository that opted in.
      // `x-commit-key` on the tarball is the full sha it was built from, so a
      // branch name resolves to a commit without trusting the branch.
      const url = `https://pkg.pr.new/${t.owner}/${t.repo}/${t.package}@${t.ref}`;
      const head = await fetch(url, { method: "HEAD", redirect: "follow", headers: ua });
      const key = head.headers.get("x-commit-key") ?? "";
      const full = key.split(":")[2] ?? "";
      if (!head.ok || !/^[0-9a-f]{40}$/.test(full)) throw new Error(`pkg.pr.new answered ${head.status} for ${t.package}@${t.ref} with x-commit-key ${JSON.stringify(key)}`);
      const sha = full.slice(0, 7);
      const refIsSha = /^[0-9a-f]{7,40}$/.test(t.ref) && full.startsWith(t.ref);
      let publishedAt: string | null = null;
      try { publishedAt = (await ghJson<{ commit: { committer: { date: string } } }>(`repos/${t.owner}/${t.repo}/commits/${full}`)).commit.committer.date; } catch { /* the date is a nicety */ }
      return {
        name, kind: t.kind, id: sha,
        // Always the sha form: `@main` floats and breaks a frozen lockfile the next day.
        install: `https://pkg.pr.new/${t.owner}/${t.repo}/${t.package}@${sha}`,
        binary: null, immutable: true, publishedAt, commit: full,
        note: refIsSha ? `pkg.pr.new ${t.package}@${sha}` : `pkg.pr.new ${t.package}@${t.ref} -> ${sha} (the ref floats; the install spec names the sha)`,
      };
    }
    case "github-rolling-tag": {
      // A rolling tag's release object is ancient and its `published_at` never
      // moves; the asset's `updated_at` is the honest timestamp. Nothing here
      // is pinnable: the same URL serves different bytes tomorrow.
      const rel = await ghJson<{ assets: { name: string; browser_download_url: string; updated_at: string }[] }>(`repos/${t.owner}/${t.repo}/releases/tags/${t.tag}`);
      const wanted = t.asset?.[host];
      const asset = wanted ? rel.assets.find((a) => a.name === wanted) : null;
      if (wanted && !asset) throw new Error(`${name}: release ${t.tag} carries no asset ${wanted}`);
      return {
        name, kind: t.kind, id: `${t.tag}@${asset?.updated_at ?? "?"}`, install: null,
        binary: asset ? { url: asset.browser_download_url, integrity: null, path: "" } : null,
        immutable: false, publishedAt: asset?.updated_at ?? null, commit: null,
        note: `rolling tag ${t.tag}, asset updated ${asset?.updated_at ?? "?"}; not pinnable, instrument only`,
      };
    }
  }
}

/** Age in hours, for the install-policy warning. */
export const ageHours = (publishedAt: string | null, now = Date.now()) =>
  publishedAt ? (now - Date.parse(publishedAt)) / 3_600_000 : null;
