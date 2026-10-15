import sharp from "sharp";

import { rgbToOklab } from "../extractors/image.analyze.js";
import { rgbToHex } from "../core/color.js";
import type { BlockKind, Box } from "./types.js";

/**
 * Finds the elements of a piece in its pixels: text lines and paragraphs,
 * photos, solid shapes, rules and colored panels (with what sits on them).
 * Deterministic and estimated: it sees contrast against the background, not
 * meaning. The host model names the blocks afterwards.
 */

export interface RawBlock {
  readonly kind: BlockKind;
  /** Pixels of the original image. */
  readonly box: Box;
  readonly color: string;
  readonly background: string;
  readonly contrast: number;
  readonly text?: { lines: number; linePitchPx?: number; sizePx?: number; exact: false };
  /** Index in the returned list of the panel this block sits on. */
  readonly parentIndex?: number;
}

export interface PixelReading {
  readonly width: number;
  readonly height: number;
  readonly background: { hex: string; uniform: boolean };
  readonly blocks: RawBlock[];
  readonly limitations: string[];
}

const LONG_SIDE = 640;

const labToHex = (L: number, a: number, b: number): string => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const to = (v: number): number => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, c)) * 255);
  };
  return rgbToHex(to(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), to(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), to(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s));
};

interface Raster {
  readonly w: number;
  readonly h: number;
  readonly lab: Float32Array;
  readonly grad: Float32Array;
}

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/** Median color of a ring of pixels inside a box, and how many pixels sit close to it. */
const ringColor = (r: Raster, box: Box, inset: number, thickness: number): { lab: [number, number, number]; uniform: number } => {
  const L: number[] = [], A: number[] = [], B: number[] = [];
  const x0 = box.x + inset, y0 = box.y + inset, x1 = box.x + box.w - 1 - inset, y1 = box.y + box.h - 1 - inset;
  const push = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= r.w || y >= r.h) return;
    const i = (y * r.w + x) * 3;
    L.push(r.lab[i]!); A.push(r.lab[i + 1]!); B.push(r.lab[i + 2]!);
  };
  for (let t = 0; t < thickness; t++) {
    for (let x = x0; x <= x1; x += 1) { push(x, y0 + t); push(x, y1 - t); }
    for (let y = y0; y <= y1; y += 1) { push(x0 + t, y); push(x1 - t, y); }
  }
  const lab: [number, number, number] = [median(L), median(A), median(B)];
  let close = 0;
  for (let i = 0; i < L.length; i++) if (Math.hypot(L[i]! - lab[0], A[i]! - lab[1], B[i]! - lab[2]) < 0.05) close++;
  return { lab, uniform: L.length ? close / L.length : 0 };
};

/** Binary morphology with a square window, via an integral image. */
const boxSum = (mask: Uint8Array, w: number, h: number): Int32Array => {
  const ii = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += mask[y * w + x]!;
      ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1]! + row;
    }
  }
  return ii;
};
const windowCount = (ii: Int32Array, w: number, h: number, x: number, y: number, rx: number, ry: number): { sum: number; area: number } => {
  const x0 = Math.max(0, x - rx), y0 = Math.max(0, y - ry), x1 = Math.min(w - 1, x + rx), y1 = Math.min(h - 1, y + ry);
  const W = w + 1;
  const sum = ii[(y1 + 1) * W + x1 + 1]! - ii[y0 * W + x1 + 1]! - ii[(y1 + 1) * W + x0]! + ii[y0 * W + x0]!;
  return { sum, area: (x1 - x0 + 1) * (y1 - y0 + 1) };
};
/** Closing: dilate then erode. Horizontal reach is wider so letters join into words and lines. */
const close = (mask: Uint8Array, w: number, h: number, rx: number, ry: number): Uint8Array => {
  const dil = new Uint8Array(w * h);
  const ii = boxSum(mask, w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) dil[y * w + x] = windowCount(ii, w, h, x, y, rx, ry).sum > 0 ? 1 : 0;
  const out = new Uint8Array(w * h);
  const jj = boxSum(dil, w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = windowCount(jj, w, h, x, y, rx, ry);
    out[y * w + x] = c.sum === c.area ? 1 : 0;
  }
  // Erosion against the canvas edge would eat bleed elements; keep the dilated edge.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x < rx || y < ry || x >= w - rx || y >= h - ry) && dil[y * w + x] && mask[y * w + x]) out[y * w + x] = 1;
  return out;
};

