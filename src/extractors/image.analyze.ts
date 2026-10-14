import sharp from "sharp";

import { rgbToHex } from "../core/color.js";

/**
 * Pixel-level analysis shared by the image and video extractors and by the
 * verifier. Everything here is "estimated": it measures pixels, not intent.
 */

export interface PaletteEntry {
  readonly hex: string;
  /** Share of the analysed area, 0..1. */
  readonly share: number;
  /** Region (in original image pixels) where this color dominates most. */
  readonly region: { x: number; y: number; w: number; h: number };
}

export interface ImageMetrics {
  /** Mean OKLab lightness, 0..1. */
  readonly lightness: number;
  /** Standard deviation of lightness: global tonal contrast. */
  readonly contrast: number;
  /** Mean OKLCH chroma. */
  readonly chroma: number;
  /** Mean OKLab b (yellow-blue axis): >0 warm, <0 cool. */
  readonly warmth: number;
  /** Mean OKLab a (green-magenta axis): tint. */
  readonly tint: number;
  /** Share of the frame with little detail: negative space. */
  readonly negativeSpace: number;
  /** Mean gradient energy: visual busyness. */
  readonly detail: number;
  /** Left/right mirror similarity of lightness, 0..1. */
  readonly symmetry: number;
  /** Center of visual weight, normalized 0..1. */
  readonly focusX: number;
  readonly focusY: number;
  /** Share of near-black and near-white pixels: clipping/keying style. */
  readonly shadowsShare: number;
  readonly highlightsShare: number;
}

export interface ImageAnalysis {
  readonly width: number;
  readonly height: number;
  readonly aspect: number;
  readonly palette: readonly PaletteEntry[];
  readonly metrics: ImageMetrics;
  /** Estimated empty margins as a share of width/height. */
  readonly margins: { left: number; right: number; top: number; bottom: number };
  /** Estimated vertical content columns from detail projection. */
  readonly columns: number;
}

const srgbToLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** sRGB 0-255 to OKLab (Björn Ottosson). */
export const rgbToOklab = (r: number, g: number, b: number): [number, number, number] => {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};

const round = (n: number, d = 4): number => Math.round(n * 10 ** d) / 10 ** d;

/** Deterministic k-means++ in OKLab. Seeded so the same image yields the same palette. */
const kmeans = (points: Float32Array, n: number, k: number): { centers: number[][]; labels: Uint8Array } => {
  let seed = 1337;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const dist = (i: number, c: number[]): number => {
    const dl = points[i * 3]! - c[0]!, da = points[i * 3 + 1]! - c[1]!, db = points[i * 3 + 2]! - c[2]!;
    return dl * dl + da * da + db * db;
  };
  const centers: number[][] = [];
  const first = Math.floor(rand() * n);
  centers.push([points[first * 3]!, points[first * 3 + 1]!, points[first * 3 + 2]!]);
  const d2 = new Float64Array(n).fill(Infinity);
  while (centers.length < k) {
    let total = 0;
    const last = centers.at(-1)!;
    for (let i = 0; i < n; i++) {
      d2[i] = Math.min(d2[i]!, dist(i, last));
      total += d2[i]!;
    }
    if (total === 0) break;
    let target = rand() * total;
    let pick = 0;
    for (let i = 0; i < n; i++) {
      target -= d2[i]!;
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    centers.push([points[pick * 3]!, points[pick * 3 + 1]!, points[pick * 3 + 2]!]);
  }
  const labels = new Uint8Array(n);
  for (let iter = 0; iter < 16; iter++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = dist(i, centers[c]!);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (labels[i] !== best) { labels[i] = best; moved++; }
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const s = sums[labels[i]!]!;
      s[0]! += points[i * 3]!; s[1]! += points[i * 3 + 1]!; s[2]! += points[i * 3 + 2]!; s[3]! += 1;
    }
    sums.forEach((s, c) => { if (s[3]! > 0) centers[c] = [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!]; });
    if (moved === 0) break;
  }
  return { centers, labels };
};

const oklabToHex = (L: number, a: number, b: number): string => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const toSrgb = (v: number): number => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, c)) * 255);
  };
  return rgbToHex(
    toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  );
};

