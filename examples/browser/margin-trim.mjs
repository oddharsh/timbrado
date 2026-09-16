// An optional project-owned probe. The Rust engine has no browser dependency.
// Playwright launches disposable profiles and closes only the browser it owns.
import { chromium } from "playwright-core";

const channel = process.argv[2];
if (!["chrome", "chrome-canary"].includes(channel)) throw new Error("expected chrome or chrome-canary");
const browser = await chromium.launch({ channel, headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html>
    <style>
      body { margin: 0; }
      .box { display: flow-root; width: 100px; }
      .child { height: 10px; margin-block: 20px 30px; }
      #trimmed { margin-trim: block; }
    </style>
    <div id="control" class="box"><div class="child"></div></div>
    <div id="trimmed" class="box"><div class="child"></div></div>`);
  const geometry = await page.evaluate(() => {
    const read = (id) => {
      const parent = document.getElementById(id);
      const box = parent.getBoundingClientRect();
      const child = parent.firstElementChild.getBoundingClientRect();
      return { height: box.height, topGap: child.top - box.top, bottomGap: box.bottom - child.bottom };
    };
    return { control: read("control"), trimmed: read("trimmed"), parses: CSS.supports("margin-trim", "block") };
  });
  const near = (a, b) => Math.abs(a - b) < 0.5;
  const { control, trimmed } = geometry;
  if (!near(control.height, 60) || !near(control.topGap, 20) || !near(control.bottomGap, 30)) {
    throw new Error(`invalid layout control: ${JSON.stringify(control)}`);
  }
  const landed = near(trimmed.height, 10) && near(trimmed.topGap, 0) && near(trimmed.bottomGap, 0);
  console.log(JSON.stringify({
    landed,
    detail: `${channel} ${browser.version()}: trimmed height ${trimmed.height}px, gaps ${trimmed.topGap}/${trimmed.bottomGap}px`,
    evidence: { channel, browserVersion: browser.version(), geometry, requestedFeatureFlags: [] },
  }));
} finally {
  await browser.close();
}
