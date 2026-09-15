import { describe, expect, test } from "bun:test";
import { marker, plan, render, verdictOf } from "../src/report.ts";
import { watchRow } from "../src/watch.ts";

describe("report", () => {
  const open = (text: string) => ({ number: 7, text });
  test("the decision table", () => {
    const red = { target: "bun", verdict: "red" as const, signature: "red:zstd" };
    expect(plan(red, null)).toEqual({ kind: "create" });
    expect(plan(red, open("x"))).toEqual({ kind: "comment", number: 7 });
    expect(plan(red, open(`x\n${marker("bun", "red:zstd")}`))).toEqual({ kind: "none" });
    expect(plan({ ...red, verdict: "changed" }, null)).toEqual({ kind: "create" });
    expect(plan({ ...red, verdict: "green", signature: "green" }, open("x"))).toEqual({ kind: "close", number: 7 });
    expect(plan({ ...red, verdict: "green", signature: "green" }, null)).toEqual({ kind: "none" });
    expect(plan({ ...red, verdict: "instrument" }, null)).toEqual({ kind: "none" });
    expect(plan({ ...red, verdict: "instrument" }, open("x"))).toEqual({ kind: "none" });
    expect(plan({ ...red, target: "wrangler" }, open(marker("bun", "red:zstd")))).toEqual({ kind: "comment", number: 7 });
  });
  test("verdict: hard gates red, soft gates and moved watches changed, else green; the signature names what, never which build", () => {
    const w = { name: "x", issue: "https://github.com/o/r/issues/1", landed: "x" };
    const moved = watchRow(w, { landed: false, detail: "" }, { landed: true, detail: "" });
    expect(verdictOf([{ name: "build", ok: false, detail: "" }], [moved])).toEqual({ verdict: "red", signature: "red:build|watch:x:f>t" });
    expect(verdictOf([{ name: "bundle", ok: false, hard: false, detail: "" }], [])).toEqual({ verdict: "changed", signature: "changed:bundle" });
    expect(verdictOf([], [moved])).toEqual({ verdict: "changed", signature: "changed:watch:x:f>t" });
    expect(verdictOf([{ name: "ok", ok: true, detail: "" }], [])).toEqual({ verdict: "green", signature: "green" });
  });
  test("render: tables survive pipes and newlines in details, and every watch row says its state", () => {
    const w = { name: "x", issue: "https://github.com/o/r/issues/1", landed: "x is fixed" };
    const body = render({
      target: "bun", verdict: "changed", signature: "s", subject: { revision: "1.4.3-canary.1+abc" },
      gates: [{ name: "g", ok: false, detail: "a|b\nc" }],
      watches: [watchRow(w, { landed: false, detail: "" }, { landed: true, detail: "" }), watchRow({ ...w, name: "y" }, { landed: true, detail: "" }, { landed: true, detail: "" }), watchRow({ ...w, name: "z" }, { landed: null, detail: "did not run" }, { landed: false, detail: "" })],
    }, "https://run", "timbrado try bun");
    expect(body).toContain("| g | FAIL | a\\|b c |");
    expect(body).toContain("| not yet | landed **MOVED** |");
    expect(body).toContain("landed | landed (in the pin too: retire this watch)");
    expect(body).toContain("| did not run | not yet |");
    expect(body).toContain("`x` landed means: x is fixed");
    expect(body).toContain(marker("bun", "s"));
    expect(body).toContain("Reproduce with `timbrado try bun`");
  });
});
