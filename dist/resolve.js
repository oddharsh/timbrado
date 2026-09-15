import { hostKey } from "./registry.js";
const ua = { "user-agent": "timbrado" };
async function npmDoc(pkg) {
  const res = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}`, { headers: { ...ua, accept: "application/json" } });
  if (!res.ok)
    throw new Error(`npm answered ${res.status} for ${pkg}`);
  return await res.json();
}
export async function ghJson(path) {
  const headers = { ...ua, accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN)
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/${path}`, { headers });
  if (!res.ok)
    throw new Error(`GitHub answered ${res.status} for ${path}`);
  return await res.json();
}
export async function resolve(name, t, host = hostKey()) {
  switch (t.kind) {
    case "npm-dist-tag": {
      const doc = await npmDoc(t.package);
      const version = doc["dist-tags"][t.tag];
      if (!version)
        throw new Error(`${t.package} has no dist-tag \`${t.tag}\` (has: ${Object.keys(doc["dist-tags"]).join(", ")})`);
      return {
        name,
        kind: t.kind,
        id: version,
        install: `${t.package}@${version}`,
        binary: null,
        immutable: true,
        publishedAt: doc.time?.[version] ?? null,
        commit: null,
        note: `npm dist-tag ${t.tag} -> ${version}`
      };
    }
    case "npm-dated-canary": {
      const doc = await npmDoc(t.package);
      const version = doc["dist-tags"][t.tag];
      if (!version)
        throw new Error(`${t.package} has no dist-tag \`${t.tag}\``);
      const platformPkg = t.binary.platforms[host];
      if (!platformPkg)
        throw new Error(`${name}: no platform package declared for ${host} (has ${Object.keys(t.binary.platforms).join(", ")})`);
      const dep = doc.versions[version]?.optionalDependencies?.[platformPkg] ?? "";
      const commit = /\+([0-9a-f]{7,40})$/.exec(dep)?.[1] ?? null;
      const bin = await npmDoc(platformPkg);
      const dist = bin.versions[version]?.dist;
      if (!dist?.tarball)
        throw new Error(`${platformPkg}@${version} is not on the registry`);
      return {
        name,
        kind: t.kind,
        id: commit ? `${version}+${commit}` : version,
        install: `${t.package}@${version}`,
        binary: { url: dist.tarball, integrity: dist.integrity ?? null, path: t.binary.path },
        immutable: true,
        publishedAt: doc.time?.[version] ?? null,
        commit,
        note: `npm dist-tag ${t.tag} -> ${version}${commit ? ` (build ${commit})` : ""}, binary ${platformPkg}`
      };
    }
    case "pkg-pr-new": {
      const url = `https://pkg.pr.new/${t.owner}/${t.repo}/${t.package}@${t.ref}`;
      const head = await fetch(url, { method: "HEAD", redirect: "follow", headers: ua });
      const key = head.headers.get("x-commit-key") ?? "";
      const full = key.split(":")[2] ?? "";
      if (!head.ok || !/^[0-9a-f]{40}$/.test(full))
        throw new Error(`pkg.pr.new answered ${head.status} for ${t.package}@${t.ref} with x-commit-key ${JSON.stringify(key)}`);
      const sha = full.slice(0, 7);
      const refIsSha = /^[0-9a-f]{7,40}$/.test(t.ref) && full.startsWith(t.ref);
      let publishedAt = null;
      try {
        publishedAt = (await ghJson(`repos/${t.owner}/${t.repo}/commits/${full}`)).commit.committer.date;
      } catch {}
      return {
        name,
        kind: t.kind,
        id: sha,
        install: `https://pkg.pr.new/${t.owner}/${t.repo}/${t.package}@${sha}`,
        binary: null,
        immutable: true,
        publishedAt,
        commit: full,
        note: refIsSha ? `pkg.pr.new ${t.package}@${sha}` : `pkg.pr.new ${t.package}@${t.ref} -> ${sha} (the ref floats; the install spec names the sha)`
      };
    }
    case "github-rolling-tag": {
      const rel = await ghJson(`repos/${t.owner}/${t.repo}/releases/tags/${t.tag}`);
      const wanted = t.asset?.[host];
      const asset = wanted ? rel.assets.find((a) => a.name === wanted) : null;
      if (wanted && !asset)
        throw new Error(`${name}: release ${t.tag} carries no asset ${wanted}`);
      return {
        name,
        kind: t.kind,
        id: `${t.tag}@${asset?.updated_at ?? "?"}`,
        install: null,
        binary: asset ? { url: asset.browser_download_url, integrity: null, path: "" } : null,
        immutable: false,
        publishedAt: asset?.updated_at ?? null,
        commit: null,
        note: `rolling tag ${t.tag}, asset updated ${asset?.updated_at ?? "?"}; not pinnable, instrument only`
      };
    }
  }
}
export const ageHours = (publishedAt, now = Date.now()) => publishedAt ? (now - Date.parse(publishedAt)) / 3600000 : null;
