import { describe, expect, test } from "bun:test";
import { checkWatch, runWatch, watchMoved, watchRow, watchSignature } from "../src/watch.ts";
import { watches } from "../timbrado.watches.example.ts";

const w = { name: "x-lands", issue: "https://github.com/oven-sh/bun/issues/1", landed: "x is fixed" };
const yes = { landed: true, detail: "yes" };
const no = { landed: false, detail: "no" };
const none = { landed: null, detail: "did not run: boom" };

describe("watch", () => {
  test("moves only when both readings are real and differ", () => {
    expect(watchMoved(watchRow(w, no, yes))).toBe(true);
    expect(watchMoved(watchRow(w, yes, no))).toBe(true);
    expect(watchMoved(watchRow(w, no, no))).toBe(false);
    expect(watchMoved(watchRow(w, yes, yes))).toBe(false);
    expect(watchMoved(watchRow(w, none, yes))).toBe(false);
    expect(watchSignature(watchRow(w, no, yes))).toBe("watch:x-lands:f>t");
  });
  test("checkWatch refuses an entry with no thread, no date, or a name that cannot sit in a signature", () => {
    expect(checkWatch({ ...w, measured: "2026-09-15, bun 1.4.2: no", script: "x" })).toEqual([]);
    expect(checkWatch({ ...w, issue: "https://example.com", measured: "2026-09-15, x", script: "x" }).join()).toMatch(/issue/);
    expect(checkWatch({ ...w, measured: "yesterday", script: "x" }).join()).toMatch(/measured/);
    expect(checkWatch({ ...w, name: "Not Kebab", measured: "2026-09-15, x", script: "x" }).join()).toMatch(/kebab/);
  });
  test("a probe that prints no JSON line reads as did-not-run, never as either answer", () => {
    const r = runWatch(process.execPath, { ...w, measured: "2026-09-15, x", script: "console.log('not json'); process.exit(3)" });
    expect(r.landed).toBeNull();
    expect(r.detail).toMatch(/^did not run/);
  });
  test("successful JSON followed by a crash is still unmeasured", () => {
    const r = runWatch(process.execPath, { ...w, measured: "2026-09-15, x", script: `console.log(JSON.stringify({ landed: true, detail: "printed before crashing" })); process.exit(3)` });
    expect(r.landed).toBeNull();
    expect(r.detail).toContain("probe exited 3");
  });
  test("an extra stdout line violates the probe protocol", () => {
    const r = runWatch(process.execPath, { ...w, measured: "2026-09-15, x", script: `console.log("noise"); console.log(JSON.stringify({ landed: true, detail: "not the only output" }))` });
    expect(r.landed).toBeNull();
  });
  test("every example watch runs under this bun and answers a boolean (the control: a watch that reads null is decoration)", () => {
    for (const x of watches) {
      expect(checkWatch(x)).toEqual([]);
      const r = runWatch(process.execPath, x);
      expect([true, false]).toContain(r.landed);
      expect(r.detail.length).toBeGreaterThan(0);
    }
  });
});
