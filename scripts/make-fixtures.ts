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
// Gallery fixtures: large works, a small avatar that must be ignored, and a second clip for the iframe player.
const sharp = (await import("sharp")).default;
const grad = (w: number, h: number, a: string, b: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><rect x="${w * 0.3}" y="${h * 0.3}" width="${w * 0.4}" height="${h * 0.4}" rx="40" fill="#ffffff"/></svg>`);
await sharp(grad(1600, 1000, "#f6a96a", "#b58be6")).jpeg().toFile(join(out, "gallery-1.jpg"));
await sharp(grad(800, 500, "#f6a96a", "#b58be6")).jpeg().toFile(join(out, "gallery-1-small.jpg"));
await sharp(grad(1200, 1200, "#ccE7da", "#14301f")).png().toFile(join(out, "gallery-2.png"));
await sharp(grad(1400, 900, "#eeeeeb", "#161816")).jpeg().toFile(join(out, "gallery-3.jpg"));
await sharp(grad(1200, 630, "#161816", "#1f4535")).jpeg().toFile(join(out, "gallery-cover.jpg"));
await sharp(grad(64, 64, "#000000", "#ff0000")).png().toFile(join(out, "avatar.png"));
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x1f4535:s=640x360:d=2:r=30", "-vf", "drawbox=x='100+60*t':y=120:w=200:h=120:color=0xf6a96a:t=fill,format=yuv420p", "-c:v", "libx264", join(out, "player-clip.mp4")]);
console.log(`fixtures written to ${out}`);