interface Component {
  x0: number; y0: number; x1: number; y1: number;
  pixels: number;
  /** Pixels that differ in color from the background (not just edges). */
  raw: number;
  wsum: number; sumL: number; sumA: number; sumB: number;
  /** Unweighted color moments of raw pixels, for uniformity. */
  mL: number; mA: number; mB: number; m2: number;
  gradSum: number;
}

const components = (closed: Uint8Array, raw: Uint8Array, r: Raster, region: Box, bg: readonly number[]): Component[] => {
  const { w } = r;
  const seen = new Uint8Array(closed.length);
  const out: Component[] = [];
  const stack: number[] = [];
  for (let y = region.y; y < region.y + region.h; y++) for (let x = region.x; x < region.x + region.w; x++) {
    const start = y * w + x;
    if (!closed[start] || seen[start]) continue;
    const c: Component = { x0: x, y0: y, x1: x, y1: y, pixels: 0, raw: 0, wsum: 0, sumL: 0, sumA: 0, sumB: 0, mL: 0, mA: 0, mB: 0, m2: 0, gradSum: 0 };
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const px = i % w, py = (i - px) / w;
      c.pixels++;
      if (px < c.x0) c.x0 = px; if (px > c.x1) c.x1 = px; if (py < c.y0) c.y0 = py; if (py > c.y1) c.y1 = py;
      if (raw[i]) {
        const L = r.lab[i * 3]!, A = r.lab[i * 3 + 1]!, B = r.lab[i * 3 + 2]!;
        // Antialiased edges blend into the background; weight pixels by how far they are from it.
        const d = Math.hypot(L - bg[0]!, A - bg[1]!, B - bg[2]!);
        const wt = d * d * d;
        c.raw++;
        c.wsum += wt; c.sumL += L * wt; c.sumA += A * wt; c.sumB += B * wt;
        c.mL += L; c.mA += A; c.mB += B; c.m2 += L * L + A * A + B * B;
      }
      c.gradSum += r.grad[i]!;
      const nb = [px > region.x ? i - 1 : -1, px < region.x + region.w - 1 ? i + 1 : -1, py > region.y ? i - w : -1, py < region.y + region.h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && closed[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
    }
    out.push(c);
  }
  return out;
};

/** Rows of foreground inside a box: text shows as bands separated by quiet rows. */
const textBands = (raw: Uint8Array, w: number, box: Box): { bands: { start: number; end: number }[]; runsPerRow: number } => {
  const active: boolean[] = [];
  let runsTotal = 0, activeRows = 0;
  for (let y = box.y; y < box.y + box.h; y++) {
    let count = 0, runs = 0, prev = 0;
    for (let x = box.x; x < box.x + box.w; x++) {
      const v = raw[y * w + x]!;
      count += v;
      if (v && !prev) runs++;
      prev = v;
    }
    const on = count > box.w * 0.01;
    active.push(on);
    if (on) { runsTotal += runs; activeRows++; }
  }
  const bands: { start: number; end: number }[] = [];
  let s = -1;
  active.forEach((on, i) => {
    if (on && s < 0) s = i;
    if (!on && s >= 0) { bands.push({ start: s, end: i - 1 }); s = -1; }
  });
  if (s >= 0) bands.push({ start: s, end: active.length - 1 });
  return { bands: bands.filter((b) => b.end - b.start >= 1), runsPerRow: activeRows ? runsTotal / activeRows : 0 };
};

const load = async (input: string | Buffer): Promise<{ raster: Raster; width: number; height: number; scale: number }> => {
  const base = sharp(input, { failOn: "none" }).rotate();
  const meta = await base.metadata();
  const oriented = (meta.orientation ?? 1) >= 5;
  const width = (oriented ? meta.height : meta.width) ?? 0;
  const height = (oriented ? meta.width : meta.height) ?? 0;
  if (!width || !height) throw new Error("Image has no readable dimensions");
  const scale = Math.min(1, LONG_SIDE / Math.max(width, height));
  const w = Math.max(8, Math.round(width * scale));
  const h = Math.max(8, Math.round(height * scale));
  const { data } = await base.clone().flatten({ background: "#ffffff" }).resize(w, h, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const lab = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const [L, a, b] = rgbToOklab(data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!);
    lab[i * 3] = L; lab[i * 3 + 1] = a; lab[i * 3 + 2] = b;
  }
  const grad = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const g = (k: number, j: number) => Math.hypot(lab[k * 3]! - lab[j * 3]!, (lab[k * 3 + 1]! - lab[j * 3 + 1]!) * 0.6, (lab[k * 3 + 2]! - lab[j * 3 + 2]!) * 0.6);
    grad[i] = Math.max(g(i + 1, i - 1), g(i + w, i - w));
  }
  return { raster: { w, h, lab, grad }, width, height, scale: w / width };
};

