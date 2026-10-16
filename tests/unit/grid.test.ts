import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { analyzeLayout, type LayoutInput } from "../../src/anatomy/layout.js";
import { inkInBox, dHash, hamming } from "../../src/anatomy/triage.js";

const bg = { hex: "#ffffff", uniform: true };
const text = (x: number, y: number, w: number, h: number, sizePx = 18, pitch = 24): LayoutInput => ({ kind: "text", box: { x, y, w, h }, color: "#111111", background: "#ffffff", contrast: 90, text: { lines: Math.max(1, Math.round(h / pitch)), linePitchPx: pitch, sizePx, exact: true } });
const image = (x: number, y: number, w: number, h: number): LayoutInput => ({ kind: "image", box: { x, y, w, h }, color: "#3366cc", background: "#ffffff", contrast: 40 });

describe("grid reading", () => {
  it("finds a 4-column web grid and the columns each block spans; text ends where its words end", () => {
    // 1440 wide, 160px margins, 4 columns of 256px with 32px gutters: starts at 160, 448, 736, 1024.
    const starts = [160, 448, 736, 1024];
    const blocks: LayoutInput[] = [
      text(160, 40, 520, 90, 64, 70),
      ...starts.map((x) => text(x, 200, 140, 30, 32, 36)),
      ...starts.map((x) => text(x, 250, 200, 96, 18, 24)),
      image(160, 400, 544, 400), image(736, 400, 544, 400),
      image(160, 832, 1120, 500),
    ];
    const a = analyzeLayout(1440, 1400, bg, blocks, { web: true, exact: true });
    expect(a.grids?.kind).toBe("column");
    expect(a.grids?.columns?.columns).toBe(4);
    expect(a.grids?.columns?.gutterPx).toBeGreaterThanOrEqual(28);
    expect(a.grids?.columns?.gutterPx).toBeLessThanOrEqual(36);
    const wide = a.blocks.find((b) => b.kind === "image" && b.box.w === 1120)!;
    expect(a.grids?.columnSpans.find((s) => s.block === wide.n)).toMatchObject({ from: 1, to: 4 });
    const half = a.blocks.find((b) => b.kind === "image" && b.box.x === 736)!;
    expect(a.grids?.columnSpans.find((s) => s.block === half.n)).toMatchObject({ from: 3, to: 4 });
    expect(a.grids?.container).toMatchObject({ widthPx: 1120, marginPx: 160 });
    expect(a.summary.join(" ")).toContain("4-column grid");
  });

  it("calls a scattered layout a free composition instead of inventing narrow columns", () => {
    const blocks: LayoutInput[] = [text(24, 30, 120, 30), image(170, 90, 140, 90), text(61, 220, 200, 48), image(250, 300, 90, 140), text(37, 480, 280, 30)];
    const a = analyzeLayout(390, 600, bg, blocks, { web: true, exact: true });
    expect(a.grids?.kind === "free" || a.grids?.kind === "manuscript").toBe(true);
    expect(a.grids?.columns?.columns ?? 1).toBe(1);
  });

  it("reads a modular grid (columns × rows) on a poster", () => {
    // 1080×1350 poster, 3 columns × 3 rows of image modules with 30px gutters inside 90px margins.
    const cw = (1080 - 180 - 60) / 3, rh = (1350 - 180 - 60) / 3;
    const blocks: LayoutInput[] = [];
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) if ((c + r) % 2 === 0 || c === 1) blocks.push(image(90 + c * (cw + 30), 90 + r * (rh + 30), cw, rh));
    const a = analyzeLayout(1080, 1350, bg, blocks, { web: false, exact: false });
    expect(a.grids?.kind).toBe("modular");
    expect(a.grids?.columns?.columns).toBe(3);
    expect(a.grids?.rows?.count).toBe(3);
  });

  it("finds the baseline the text sits on, and only when it beats chance", () => {
    const tops = [96, 144, 216, 264, 336, 408, 456];
    const a = analyzeLayout(1080, 600, bg, tops.map((y, i) => text(80 + (i % 2) * 400, y, 300, 24)), { exact: true });
    expect(a.grids?.baseline?.unitPx).toBeDefined();
    expect(24 % a.grids!.baseline!.unitPx === 0 || a.grids!.baseline!.unitPx % 24 === 0).toBe(true);
    const random = analyzeLayout(1080, 600, bg, [93, 141, 205, 270, 329, 413, 467].map((y, i) => text(80 + (i % 2) * 400, y, 300, 24)), { exact: true });
    expect(random.grids?.baseline).toBeNull();
  });

  it("notices a composition built on the thirds", () => {
    const blocks: LayoutInput[] = [image(360, 0, 720, 1350), text(60, 450, 290, 120, 48, 56), text(60, 900, 290, 60)];
    const a = analyzeLayout(1080, 1350, bg, blocks, { exact: false });
    expect(a.grids?.proportional?.system).toBe("thirds");
  });
});

describe("triage helpers", () => {
  it("tells painted text from an empty box on the same ground", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><rect width="600" height="200" fill="#000"/><text x="20" y="80" font-family="DejaVu Sans" font-size="40" fill="#bbbbbb">Visible words</text></svg>`;
    const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const raw = { data, width: info.width, height: info.height, channels: info.channels };
    expect((await inkInBox(raw, { x: 15, y: 40, w: 300, h: 50 }, "#ffffff", "#000000")).painted).toBe(true);
    expect((await inkInBox(raw, { x: 15, y: 120, w: 300, h: 50 }, "#ffffff", "#000000")).painted).toBe(false);
  });

  it("spots near-duplicate pictures", async () => {
    const pic = (c: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#fff"/><rect x="30" y="30" width="140" height="90" fill="${c}"/></svg>`)).png().toBuffer();
    const a = await dHash(await pic("#222")), b = await dHash(await pic("#232323"));
    const c = await dHash(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#fff"/><circle cx="220" cy="140" r="50" fill="#222"/></svg>`)).png().toBuffer());
    expect(hamming(a, b)).toBeLessThanOrEqual(4);
    expect(hamming(a, c)).toBeGreaterThan(4);
  });
});
