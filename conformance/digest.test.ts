import { describe, expect, test } from "bun:test";
import { changesets, renderDigest } from "../src/digest.ts";
import fixture from "./fixtures/compare.json";

describe("digest", () => {
  test("parses added changesets and nothing else", () => {
    const sets = changesets(fixture.files);
    expect(sets.map((s) => s.file)).toEqual([".changeset/nice-cats.md", ".changeset/big-dog.md"]);
    expect(sets[0].packages).toEqual([{ name: "wrangler", bump: "patch" }, { name: "miniflare", bump: "minor" }]);
    expect(sets[0].note).toBe("Replace execa with tinyexec.\nSecond line.");
  });
  test("renders changesets first, preferred packages first, and flags a major bump", () => {
    const md = renderDigest("cloudflare/workers-sdk", "aaaaaaa", "bbbbbbb", fixture, ["wrangler"]);
    expect(md).toContain("**1 changeset declares a MAJOR bump.** Read it first.");
    expect(md.indexOf("**wrangler** patch")).toBeLessThan(md.indexOf("**miniflare** major"));
    expect(md).toContain("- **wrangler** patch, **miniflare** minor: Replace execa with tinyexec.");
    expect(md).toContain("3 commit subjects, 1 by bots");
    expect(md).toContain("- scriptx/script subject (z)");
    expect(md).not.toContain("No changeset");
  });
  test("caps subjects, reports truncation, and says nothing about changesets where the repository has none", () => {
    const commits = Array.from({ length: 250 }, (_, i) => ({ sha: String(i), commit: { message: `commit ${i}`, author: { name: "robobun" } }, author: { login: "robobun" } }));
    const md = renderDigest("oven-sh/bun", "1111111", "2222222", { total_commits: 300, commits, files: [] });
    expect(md).toContain("(the API returned 250 of 300)");
    expect(md).toContain("- and 210 more");
    expect(md).toContain("250 by bots");
    expect(md).not.toContain("changeset");
  });
});
