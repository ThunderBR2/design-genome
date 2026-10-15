import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { detectBlocks } from "../../src/anatomy/blocks.js";
import { adaptLayout } from "../../src/anatomy/blueprint.js";
import { analyzeLayout, aspectName } from "../../src/anatomy/layout.js";
import { invariants } from "../../src/anatomy/reading.js";
import type { Piece } from "../../src/anatomy/types.js";

/** A 4:5 post with a known layout: 96px margins, two-line headline, subline, image band, pill button, wordmark. */
const poster = (headline: [string, string], colors: [string, string]) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350">
<rect width="1080" height="1350" fill="#f4efe6"/>
<text x="96" y="200" font-family="DejaVu Sans, Arial" font-weight="700" font-size="96" fill="#1b1b1b">${headline[0]}</text>
<text x="96" y="310" font-family="DejaVu Sans, Arial" font-weight="700" font-size="96" fill="#1b1b1b">${headline[1]}</text>
<text x="96" y="400" font-family="DejaVu Sans, Arial" font-size="32" fill="#555">Fresh bowls, cold brew and long afternoons.</text>
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient></defs>
<rect x="96" y="480" width="888" height="560" fill="url(#g)"/>
<rect x="96" y="1120" width="320" height="96" rx="48" fill="#1b1b1b"/>
<text x="150" y="1182" font-family="DejaVu Sans, Arial" font-size="34" fill="#fff">Order now</text>
<text x="820" y="1182" font-family="DejaVu Sans, Arial" font-weight="700" font-size="34" fill="#1b1b1b">LUMEN</text>
</svg>`)).png().toBuffer();

const near = (a: number, b: number, tol: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

const pieceOf = async (headline: [string, string], colors: [string, string], id: string): Promise<Piece> => {
  const reading = await detectBlocks(await poster(headline, colors));
  return { id, sourceId: id.split("#")[0]!, index: 1, kind: "image", label: id, precision: "estimated", artifact: "", overlay: "", anatomy: analyzeLayout(reading.width, reading.height, reading.background, reading.blocks) };
};

describe("anatomy", () => {
  it("finds the blocks of a piece in its pixels", async () => {
    const r = await detectBlocks(await poster(["Summer drop", "is here now"], ["#e2683c", "#3c6ee2"]));
    expect(r.background.uniform).toBe(true);
    const headline = r.blocks.find((b) => b.kind === "text" && (b.text?.lines ?? 0) === 2)!;
    expect(headline).toBeDefined();
    near(headline.box.x, 96, 8);
    near(headline.text!.linePitchPx!, 110, 6);
    const image = r.blocks.find((b) => b.kind === "image")!;
    near(image.box.x, 96, 6);
    near(image.box.w, 888, 12);
    near(image.box.h, 560, 12);
    const button = r.blocks.findIndex((b) => b.kind === "control");
    expect(button).toBeGreaterThanOrEqual(0);
    expect(r.blocks.some((b) => b.kind === "text" && b.parentIndex === button)).toBe(true);
  });

  it("measures margins, shared edges, hierarchy and reading path", async () => {
    const { anatomy: a } = await pieceOf(["Summer drop", "is here now"], ["#e2683c", "#3c6ee2"], "src_a#1");
    expect(a.canvas.aspectName).toBe("4:5");
    near(a.margins.left, 96, 8);
    near(a.margins.left, a.margins.right, 10);
    const left = a.axes.find((x) => x.edge === "left")!;
    expect(left.blocks.length).toBeGreaterThanOrEqual(4);
    expect(a.hierarchy.textScale[0]!.ratioToSmallest).toBeGreaterThan(2.5);
    expect(a.readingPath.pattern).toContain("flush-left");
    expect(a.summary.length).toBeGreaterThan(5);
  });

  it("names aspect ratios", () => {
    expect(aspectName(1080, 1920)).toBe("9:16");
    expect(aspectName(2480, 3508)).toBe("1:√2 (A-series)");
  });

  it("finds what stays constant across pieces", async () => {
    const pieces = [await pieceOf(["Summer drop", "is here now"], ["#e2683c", "#3c6ee2"], "src_a#1"), await pieceOf(["Winter menu", "warms you up"], ["#3a5a40", "#a3b18a"], "src_b#1")];
    const inv = invariants(pieces);
    expect(inv.find((i) => i.feature === "margin-left")!.constant).toBe(true);
    expect(inv.find((i) => i.feature === "aspect")!.constant).toBe(true);
  });

  it("re-lays a piece out on a new format and keeps it inside the canvas", async () => {
    const piece = await pieceOf(["Summer drop", "is here now"], ["#e2683c", "#3c6ee2"], "src_a#1");
    const { elements, margins, warnings } = adaptLayout(piece, 1080, 1920);
    near(margins.left, piece.anatomy.margins.left, 1);
    for (const e of elements) {
      expect(e.box.x).toBeGreaterThanOrEqual(0);
      expect(e.box.y).toBeGreaterThanOrEqual(0);
      expect(e.box.x + e.box.w).toBeLessThanOrEqual(1080);
      expect(e.box.y + e.box.h).toBeLessThanOrEqual(1920);
    }
    const image = elements.find((e) => e.kind === "image")!;
    const original = piece.anatomy.blocks.find((b) => b.kind === "image")!;
    // The taller canvas goes to the flexible image; type keeps its size (same short side).
    expect(image.box.h).toBeGreaterThan(original.box.h);
    expect(elements.find((e) => e.role === "headline")!.sizePx).toBe(piece.anatomy.hierarchy.textScale[0]!.sizePx);
    expect(warnings).toEqual([]);
  });
});
