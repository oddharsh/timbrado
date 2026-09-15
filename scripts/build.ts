#!/usr/bin/env bun
// bun scripts/build.ts
//
// Strips the types out of src/ into dist/, one file per file, no bundling.
// Node refuses to type-strip a `.ts` inside node_modules (by design), so a
// git dependency that ships only TypeScript is bun-only by accident; dist/
// is COMMITTED so `github:oddharsh/timbrado#<sha>` installs something node
// can import. package.json's exports map hands TypeScript the `.ts` source
// for types, bun the source to run, and everyone else dist/. The conformance
// suite rebuilds and diffs, so a stale dist fails by name.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const transpiler = new Bun.Transpiler({ loader: "ts", target: "node" });

export function buildAll(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts")).sort()) {
    const src = readFileSync(join(root, "src", name), "utf8");
    let js = transpiler.transformSync(src);
    // Relative imports keep their `.ts` spelling in source so bun and tsc
    // resolve them; dist speaks `.js`.
    js = js.replace(/(from\s+"\.\/[^"]+)\.ts"/g, '$1.js"').replace(/(import\s*\(\s*"\.\/[^"]+)\.ts"/g, '$1.js"');
    if (name === "cli.ts") js = `#!/usr/bin/env node\n${js.replace(/^#!.*\n/, "")}`;
    out[name.replace(/\.ts$/, ".js")] = js;
  }
  return out;
}

if (import.meta.main) {
  mkdirSync(join(root, "dist"), { recursive: true });
  const files = buildAll();
  for (const [name, js] of Object.entries(files)) writeFileSync(join(root, "dist", name), js, { mode: name === "cli.js" ? 0o755 : 0o644 });
  console.log(`dist/: ${Object.keys(files).length} files`);
}
