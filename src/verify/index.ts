import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { colorDistance, isNeutral } from "../core/color.js";
import { familyKey } from "../core/fonts.js";
import type { Genome } from "../core/genome.js";
import { Project } from "../core/project.js";
import type { Observation } from "../core/model.js";
import { analyzeImage } from "../extractors/image.analyze.js";
import { webExtractor } from "../extractors/web.js";
import { normalizeEasing } from "../reconcile/metrics.js";

/**
 * The closed loop: measure a candidate design with the same extractors that
 * built the genome, then report every deviation with the nearest valid value.
 */

export type Severity = "high" | "medium" | "low";

export interface Violation {
  readonly facet: string;
  readonly severity: Severity;
  readonly message: string;
  readonly found: string;
  readonly expected: string;
  readonly where?: string;
}

export interface FacetReport {
  readonly score: number;
  readonly checked: number;
  readonly violations: readonly Violation[];
}

export interface VerifyReport {
  readonly target: string;
  readonly kind: "web" | "image";
  readonly score: number;
  readonly facets: Readonly<Record<string, FacetReport>>;
  readonly violations: readonly Violation[];
  readonly summary: string;
  readonly limitations: readonly string[];
}

const SEVERITY_WEIGHT: Record<Severity, number> = { high: 1, medium: 0.6, low: 0.25 };
const round = (n: number, d = 3): number => Math.round(n * 10 ** d) / 10 ** d;

class FacetScore {
  checked = 0;
  penalty = 0;
  readonly violations: Violation[] = [];
  constructor(readonly facet: string) {}
  pass(weight = 1): void {
    this.checked += weight;
  }
  fail(v: Omit<Violation, "facet">, weight = 1): void {
    this.checked += weight;
    this.penalty += weight * SEVERITY_WEIGHT[v.severity];
    this.violations.push({ facet: this.facet, ...v });
  }
  report(): FacetReport {
    return { score: this.checked ? round(Math.max(0, 1 - this.penalty / this.checked)) : 1, checked: Math.round(this.checked), violations: this.violations.slice(0, 40) };
  }
}

/** Interpolate the genome's tracking table at a size, on a log-size axis. */
export const expectedTracking = (genome: Genome, size: number): number | null => {
  const table = genome.typography.tracking?.table ?? [];
  if (!table.length) return null;
  if (size <= table[0]!.sizePx) return table[0]!.trackingEm;
  if (size >= table.at(-1)!.sizePx) return table.at(-1)!.trackingEm;
  for (let i = 1; i < table.length; i++) {
    const a = table[i - 1]!, b = table[i]!;
    if (size <= b.sizePx) {
      const t = (Math.log(size) - Math.log(a.sizePx)) / (Math.log(b.sizePx) - Math.log(a.sizePx));
      return round(a.trackingEm + t * (b.trackingEm - a.trackingEm), 4);
    }
  }
  return null;
};

const nearestColor = (genome: Genome, hex: string) =>
  genome.color.tokens.map((t) => ({ t, d: colorDistance(t.hex, hex) })).sort((a, b) => a.d - b.d)[0];

const where = (o: Observation): string | undefined => {
  const l = o.evidence[0]?.locator;
  return l?.type === "css" ? `${l.selector} @${l.viewport}px` : undefined;
};

