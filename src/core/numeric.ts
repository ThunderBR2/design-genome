/** Numeric derivations shared by reconciliation and verification. Pure functions. */

export interface Weighted {
  readonly value: number;
  readonly weight: number;
}

export interface Cluster<T extends Weighted = Weighted> {
  readonly center: number;
  readonly weight: number;
  readonly members: readonly T[];
}

const round = (value: number, digits = 3): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * Greedy 1-D clustering: sorted values join the current cluster while they sit
 * within `tolerance` (absolute, or relative when `relative` is set) of its center.
 */
export const cluster1D = <T extends Weighted>(
  items: readonly T[],
  tolerance: number,
  relative = false,
): Cluster<T>[] => {
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const clusters: { members: T[]; sum: number; weight: number }[] = [];
  for (const item of sorted) {
    const current = clusters.at(-1);
    const center = current ? current.sum / current.weight : 0;
    const limit = relative ? Math.abs(center) * tolerance : tolerance;
    if (current && Math.abs(item.value - center) <= limit) {
      current.members.push(item);
      current.sum += item.value * item.weight;
      current.weight += item.weight;
    } else {
      clusters.push({ members: [item], sum: item.value * item.weight, weight: item.weight });
    }
  }
  return clusters.map((c) => ({
    center: round(c.sum / c.weight, 2),
    weight: round(c.weight, 4),
    members: c.members,
  }));
};

export const NAMED_RATIOS: readonly { readonly name: string; readonly ratio: number }[] = [
  { name: "minor second", ratio: 1.067 },
  { name: "major second", ratio: 1.125 },
  { name: "minor third", ratio: 1.2 },
  { name: "major third", ratio: 1.25 },
  { name: "perfect fourth", ratio: 1.333 },
  { name: "augmented fourth", ratio: 1.414 },
  { name: "perfect fifth", ratio: 1.5 },
  { name: "golden ratio", ratio: 1.618 },
];

export interface ScaleFit {
  readonly base: number;
  readonly ratio: number;
  readonly namedRatio: string | null;
  /** Mean absolute log error, in steps of the ratio. 0 is a perfect modular scale. */
  readonly error: number;
  /** True when the sizes are well explained by one ratio (error < 0.12 steps). */
  readonly modular: boolean;
  readonly steps: readonly { readonly size: number; readonly step: number }[];
}

/** Fit sizes to base * ratio^k. Reports honestly when no single ratio explains them. */
export const fitModularScale = (sizes: readonly Weighted[], base: number): ScaleFit | null => {
  const usable = sizes.filter((s) => s.value > 0);
  if (usable.length < 3 || base <= 0) return null;
  let best: { ratio: number; error: number } | null = null;
  // Ratios below 1.12 fit almost any set of sizes and explain nothing.
  for (let ratio = 1.12; ratio <= 1.7; ratio += 0.001) {
    const logR = Math.log(ratio);
    let err = 0;
    let weight = 0;
    for (const s of usable) {
      const k = Math.log(s.value / base) / logR;
      err += Math.abs(k - Math.round(k)) * s.weight;
      weight += s.weight;
    }
    const error = err / weight;
    // Prefer larger ratios on near-ties: small ratios fit anything trivially.
    if (!best || error < best.error - 0.01) best = { ratio, error };
  }
  if (!best) return null;
  const ratio = round(best.ratio, 3);
  const named = NAMED_RATIOS.find((n) => Math.abs(n.ratio - ratio) < 0.012) ?? null;
  const logR = Math.log(ratio);
  return {
    base,
    ratio,
    namedRatio: named?.name ?? null,
    error: round(best.error, 3),
    modular: best.error < 0.12,
    steps: usable
      .map((s) => ({ size: s.value, step: Math.round(Math.log(s.value / base) / logR) }))
      .sort((a, b) => a.size - b.size),
  };
};

export interface GridFit {
  readonly unit: number;
  /** Weighted share of values that are multiples of the unit (±0.5px). */
  readonly adherence: number;
  readonly offGrid: readonly number[];
}

const GRID_CANDIDATES = [2, 4, 5, 6, 8, 10, 12, 16];

export const detectGrid = (values: readonly Weighted[]): GridFit | null => {
  const usable = values.filter((v) => v.value > 0);
  if (usable.length < 4) return null;
  const total = usable.reduce((sum, v) => sum + v.weight, 0);
  const fits = GRID_CANDIDATES.map((unit) => {
    let on = 0;
    const offGrid: number[] = [];
    for (const v of usable) {
      const remainder = v.value % unit;
      if (Math.min(remainder, unit - remainder) <= 0.5) on += v.weight;
      else offGrid.push(v.value);
    }
    return { unit, adherence: round(on / total, 3), offGrid };
  });
  // The largest unit that still explains most values is the meaningful grid.
  const strong = fits.filter((f) => f.adherence >= 0.85).sort((a, b) => b.unit - a.unit)[0];
  const chosen = strong ?? [...fits].sort((a, b) => b.adherence - a.adherence)[0];
  if (!chosen) return null;
  return { ...chosen, offGrid: [...new Set(chosen.offGrid)].sort((a, b) => a - b).slice(0, 12) };
};

export interface LinearFit {
  readonly slope: number;
  readonly intercept: number;
  readonly r2: number;
  readonly n: number;
}

export const linearFit = (points: readonly { x: number; y: number; w?: number }[]): LinearFit | null => {
  if (points.length < 3) return null;
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) {
    const w = p.w ?? 1;
    sw += w; sx += w * p.x; sy += w * p.y; sxx += w * p.x * p.x; sxy += w * p.x * p.y;
  }
  const denom = sw * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const slope = (sw * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / sw;
  const meanY = sy / sw;
  let ssTot = 0, ssRes = 0;
  for (const p of points) {
    const w = p.w ?? 1;
    ssTot += w * (p.y - meanY) ** 2;
    ssRes += w * (p.y - (slope * p.x + intercept)) ** 2;
  }
  return {
    slope: round(slope, 5),
    intercept: round(intercept, 5),
    r2: ssTot === 0 ? 1 : round(1 - ssRes / ssTot, 3),
    n: points.length,
  };
};

export const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

export const mean = (values: readonly number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

export const coefficientOfVariation = (values: readonly number[]): number | null => {
  const m = mean(values);
  if (m === null || m === 0 || values.length < 2) return null;
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return round(Math.sqrt(variance) / m, 3);
};

export { round };