const DIFF = 0.075;
const EDGE = 0.14;

interface Found {
  kind: BlockKind;
  box: Box;
  lab: [number, number, number];
  contrast: number;
  text?: { lines: number; pitch?: number; band?: number };
  parent?: number;
  id: number;
}

const textReading = (raw: Uint8Array, w: number, box: Box, short: number): { lines: number; pitch?: number; band?: number } | null => {
  const { bands, runsPerRow } = textBands(raw, w, box);
  if (!bands.length) return null;
  const bandH = median(bands.map((b) => b.end - b.start + 1));
  if (bandH >= short * 0.35 || runsPerRow < 1.5) return null;
  const pitches = bands.slice(1).map((b, i) => b.start - bands[i]!.start);
  return { lines: bands.length, ...(pitches.length ? { pitch: median(pitches) } : {}), band: bandH };
};

/** Detect blocks inside `region`, against `bg`. Returns blocks in working (downscaled) pixels. */
const detect = (r: Raster, region: Box, bg: [number, number, number], depth: number, outside?: readonly number[]): Omit<Found, "id">[] => {
  const { w, h } = r;
  const colorMask = new Uint8Array(w * h);
  const fg = new Uint8Array(w * h);
  const pad = depth > 0 ? Math.max(1, Math.round(Math.min(region.w, region.h) * 0.04)) : 0;
  // Inside a container, pixels of the color around it (and their antialiased rim) are outside its shape.
  let rim: Int32Array | null = null;
  if (outside) {
    // Flood from the box edge through the outside color: corners and gaps of the shape, never text inside it.
    const out = new Uint8Array(w * h);
    const isOut = (i: number): boolean => Math.hypot(r.lab[i * 3]! - outside[0]!, r.lab[i * 3 + 1]! - outside[1]!, r.lab[i * 3 + 2]! - outside[2]!) < DIFF * 1.5;
    const stack: number[] = [];
    const seed = (x: number, y: number): void => { const i = y * w + x; if (!out[i] && isOut(i)) { out[i] = 1; stack.push(i); } };
    for (let x = region.x; x < region.x + region.w; x++) { seed(x, region.y); seed(x, region.y + region.h - 1); }
    for (let y = region.y; y < region.y + region.h; y++) { seed(region.x, y); seed(region.x + region.w - 1, y); }
    while (stack.length) {
      const i = stack.pop()!;
      const px = i % w, py = (i - px) / w;
      if (px > region.x) seed(px - 1, py);
      if (px < region.x + region.w - 1) seed(px + 1, py);
      if (py > region.y) seed(px, py - 1);
      if (py < region.y + region.h - 1) seed(px, py + 1);
    }
    rim = boxSum(out, w, h);
  }
  for (let y = region.y + pad; y < region.y + region.h - pad; y++) for (let x = region.x + pad; x < region.x + region.w - pad; x++) {
    const i = y * w + x;
    if (rim && windowCount(rim, w, h, x, y, 2, 2).sum > 0) continue;
    const d = Math.hypot(r.lab[i * 3]! - bg[0], r.lab[i * 3 + 1]! - bg[1], r.lab[i * 3 + 2]! - bg[2]);
    if (d > DIFF) colorMask[i] = 1;
    if (d > DIFF || r.grad[i]! > EDGE) fg[i] = 1;
  }
  const short = Math.min(region.w, region.h);
  const ry = Math.max(1, Math.round(short * 0.005));
  const rx = Math.max(1, Math.round(short * 0.008));
  const closed = close(fg, w, h, rx, ry);
  const comps = components(closed, colorMask, r, region, bg);
  const regionArea = region.w * region.h;
  const out: Omit<Found, "id">[] = [];
  for (const c of comps) {
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    const area = bw * bh;
    const long = Math.max(bw, bh), thin = Math.min(bw, bh);
    const isLine = long / Math.max(1, thin) > 14 && thin <= Math.max(3, short * 0.012) && long > short * 0.06;
    if (area < regionArea * 0.0003 && !isLine) continue;
    if (c.raw < 3 || c.wsum <= 0) continue;
    const box = { x: c.x0, y: c.y0, w: bw, h: bh };
    const lab: [number, number, number] = [c.sumL / c.wsum, c.sumA / c.wsum, c.sumB / c.wsum];
    const contrast = Math.round(Math.hypot(lab[0] - bg[0], lab[1] - bg[1], lab[2] - bg[2]) * 1000) / 10;
    const coverage = c.raw / area;
    const detail = c.gradSum / Math.max(1, c.pixels);
    const mean = [c.mL / c.raw, c.mA / c.raw, c.mB / c.raw];
    const spread = Math.sqrt(Math.max(0, c.m2 / c.raw - mean[0]! ** 2 - mean[1]! ** 2 - mean[2]! ** 2));
    let kind: BlockKind = "unknown";
    let text: { lines: number; pitch?: number; band?: number } | undefined;
    if (isLine) kind = "line";
    else if (coverage > 0.7 && spread < 0.18 && ringColor(r, box, Math.max(1, Math.round(Math.min(bw, bh) * 0.15)), 1).uniform > 0.6) {
      // A flat field of color. Large ones are panels; small ones holding something are controls (buttons, tags).
      if (depth === 0) kind = area > regionArea * 0.08 ? "panel" : detail > 0.03 ? "control" : "shape";
      else kind = "shape";
    } else if (coverage > 0.6) kind = "image";
    else {
      const t = textReading(colorMask, w, box, short);
      if (t) { kind = "text"; text = t; }
      else kind = coverage > 0.3 ? "image" : "unknown";
    }
    out.push({ kind, box, lab, contrast, ...(text ? { text } : {}) });
  }
  return out;
};

