import { cluster1D } from "../core/numeric.js";
import type { AlignmentAxis, Anatomy, Block, BlockKind, Box, Gap, GridReading } from "./types.js";

/**
 * Turns a list of element boxes into the measured anatomy of a piece: margins,
 * live area, alignment axes, gaps and spacing rhythm, column grid, scale
 * hierarchy, balance, proportion, whitespace and reading path. Works the same
 * for boxes found in pixels and boxes read from the DOM.
 */

export interface LayoutInput {
  readonly kind: BlockKind;
  readonly box: Box;
  readonly color?: string;
  readonly background?: string;
  readonly contrast?: number;
  readonly parentIndex?: number;
  readonly text?: Block["text"];
  readonly selector?: string;
  readonly tag?: string;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const pct = (n: number): string => `${Math.round(n * 1000) / 10}%`;

const ASPECTS: readonly { name: string; ratio: number }[] = [
  { name: "1:1", ratio: 1 },
  { name: "4:5", ratio: 0.8 },
  { name: "5:4", ratio: 1.25 },
  { name: "3:4", ratio: 0.75 },
  { name: "4:3", ratio: 4 / 3 },
  { name: "2:3", ratio: 2 / 3 },
  { name: "3:2", ratio: 1.5 },
  { name: "9:16", ratio: 9 / 16 },
  { name: "16:9", ratio: 16 / 9 },
  { name: "1:√2 (A-series)", ratio: 1 / Math.SQRT2 },
  { name: "√2:1 (A-series landscape)", ratio: Math.SQRT2 },
  { name: "1:1.618 (golden)", ratio: 1 / 1.618 },
  { name: "1.618:1 (golden)", ratio: 1.618 },
  { name: "1.91:1", ratio: 1.91 },
  { name: "21:9", ratio: 21 / 9 },
];

export const aspectName = (w: number, h: number): string => {
  const ratio = w / h;
  const best = ASPECTS.map((a) => ({ ...a, err: Math.abs(a.ratio - ratio) / a.ratio })).sort((a, b) => a.err - b.err)[0]!;
  if (best.err <= 0.02) return best.name;
  return ratio >= 1 ? `${r2(ratio)}:1` : `1:${r2(1 / ratio)}`;
};

const POWER_POINTS: readonly { name: string; x: number; y: number }[] = [
  { name: "center", x: 0.5, y: 0.5 },
  ...[1 / 3, 2 / 3].flatMap((x) => [1 / 3, 2 / 3].map((y) => ({ name: `thirds ${x < 0.5 ? "left" : "right"}-${y < 0.5 ? "top" : "bottom"}`, x, y }))),
  ...[0.382, 0.618].flatMap((x) => [0.382, 0.618].map((y) => ({ name: `golden ${x < 0.5 ? "left" : "right"}-${y < 0.5 ? "top" : "bottom"}`, x, y }))),
  { name: "upper center (optical center)", x: 0.5, y: 0.42 },
];

const contains = (outer: Box, inner: Box, tol = 1): boolean =>
  inner.x >= outer.x - tol && inner.y >= outer.y - tol && inner.x + inner.w <= outer.x + outer.w + tol && inner.y + inner.h <= outer.y + outer.h + tol;

/** Number blocks in reading order: rows top to bottom, left to right inside a row. */
const readingSort = (items: LayoutInput[]): LayoutInput[] => {
  const sorted = [...items].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const rows: LayoutInput[][] = [];
  for (const it of sorted) {
    const row = rows.at(-1);
    const ref = row?.[0];
    if (row && ref && it.box.y < ref.box.y + Math.min(ref.box.h, it.box.h) * 0.5) row.push(it);
    else rows.push([it]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.box.x - b.box.x));
};

/** Largest empty rectangle on a coarse occupancy grid (maximal rectangle in a histogram). */
const largestEmpty = (occupied: boolean[][], cellW: number, cellH: number): Box | null => {
  const rows = occupied.length, cols = occupied[0]?.length ?? 0;
  const heights = new Array(cols).fill(0) as number[];
  let best = { area: 0, x: 0, y: 0, w: 0, h: 0 };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) heights[x] = occupied[y]![x] ? 0 : heights[x]! + 1;
    const stack: number[] = [];
    for (let x = 0; x <= cols; x++) {
      const hgt = x === cols ? 0 : heights[x]!;
      while (stack.length && heights[stack.at(-1)!]! >= hgt) {
        const top = stack.pop()!;
        const height = heights[top]!;
        const left = stack.length ? stack.at(-1)! + 1 : 0;
        const width = x - left;
        if (width * height > best.area) best = { area: width * height, x: left, y: y - height + 1, w: width, h: height };
      }
      stack.push(x);
    }
  }
  return best.area ? { x: Math.round(best.x * cellW), y: Math.round(best.y * cellH), w: Math.round(best.w * cellW), h: Math.round(best.h * cellH) } : null;
};

