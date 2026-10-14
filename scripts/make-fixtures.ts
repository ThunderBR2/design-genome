/** Generates binary fixtures (screenshot, PDF, video) from the HTML fixtures. */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

import { serveDirectory } from "../tests/support/server.js";

const fixtures = join(import.meta.dirname, "..", "tests", "fixtures");
const out = join(fixtures, "out");
mkdirSync(out, { recursive: true });

const site = await serveDirectory(join(fixtures, "site"));
const browser = await chromium.launch();
try {
  const shot = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await shot.goto(site.url);
  await shot.screenshot({ path: join(out, "site-1440@2x.png"), fullPage: true });
  const pdf = await browser.newPage();
  await pdf.goto(`file://${join(fixtures, "brandbook.html")}`);
  await pdf.pdf({ path: join(out, "brandbook.pdf"), format: "A4", printBackground: true });
} finally {
  await browser.close();
  await site.close();
}

// Five distinct shots: a moving "product" block on seamless backgrounds.
const shots = [
  { d: 2.0, bg: "0xf5f5f7", box: "0x1d1d1f" },
  { d: 1.5, bg: "0x1d1d1f", box: "0xf5f5f7" },
  { d: 2.5, bg: "0xffffff", box: "0x0071e3" },
  { d: 1.0, bg: "0x0071e3", box: "0xffffff" },
  { d: 1.8, bg: "0xf5f5f7", box: "0x6e6e73" },
];
const inputs: string[] = [];
const filters: string[] = [];
shots.forEach((s, i) => {
  inputs.push("-f", "lavfi", "-i", `color=c=${s.bg}:s=640x360:d=${s.d}:r=30`);
  filters.push(`[${i}:v]drawbox=x='200+40*t':y=110:w=240:h=140:color=${s.box}:t=fill,format=yuv420p[v${i}]`);
});
filters.push(`${shots.map((_, i) => `[v${i}]`).join("")}concat=n=${shots.length}:v=1:a=0[out]`);
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", filters.join(";"), "-map", "[out]", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(out, "campaign.mp4")]);
console.log(`fixtures written to ${out}`);
