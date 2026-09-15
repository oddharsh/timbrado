const KINDS = new Set(["npm-dist-tag", "npm-dated-canary", "pkg-pr-new", "github-rolling-tag"]);
export function validateRegistry(raw) {
  if (!raw || typeof raw !== "object" || !("targets" in raw))
    throw new Error("registry needs a top-level `targets` object");
  const targets = raw.targets;
  if (!targets || typeof targets !== "object")
    throw new Error("`targets` must be an object keyed by name");
  const out = { targets: {} };
  for (const [name, entry] of Object.entries(targets)) {
    if (!entry || typeof entry !== "object")
      throw new Error(`target ${name}: not an object`);
    const t = entry;
    const kind = String(t.kind ?? "");
    if (!KINDS.has(kind))
      throw new Error(`target ${name}: unknown kind ${JSON.stringify(t.kind)}; known: ${[...KINDS].join(", ")}`);
    const need = (keys) => {
      for (const k of keys)
        if (typeof t[k] !== "string" || !t[k].length)
          throw new Error(`target ${name} (${kind}): missing \`${k}\``);
    };
    if (kind === "npm-dist-tag")
      need(["package", "tag"]);
    if (kind === "npm-dated-canary") {
      need(["package", "tag"]);
      const b = t.binary;
      if (!b || typeof b !== "object" || !b.platforms || typeof b.platforms !== "object" || typeof b.path !== "string") {
        throw new Error(`target ${name} (${kind}): \`binary\` needs { platforms: { "os-arch": "@scope/pkg" }, path }`);
      }
    }
    if (kind === "pkg-pr-new")
      need(["owner", "repo", "package", "ref"]);
    if (kind === "github-rolling-tag")
      need(["owner", "repo", "tag"]);
    if (t.source !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(String(t.source)))
      throw new Error(`target ${name}: \`source\` must be owner/name`);
    out.targets[name] = t;
  }
  return out;
}
export function sourceOf(t) {
  if (t.source)
    return t.source;
  if (t.kind === "pkg-pr-new" || t.kind === "github-rolling-tag")
    return `${t.owner}/${t.repo}`;
  return null;
}
export const hostKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;