export const verifyObservations = (genome: Genome, observations: readonly Observation[]): Record<string, FacetReport> => {
  const color = new FacetScore("color");
  const type = new FacetScore("typography");
  const spacing = new FacetScore("spacing");
  const shape = new FacetScore("shape");
  const motion = new FacetScore("motion");
  const voice = new FacetScore("voice");

  if (genome.color.tokens.length) {
    for (const o of observations) {
      if (o.value.kind !== "color" || o.context.usage === "variable") continue;
      const near = nearestColor(genome, o.value.hex);
      if (!near) continue;
      const weight = Math.log2(1 + o.count);
      if (near.d <= 3) color.pass(weight);
      else {
        const neutral = isNeutral(o.value.oklch);
        color.fail({ severity: neutral ? "low" : near.d > 15 ? "high" : "medium", message: `${o.value.hex} (${o.context.usage ?? "color"}) is not in the palette; nearest is ${near.t.name} ${near.t.hex} (ΔE ${round(near.d, 1)}).`, found: o.value.hex, expected: near.t.hex, where: where(o) }, weight);
      }
    }
  }

  const families = genome.typography.families;
  const allowedFamilies = new Set(families.flatMap((f) => [familyKey(f.family), ...(f.substitute ? [familyKey(f.substitute)] : [])]));
  const sizes = [...new Set(genome.typography.styles.map((s) => s.sizePx))].sort((a, b) => a - b);
  const avoidUppercase = genome.rules.some((r) => r.topic === "typography" && (r.polarity === "avoid" || r.polarity === "never") && /upper|caps|caixa alta/i.test(r.statement));
  for (const o of observations) {
    if (o.value.kind !== "typography") continue;
    const v = o.value;
    const weight = Math.log2(1 + o.count);
    if (allowedFamilies.size) {
      if ([...allowedFamilies].some((f) => familyKey(v.family).startsWith(f) || f.startsWith(familyKey(v.family)))) type.pass(weight);
      else type.fail({ severity: "high", message: `Font family "${v.family}" is outside the system (${families.map((f) => f.family + (f.substitute ? ` / ${f.substitute}` : "")).join(", ")}).`, found: v.family, expected: families[0]?.substitute ?? families[0]?.family ?? "", where: where(o) }, weight);
    }
    if (v.sizePx && sizes.length) {
      const nearest = sizes.reduce((best, s) => (Math.abs(s - v.sizePx!) < Math.abs(best - v.sizePx!) ? s : best), sizes[0]!);
      if (Math.abs(nearest - v.sizePx) <= 0.5) type.pass(weight);
      else type.fail({ severity: Math.abs(nearest - v.sizePx) / nearest > 0.15 ? "medium" : "low", message: `${v.sizePx}px is not on the type ramp; nearest step is ${nearest}px.`, found: `${v.sizePx}px`, expected: `${nearest}px`, where: where(o) }, weight);
      const expected = expectedTracking(genome, v.sizePx);
      if (expected !== null && v.trackingEm !== undefined) {
        const diff = Math.abs(expected - v.trackingEm);
        if (diff <= 0.006) type.pass(weight);
        else type.fail({ severity: diff > 0.02 ? "medium" : "low", message: `Tracking at ${v.sizePx}px is ${v.trackingEm}em; the system uses ≈${expected}em at that size.`, found: `${v.trackingEm}em`, expected: `${expected}em`, where: where(o) }, weight);
      }
    }
    if (avoidUppercase && v.transform === "uppercase") type.fail({ severity: "medium", message: `All-caps text ("${v.sample ?? ""}") goes against the system.`, found: "uppercase", expected: "sentence case", where: where(o) }, weight);
  }

  const grid = genome.spacing.grid;
  if (grid) {
    for (const o of observations) {
      if (o.value.kind !== "spacing") continue;
      const px = o.value.px;
      const r = px % grid.unit;
      const weight = Math.log2(1 + o.count);
      if (Math.min(r, grid.unit - r) <= 0.5) spacing.pass(weight);
      else {
        const snapped = Math.max(grid.unit, Math.round(px / grid.unit) * grid.unit);
        spacing.fail({ severity: Math.abs(snapped - px) > grid.unit / 2 ? "medium" : "low", message: `${px}px ${o.context.usage ?? "spacing"} is off the ${grid.unit}px grid; use ${snapped}px.`, found: `${px}px`, expected: `${snapped}px`, where: where(o) }, weight);
      }
    }
  }

  const radii = genome.radius.map((r) => r.value);
  if (radii.length) {
    for (const o of observations) {
      if (o.value.kind !== "radius") continue;
      const px = o.value.px;
      const nearest = radii.reduce((b, r) => (Math.abs(r - px) < Math.abs(b - px) ? r : b), radii[0]!);
      if (Math.abs(nearest - px) <= 1) shape.pass();
      else shape.fail({ severity: "low", message: `Corner radius ${px}px is not in the set (${radii.map((r) => (r >= 9999 ? "pill" : `${r}px`)).join(", ")}).`, found: `${px}px`, expected: nearest >= 9999 ? "pill" : `${nearest}px`, where: where(o) });
    }
  }

  const durations = genome.motion.durations.map((d) => d.value);
  const easings = new Set(genome.motion.easings.map((e) => e.easing));
  if (durations.length) {
    const lo = Math.min(...durations) * 0.8;
    const hi = Math.max(...durations) * 1.2;
    for (const o of observations) {
      if (o.value.kind !== "motion" || !o.value.durationMs || o.value.type === "cut") continue;
      const d = o.value.durationMs;
      if (d >= lo && d <= hi) motion.pass();
      else motion.fail({ severity: "low", message: `${d}ms ${o.value.type} is outside the system's ${Math.round(lo / 0.8)}–${Math.round(hi / 1.2)}ms range.`, found: `${d}ms`, expected: `${Math.round(lo / 0.8)}–${Math.round(hi / 1.2)}ms`, where: where(o) });
      if (o.value.easing && easings.size) {
        const e = normalizeEasing(o.value.easing).easing;
        if (easings.has(e)) motion.pass();
        else motion.fail({ severity: "low", message: `Easing ${e} is not one of the system curves (${[...easings].join(", ")}).`, found: e, expected: [...easings][0]!, where: where(o) });
      }
    }
  }

  const maxWords = genome.voice.headlineWords?.max;
  if (maxWords) {
    for (const o of observations) {
      if (o.value.kind !== "voice" || !(o.value.role === "display" || o.value.role === "headline")) continue;
      if (o.value.words <= maxWords + 2) voice.pass();
      else voice.fail({ severity: "low", message: `Headline "${o.value.text.slice(0, 60)}" has ${o.value.words} words; the system's run ${genome.voice.headlineWords!.median}–${maxWords}.`, found: `${o.value.words} words`, expected: `≤ ${maxWords} words`, where: where(o) });
    }
  }

  const out: Record<string, FacetReport> = {};
  for (const f of [color, type, spacing, shape, motion, voice]) if (f.checked) out[f.facet] = f.report();
  return out;
};

