import type { Genome, MetricToken, MotionTokens, ScalarToken } from "../core/genome.js";
import type { Observation } from "../core/model.js";
import { cluster1D, coefficientOfVariation, detectGrid, mean, median } from "../core/numeric.js";
import { IMAGERY_DESCRIPTIONS } from "../extractors/image.js";
import type { ReconcileContext } from "./context.js";
import { groupBy } from "./typography.js";

const round = (n: number, d = 3): number => Math.round(n * 10 ** d) / 10 ** d;

/** Cluster scalar observations into tokens; each token keeps the observations that formed it. */
const scalarTokens = (
  ctx: ReconcileContext,
  observations: readonly Observation[],
  valueOf: (o: Observation) => number,
  unit: string,
  prefix: string,
  tolerance: number,
  relative = false,
  limit = 16,
): ScalarToken[] => {
  const items = observations.map((o) => ({ value: valueOf(o), weight: o.count, obs: o }));
  const clusters = cluster1D(items, tolerance, relative);
  const total = items.reduce((s, i) => s + i.weight, 0) || 1;
  return clusters
    .map((c) => ({
      id: `${prefix}-${String(c.center).replace(".", "_")}`,
      value: c.center,
      unit,
      share: round(c.weight / total),
      support: ctx.support(c.members.map((m) => m.obs)),
    }))
    .sort((a, b) => b.share - a.share)
    .slice(0, limit)
    .sort((a, b) => a.value - b.value);
};

export const reconcileSpacing = (ctx: ReconcileContext): Genome["spacing"] => {
  const obs = ctx.of("spacing").filter((o) => o.precision !== "estimated");
  const grid = detectGrid(obs.map((o) => ({ value: o.value.px, weight: o.count })));
  return { grid, scale: scalarTokens(ctx, obs, (o) => (o.value as { px: number }).px, "px", "space", 0.5) };
};

export const reconcileRadius = (ctx: ReconcileContext): ScalarToken[] => {
  const tokens = scalarTokens(ctx, ctx.of("radius"), (o) => (o.value as { px: number }).px, "px", "radius", 0.5, false, 12);
  return tokens.map((t) => (t.value >= 9999 ? { ...t, name: "pill" } : t));
};

export const reconcileShadows = (ctx: ReconcileContext): Genome["shadow"] => {
  const obs = ctx.of("shadow");
  const total = obs.reduce((s, o) => s + o.count, 0) || 1;
  return [...groupBy(obs, (o) => o.value.css).values()]
    .map((members) => ({ css: members[0]!.value.css, share: round(members.reduce((s, m) => s + m.count, 0) / total), support: ctx.support(members) }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 8);
};

const NAMED_EASINGS: Record<string, string> = {
  ease: "cubic-bezier(0.25, 0.1, 0.25, 1)",
  "ease-in": "cubic-bezier(0.42, 0, 1, 1)",
  "ease-out": "cubic-bezier(0, 0, 0.58, 1)",
  "ease-in-out": "cubic-bezier(0.42, 0, 0.58, 1)",
  linear: "linear",
};

export const normalizeEasing = (easing: string): { easing: string; name: string } => {
  const clean = easing.replace(/\s+/g, " ").trim().toLowerCase();
  if (NAMED_EASINGS[clean]) return { easing: NAMED_EASINGS[clean]!, name: clean };
  const named = Object.entries(NAMED_EASINGS).find(([, v]) => v.replace(/\s/g, "") === clean.replace(/\s/g, ""));
  if (named) return { easing: named[1], name: named[0] };
  return { easing: clean, name: clean.startsWith("cubic-bezier") ? "custom curve" : clean };
};

export const reconcileMotion = (ctx: ReconcileContext): MotionTokens => {
  const motion = ctx.of("motion");
  const timed = motion.filter((o) => (o.value.type === "transition" || o.value.type === "animation") && (o.value.durationMs ?? 0) > 0);
  const durations = scalarTokens(ctx, timed, (o) => (o.value as { durationMs: number }).durationMs, "ms", "duration", 0.12, true, 10);
  const total = timed.reduce((s, o) => s + o.count, 0) || 1;
  const easings = [...groupBy(timed, (o) => normalizeEasing(o.value.easing ?? "ease").easing).values()]
    .map((members) => {
      const n = normalizeEasing(members[0]!.value.easing ?? "ease");
      return { easing: n.easing, name: n.name, share: round(members.reduce((s, m) => s + m.count, 0) / total), support: ctx.support(members) };
    })
    .sort((a, b) => b.share - a.share)
    .slice(0, 8);

  const shots = motion.filter((o) => o.value.type === "cut" && o.value.durationMs);
  let editing: MotionTokens["editing"];
  const videos = new Set(shots.map((o) => o.sourceId));
  const cutCount = shots.length - videos.size;
  if (cutCount >= 1) {
    const secs = shots.map((c) => c.value.durationMs! / 1000);
    const totalSec = secs.reduce((a, b) => a + b, 0);
    const med = median(secs)!;
    const cv = coefficientOfVariation(secs) ?? 0;
    const perMinute = round((cutCount / totalSec) * 60, 1);
    editing = {
      medianShotSec: round(med, 2),
      meanShotSec: round(mean(secs)!, 2),
      variation: cv,
      cutsPerMinute: perMinute,
      description: `${med < 1.2 ? "Fast" : med < 3 ? "Measured" : "Slow, contemplative"} editing: median shot ${round(med, 2)}s, ${perMinute} cuts/min, ${cv > 0.8 ? "irregular rhythm" : "steady rhythm"} (variation ${cv}) across ${shots.length} shots.`,
      support: ctx.support(shots),
    };
  }
  const intensity = motion.filter((o) => o.value.type === "intensity" && o.value.magnitude !== undefined);
  const meanIntensity = mean(intensity.map((o) => o.value.magnitude!));
  return {
    durations,
    easings,
    ...(editing ? { editing } : {}),
    ...(meanIntensity !== null
      ? {
          intensity: {
            value: round(meanIntensity, 4),
            description: `${meanIntensity < 0.02 ? "Near-still frames: slow camera and subject motion" : meanIntensity < 0.06 ? "Moderate in-shot motion" : "High in-shot motion"} (mean frame change ${round(meanIntensity, 4)}).`,
            support: ctx.support(intensity),
          },
        }
      : {}),
  };
};

export const reconcileBreakpoints = (ctx: ReconcileContext): ScalarToken[] =>
  scalarTokens(ctx, ctx.of("breakpoint"), (o) => (o.value as { px: number }).px, "px", "bp", 2, false, 10);

const describeLayout = (metric: string, value: number, unit?: string): string => {
  if (metric === "content-max-width") return `Content column caps at ${value}px.`;
  if (metric.startsWith("margin-")) return `Empty ${metric.slice(7)} margin ≈ ${Math.round(value * 100)}% of the frame (estimated).`;
  if (metric === "columns") return `≈${value} content column(s) across the frame (estimated).`;
  return `${metric}: ${value}${unit ?? ""}`;
};

export const reconcileLayout = (ctx: ReconcileContext): MetricToken[] => {
  const out: MetricToken[] = [];
  for (const [metric, members] of groupBy(ctx.of("layout"), (o) => o.value.metric)) {
    if (metric === "content-max-width") {
      const clusters = cluster1D(members.map((m) => ({ value: m.value.value, weight: m.count, obs: m })), 4);
      const top = clusters.sort((a, b) => b.weight - a.weight)[0];
      if (top) out.push({ metric, value: top.center, unit: "px", description: describeLayout(metric, top.center), support: ctx.support(top.members.map((m) => m.obs)) });
      continue;
    }
    const values = members.map((m) => m.value.value);
    const m = mean(values)!;
    const spread = Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, values.length - 1));
    out.push({ metric, value: round(m), unit: members[0]!.value.unit, spread: round(spread), description: describeLayout(metric, round(m, 2), members[0]!.value.unit), support: ctx.support(members) });
  }
  return out;
};

