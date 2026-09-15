// The registry: HOW to find the head of each thing you depend on.
//
// This is the whole reason a generic tool is hard, and the reason it is worth
// having: there is no one channel. Measured on one repository's 40-odd
// dependencies (2026-09-14), bun publishes every canary to npm under a dated,
// immutable version with the binary in a platform package; cloudflare's
// workers-sdk publishes every commit and PR to pkg.pr.new; TypeScript and
// playwright-core keep an npm `next` tag; node has nightlies on its own
// server; oxc, lightningcss, minify-html, readability and linkedom have no
// prerelease channel at all. Each of those is a different resolver, and the
// recipe for a package rots when the upstream changes how it publishes.
//
// So the registry is data, and each entry names its KIND. A kind is a
// resolver in resolve.ts; the entry carries only what that resolver needs.
// Two things every kind answers the same way: whether the candidate it
// resolves to is IMMUTABLE (a dated npm version or a tarball named by a sha
// is; a rolling tag or a branch name is not), and when it was published.
// Immutability decides what may be pinned: a floating ref breaks a frozen
// lockfile the next morning, so `try` will test it and `pin` will refuse it.

export type Platforms = Record<string, string>; // "darwin-arm64" -> "@oven/bun-darwin-aarch64"

export type Channel =
  | { kind: "npm-dist-tag"; package: string; tag: string }
  | {
      kind: "npm-dated-canary";
      package: string;
      tag: string;
      /** the platform packages carrying the binary, keyed `${os}-${arch}`, plus the path of the executable inside the tarball */
      binary: { platforms: Platforms; path: string };
    }
  | { kind: "pkg-pr-new"; owner: string; repo: string; package: string; ref: string }
  | { kind: "github-rolling-tag"; owner: string; repo: string; tag: string; asset?: Platforms };

export type Target = Channel & {
  /** the upstream repository, `owner/name`, for the digest; inferred for the github kinds */
  source?: string;
  /** the current pin as this project records it, for the digest range and the retire-me check */
  pinned?: string;
};

export type Registry = { targets: Record<string, Target> };

const KINDS = new Set(["npm-dist-tag", "npm-dated-canary", "pkg-pr-new", "github-rolling-tag"]);

/** Reads and checks a registry object. Throws with the entry named, because a registry that half-loads is worse than one that refuses. */
export function validateRegistry(raw: unknown): Registry {
  if (!raw || typeof raw !== "object" || !("targets" in raw)) throw new Error("registry needs a top-level `targets` object");
  const targets = (raw as { targets: unknown }).targets;
  if (!targets || typeof targets !== "object") throw new Error("`targets` must be an object keyed by name");
  const out: Registry = { targets: {} };
  for (const [name, entry] of Object.entries(targets as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") throw new Error(`target ${name}: not an object`);
    const t = entry as Record<string, unknown>;
    const kind = String(t.kind ?? "");
    if (!KINDS.has(kind)) throw new Error(`target ${name}: unknown kind ${JSON.stringify(t.kind)}; known: ${[...KINDS].join(", ")}`);
    const need = (keys: string[]) => {
      for (const k of keys) if (typeof t[k] !== "string" || !(t[k] as string).length) throw new Error(`target ${name} (${kind}): missing \`${k}\``);
    };
    if (kind === "npm-dist-tag") need(["package", "tag"]);
    if (kind === "npm-dated-canary") {
      need(["package", "tag"]);
      const b = t.binary as { platforms?: unknown; path?: unknown } | undefined;
      if (!b || typeof b !== "object" || !b.platforms || typeof b.platforms !== "object" || typeof b.path !== "string") {
        throw new Error(`target ${name} (${kind}): \`binary\` needs { platforms: { "os-arch": "@scope/pkg" }, path }`);
      }
    }
    if (kind === "pkg-pr-new") need(["owner", "repo", "package", "ref"]);
    if (kind === "github-rolling-tag") need(["owner", "repo", "tag"]);
    if (t.source !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(String(t.source))) throw new Error(`target ${name}: \`source\` must be owner/name`);
    out.targets[name] = t as unknown as Target;
  }
  return out;
}

/** The upstream repository for a target, `owner/name`, or null when the entry does not say and the kind cannot imply it. */
export function sourceOf(t: Target): string | null {
  if (t.source) return t.source;
  if (t.kind === "pkg-pr-new" || t.kind === "github-rolling-tag") return `${t.owner}/${t.repo}`;
  return null;
}

export const hostKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;