const IMAGE_TOLERANCE: Record<string, number> = { lightness: 0.12, contrast: 0.08, chroma: 0.03, warmth: 0.015, negativeSpace: 0.2, symmetry: 0.2, focusX: 0.15 };

export const verifyImage = async (genome: Genome, path: string): Promise<Record<string, FacetReport>> => {
  const analysis = await analyzeImage(path);
  const color = new FacetScore("color");
  const imagery = new FacetScore("imagery");
  for (const entry of analysis.palette) {
    const near = nearestColor(genome, entry.hex);
    if (!near) continue;
    const weight = entry.share * 10;
    if (near.d <= 8) color.pass(weight);
    else color.fail({ severity: entry.share > 0.2 ? "high" : entry.share > 0.05 ? "medium" : "low", message: `${entry.hex} covers ${Math.round(entry.share * 100)}% of the image; nearest system color is ${near.t.name} ${near.t.hex} (ΔE ${round(near.d, 1)}).`, found: entry.hex, expected: near.t.hex, where: `region ${entry.region.x},${entry.region.y}` }, weight);
  }
  for (const [metric, tol] of Object.entries(IMAGE_TOLERANCE)) {
    const target = genome.imagery.find((m) => m.metric === metric && m.spread !== undefined);
    const value = (analysis.metrics as unknown as Record<string, number>)[metric];
    if (!target || value === undefined) continue;
    const allowed = Math.max(tol, (target.spread ?? 0) * 1.5);
    const diff = Math.abs(value - target.value);
    if (diff <= allowed) imagery.pass();
    else imagery.fail({ severity: diff > allowed * 2 ? "medium" : "low", message: `${metric} is ${round(value)}; the system's imagery sits at ${target.value}${target.label ? ` (${target.label})` : ""} ±${round(allowed)}.`, found: String(round(value)), expected: `${target.value} ±${round(allowed)}` });
  }
  const out: Record<string, FacetReport> = {};
  if (color.checked) out.color = color.report();
  if (imagery.checked) out.imagery = imagery.report();
  return out;
};

const FACET_WEIGHT: Record<string, number> = { color: 1, typography: 1, spacing: 0.7, shape: 0.4, motion: 0.4, voice: 0.3, imagery: 1 };

const summarize = (facets: Record<string, FacetReport>, target: string, kind: "web" | "image", limitations: string[]): VerifyReport => {
  let num = 0, den = 0;
  for (const [facet, r] of Object.entries(facets)) {
    const w = FACET_WEIGHT[facet] ?? 0.5;
    num += r.score * w;
    den += w;
  }
  const score = den ? round(num / den) : 0;
  const violations = Object.values(facets).flatMap((f) => f.violations).sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]);
  const worst = Object.entries(facets).sort((a, b) => a[1].score - b[1].score)[0];
  return {
    target,
    kind,
    score,
    facets,
    violations,
    summary: `${Math.round(score * 100)}% conformant across ${Object.keys(facets).length} facet(s); ${violations.length} deviation(s)${worst && worst[1].score < 1 ? `, weakest: ${worst[0]} (${Math.round(worst[1].score * 100)}%)` : ""}.`,
    limitations,
  };
};

const isImagePath = (t: string): boolean => /\.(png|jpe?g|webp|gif|avif|tiff?|bmp)$/i.test(t.split("?")[0]!);

/** Verify a URL, a local HTML file, or an image against a genome. */
export const verify = async (genome: Genome, target: string, options: { viewports?: number[]; log?: (m: string) => void } = {}): Promise<VerifyReport> => {
  if (isImagePath(target) && !/^https?:/i.test(target)) {
    return summarize(await verifyImage(genome, target), target, "image", ["Image checks compare palette and imagery statistics; typography in pixels is not read."]);
  }
  const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "genome-verify-"));
  try {
    const project = await Project.create(dir, "verify");
    const uri = /^https?:|^file:/i.test(target) ? target : `file://${target.startsWith("/") ? target : join(process.cwd(), target)}`;
    const source = { id: "candidate", kind: "web" as const, uri, addedAt: new Date().toISOString(), tags: [], options: { viewports: options.viewports ?? [1440] } };
    const extraction = await webExtractor.extract({ project, source, log: options.log ?? (() => undefined) });
    return summarize(verifyObservations(genome, extraction.observations), target, "web", extraction.limitations);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
