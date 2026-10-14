/** Captures Studio screenshots for the docs. Usage: tsx scripts/studio-screenshots.ts <projectDir> <outDir> */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

import { GenomeService } from "../src/service.js";
import { startStudio } from "../src/studio/server.js";

const [projectDir, outDir] = process.argv.slice(2);
if (!projectDir || !outDir) throw new Error("usage: studio-screenshots <projectDir> <outDir>");
mkdirSync(outDir, { recursive: true });
const studio = await startStudio(new GenomeService(projectDir), { port: 0 });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(studio.url);
  await page.waitForSelector("[data-tab]");
  for (const tab of ["overview", "color", "type", "space", "imagery", "rules", "conflicts"]) {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(outDir, `studio-${tab}.png`) });
  }
  await page.click('[data-tab="type"]');
  await page.click(".specimen");
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(outDir, "studio-evidence.png") });
} finally {
  await browser.close();
  await studio.close();
}
console.log(`screenshots in ${outDir}`);