const qualitative = (metric: string, v: number): string | undefined => {
  switch (metric) {
    case "lightness": return v > 0.8 ? "high-key, bright" : v < 0.35 ? "low-key, dark" : "mid-key";
    case "contrast": return v > 0.3 ? "high contrast" : v < 0.15 ? "soft, low contrast" : "moderate contrast";
    case "chroma": return v < 0.03 ? "near-monochrome" : v < 0.07 ? "restrained color" : "saturated";
    case "warmth": return v > 0.012 ? "warm" : v < -0.012 ? "cool" : "neutral temperature";
    case "negativeSpace": return v > 0.55 ? "generous negative space" : v < 0.25 ? "dense, little negative space" : "balanced";
    case "symmetry": return v > 0.85 ? "strongly symmetric" : v < 0.6 ? "asymmetric" : "loosely balanced";
    case "focusX": return Math.abs(v - 0.5) < 0.08 ? "centered subject" : Math.abs(v - 0.33) < 0.08 || Math.abs(v - 0.67) < 0.08 ? "subject on a third" : "off-center subject";
    default: return undefined;
  }
};

export const reconcileImagery = (ctx: ReconcileContext): MetricToken[] => {
  const out: MetricToken[] = [];
  const imagery = ctx.of("imagery");
  for (const [metric, members] of groupBy(imagery.filter((o) => !o.value.label), (o) => o.value.metric)) {
    const values = members.map((m) => m.value.value);
    const m = mean(values)!;
    const spread = Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, values.length - 1));
    const label = qualitative(metric, m);
    out.push({
      metric,
      value: round(m, 4),
      spread: round(spread, 4),
      ...(label ? { label } : {}),
      description: `${IMAGERY_DESCRIPTIONS[metric] ?? metric}: ${round(m, 3)}${label ? ` (${label})` : ""}, spread ${round(spread, 3)} across ${values.length} frame(s).`,
      support: ctx.support(members),
    });
  }
  for (const [metric, members] of groupBy(imagery.filter((o) => o.value.label), (o) => o.value.metric)) {
    for (const [label, same] of groupBy(members, (o) => o.value.label!.toLowerCase())) {
      out.push({ metric, value: round(same.length / members.length, 2), label, description: `${metric}: "${label}" in ${same.length} of ${members.length} readings (vision, inferred).`, support: ctx.support(same) });
    }
  }
  return out;
};

export const reconcileVoice = (ctx: ReconcileContext): Genome["voice"] => {
  const voice = ctx.of("voice");
  const headlines = voice.filter((o) => o.value.role === "display" || o.value.role === "headline");
  const words = headlines.map((o) => o.value.words);
  const seen = new Set<string>();
  const samples = [...voice]
    .sort((a, b) => (a.value.role === "display" ? -1 : 0) - (b.value.role === "display" ? -1 : 0) || b.count - a.count)
    .filter((o) => {
      const key = o.value.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 16)
    .map((o) => ({ text: o.value.text, role: o.value.role ?? "headline", sourceId: o.sourceId }));
  return { headlineWords: words.length ? { median: median(words)!, max: Math.max(...words) } : null, samples };
};
