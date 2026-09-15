// Live conformance: the real upstreams, run with TIMBRADO_LIVE=1. Each case
// is a channel recipe measured against the registry it names, so a recipe
// that rots fails here by name before it fails in someone's nightly.
import { describe, expect, test } from "bun:test";
import { validateRegistry } from "../src/registry.ts";
import { resolve } from "../src/resolve.ts";
import known from "../registry/known.json";

const live = process.env.TIMBRADO_LIVE === "1";
const reg = validateRegistry(known);

describe.if(live)("live resolve", () => {
  test("bun's dated canary carries its build sha and a binary with a sha512 for this host", async () => {
    const c = await resolve("bun", reg.targets.bun);
    expect(c.immutable).toBe(true);
    expect(c.id).toMatch(/^\d+\.\d+\.\d+-canary\.\d{8}\.\d+\+[0-9a-f]{7,}$/);
    expect(c.binary?.integrity).toMatch(/^sha512-/);
    expect(c.publishedAt).toBeTruthy();
  });
  test("pkg.pr.new resolves a floating ref to a sha and installs by the sha", async () => {
    const c = await resolve("wrangler", reg.targets.wrangler);
    expect(c.id).toMatch(/^[0-9a-f]{7}$/);
    expect(c.install).toBe(`https://pkg.pr.new/cloudflare/workers-sdk/wrangler@${c.id}`);
    expect(c.note).toMatch(/the ref floats/);
  });
  test("a rolling tag is never pinnable", async () => {
    const c = await resolve("bun-rolling", reg.targets["bun-rolling"]);
    expect(c.immutable).toBe(false);
    expect(c.install).toBeNull();
  });
  test("an npm dist-tag resolves to an exact version", async () => {
    const c = await resolve("typescript", reg.targets.typescript);
    expect(c.install).toBe(`typescript@${c.id}`);
    expect(c.immutable).toBe(true);
  });
});