/** Words of one line: neighbours on the same row, same height, separated by less than a letter's height. */
const mergeWords = (blocks: Found[]): Found[] => {
  const candidates = (b: Found): boolean => b.kind === "text" || b.kind === "unknown" || (b.kind === "image" && b.box.h < 200);
  const out: Found[] = [];
  for (const b of [...blocks].sort((a, c) => a.box.x - c.box.x)) {
    if (!candidates(b)) { out.push({ ...b }); continue; }
    const mate = out.find((p) => {
      if (!candidates(p) || p.parent !== b.parent) return false;
      if (p.kind !== "text" && b.kind !== "text") return false;
      const top = Math.max(p.box.y, b.box.y), bottom = Math.min(p.box.y + p.box.h, b.box.y + b.box.h);
      const overlap = bottom - top;
      const ratio = Math.max(p.box.h, b.box.h) / Math.max(1, Math.min(p.box.h, b.box.h));
      const gap = b.box.x - (p.box.x + p.box.w);
      return overlap > 0.6 * Math.min(p.box.h, b.box.h) && ratio < 1.6 && gap > -2 && gap < 0.9 * Math.max(p.box.h, b.box.h);
    });
    if (!mate) { out.push({ ...b }); continue; }
    const x = Math.min(mate.box.x, b.box.x), y = Math.min(mate.box.y, b.box.y);
    const box = { x, y, w: Math.max(mate.box.x + mate.box.w, b.box.x + b.box.w) - x, h: Math.max(mate.box.y + mate.box.h, b.box.y + b.box.h) - y };
    const wa = mate.box.w * mate.box.h, wb = b.box.w * b.box.h;
    const lab = mate.lab.map((v, i) => (v * wa + b.lab[i]! * wb) / (wa + wb)) as [number, number, number];
    Object.assign(mate, { kind: "text", box, lab, contrast: Math.max(mate.contrast, b.contrast), text: { lines: 1, band: Math.max(mate.text?.band ?? mate.box.h, b.text?.band ?? b.box.h) } });
  }
  return out;
};

