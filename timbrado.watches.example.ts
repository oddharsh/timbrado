// An example watch file. Copy to timbrado.watches.ts and keep only the
// threads YOU are waiting on; every entry must read `landed: false` on your
// pinned runtime the day you add it, and `measured` records that reading.
//
// These three are real, from aadhar.sh's list (2026-09-15), and read false on
// bun 1.4.2 and on 1.4.3-canary.1+782c4020b.

import type { Watch } from "./src/watch.ts";

const PNG_2X1_8BIT = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGNgYGD4//8/AAYBAv4CsjmuAAAAAElFTkSuQmCC";

export const watches: Watch[] = [
  {
    name: "bun-image-rejects-out-of-range-quality",
    issue: "https://github.com/oven-sh/bun/issues/40490",
    landed: "Bun.Image throws on `quality: 999` instead of encoding with it (the fix is oven-sh/bun#40520)",
    measured: "2026-09-15, bun 1.4.2: accepted, wrote 652 B",
    runtime: "bun",
    script: `
      const png = Buffer.from("${PNG_2X1_8BIT}", "base64");
      let landed = false, detail;
      try { const n = (await new Bun.Image(png).jpeg({ quality: 999 }).bytes()).length; detail = "quality: 999 accepted, " + n + " B written"; }
      catch (e) { landed = true; detail = "quality: 999 throws: " + String(e && e.message || e).split("\\n")[0].slice(0, 90); }
      console.log(JSON.stringify({ landed, detail }));
    `,
  },
  {
    name: "fetch-honours-dispatcher",
    issue: "https://github.com/oven-sh/bun/issues/39247",
    landed: "`fetch(url, { dispatcher })` calls the dispatcher's `dispatch()` under bun, which is what miniflare's `dispatchFetch()` relies on (the fix is oven-sh/bun#39250)",
    measured: "2026-09-15, bun 1.4.2: dispatch() never called, the fetch went to the network",
    runtime: "bun",
    script: `
      let called = 0;
      const dispatcher = { dispatch(opts, h) { called++; if (h && typeof h.onError === "function") h.onError(new Error("watch")); return true; } };
      let err = "";
      try { await fetch("http://127.0.0.1:1/", { dispatcher }); } catch (e) { err = String(e && e.message || e).split("\\n")[0].slice(0, 60); }
      console.log(JSON.stringify({ landed: called > 0, detail: called > 0 ? "dispatch() called " + called + "x" : "dispatch() never called; fetch went to the network: " + err }));
    `,
  },
  {
    name: "css-minifier-lowercases-target-current",
    issue: "https://github.com/oven-sh/bun/issues/42480",
    landed: "`:TARGET-CURRENT` is emitted lowercased like `:TARGET-WITHIN`, so two spellings of one selector merge (the fix is oven-sh/bun#42484)",
    measured: "2026-09-15, bun 1.4.2: emitted verbatim beside a lowercased :target-within",
    runtime: "bun",
    script: `
      await Bun.write("w.css", "x:TARGET-CURRENT{c:d}y:TARGET-WITHIN{c:d}");
      await Bun.build({ entrypoints: ["w.css"], minify: true, outdir: "out" });
      const css = await Bun.file("out/w.css").text();
      const landed = css.includes(":target-current") && !css.includes(":TARGET-CURRENT");
      console.log(JSON.stringify({ landed, detail: "emitted " + JSON.stringify(css.trim().slice(0, 60)) }));
    `,
  },
];
