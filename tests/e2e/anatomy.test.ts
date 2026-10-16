import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { exportGenome } from "../../src/export/index.js";
import { GenomeService } from "../../src/service.js";
import { TOOLS } from "../../src/tools.js";
import { serveDirectory } from "../support/server.js";

/**
 * The anatomy cycle: measure pieces (site sections from rendered boxes, posters
 * from pixels), store a host reading per piece, read the concept, then plan a
 * new piece in another format.
 */
const fixtures = join(import.meta.dirname, "..", "fixtures");

const poster = (title: string, a: string, b: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350">
<rect width="1080" height="1350" fill="#f4efe6"/>
<text x="96" y="200" font-family="DejaVu Sans, Arial" font-weight="700" font-size="96" fill="#1b1b1b">${title}</text>
<text x="96" y="290" font-family="DejaVu Sans, Arial" font-size="32" fill="#555">A short line that supports the headline.</text>
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
<rect x="96" y="380" width="888" height="660" fill="url(#g)"/>
<rect x="96" y="1120" width="320" height="96" rx="48" fill="#1b1b1b"/>
<text x="150" y="1182" font-family="DejaVu Sans, Arial" font-size="34" fill="#fff">Order now</text></svg>`)).png();

describe("anatomy cycle", () => {
  let dir: string;
  let site: Awaited<ReturnType<typeof serveDirectory>>;
  let svc: GenomeService;
  const ctx = () => ({ projectDir: join(dir, "project"), client: "test", log: () => undefined });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "genome-anatomy-"));
    site = await serveDirectory(join(fixtures, "site"));
    await poster("Summer drop", "#e2683c", "#3c6ee2").toFile(join(dir, "post-1.png"));
    await poster("Winter menu", "#3a5a40", "#a3b18a").toFile(join(dir, "post-2.png"));
    svc = new GenomeService(join(dir, "project"));
    await svc.init("Lumen");
    await svc.ingest([{ uri: site.url, label: "site" }, { uri: join(dir, "post-1.png") }, { uri: join(dir, "post-2.png") }]);
  });

  afterAll(async () => {
    await site?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("measures site sections exactly and posters from pixels", async () => {
    const g = await svc.genome();
    const pieces = g.anatomy!.pieces;
    const sections = pieces.filter((p) => p.kind === "web-section");
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(sections.every((p) => p.precision === "exact")).toBe(true);
    expect(pieces.filter((p) => p.kind === "image")).toHaveLength(2);
    for (const p of pieces) expect(existsSync(join(dir, "project", p.overlay))).toBe(true);
    expect(g.anatomy!.invariants.visual?.find((i) => i.feature === "margin-left")?.constant).toBe(true);
  });

  it("stores readings, turns their rules into genome rules, and reads the concept", async () => {
    const reading = (pieceId: string) => ({
      pieceId,
      whatItIs: "A seasonal social post: headline, image band and button.",
      pieceType: "social post",
      summary: "Seasonal post.",
      elements: [{ block: 1, role: "headline", why: "On the shared left margin." }],
      composition: { structure: "flush-left column with an image band", eyePath: "headline → image → button", principles: [{ name: "alignment", how: "one left edge", why: "order" }] },
      whyItWorks: ["one strong left axis"],
      intent: { message: "new menu" },
      rules: [{ topic: "layout", statement: "Every block starts on the same left margin, about nine percent of the width", polarity: "must", confidence: 0.7 }],
    });
    let next = await svc.dissectRequest();
    let guard = 0;
    while (next && guard++ < 20) {
      const id = next.images.piece.id;
      if (next.images.piece.kind === "image") await TOOLS.genome_dissect_submit(reading(id), ctx());
      else await TOOLS.genome_dissect_submit({ ...reading(id), pieceType: "landing section", rules: [] }, ctx());
      next = await svc.dissectRequest();
    }
    const g = await svc.genome();
    const readable = g.anatomy!.pieces.filter((p) => !p.skipped && p.triage !== "skip");
    expect(readable.length).toBeGreaterThanOrEqual(4);
    expect(readable.every((p) => p.reading)).toBe(true);
    // A one-line strip (the mobile footer) is set aside by the pre-check, with its reason, and never read.
    for (const p of g.anatomy!.pieces.filter((p) => p.triage === "skip")) expect(p.reading).toBeUndefined();
    const rule = g.rules.find((r) => r.statement.startsWith("Every block starts on the same left margin"))!;
    expect(rule.origin).toBe("inferred");
    expect(rule.support.status).toBe("confirmed");

    const request = await TOOLS.genome_concept_request({}, ctx());
    expect(request.content.some((c) => c.type === "image")).toBe(true);
    await TOOLS.genome_concept_submit({ bigIdea: "Seasons as menus", concept: "Calm editorial posts", why: "A crafted food brand", constants: [{ what: "9% margin", why: "order" }], variables: [{ what: "image colors", range: "seasonal" }], grammar: ["headline top-left", "image band", "button bottom-left"] }, ctx());
    const brief = exportGenome(await svc.genome(), "brief").content;
    expect(brief).toContain("Seasons as menus");
    expect(brief).toContain("Composition constants");
    expect(exportGenome(await svc.genome(), "anatomy").content).toContain("Why it works");
  });

  it("plans a new piece in another format", async () => {
    const bp = await svc.blueprint({ request: "story for the autumn menu", format: "story" });
    expect(bp.canvas).toMatchObject({ w: 1080, h: 1920 });
    expect(bp.references[0]!.id).toMatch(/#1$/);
    expect(bp.elements.length).toBeGreaterThan(2);
    expect(bp.margins.top).toBeGreaterThanOrEqual(250);
    expect(bp.markdown).toContain("Seasons as menus");
    expect(existsSync(join(dir, "project", bp.wireframe!))).toBe(true);
    const tool = await TOOLS.genome_blueprint({ request: "landing hero", format: "web-desktop" }, ctx());
    expect(tool.content.filter((c) => c.type === "image").length).toBeGreaterThanOrEqual(2);
  });
});