const fitGrid = (edges: { left: number[]; right: number[] }, live: Box, W: number): GridReading | null => {
  const all = [...edges.left, ...edges.right];
  if (edges.left.length < 3) return null;
  const tol = Math.max(3, W * 0.008);
  const evaluate = (n: number, g: number): GridReading | null => {
    const col = (live.w - (n - 1) * g) / n;
    if (col < W * 0.05) return null;
    const lines: number[] = [];
    for (let k = 0; k < n; k++) { const l = live.x + k * (col + g); lines.push(l, l + col); }
    const hits = all.filter((e) => lines.some((l) => Math.abs(l - e) <= tol)).length;
    // Columns the content actually starts in: a grid nobody uses is not a grid.
    const used = new Set(edges.left.map((e) => lines.findIndex((l, i) => i % 2 === 0 && Math.abs(l - e) <= tol)).filter((i) => i >= 0)).size;
    return { columns: n, gutterPx: Math.round(g), marginPx: Math.round(live.x), columnPx: Math.round(col), fit: r2(hits / all.length), description: "", used } as GridReading & { used: number };
  };
  const single = evaluate(1, 0);
  let best = single as (GridReading & { used: number }) | null;
  for (let n = 2; n <= 12; n++) {
    for (let g = 0; g <= W * 0.06; g += Math.max(1, W * 0.005)) {
      const c = evaluate(n, g) as (GridReading & { used: number }) | null;
      if (!c || c.used < 2 || all.length < 8) continue;
      // A multi-column grid must explain clearly more edges than a single column, and each column must earn its place.
      const gain = c.fit - (single?.fit ?? 0);
      const score = c.fit - 0.04 * (n - 1);
      const bestScore = best ? best.fit - 0.04 * (best.columns - 1) : -1;
      if (gain >= 0.15 && c.fit >= 0.75 && score > bestScore + 1e-9) best = c;
    }
  }
  if (!best || best.fit < 0.5) return null;
  const { used: _u, ...grid } = best;
  const description = grid.columns === 1
    ? `Single column ${grid.columnPx}px wide (${pct(grid.columnPx / W)} of the width), ${grid.marginPx}px side margin; ${Math.round(grid.fit * 100)}% of block edges sit on it.`
    : `${grid.columns}-column grid: columns ${grid.columnPx}px, gutter ${grid.gutterPx}px (${pct(grid.gutterPx / W)}), margin ${grid.marginPx}px; ${Math.round(grid.fit * 100)}% of block edges land on a column line.`;
  return { ...grid, description };
};

