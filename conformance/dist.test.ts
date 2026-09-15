import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAll } from "../scripts/build.ts";

describe("dist", () => {
  test("is what src builds to, file for file (node cannot import .ts from node_modules, so dist is the install)", () => {
    const root = new URL("..", import.meta.url).pathname;
    for (const [name, js] of Object.entries(buildAll())) {
      expect(readFileSync(join(root, "dist", name), "utf8"), name).toBe(js);
    }
  });
  test("dist imports speak .js and the cli runs under node", () => {
    const root = new URL("..", import.meta.url).pathname;
    expect(readFileSync(join(root, "dist", "report.js"), "utf8")).toMatch(/from "\.\/watch\.js"/);
    const { spawnSync } = require("node:child_process");
    const run = spawnSync("node", [join(root, "dist", "cli.js")], { encoding: "utf8" });
    expect(run.stdout + run.stderr).toMatch(/timbrado: run your own gates/);
    const rep = spawnSync("node", ["-e", `import("${join(root, "dist", "report.js")}").then((m) => console.log(m.title("x")))`], { encoding: "utf8" });
    expect(rep.stdout.trim()).toBe("timbrado: x");
  });
});