/** Stacked lines of the same size and edge become one paragraph block. */
const mergeParagraphs = (blocks: Found[]): Found[] => {
  const sorted = [...blocks].sort((a, b) => a.box.y - b.box.y);
  const out: Found[] = [];
  for (const b of sorted) {
    const prev = [...out].reverse().find((p) => p.kind === "text" && b.kind === "text" && p.parent === b.parent);
    if (prev && prev.text && b.text) {
      const gap = b.box.y - (prev.box.y + prev.box.h);
      const ratio = (prev.text.band ?? 1) / Math.max(1, b.text.band ?? 1);
      const overlap = Math.min(prev.box.x + prev.box.w, b.box.x + b.box.w) - Math.max(prev.box.x, b.box.x);
      const sameEdge = Math.abs(prev.box.x - b.box.x) <= Math.max(2, prev.box.w * 0.04) || Math.abs(prev.box.x + prev.box.w / 2 - (b.box.x + b.box.w / 2)) <= Math.max(2, prev.box.w * 0.04);
      if (gap >= 0 && gap < (prev.text.band ?? 4) * 1.1 && ratio > 0.75 && ratio < 1.33 && overlap > Math.min(prev.box.w, b.box.w) * 0.4 && sameEdge) {
        const x = Math.min(prev.box.x, b.box.x), y = prev.box.y;
        const box = { x, y, w: Math.max(prev.box.x + prev.box.w, b.box.x + b.box.w) - x, h: b.box.y + b.box.h - y };
        const pitch = b.box.y - prev.box.y - (prev.text.lines - 1) * (prev.text.pitch ?? 0);
        Object.assign(prev, { box, text: { ...prev.text, lines: prev.text.lines + b.text.lines, pitch: prev.text.pitch ?? pitch } });
        continue;
      }
    }
    out.push({ ...b });
  }
  return out;
};