export const analyzeImage = async (input: string | Buffer, options: { colors?: number } = {}): Promise<ImageAnalysis> => {
  const base = sharp(input, { failOn: "none" }).rotate();
  const meta = await base.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error("Image has no readable dimensions");
  const target = 320;
  const scale = Math.min(1, target / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const { data } = await base.clone().flatten({ background: "#ffffff" }).resize(w, h, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = w * h;
  const lab = new Float32Array(n * 3);
  let sumL = 0, sumL2 = 0, sumA = 0, sumB = 0, sumC = 0, dark = 0, bright = 0;
  for (let i = 0; i < n; i++) {
    const [L, a, b] = rgbToOklab(data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!);
    lab[i * 3] = L; lab[i * 3 + 1] = a; lab[i * 3 + 2] = b;
    sumL += L; sumL2 += L * L; sumA += a; sumB += b; sumC += Math.hypot(a, b);
    if (L < 0.12) dark++;
    if (L > 0.96) bright++;
  }
  const meanL = sumL / n;

  // Gradient energy on lightness for detail, negative space, focus and columns.
  const grad = new Float32Array(n);
  let gradSum = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = lab[(i + 1) * 3]! - lab[(i - 1) * 3]!;
      const gy = lab[(i + w) * 3]! - lab[(i - w) * 3]!;
      const g = Math.hypot(gx, gy);
      grad[i] = g;
      gradSum += g;
    }
  }
  const tile = Math.max(4, Math.round(Math.min(w, h) / 16));
  let quietTiles = 0, tiles = 0;
  for (let ty = 0; ty < h; ty += tile) {
    for (let tx = 0; tx < w; tx += tile) {
      let e = 0, c = 0;
      for (let y = ty; y < Math.min(h, ty + tile); y++) for (let x = tx; x < Math.min(w, tx + tile); x++) { e += grad[y * w + x]!; c++; }
      tiles++;
      if (e / c < 0.012) quietTiles++;
    }
  }
  let fx = 0, fy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const g = grad[y * w + x]!; fx += g * x; fy += g * y; }
  let symDiff = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < Math.floor(w / 2); x++) symDiff += Math.abs(lab[(y * w + x) * 3]! - lab[(y * w + (w - 1 - x)) * 3]!);
  const symmetry = 1 - Math.min(1, symDiff / (h * Math.floor(w / 2) || 1) / 0.25);

  // Column and margin estimation from the vertical/horizontal detail projections.
  const colEnergy = new Float32Array(w);
  const rowEnergy = new Float32Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { colEnergy[x]! += grad[y * w + x]!; rowEnergy[y]! += grad[y * w + x]!; }
  const colMax = Math.max(...colEnergy), rowMax = Math.max(...rowEnergy);
  const colQuiet = [...colEnergy].map((e) => e < colMax * 0.05);
  const rowQuiet = [...rowEnergy].map((e) => e < rowMax * 0.05);
  const leading = (arr: boolean[]): number => { let i = 0; while (i < arr.length && arr[i]) i++; return i; };
  const margins = {
    left: round(leading(colQuiet) / w, 3),
    right: round(leading([...colQuiet].reverse()) / w, 3),
    top: round(leading(rowQuiet) / h, 3),
    bottom: round(leading([...rowQuiet].reverse()) / h, 3),
  };
  let columns = 0, inBlock = false;
  const start = Math.round(margins.left * w), end = w - Math.round(margins.right * w);
  for (let x = start; x < end; x++) {
    if (!colQuiet[x] && !inBlock) { columns++; inBlock = true; }
    else if (colQuiet[x]) inBlock = false;
  }

  // Palette: k-means then merge near-identical clusters.
  const k = options.colors ?? 8;
  const { centers, labels } = kmeans(lab, n, Math.min(k, n));
  const counts = new Array(centers.length).fill(0) as number[];
  for (let i = 0; i < n; i++) counts[labels[i]!]!++;
  const grid = 8;
  const cellW = w / grid, cellH = h / grid;
  const cellCounts = centers.map(() => new Array(grid * grid).fill(0) as number[]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const cell = Math.min(grid - 1, Math.floor(y / cellH)) * grid + Math.min(grid - 1, Math.floor(x / cellW));
    cellCounts[labels[y * w + x]!]![cell]!++;
  }
  const raw = centers.map((c, i) => {
    const cells = cellCounts[i]!;
    const bestCell = cells.indexOf(Math.max(...cells));
    const cx = bestCell % grid, cy = Math.floor(bestCell / grid);
    return {
      lab: c,
      share: counts[i]! / n,
      region: { x: Math.round((cx * cellW) / scale), y: Math.round((cy * cellH) / scale), w: Math.round(cellW / scale), h: Math.round(cellH / scale) },
    };
  });
  const merged: typeof raw = [];
  for (const entry of raw.sort((a, b) => b.share - a.share)) {
    const near = merged.find((m) => Math.hypot(m.lab[0]! - entry.lab[0]!, m.lab[1]! - entry.lab[1]!, m.lab[2]! - entry.lab[2]!) < 0.035);
    if (near) {
      const total = near.share + entry.share;
      near.lab = near.lab.map((v, i) => (v * near.share + entry.lab[i]! * entry.share) / total);
      near.share = total;
    } else merged.push({ ...entry, lab: [...entry.lab] });
  }
  const palette = merged
    .filter((m) => m.share >= 0.005)
    .map((m) => ({ hex: oklabToHex(m.lab[0]!, m.lab[1]!, m.lab[2]!), share: round(m.share, 4), region: m.region }));

  return {
    width,
    height,
    aspect: round(width / height, 3),
    palette,
    metrics: {
      lightness: round(meanL),
      contrast: round(Math.sqrt(Math.max(0, sumL2 / n - meanL * meanL))),
      chroma: round(sumC / n),
      warmth: round(sumB / n),
      tint: round(sumA / n),
      negativeSpace: round(quietTiles / tiles, 3),
      detail: round(gradSum / n),
      symmetry: round(symmetry, 3),
      focusX: round(gradSum ? fx / gradSum / w : 0.5, 3),
      focusY: round(gradSum ? fy / gradSum / h : 0.5, 3),
      shadowsShare: round(dark / n, 3),
      highlightsShare: round(bright / n, 3),
    },
    margins,
    columns,
  };
};

/** Mean absolute lightness difference between two frames, 0..1. */
export const frameDifference = async (a: string, b: string): Promise<number> => {
  const load = (p: string) => sharp(p).resize(160, 90, { fit: "fill" }).greyscale().raw().toBuffer();
  const [x, y] = await Promise.all([load(a), load(b)]);
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs(x[i]! - y[i]!);
  return round(sum / x.length / 255, 4);
};
