import { describe, expect, test } from "bun:test";
import { isFloating, managerOf, releaseAgeSeconds } from "../src/isolate.ts";
import { sourceOf, validateRegistry } from "../src/registry.ts";
import { newerThanLatest } from "../src/survey.ts";
import known from "../registry/known.json";

describe("registry", () => {
  test("the known registry validates, and every entry names or implies its source", () => {
    const reg = validateRegistry(known);
    expect(Object.keys(reg.targets).length).toBeGreaterThanOrEqual(5);
    for (const [name, t] of Object.entries(reg.targets)) expect(sourceOf(t), name).toMatch(/^[^/]+\/[^/]+$/);
  });
  test("refuses an unknown kind, a missing field, and a malformed source, naming the entry", () => {
    expect(() => validateRegistry({ targets: { x: { kind: "svn" } } })).toThrow(/target x: unknown kind "svn"/);
    expect(() => validateRegistry({ targets: { x: { kind: "pkg-pr-new", owner: "o", repo: "r", package: "p" } } })).toThrow(/missing `ref`/);
    expect(() => validateRegistry({ targets: { x: { kind: "npm-dist-tag", package: "p", tag: "next", source: "nope" } } })).toThrow(/owner\/name/);
    expect(() => validateRegistry({ targets: { x: { kind: "npm-dated-canary", package: "p", tag: "canary" } } })).toThrow(/binary/);
  });
});

describe("pinnability", () => {
  test("a spec floats unless it names an exact version or a sha", () => {
    expect(isFloating("wrangler")).toBe(true);
    expect(isFloating("wrangler@next")).toBe(true);
    expect(isFloating("https://pkg.pr.new/cloudflare/workers-sdk/wrangler@main")).toBe(true);
    expect(isFloating("https://pkg.pr.new/cloudflare/workers-sdk/wrangler@982b806")).toBe(false);
    expect(isFloating("typescript@7.1.0-dev.20260915.1")).toBe(false);
    expect(isFloating("@oven/bun-linux-x64@1.4.2-canary.20260915.1")).toBe(false);
  });
  test("a dist-tag is a head only when it points past latest", () => {
    expect(newerThanLatest("7.1.0-dev.20260915.1", "7.0.2")).toBe(true);
    expect(newerThanLatest("3.9.4", "7.0.2")).toBe(false);
    expect(newerThanLatest("7.0.1-rc", "7.0.2")).toBe(false);
    expect(newerThanLatest("1.63.0-beta-1", "1.63.0")).toBe(false);
    expect(newerThanLatest("1.64.0-alpha-2026-09-15", "1.63.0")).toBe(true);
  });
  test("the manager is read off the lockfile, and bun's release-age policy off bunfig", () => {
    const { mkdtempSync, writeFileSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const dir = mkdtempSync(join(tmpdir(), "timbrado-reg-"));
    expect(managerOf(dir)).toBe("npm");
    writeFileSync(join(dir, "bun.lock"), "");
    expect(managerOf(dir)).toBe("bun");
    expect(releaseAgeSeconds(dir)).toBeNull();
    writeFileSync(join(dir, "bunfig.toml"), "[install]\nminimumReleaseAge = 86400\n");
    expect(releaseAgeSeconds(dir)).toBe(86400);
  });
});