/** Connected areas of one flat color, crisp and near-rectangular: badges, buttons and bars over a photo. */
const flatShapes = (r: Raster, region: Box): Omit<Found, "id">[] => {
  const { w } = r;
  const seen = new Uint8Array(r.w * r.h);
  const out: Omit<Found, "id">[] = [];
  const regionArea = region.w * region.h;
  const stack: number[] = [];
  const dist = (i: number, L: number, A: number, B: number) => Math.hypot(r.lab[i * 3]! - L, r.lab[i * 3 + 1]! - A, r.lab[i * 3 + 2]! - B);
  for (let y = region.y + 1; y < region.y + region.h - 1; y += 2) for (let x = region.x + 1; x < region.x + region.w - 1; x += 2) {
    const start = y * w + x;
    if (seen[start] || r.grad[start]! > 0.02) continue;
    const L = r.lab[start * 3]!, A = r.lab[start * 3 + 1]!, B = r.lab[start * 3 + 2]!;
    let x0 = x, y0 = y, x1 = x, y1 = y, n = 0, edge = false;
    stack.push(start); seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const px = i % w, py = (i - px) / w;
      n++;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      if (px <= region.x || py <= region.y || px >= region.x + region.w - 1 || py >= region.y + region.h - 1) edge = true;
      for (const j of [px > region.x ? i - 1 : -1, px < region.x + region.w - 1 ? i + 1 : -1, py > region.y ? i - w : -1, py < region.y + region.h - 1 ? i + w : -1]) {
        if (j >= 0 && !seen[j] && dist(j, L, A, B) < 0.06) { seen[j] = 1; stack.push(j); }
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (edge || n < regionArea * 0.0015 || bw * bh > regionArea * 0.4) continue;
    // Text holes lower the fill; the shape itself must still be a clean box.
    const fill = n / (bw * bh);
    if (fill < 0.6) continue;
    const box = { x: x0, y: y0, w: bw, h: bh };
    const ring = ringColor(r, { x: Math.max(region.x, x0 - 2), y: Math.max(region.y, y0 - 2), w: Math.min(region.x + region.w, x1 + 3) - Math.max(region.x, x0 - 2), h: Math.min(region.y + region.h, y1 + 3) - Math.max(region.y, y0 - 2) }, 0, 1);
    const contrast = Math.round(Math.hypot(L - ring.lab[0], A - ring.lab[1], B - ring.lab[2]) * 1000) / 10;
    if (contrast < 8) continue;
    // Crisp: the color changes sharply all around the box.
    let crisp = 0, total = 0;
    for (let xx = x0; xx <= x1; xx += 2) for (const yy of [y0, y1]) { total++; if (r.grad[yy * w + xx]! > 0.04 || r.grad[(yy + (yy === y0 ? -1 : 1)) * w + xx]! > 0.04) crisp++; }
    for (let yy = y0; yy <= y1; yy += 2) for (const xx of [x0, x1]) { total++; if (r.grad[yy * w + xx]! > 0.04 || r.grad[yy * w + xx + (xx === x0 ? -1 : 1)]! > 0.04) crisp++; }
    if (total && crisp / total < 0.6) continue;
    out.push({ kind: "shape", box, lab: [L, A, B], contrast });
  }
  return out;
};

/**
 * Elements set over a photo or texture: type, badges, buttons and logos stand out
 * from their surroundings, photo detail does not. Each pixel is compared with the
 * mean color around it; what differs strongly is figure.
 */
const detectOverlay = (r: Raster, region: Box): Omit<Found, "id">[] => {
  const { w, h } = r;
  const short = Math.min(region.w, region.h);
  const R = Math.max(4, Math.round(short * 0.05));
  const W1 = w + 1;
  // Local mean of the ground, from integral images; `skip` leaves figure pixels out so they do not tint it.
  const localMeans = (skip: Uint8Array | null): ((x: number, y: number) => [number, number, number] | null) => {
    const ii = [new Float64Array(W1 * (h + 1)), new Float64Array(W1 * (h + 1)), new Float64Array(W1 * (h + 1))];
    const cnt = new Float64Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let r0 = 0, r1 = 0, r2 = 0, rc = 0;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!skip || !skip[i]) { r0 += r.lab[i * 3]!; r1 += r.lab[i * 3 + 1]!; r2 += r.lab[i * 3 + 2]!; rc++; }
        const o = (y + 1) * W1 + x + 1, u = y * W1 + x + 1;
        ii[0]![o] = ii[0]![u]! + r0; ii[1]![o] = ii[1]![u]! + r1; ii[2]![o] = ii[2]![u]! + r2; cnt[o] = cnt[u]! + rc;
      }
    }
    return (x, y) => {
      const x0 = Math.max(region.x, x - R), y0 = Math.max(region.y, y - R), x1 = Math.min(region.x + region.w - 1, x + R), y1 = Math.min(region.y + region.h - 1, y + R);
      const sum = (a: Float64Array) => a[(y1 + 1) * W1 + x1 + 1]! - a[y0 * W1 + x1 + 1]! - a[(y1 + 1) * W1 + x0]! + a[y0 * W1 + x0]!;
      const n = sum(cnt);
      if (n < 4) return null;
      return [sum(ii[0]!) / n, sum(ii[1]!) / n, sum(ii[2]!) / n];
    };
  };
  const pass = (skip: Uint8Array | null): Uint8Array => {
    const meanAt = localMeans(skip);
    const out = new Uint8Array(w * h);
    for (let y = region.y; y < region.y + region.h; y++) for (let x = region.x; x < region.x + region.w; x++) {
      const i = y * w + x;
      const m = meanAt(x, y);
      if (m && Math.hypot(r.lab[i * 3]! - m[0], r.lab[i * 3 + 1]! - m[1], r.lab[i * 3 + 2]! - m[2]) > 0.16) out[i] = 1;
    }
    return out;
  };
  // Second pass against the ground without the figure: no halo around type.
  const mask = pass(pass(null));
  const ry = Math.max(1, Math.round(short * 0.005)), rx = Math.max(1, Math.round(short * 0.008));
  const closed = close(mask, w, h, rx, ry);
  const photo = ringColor(r, region, 0, 2).lab;
  const comps = components(closed, mask, r, region, photo);
  const regionArea = region.w * region.h;
  const out: Omit<Found, "id">[] = [];
  for (const c of comps) {
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    const area = bw * bh;
    if (area < regionArea * 0.0004 || c.raw < 4 || c.wsum <= 0) continue;
    if (area > regionArea * 0.5) continue;
    const box = { x: c.x0, y: c.y0, w: bw, h: bh };
    const inner = ringColor(r, box, Math.max(1, Math.round(Math.min(bw, bh) * 0.08)), 1);
    const grow = Math.max(2, Math.round(short * 0.01));
    const outside = ringColor(r, { x: Math.max(region.x, box.x - grow), y: Math.max(region.y, box.y - grow), w: Math.min(region.x + region.w, box.x + bw + grow) - Math.max(region.x, box.x - grow), h: Math.min(region.y + region.h, box.y + bh + grow) - Math.max(region.y, box.y - grow) }, 0, 1);
    const lab: [number, number, number] = [c.sumL / c.wsum, c.sumA / c.wsum, c.sumB / c.wsum];
    const contrast = Math.round(Math.hypot(lab[0] - outside.lab[0], lab[1] - outside.lab[1], lab[2] - outside.lab[2]) * 1000) / 10;
    const t = textReading(mask, w, box, short);
    if (t) { out.push({ kind: "text", box, lab, contrast, text: t }); continue; }
    const flatDistinct = inner.uniform > 0.5 && Math.hypot(inner.lab[0] - outside.lab[0], inner.lab[1] - outside.lab[1], inner.lab[2] - outside.lab[2]) > 0.12;
    if (flatDistinct && area > regionArea * 0.002) out.push({ kind: "shape", box, lab: inner.lab, contrast });
  }
  // Flat fields with crisp, near-rectangular edges (badges, buttons, bars) even when their color is close to the photo's.
  const within = (a: Box, b: Box): boolean => a.x >= b.x - 2 && a.y >= b.y - 2 && a.x + a.w <= b.x + b.w + 2 && a.y + a.h <= b.y + b.h + 2;
  for (const f of flatShapes(r, region)) {
    // Flat counters of bold letters are part of the type.
    if (out.some((o) => o.kind === "text" && within(f.box, o.box))) continue;
    if (out.some((o) => Math.abs(o.box.x - f.box.x) < 4 && Math.abs(o.box.y - f.box.y) < 4 && Math.abs(o.box.w - f.box.w) < 6 && Math.abs(o.box.h - f.box.h) < 6)) continue;
    out.push(f);
  }
  for (const b of out) {
    if (b.kind !== "shape") continue;
    const holds = out.some((o) => o !== b && o.kind === "text" && o.box.x >= b.box.x && o.box.y >= b.box.y && o.box.x + o.box.w <= b.box.x + b.box.w && o.box.y + o.box.h <= b.box.y + b.box.h);
    if (holds) b.kind = "control";
  }
  // Text inside a badge or button belongs to it.
  return out.filter((b, i) => !(b.kind !== "text" && out.some((o, j) => j !== i && o.kind !== "text" && o.box.x <= b.box.x && o.box.y <= b.box.y && o.box.x + o.box.w >= b.box.x + b.box.w && o.box.y + o.box.h >= b.box.y + b.box.h && o.box.w * o.box.h > b.box.w * b.box.h)));
};

