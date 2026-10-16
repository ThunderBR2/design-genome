import type { Block, Box, GridReading } from "./types.js";

/**
 * Grid reading: the structure the blocks are set on, in the two traditions a
 * designer would check —
 *  - web / UI: a column grid (n columns, gutter, margin, centered container) and
 *    how many columns each block spans;
 *  - editorial: a modular grid (columns × rows), a baseline grid the text sits
 *    on, and proportional systems (thirds, golden section).
 * Each system is accepted only when it explains clearly more edges than chance
 * would, so "no grid" is a real answer (a free composition), not a failure.
 */

export interface AxisFit {
  readonly count: number;
  readonly gutterPx: number;
  readonly startPx: number;
  readonly trackPx: number;
  /** Share of block edges that land on a line of this system. */
  readonly fit: number;
}

export interface Span {
  readonly block: number;
  /** 1-based first and last column (or row) the block covers; null when it sits off the grid. */
  readonly from: number | null;
  readonly to: number | null;
  /** Off the columns but centered on the live area: set on the center axis instead. */
  readonly centered?: boolean;
}

export interface GridSystem {
  /** column: one column grid; modular: columns × rows; manuscript: one text column; free: no grid explains the edges. */
  readonly kind: "modular" | "column" | "manuscript" | "free";
  readonly columns: GridReading | null;
  readonly columnSpans: readonly Span[];
  readonly rows: AxisFit | null;
  readonly rowSpans: readonly Span[];
  readonly baseline: { readonly unitPx: number; readonly originPx: number; readonly fit: number; readonly texts: number } | null;
  readonly proportional: { readonly system: "thirds" | "golden"; readonly fit: number; readonly hits: number; readonly lines: readonly { readonly axis: "x" | "y"; readonly at: number }[] } | null;
  /** Web sections: content centered in a fixed-width container. */
  readonly container: { readonly widthPx: number; readonly marginPx: number } | null;
  /** Share of top-level blocks whose both edges sit on column lines. */
  readonly onGrid: number;
  readonly description: string;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const pct = (n: number): string => `${Math.round(n * 1000) / 10}%`;

/**
 * Best division of one axis into n tracks with a constant gutter, judged by how
 * many block start/end edges land on a track line, corrected for chance: with
 * many narrow tracks almost any edge lands near some line, so a system must beat
 * the hit rate random edges would get, and the blocks must actually start and
 * end on tracks. Shared by columns and rows.
 */
export interface AxisItem {
  readonly start: number;
  readonly end: number;
  /** Rigid blocks (images, panels, controls) fill their tracks; text starts on a line and ends where the words end. */
  readonly rigid: boolean;
}

export const fitAxis = (items: readonly AxisItem[], liveStart: number, liveLen: number, side: number, maxN: number, exact = false): { best: (AxisFit & { used: number; chance: number }) | null; single: number } => {
  if (items.length < 2 || liveLen <= 0) return { best: null, single: 0 };
  const edges = [...items.map((i) => i.start), ...items.filter((i) => i.rigid).map((i) => i.end)];
  const rigid = items.filter((i) => i.rigid);
  const tol = exact ? Math.max(2, side * 0.003) : Math.max(3, side * 0.008);
  const minTrack = Math.max(side * 0.05, 40);
  const evaluate = (n: number, g: number): (AxisFit & { used: number; chance: number; set: number }) | null => {
    const track = (liveLen - (n - 1) * g) / n;
    if (track < minTrack) return null;
    const starts: number[] = [], ends: number[] = [];
    for (let k = 0; k < n; k++) { const l = liveStart + k * (track + g); starts.push(l); ends.push(l + track); }
    const onStart = (e: number) => starts.some((l) => Math.abs(l - e) <= tol);
    const onEnd = (e: number) => ends.some((l) => Math.abs(l - e) <= tol);
    const hits = items.filter((i) => onStart(i.start)).length + rigid.filter((i) => onEnd(i.end)).length;
    const used = new Set(items.map((i) => starts.findIndex((l) => Math.abs(l - i.start) <= tol)).filter((x) => x >= 0)).size;
    // Blocks set on the grid: text starting on a column, rigid blocks starting and ending on columns.
    const set = items.filter((i) => onStart(i.start) && (!i.rigid || onEnd(i.end))).length / items.length;
    const chance = Math.min(1, (n * (2 * tol + 1)) / Math.max(1, liveLen));
    return { count: n, gutterPx: Math.round(g), startPx: Math.round(liveStart), trackPx: Math.round(track), fit: r2(hits / edges.length), used, chance: r2(chance), set };
  };
  const one = evaluate(1, 0);
  let best: (AxisFit & { used: number; chance: number; set: number }) | null = one && items.length >= 3 ? one : null;
  const merit = (c: { fit: number; chance: number; count: number }) => c.fit - c.chance - 0.02 * (c.count - 1);
  if (items.length >= 5) {
    for (let n = 2; n <= maxN; n++) {
      for (let g = 0; g <= side * 0.06; g += Math.max(1, side * 0.0025)) {
        const c = evaluate(n, g);
        if (!c || c.used < 2) continue;
        // More tracks must explain clearly more edges than one track and than chance, with most blocks set on the tracks.
        if (c.fit < 0.7 || c.fit - c.chance < 0.4 || c.fit - (one?.fit ?? 0) < 0.15 || c.set < 0.6) continue;
        if (!best || best.count === 1 || merit(c) > merit(best) + 1e-9) best = c;
      }
    }
  }
  if (!best || best.fit < 0.5) return { best: null, single: one?.fit ?? 0 };
  const { set: _s, ...out } = best;
  return { best: out, single: one?.fit ?? 0 };
};

const spansOf = (blocks: readonly Block[], fit: AxisFit, axis: "x" | "y", side: number, exact: boolean, live?: Box): Span[] => {
  const tol = exact ? Math.max(2, side * 0.003) : Math.max(3, side * 0.008);
  const lines = Array.from({ length: fit.count }, (_, k) => fit.startPx + k * (fit.trackPx + fit.gutterPx));
  return blocks.map((b) => {
    const a = axis === "x" ? b.box.x : b.box.y;
    const z = axis === "x" ? b.box.x + b.box.w : b.box.y + b.box.h;
    const from = lines.findIndex((l) => Math.abs(l - a) <= tol);
    // Rigid blocks end on a track edge; text ends inside the track its last word reaches.
    const to = b.kind !== "text" ? lines.findIndex((l) => Math.abs(l + fit.trackPx - z) <= tol) : lines.findLastIndex((l) => l < z - tol);
    const span = { block: b.n, from: from >= 0 ? from + 1 : null, to: to >= 0 && from >= 0 && to >= from ? to + 1 : null };
    const mid = live ? (axis === "x" ? live.x + live.w / 2 : live.y + live.h / 2) : null;
    const centered = (span.from === null || span.to === null) && mid !== null && Math.abs((a + z) / 2 - mid) <= Math.max(tol, side * 0.006);
    return centered ? { ...span, centered: true } : span;
  });
};

/** The unit the text tops share, when most of them sit on one. */
export const fitBaseline = (texts: readonly Block[], exact: boolean): GridSystem["baseline"] => {
  const tops = texts.map((b) => b.box.y);
  if (tops.length < 5) return null;
  const pitches = texts.map((b) => b.text?.linePitchPx).filter((p): p is number => Boolean(p && p >= 6));
  const candidates = new Set<number>([...Array.from({ length: 27 }, (_, i) => i + 6), ...pitches.map(Math.round), ...pitches.map((p) => Math.round(p / 2))]);
  let best: NonNullable<GridSystem["baseline"]> & { margin: number } | null = null;
  for (const u of candidates) {
    if (u < 6) continue;
    const tol = exact ? 1.5 : Math.max(2, u * 0.15);
    const chance = Math.min(1, (2 * tol + 1) / u);
    for (const origin of tops.map((t) => ((t % u) + u) % u)) {
      const hits = tops.filter((t) => { const d = (((t - origin) % u) + u) % u; return Math.min(d, u - d) <= tol; }).length;
      const fit = hits / tops.length;
      const margin = fit - chance;
      if (fit < 0.8 || margin < 0.45) continue;
      // Prefer the larger unit when it explains the tops about as well: a 24px baseline beats its 8px divisor.
      if (!best || margin > best.margin + 0.05 || (Math.abs(margin - best.margin) <= 0.05 && u > best.unitPx)) {
        best = { unitPx: u, originPx: Math.round(origin), fit: r2(fit), texts: tops.length, margin };
      }
    }
  }
  if (!best) return null;
  const { margin: _m, ...out } = best;
  return out;
};

const THIRDS = [1 / 3, 2 / 3];
const GOLDEN = [0.382, 0.618];

/** Thirds or golden lines the edges gather on, beyond what scattered edges would hit by chance. */
export const fitProportional = (blocks: readonly Block[], W: number, H: number, useY: boolean): GridSystem["proportional"] => {
  const edgesX = blocks.flatMap((b) => [b.box.x, b.box.x + b.box.w, b.box.x + b.box.w / 2]);
  const edgesY = useY ? blocks.flatMap((b) => [b.box.y, b.box.y + b.box.h, b.box.y + b.box.h / 2]) : [];
  const total = edgesX.length + edgesY.length;
  if (total < 6) return null;
  const tolX = W * 0.015, tolY = H * 0.015;
  const chance = 2 * 2 * 0.015;
  let best: GridSystem["proportional"] = null;
  for (const [system, ratios] of [["thirds", THIRDS], ["golden", GOLDEN]] as const) {
    const lines = [...ratios.map((r) => ({ axis: "x" as const, at: Math.round(W * r) })), ...(useY ? ratios.map((r) => ({ axis: "y" as const, at: Math.round(H * r) })) : [])];
    const hitLines = new Set<string>();
    let hits = 0;
    for (const e of edgesX) { const l = lines.find((l) => l.axis === "x" && Math.abs(l.at - e) <= tolX); if (l) { hits++; hitLines.add(`x${l.at}`); } }
    for (const e of edgesY) { const l = lines.find((l) => l.axis === "y" && Math.abs(l.at - e) <= tolY); if (l) { hits++; hitLines.add(`y${l.at}`); } }
    const fit = hits / total;
    if (hits >= 3 && hitLines.size >= 2 && fit >= 0.2 && fit >= chance * 3 && (!best || fit > best.fit)) {
      best = { system, fit: r2(fit), hits, lines: lines.filter((l) => hitLines.has(`${l.axis}${l.at}`)) };
    }
  }
  return best;
};

const spanText = (spans: readonly Span[], letter: string): string => {
  const on = spans.filter((s) => s.from !== null && s.to !== null);
  const centered = spans.filter((s) => s.centered);
  const off = spans.filter((s) => (s.from === null || s.to === null) && !s.centered);
  const parts = on.slice(0, 14).map((s) => `#${s.block} ${letter}${s.from}${s.to !== s.from ? `–${s.to}` : ""}`);
  return `${parts.join(", ")}${on.length > 14 ? ` (+${on.length - 14})` : ""}${centered.length ? `; centered on the axis: ${centered.slice(0, 10).map((s) => `#${s.block}`).join(", ")}` : ""}${off.length ? `; off the grid: ${off.slice(0, 10).map((s) => `#${s.block}`).join(", ")}` : ""}`;
};

export const analyzeGrid = (W: number, H: number, blocks: readonly Block[], live: Box, options: { web: boolean; exact: boolean }): GridSystem => {
  const content = blocks.filter((b) => !b.bleed);
  const topLevel = content.filter((b) => !b.parent);
  const rigidKind = (b: Block) => b.kind !== "text";
  const cols = fitAxis(topLevel.map((b) => ({ start: b.box.x, end: b.box.x + b.box.w, rigid: rigidKind(b) })), live.x, live.w, W, 12, options.exact);
  const columns: GridReading | null = cols.best
    ? {
      columns: cols.best.count,
      gutterPx: cols.best.gutterPx,
      marginPx: cols.best.startPx,
      columnPx: cols.best.trackPx,
      fit: cols.best.fit,
      description: cols.best.count === 1
        ? `Single column ${cols.best.trackPx}px wide (${pct(cols.best.trackPx / W)} of the width), ${cols.best.startPx}px side margin; ${Math.round(cols.best.fit * 100)}% of block edges sit on it.`
        : `${cols.best.count}-column grid: columns ${cols.best.trackPx}px, gutter ${cols.best.gutterPx}px (${pct(cols.best.gutterPx / W)}), margin ${cols.best.startPx}px; ${Math.round(cols.best.fit * 100)}% of block edges land on a column line.`,
    }
    : null;
  const columnSpans = cols.best && cols.best.count > 1 ? spansOf(topLevel, cols.best, "x", W, Boolean(options.exact), live) : [];
  // Rows only mean something on a canvas read at once (a poster, a screen), not down a long page.
  const rowsFit = H / W <= 2.2 && topLevel.length >= 6 ? fitAxis(topLevel.map((b) => ({ start: b.box.y, end: b.box.y + b.box.h, rigid: rigidKind(b) })), live.y, live.h, H, 8, options.exact).best : null;
  const rows = rowsFit && rowsFit.count >= 2 ? (({ used: _u, chance: _c, ...r }) => r)(rowsFit) : null;
  const rowSpans = rows ? spansOf(topLevel, rows, "y", H, Boolean(options.exact)) : [];
  const texts = content.filter((b) => b.kind === "text");
  const baseline = fitBaseline(texts, options.exact);
  const proportional = fitProportional(content.filter((b) => b.kind !== "line"), W, H, !options.web || H / W <= 2.2);
  const marginsEqual = Math.abs(live.x - (W - live.x - live.w)) <= Math.max(4, W * 0.01);
  const container = options.web && marginsEqual && live.x >= W * 0.04 && content.length >= 3 ? { widthPx: Math.round(live.w), marginPx: Math.round(live.x) } : null;
  const onGrid = columnSpans.length ? r2(columnSpans.filter((s) => (s.from !== null && s.to !== null) || s.centered).length / columnSpans.length) : 0;
  const kind: GridSystem["kind"] = columns && columns.columns >= 2 && rows ? "modular" : columns && columns.columns >= 2 ? "column" : columns ? "manuscript" : "free";

  const lines: string[] = [];
  if (kind === "modular") lines.push(`Modular grid ${columns!.columns}×${rows!.count}: ${columns!.columns} columns of ${columns!.columnPx}px with ${columns!.gutterPx}px gutters and ${rows!.count} rows of ${rows!.trackPx}px with ${rows!.gutterPx}px gutters; ${Math.round(columns!.fit * 100)}% of horizontal and ${Math.round(rows!.fit * 100)}% of vertical edges land on it.`);
  else if (columns) lines.push(`${kind === "column" ? "Column grid" : "Manuscript (single-column) grid"} — ${columns.description}`);
  else lines.push(`Free composition: no column grid explains the block edges (the best single column explains ${Math.round(cols.single * 100)}%).`);
  if (columnSpans.length) lines.push(`Column spans (c = column): ${spanText(columnSpans, "c")}.`);
  if (rowSpans.length) lines.push(`Row spans (r = row): ${spanText(rowSpans, "r")}.`);
  if (container) lines.push(`Centered container ${container.widthPx}px with ${container.marginPx}px side margins (${pct(container.marginPx / W)}).`);
  if (baseline) lines.push(`Baseline grid ${baseline.unitPx}px: ${Math.round(baseline.fit * 100)}% of ${baseline.texts} text blocks start on it.`);
  else if (texts.length >= 5) lines.push("No baseline grid: text tops do not share a unit.");
  if (proportional) lines.push(`Proportional system: ${proportional.hits} edges (${Math.round(proportional.fit * 100)}%) sit on the ${proportional.system} lines (${proportional.lines.map((l) => `${l.axis}=${l.at}px`).join(", ")}).`);
  return { kind, columns, columnSpans, rows, rowSpans, baseline, proportional, container, onGrid, description: lines.join(" ") };
};
