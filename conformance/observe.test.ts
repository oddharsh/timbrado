import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { marker, plan, render, type Report } from "../src/report.ts";
import { nativeBinary } from "../src/native.ts";

describe("opportunity CLI and existing reporter", () => {
  test("Node CLI preserves native evidence and reporter policy without posting", () => {
    const dir = mkdtempSync(join(tmpdir(), "timbrado-observe-"));
    const manifest = join(dir, "opportunities.json");
    const result = join(dir, "report.json");
    const probe = join(dir, "probe.mjs");
    writeFileSync(probe, `console.log(JSON.stringify({landed:process.argv[2]==="true",detail:"behavior measured",evidence:{build:process.argv[2]}}))`);
    writeFileSync(manifest, JSON.stringify({
      schemaVersion: 1, target: "layout", opportunities: [{
        name: "native-layout", intention: "Remove the layout workaround", affected: ["src/layout.css"],
        sources: ["https://example.com/spec"], verification: "Layout behavior works", adoption: "Review all supported browsers",
        baseline: { id: "stable", command: { argv: ["node", "{manifest}/probe.mjs", "false"] } },
        candidate: { id: "canary", command: { argv: ["node", "{manifest}/probe.mjs", "true"] } },
      }],
    }));
    try {
      const run = spawnSync("node", [new URL("../dist/cli.js", import.meta.url).pathname, "observe", manifest, "--json", result], { encoding: "utf8" });
      expect(run.status).toBe(1);
      const report: Report = JSON.parse(readFileSync(result, "utf8"));
      expect(JSON.parse(run.stdout)).toEqual(report);
      expect(report.opportunities?.[0].experiment.candidate.measurement.evidence).toEqual({ build: "true" });
      expect(plan(report, null)).toEqual({ kind: "create" });
      expect(plan(report, { number: 7, text: marker(report.target, report.signature) })).toEqual({ kind: "none" });
      const body = render(report);
      expect(body).toContain("Remove the layout workaround");
      expect(body).toContain("`src/layout.css`");
      expect(body).toContain("| stable | false | behavior measured |");
      expect(body).toContain("| canary | true | behavior measured |");
      expect(body).toContain("Adoption condition: Review all supported browsers");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a missing native engine is explicit, while pure JS reporting still works", () => {
    const reporter = new URL("../dist/report.js", import.meta.url).href;
    const watch = new URL("../dist/watch.js", import.meta.url).href;
    const script = `import { title } from ${JSON.stringify(reporter)};
      import { runWatch } from ${JSON.stringify(watch)};
      console.log(title("x"));
      console.log(JSON.stringify(runWatch(process.execPath,{script:"console.log('{}')"})));`;
    const p = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, TIMBRADO_BIN: "/missing-timbrado-native" } });
    expect(p.status).toBe(0);
    expect(p.stdout).toContain("timbrado: x");
    expect(p.stdout).toContain('"landed":null');
    expect(p.stdout).toContain("Rust engine is missing");
    expect(nativeBinary()).toContain("timbrado");
  });
});