export const analyzeLayout = (W: number, H: number, background: { hex: string; uniform: boolean }, input: readonly LayoutInput[]): Anatomy => {
  // Keep the input index so parents can be renumbered after sorting.
  const tagged = input.map((b, i) => ({ ...b, _i: i }));
  const ordered = readingSort(tagged) as (LayoutInput & { _i: number })[];
  const numberOf = new Map(ordered.map((b, k) => [b._i, k + 1]));
  const canvasArea = W * H;
  const rawWeights = ordered.map((b) => {
    const area = (b.box.w * b.box.h) / canvasArea;
    const contrast = (b.contrast ?? 30) / 100;
    // Text reads heavier than its ink suggests; panels and bleed images are ground, not figure.
    const factor = b.kind === "text" ? 1.6 : b.kind === "panel" ? 0.35 : 1;
    return area * Math.max(0.05, contrast) * factor;
  });
  const maxW = Math.max(...rawWeights, 1e-9);
  const blocks: Block[] = ordered.map((b, k) => {
    const edges = [b.box.x <= W * 0.01, b.box.y <= H * 0.01, b.box.x + b.box.w >= W * 0.99, b.box.y + b.box.h >= H * 0.99].filter(Boolean).length;
    const parent = b.parentIndex !== undefined ? numberOf.get(b.parentIndex) : undefined;
    return {
      n: k + 1,
      kind: b.kind,
      box: b.box,
      rel: { x: r3(b.box.x / W), y: r3(b.box.y / H), w: r3(b.box.w / W), h: r3(b.box.h / H) },
      areaShare: r3((b.box.w * b.box.h) / canvasArea),
      ...(b.color ? { color: b.color } : {}),
      ...(b.background ? { background: b.background } : {}),
      ...(b.contrast !== undefined ? { contrast: b.contrast } : {}),
      weight: r3(rawWeights[k]! / maxW),
      ...(parent ? { parent } : {}),
      ...(b.text ? { text: b.text } : {}),
      ...(edges >= 2 || (b.box.w * b.box.h) / canvasArea > 0.8 ? { bleed: true } : {}),
      ...(b.selector ? { selector: b.selector } : {}),
      ...(b.tag ? { tag: b.tag } : {}),
    };
  });

  // Content: what is set on the canvas, not the ground it sits on.
  const content = blocks.filter((b) => !b.bleed);
  const measured = content.length ? content : blocks;
  const left = Math.min(...measured.map((b) => b.box.x));
  const top = Math.min(...measured.map((b) => b.box.y));
  const right = W - Math.max(...measured.map((b) => b.box.x + b.box.w));
  const bottom = H - Math.max(...measured.map((b) => b.box.y + b.box.h));
  const margins = blocks.length
    ? { left: Math.max(0, left), right: Math.max(0, right), top: Math.max(0, top), bottom: Math.max(0, bottom) }
    : { left: 0, right: 0, top: 0, bottom: 0 };
  const marginsRel = { left: r3(margins.left / W), right: r3(margins.right / W), top: r3(margins.top / H), bottom: r3(margins.bottom / H) };
  const liveArea = { x: margins.left, y: margins.top, w: W - margins.left - margins.right, h: H - margins.top - margins.bottom };

  // Alignment axes: edges that several blocks share.
  const axes: AlignmentAxis[] = [];
  const axisSpecs: { edge: AlignmentAxis["edge"]; side: number; pick: (b: Block) => number; skip?: (b: Block) => boolean }[] = [
    { edge: "left", side: W, pick: (b) => b.box.x },
    { edge: "right", side: W, pick: (b) => b.box.x + b.box.w },
    { edge: "center-x", side: W, pick: (b) => b.box.x + b.box.w / 2, skip: (b) => b.box.w > W * 0.85 },
    { edge: "top", side: H, pick: (b) => b.box.y },
    { edge: "bottom", side: H, pick: (b) => b.box.y + b.box.h },
    { edge: "center-y", side: H, pick: (b) => b.box.y + b.box.h / 2, skip: (b) => b.box.h > H * 0.85 },
  ];
  const alignable = blocks.filter((b) => !b.bleed);
  for (const spec of axisSpecs) {
    const items = alignable.filter((b) => !spec.skip?.(b)).map((b) => ({ value: spec.pick(b), weight: 1, n: b.n }));
    for (const c of cluster1D(items, Math.max(2, spec.side * 0.006))) {
      const members = [...new Set(c.members.map((m) => m.n))];
      if (members.length >= 2) axes.push({ edge: spec.edge, at: Math.round(c.center), rel: r3(c.center / spec.side), blocks: members });
    }
  }
  axes.sort((a, b) => b.blocks.length - a.blocks.length);
  const topAxes = axes.slice(0, 10);

  // Gaps to the nearest neighbour below and to the right (siblings on the same ground).
  const gaps: Gap[] = [];
  for (const a of alignable) {
    let below: { b: Block; d: number } | null = null, beside: { b: Block; d: number } | null = null;
    for (const b of alignable) {
      if (a === b || a.parent !== b.parent || contains(a.box, b.box) || contains(b.box, a.box)) continue;
      const xOverlap = Math.min(a.box.x + a.box.w, b.box.x + b.box.w) - Math.max(a.box.x, b.box.x);
      const yOverlap = Math.min(a.box.y + a.box.h, b.box.y + b.box.h) - Math.max(a.box.y, b.box.y);
      const dy = b.box.y - (a.box.y + a.box.h);
      const dx = b.box.x - (a.box.x + a.box.w);
      if (xOverlap > 0 && dy >= 0 && (!below || dy < below.d)) below = { b, d: dy };
      if (yOverlap > 0 && dx >= 0 && (!beside || dx < beside.d)) beside = { b, d: dx };
    }
    if (below) gaps.push({ between: [a.n, below.b.n], axis: "y", px: Math.round(below.d), rel: r3(below.d / H) });
    if (beside) gaps.push({ between: [a.n, beside.b.n], axis: "x", px: Math.round(beside.d), rel: r3(beside.d / W) });
  }

  // Rhythm: which gap sizes repeat, and whether they are multiples of one unit.
  const gapClusters = cluster1D(gaps.filter((g) => g.px >= 2 && g.rel <= 0.25).map((g) => ({ value: g.px, weight: 1 })), 0.12, true);
  const values = gapClusters.map((c) => ({ px: Math.round(c.center), rel: r3(c.center / H), count: c.members.length })).sort((a, b) => a.px - b.px);
  let unitPx: number | null = null;
  let multiples: number[] = [];
  if (values.length >= 2) {
    const unit = values[0]!.px;
    const ratios = values.map((v) => v.px / unit);
    const fits = ratios.filter((x) => Math.abs(x - Math.round(x)) <= 0.15).length;
    if (unit >= 2 && fits / ratios.length >= 0.7) { unitPx = unit; multiples = ratios.map((x) => Math.round(x)); }
    else multiples = ratios.map((x) => r2(x));
  }
  const rhythmText = !values.length
    ? "Too few neighbouring blocks to read a spacing rhythm."
    : values.length === 1
      ? `One repeated gap: ${values[0]!.px}px (${pct(values[0]!.rel)} of the height, ${values[0]!.count}×).`
    : unitPx
      ? `Gaps are multiples of ${unitPx}px (${pct(unitPx / H)} of the height): ${values.map((v, i) => `${v.px}px (×${multiples[i]}, ${v.count}×)`).join(", ")}.`
      : `Distinct gaps: ${values.map((v) => `${v.px}px (${v.count}×)`).join(", ")}; ratios to the smallest ${multiples.join(" : ")} — no single unit explains them.`;

  // Grid from the left/right edges of content inside the live area.
  const topLevel = content.filter((b) => !b.parent);
  const grid = fitGrid({ left: topLevel.map((b) => b.box.x), right: topLevel.map((b) => b.box.x + b.box.w) }, liveArea, W);

  // Hierarchy: weight order, and the text size ladder.
  const order = [...blocks].filter((b) => !b.bleed && b.kind !== "panel").sort((a, b) => b.weight - a.weight).map((b) => b.n);
  const texts = blocks.filter((b) => b.kind === "text" && b.text?.sizePx).sort((a, b) => (b.text!.sizePx ?? 0) - (a.text!.sizePx ?? 0));
  const smallest = texts.at(-1)?.text?.sizePx ?? 0;
  const textScale = texts.map((b) => ({ block: b.n, sizePx: b.text!.sizePx!, ratioToSmallest: smallest ? r2(b.text!.sizePx! / smallest) : 1 }));
  const levels = cluster1D(texts.map((t) => ({ value: t.text!.sizePx!, weight: 1 })), 0.12, true).length;
  const hierText = order.length
    ? `Heaviest first: ${order.slice(0, 5).map((n) => `#${n}`).join(" → ")}.${texts.length ? ` ${levels} text size level(s); the largest text is ${textScale[0]!.ratioToSmallest}× the smallest${texts.length > 1 ? ` (${textScale.map((t) => `#${t.block} ≈${t.sizePx}px`).join(", ")})` : ""}.` : ""}`
    : "No figure blocks found.";

  // Balance.
  const figure = blocks.filter((b) => !b.bleed && b.kind !== "panel");
  const tw = figure.reduce((s, b) => s + b.weight, 0) || 1;
  const cx = figure.reduce((s, b) => s + b.weight * (b.box.x + b.box.w / 2), 0) / tw / W;
  const cy = figure.reduce((s, b) => s + b.weight * (b.box.y + b.box.h / 2), 0) / tw / H;
  const quad = { tl: 0, tr: 0, bl: 0, br: 0 };
  for (const b of figure) {
    const x = (b.box.x + b.box.w / 2) / W, y = (b.box.y + b.box.h / 2) / H;
    quad[`${y < 0.5 ? "t" : "b"}${x < 0.5 ? "l" : "r"}` as keyof typeof quad] += b.weight / tw;
  }
  const centeredBlocks = figure.filter((b) => Math.abs((b.box.x + b.box.w / 2) / W - 0.5) < 0.025).length;
  const mirrored = figure.filter((b) => figure.some((o) => o !== b && Math.abs(o.box.x - (W - b.box.x - b.box.w)) < W * 0.02 && Math.abs(o.box.y - b.box.y) < H * 0.02 && Math.abs(o.box.w - b.box.w) < W * 0.03)).length;
  const symmetry: Anatomy["balance"]["symmetry"] = figure.length && centeredBlocks / figure.length >= 0.5 ? "centered" : figure.length && mirrored / figure.length >= 0.5 ? "mirrored" : "asymmetric";
  const heavySide = Math.abs(cx - 0.5) < 0.04 ? "balanced left-right" : cx < 0.5 ? `weighted to the left (${pct(cx)})` : `weighted to the right (${pct(cx)})`;
  const heavyEnd = Math.abs(cy - 0.5) < 0.04 ? "balanced top-bottom" : cy < 0.5 ? `weighted to the top (${pct(cy)})` : `weighted to the bottom (${pct(cy)})`;

  // Proportion: where the heaviest block sits relative to thirds, golden lines and the optical center.
  const focalBlock = blocks.find((b) => b.n === order[0]);
  let proportion: Anatomy["proportion"] = { focal: null, nearestPowerPoint: null, offsetRel: null, description: "No focal block." };
  if (focalBlock) {
    const fx = (focalBlock.box.x + focalBlock.box.w / 2) / W, fy = (focalBlock.box.y + focalBlock.box.h / 2) / H;
    const near = POWER_POINTS.map((p) => ({ ...p, d: Math.hypot(p.x - fx, p.y - fy) })).sort((a, b) => a.d - b.d)[0]!;
    proportion = { focal: focalBlock.n, nearestPowerPoint: near.name, offsetRel: r3(near.d), description: `Focal block #${focalBlock.n} is centered at ${pct(fx)} × ${pct(fy)}, ${near.d < 0.04 ? "on" : `${pct(near.d)} from`} the ${near.name} point.` };
  }

  // Whitespace on a 48×48 grid: cells no figure block touches.
  const cells = 48;
  const cellW = W / cells, cellH = H / cells;
  const occupied = Array.from({ length: cells }, () => new Array(cells).fill(false) as boolean[]);
  for (const b of figure) {
    const x0 = Math.floor(b.box.x / cellW), x1 = Math.min(cells - 1, Math.floor((b.box.x + b.box.w - 1) / cellW));
    const y0 = Math.floor(b.box.y / cellH), y1 = Math.min(cells - 1, Math.floor((b.box.y + b.box.h - 1) / cellH));
    for (let y = Math.max(0, y0); y <= y1; y++) for (let x = Math.max(0, x0); x <= x1; x++) occupied[y]![x] = true;
  }
  const empty = occupied.flat().filter((o) => !o).length / (cells * cells);
  const hole = largestEmpty(occupied, cellW, cellH);
  const bleedImage = blocks.some((b) => b.bleed && (b.kind === "image" || b.kind === "panel"));
  const whitespace = {
    share: r3(empty),
    largestEmpty: hole,
    description: `${pct(empty)} of the canvas is open ground${bleedImage ? " (over a full-bleed image or color field)" : ""}${hole ? `; the largest open area is ${hole.w}×${hole.h}px at ${pct(hole.x / W)}, ${pct(hole.y / H)}` : ""}.`,
  };

  // Reading path through the heaviest blocks.
  const path = order.slice(0, 6);
  const pos = path.map((n) => blocks.find((b) => b.n === n)!).map((b) => ({ x: (b.box.x + b.box.w / 2) / W, y: (b.box.y + b.box.h / 2) / H }));
  let pattern = "weight-led";
  if (pos.length >= 2) {
    const xs = pos.map((p) => p.x);
    const spreadX = Math.max(...xs) - Math.min(...xs);
    const leftAxis = topAxes.find((a) => a.edge === "left" && a.blocks.length >= Math.min(3, path.length));
    if (spreadX < 0.08) pattern = "single vertical axis (centered)";
    else if (leftAxis && leftAxis.blocks.length >= figure.length * 0.6) pattern = "flush-left column (F)";
    else if (pos.length >= 3 && pos[0]!.y < 0.5 && pos.at(-1)!.y > 0.5 && pos.some((p, i) => i > 0 && Math.abs(p.x - pos[0]!.x) > 0.3)) pattern = "zig-zag (Z)";
    else if (pos.length >= 2 && Math.sign(pos.at(-1)!.x - pos[0]!.x) === Math.sign(pos.at(-1)!.y - pos[0]!.y) && Math.abs(pos.at(-1)!.x - pos[0]!.x) > 0.3) pattern = "diagonal";
  }
  const readingPath = { order: path, pattern, description: path.length ? `The eye lands on #${path[0]} and moves ${path.slice(1).map((n) => `#${n}`).join(" → ") || "nowhere else"}: ${pattern}.` : "No reading path." };

  const textBlocks = blocks.filter((b) => b.kind === "text");
  const density = {
    blocks: blocks.length,
    textBlocks: textBlocks.length,
    textShare: r3(textBlocks.reduce((s, b) => s + b.areaShare, 0)),
    imageShare: r3(blocks.filter((b) => b.kind === "image").reduce((s, b) => s + b.areaShare, 0)),
  };

  const axisText = topAxes.slice(0, 4).map((a) => `${a.edge} edge at ${a.at}px (${pct(a.rel)}) shared by ${a.blocks.map((n) => `#${n}`).join(", ")}`);
  const summary = [
    `Canvas ${W}×${H}px (${aspectName(W, H)}), ${background.uniform ? `flat background ${background.hex}` : `non-flat background (≈${background.hex} at the edges)`}; ${blocks.length} blocks, ${textBlocks.length} of them text.`,
    `Margins: left ${margins.left}px (${pct(marginsRel.left)}), right ${margins.right}px (${pct(marginsRel.right)}), top ${margins.top}px (${pct(marginsRel.top)}), bottom ${margins.bottom}px (${pct(marginsRel.bottom)})${Math.abs(margins.left - margins.right) <= W * 0.01 ? "; side margins are equal" : ""}.`,
    axisText.length ? `Alignment: ${axisText.join("; ")}.` : "No shared alignment edges.",
    grid?.description ?? "No column grid explains the block edges (free or single-element composition).",
    rhythmText,
    hierText,
    `Balance: ${symmetry}, ${heavySide}, ${heavyEnd}.`,
    proportion.description,
    whitespace.description,
    readingPath.description,
  ];
  return {
    canvas: { w: W, h: H, aspect: r3(W / H), aspectName: aspectName(W, H) },
    background,
    blocks,
    margins: { ...margins, rel: marginsRel },
    liveArea,
    axes: topAxes,
    gaps,
    rhythm: { values, unitPx, multiples, description: rhythmText },
    grid,
    hierarchy: { order, textScale, description: hierText },
    balance: { centroid: { x: r3(cx), y: r3(cy) }, quadrants: { tl: r2(quad.tl), tr: r2(quad.tr), bl: r2(quad.bl), br: r2(quad.br) }, symmetry, description: `${symmetry}, ${heavySide}, ${heavyEnd}` },
    proportion,
    whitespace,
    readingPath,
    density,
    summary,
  };
};
