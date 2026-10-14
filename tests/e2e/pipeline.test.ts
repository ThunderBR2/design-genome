import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Genome } from "../../src/core/genome.js";
import { exportGenome } from "../../src/export/index.js";
import { GenomeService } from "../../src/service.js";
import { serveDirectory } from "../support/server.js";

/**
 * Runs the real pipeline on fixtures: a site (exact), a 2x screenshot of it
 * (estimated, calibrated), a campaign film (estimated) and a brand book PDF
 * (declared) that deliberately contradicts the site in places.
 */
const fixtures = join(import.meta.dirname, "..", "fixtures");
const out = join(fixtures, "out");

describe("full pipeline", () => {
  let dir: string;
  let site: Awaited<ReturnType<typeof serveDirectory>>;
  let svc: GenomeService;
  let genome: Genome;

  beforeAll(async () => {
    if (!existsSync(join(out, "campaign.mp4"))) execFileSync("npx", ["tsx", join(import.meta.dirname, "..", "..", "scripts", "make-fixtures.ts")], { stdio: "inherit" });
    dir = await mkdtemp(join(tmpdir(), "genome-e2e-"));
    site = await serveDirectory(join(fixtures, "site"));
    svc = new GenomeService(dir);
    await svc.init("Lumen");
    const [web] = await svc.add([{ uri: site.url, label: "site" }]);
    await svc.add([
      { uri: join(out, "site-1440@2x.png"), label: "screenshot", depicts: web!.id },
      { uri: join(out, "campaign.mp4"), label: "campaign" },
      { uri: join(out, "brandbook.pdf"), label: "brand book" },
    ]);
    const outcomes = await svc.extract();
    expect(outcomes.filter((o) => o.status === "failed")).toEqual([]);
    genome = await svc.build();
  });

  afterAll(async () => {
    await site?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("recovers the palette and confirms it across sources", () => {
    const hexes = genome.color.tokens.map((t) => t.hex);
    expect(hexes).toEqual(expect.arrayContaining(["#ffffff", "#f5f5f7", "#1d1d1f", "#6e6e73", "#0071e3"]));
    const accent = genome.color.tokens.find((t) => t.hex === "#0071e3")!;
    expect(accent.name).toBe("accent");
    expect(accent.declaredAs).toBe("Primary Blue");
    expect(accent.support.status).toBe("confirmed");
    expect(genome.rules.some((r) => r.statement.startsWith("#0071e3 is reserved for interactive elements"))).toBe(true);
  });

  it("measures typography, spacing, shape and motion exactly", () => {
    const display = genome.typography.styles.find((s) => s.sizePx === 80 && s.viewport === 1440)!;
    expect(display).toMatchObject({ weight: 600, lineHeight: 1.05, trackingEm: -0.015 });
    expect(genome.typography.tracking?.table).toEqual(expect.arrayContaining([{ sizePx: 17, trackingEm: -0.022 }]));
    expect(genome.spacing.grid).toMatchObject({ unit: 8, adherence: 1 });
    expect(genome.radius.map((r) => r.value)).toEqual(expect.arrayContaining([18, 9999]));
    expect(genome.motion.durations.map((d) => d.value)).toEqual(expect.arrayContaining([240, 320, 400]));
    expect(genome.motion.easings[0]?.easing).toBe("cubic-bezier(0.4, 0, 0.6, 1)");
    expect(genome.breakpoints.map((b) => b.value)).toEqual(expect.arrayContaining([735, 1069]));
  });

  it("calibrates the screenshot against the page it depicts", () => {
    const shot = genome.sources.find((s) => s.label === "screenshot")!;
    expect(shot.calibration?.scale).toBe(0.5);
  });

  it("measures the film's editing rhythm", () => {
    expect(genome.motion.editing?.medianShotSec).toBeGreaterThan(1);
    expect(genome.motion.editing?.cutsPerMinute).toBeGreaterThan(20);
  });

  it("surfaces where the brand book and the product disagree", () => {
    const descriptions = genome.conflicts.map((c) => c.description);
    expect(descriptions.some((d) => d.includes("requires Helvetica Neue"))).toBe(true);
    expect(descriptions.some((d) => d.includes("Minimum declared size is 12px") && d.includes("11px"))).toBe(true);
    expect(descriptions.some((d) => d.includes("#ff3b30"))).toBe(true);
  });

  it("confirms declared rules that the product follows", () => {
    const status = (start: string) => genome.rules.find((r) => r.statement.startsWith(start))?.support.status;
    expect(status("Spacing uses a 8px base unit")).toBe("confirmed");
    expect(status("Never set headlines in uppercase")).toBe("confirmed");
    expect(status("Headlines must always be set in Helvetica Neue")).toBe("conflicted");
  });

  it("scores the original site as conformant and an off-brand page as not", async () => {
    const original = await svc.verify(join(fixtures, "site", "index.html"));
    expect(original.score).toBeGreaterThanOrEqual(0.95);
    const off = await svc.verify(join(fixtures, "candidates", "off-brand.html"));
    expect(off.score).toBeLessThan(0.8);
    expect(off.violations.some((v) => v.facet === "typography" && v.found === "Georgia")).toBe(true);
    expect(off.violations.some((v) => v.facet === "spacing")).toBe(true);
  });

  it("lets the host model read images and cross-checks what it saw", async () => {
    const pending = await svc.visionPending();
    expect(pending.map((s) => s.kind).sort()).toEqual(["image", "video", "web"]);
    const film = pending.find((s) => s.kind === "video")!;
    const request = await svc.visionRequest(film.id);
    expect(request?.images.length).toBeGreaterThan(1);
    expect(request?.images[0]!.jpeg.subarray(0, 2).toString("hex")).toBe("ffd8");
    const reading = { rules: [{ topic: "imagery", statement: "The product is always shown on a seamless light background.", polarity: "must", confidence: 0.8, images: [1, 2] }], labels: [{ metric: "background", label: "seamless studio", confidence: 0.8, images: [1] }] };
    const { observations, genome: withVision } = await svc.visionSubmit(film.id, reading, "test host");
    expect(observations).toBe(2);
    const shot = (await svc.project()).sources.find((s) => s.label === "screenshot")!;
    const after = (await svc.visionSubmit(shot.id, { rules: [{ topic: "imagery", statement: "Products sit on a seamless light background with no props.", polarity: "must", confidence: 0.7, images: [1] }] }, "test host")).genome;
    const declared = after.rules.find((r) => r.statement.startsWith("Photography should always show the product on a seamless light background"))!;
    expect(declared.support.status).toBe("confirmed");
    expect(declared.support.sources.map((s) => s.precision)).toEqual(expect.arrayContaining(["declared", "inferred"]));
    expect(withVision.imagery.some((m) => m.metric === "background" && m.label === "seamless studio")).toBe(true);
    genome = after;
  });

  it("reads a saved page added as a web source", async () => {
    const other = new GenomeService(join(dir, "saved"));
    await other.init("Saved page");
    const [saved] = await other.add([{ uri: join(fixtures, "site", "index.html"), kind: "web", label: "saved page" }]);
    const [outcome] = await other.extract([saved!.id]);
    expect(outcome?.status).toBe("extracted");
    const g = await other.build();
    expect(g.color.tokens.some((t) => t.hex === "#0071e3")).toBe(true);
  });

  it("records decisions and exports a brief that carries them", async () => {
    const conflict = genome.conflicts.find((c) => c.description.includes("requires Helvetica Neue"))!;
    const rebuilt = await svc.resolve(conflict.id, "Follow the site: Inter");
    expect(rebuilt.conflicts.find((c) => c.id === conflict.id)?.resolution?.choice).toBe("Follow the site: Inter");
    const brief = exportGenome(rebuilt, "brief").content;
    expect(brief).toContain("## Decisions");
    expect(brief).toContain("Follow the site: Inter");
    const tokens = JSON.parse(exportGenome(rebuilt, "tokens").content);
    expect(tokens.color.accent.$value).toBe("#0071e3");
  });
});