export const detectBlocks = async (input: string | Buffer): Promise<PixelReading> => {
  const { raster, width, height, scale } = await load(input);
  const full = { x: 0, y: 0, w: raster.w, h: raster.h };
  const ring = Math.max(2, Math.round(Math.min(raster.w, raster.h) * 0.015));
  const bg = ringColor(raster, full, 0, ring);
  const limitations: string[] = [];
  const uniform = bg.uniform >= 0.55;
  if (!uniform) limitations.push("The background is a photo or texture: it is read as one full-bleed image, and what is set on it (type, badges, buttons) is found by local contrast. Subjects inside the photo are not separated; the host reading names them.");
  const all: Found[] = [];
  const nestInside = (parentId: number): void => {
    const p = all[parentId]!;
    for (const child of [...all]) {
      if (child.id === parentId || child.kind !== "text") continue;
      if (child.parent !== undefined && !(all[child.parent]!.kind === "image" && child.parent !== parentId)) continue;
      const b = child.box, o = p.box;
      if (b.x >= o.x && b.y >= o.y && b.x + b.w <= o.x + o.w && b.y + b.h <= o.y + o.h) child.parent = parentId;
    }
  };
  if (!uniform) {
    // A photo or texture is the ground: one full-bleed image, with what is set on it found by local contrast.
    all.push({ kind: "image", box: full, lab: bg.lab, contrast: 0, id: 0 });
    for (const b of detectOverlay(raster, full)) all.push({ ...b, parent: 0, id: all.length });
    for (const b of all) if (b.kind === "control" || b.kind === "shape") nestInside(b.id);
  } else {
    for (const b of detect(raster, full, bg.lab, 0)) {
      const id = all.length;
      all.push({ ...b, id });
      if (b.kind === "panel" || b.kind === "control") {
        const local = ringColor(raster, b.box, Math.max(1, Math.round(Math.min(b.box.w, b.box.h) * 0.15)), 1);
        for (const child of detect(raster, b.box, local.lab, 1, bg.lab)) all.push({ ...child, parent: id, id: all.length });
      } else if (b.kind === "image" && b.box.w * b.box.h > full.w * full.h * 0.08) {
        // Type and badges set over a photo inside the layout.
        const start = all.length;
        for (const child of detectOverlay(raster, b.box)) all.push({ ...child, parent: id, id: all.length });
        for (const c of all.slice(start)) if (c.kind === "control" || c.kind === "shape") nestInside(c.id);
      }
    }
  }
  const merged = mergeParagraphs(mergeWords(all));
  const inv = 1 / scale;
  const toPx = (b: Box): Box => ({ x: Math.round(b.x * inv), y: Math.round(b.y * inv), w: Math.round(b.w * inv), h: Math.round(b.h * inv) });
  const blocks: RawBlock[] = merged.map((b) => {
    const parentLab = b.parent !== undefined ? all[b.parent]!.lab : bg.lab;
    // Over a photo there is no single color behind; report the photo's edge color.
    const parentIndex = b.parent !== undefined ? merged.findIndex((m) => m.id === b.parent) : -1;
    return {
      kind: b.kind,
      box: toPx(b.box),
      color: labToHex(...b.lab),
      background: labToHex(...parentLab),
      contrast: b.contrast,
      ...(parentIndex >= 0 ? { parentIndex } : {}),
      ...(b.text ? { text: { lines: b.text.lines, ...(b.text.pitch ? { linePitchPx: Math.round(b.text.pitch * inv) } : {}), ...(b.text.band ? { sizePx: Math.round(b.text.band * inv) } : {}), exact: false as const } } : {}),
    };
  });
  return { width, height, background: { hex: labToHex(...bg.lab), uniform }, blocks, limitations };
};

/** Background color at the edges of an image, and whether it is flat. */
export const backgroundOf = async (input: string | Buffer): Promise<{ hex: string; uniform: boolean }> => {
  const { raster } = await load(input);
  const bg = ringColor(raster, { x: 0, y: 0, w: raster.w, h: raster.h }, 0, Math.max(2, Math.round(Math.min(raster.w, raster.h) * 0.015)));
  return { hex: labToHex(...bg.lab), uniform: bg.uniform >= 0.55 };
};
