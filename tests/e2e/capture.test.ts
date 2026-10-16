import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LayoutDump } from "../../src/extractors/web.js";
import { GenomeService } from "../../src/service.js";
import { TOOLS } from "../../src/tools.js";
import { serveDirectory } from "../support/server.js";

/**
 * What the visitor sees is what gets measured: content that fades in on scroll
 * is captured revealed, text that is never painted is left out, a consent layer
 * is dismissed, and a bot-check page is refused instead of dissected. Then the
 * pre-check and the reader gate decide what is worth reading.
 */
const fixtures = join(import.meta.dirname, "..", "fixtures");

describe("faithful capture and triage", () => {
  let dir: string;
  let site: Awaited<ReturnType<typeof serveDirectory>>;
  let blocked: Awaited<ReturnType<typeof serveDirectory>>;
  let svc: GenomeService;
  let sourceId: string;
  const ctx = () => ({ projectDir: join(dir, "project"), client: "test", log: () => undefined });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "genome-capture-"));
    site = await serveDirectory(join(fixtures, "reveal"));
    blocked = await serveDirectory(join(fixtures, "blocked"));
    svc = new GenomeService(join(dir, "project"));
    await svc.init("Reveal");
    const { sources } = await svc.ingest([{ uri: site.url, label: "reveal", options: { viewports: [1440] } }]);
    sourceId = sources[0]!.id;
  }, 180_000);

  afterAll(async () => {
    await site?.close();
    await blocked?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("photographs the page screen by screen and keeps only what was painted", async () => {
    const dump = JSON.parse(await readFile(join(dir, "project", "evidence", sourceId, "layout-1440.json"), "utf8")) as LayoutDump;
    expect(dump.capture?.method).toBe("screens");
    expect(dump.capture!.screens).toBeGreaterThanOrEqual(3);
    const texts = dump.elements.map((e) => e.text ?? "");
    // Revealed on scroll: present.
    expect(texts).toContain("Four ways we help");
    expect(texts).toContain("Ready to start a project?");
    // In the code, never painted: absent.
    expect(texts.some((t) => t.includes("nobody ever sees it"))).toBe(false);
    expect(dump.capture!.unpaintedText).toBeGreaterThanOrEqual(1);
    // The consent layer was clicked away and is not part of the design.
    expect(texts.some((t) => t.includes("We use cookies"))).toBe(false);

    // The stitched picture really shows the revealed heading where its box says it is.
    const shot = join(dir, "project", "evidence", sourceId, "page-1440.jpg");
    const heading = dump.elements.find((e) => e.text === "Ready to start a project?")!;
    const { data, info } = await sharp(shot).extract({ left: heading.box.x, top: heading.box.y, width: Math.min(heading.box.w, 600), height: heading.box.h }).greyscale().raw().toBuffer({ resolveWithObject: true });
    const bright = [...data].filter((v) => v > 150).length / (info.width * info.height);
    expect(bright).toBeGreaterThan(0.02);

    const g = await svc.genome();
    const limitations = g.sources.find((s) => s.id === sourceId)!.limitations.join(" ");
    expect(limitations).toContain("consent layer was dismissed");
    expect(limitations).toContain("never painted");
  });

  it("pre-checks every piece and hands the reader a grid image", async () => {
    const req = await TOOLS.genome_dissect_request({}, ctx());
    const header = (req.content[0] as { text: string }).text;
    expect(header).toContain("Pre-check:");
    expect(header).toContain("STEP 1");
    expect(req.content.filter((c) => c.type === "image")).toHaveLength(3);
    const g = await svc.genome();
    expect(g.anatomy!.pieces.every((p) => p.triage)).toBe(true);
  });

  it("refuses readings that skip the identification or name blocks that do not exist", async () => {
    const next = await svc.dissectRequest();
    const id = next!.images.piece.id;
    const base = { pieceId: id, pieceType: "landing section", summary: "s", elements: [{ block: 1, role: "headline", why: "w" }], composition: { structure: "s", eyePath: "e", principles: [] }, whyItWorks: ["w"], intent: { message: "m" } };
    await expect(TOOLS.genome_dissect_submit(base, ctx())).rejects.toThrow(/whatItIs/);
    await expect(TOOLS.genome_dissect_submit({ ...base, whatItIs: "The opening section of the page.", elements: [{ block: 999, role: "headline", why: "w" }] }, ctx())).rejects.toThrow(/#999/);
    const ok = await TOOLS.genome_dissect_submit({ ...base, whatItIs: "The opening section of the page.", grid: { system: "single column on a 160px margin", agrees: true } }, ctx());
    expect(JSON.parse((ok.content[0] as { text: string }).text).stored).toBe(id);
    const piece = (await svc.genome()).anatomy!.pieces.find((p) => p.id === id)!;
    expect(piece.reading?.whatItIs).toBe("The opening section of the page.");
    expect(piece.reading?.grid?.agrees).toBe(true);
  });

  it("lets the reader set a piece aside, out of the queue and the constants", async () => {
    const next = await svc.dissectRequest();
    const id = next!.images.piece.id;
    await TOOLS.genome_dissect_skip({ pieceId: id, reason: "Only a background strip, nothing composed." }, ctx());
    const g = await svc.genome();
    const piece = g.anatomy!.pieces.find((p) => p.id === id)!;
    expect(piece.skipped).toContain("background strip");
    const again = await svc.dissectRequest();
    expect(again?.images.piece.id).not.toBe(id);
    expect(again?.setAside.some((p) => p.id === id)).toBe(true);
  });

  it("refuses a bot-check page instead of measuring it", async () => {
    const before = (await svc.project()).sources.length;
    const { outcomes } = await svc.ingest([{ uri: blocked.url, label: "blocked" }]);
    expect(outcomes[0]!.status).toBe("failed");
    expect(String(outcomes[0]!.error)).toMatch(/bot check|block page/);
    const g = await svc.genome();
    expect(g.anatomy!.pieces.filter((p) => p.sourceId !== sourceId)).toHaveLength(0);
    expect((await svc.project()).sources.length).toBe(before + 1);
  });
});
