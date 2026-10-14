import { colorDistance, colorFamily, isNeutral, oklchOf } from "../core/color.js";
import type { ColorToken } from "../core/genome.js";
import type { Observation, Precision } from "../core/model.js";
import { byPrecision, type ReconcileContext } from "./context.js";

type ColorObs = Observation & { value: Extract<Observation["value"], { kind: "color" }> };

/** Merge tolerance in CIEDE2000, by the precisions being compared. */
export const colorTolerance = (a: Precision, b: Precision): number => {
  const pair = new Set([a, b]);
  if (pair.has("estimated") || pair.has("inferred")) return 6;
  if (pair.has("declared")) return 2.5;
  return 1.2;
};

interface Group {
  readonly members: ColorObs[];
  anchor: ColorObs;
}

export interface PaletteResult {
  readonly tokens: ColorToken[];
  readonly neutralsShare: number;
  readonly accentCount: number;
  /** observation id -> token id, for rules and conflicts. */
  readonly membership: ReadonlyMap<string, string>;
}

const SHARELESS = new Set(["variable", "border"]);

export const reconcilePalette = (ctx: ReconcileContext): PaletteResult => {
  const colors = ctx.of("color") as ColorObs[];
  const sourceTotals = new Map<string, number>();
  for (const o of colors) {
    if (SHARELESS.has(o.context.usage ?? "")) continue;
    sourceTotals.set(o.sourceId, (sourceTotals.get(o.sourceId) ?? 0) + (o.value.share ?? 0));
  }
  const normShare = (o: ColorObs): number => {
    if (SHARELESS.has(o.context.usage ?? "")) return 0;
    const total = sourceTotals.get(o.sourceId) ?? 0;
    return total > 0 ? (o.value.share ?? 0) / total : 0;
  };

  // Exact readings anchor groups first; estimated pixels then snap to them.
  const ordered = [...colors].sort((a, b) => byPrecision(a, b) || normShare(b) - normShare(a) || b.count - a.count);
  const groups: Group[] = [];
  for (const o of ordered) {
    let best: { group: Group; d: number } | null = null;
    for (const g of groups) {
      if (o.precision === "exact" && g.anchor.precision === "exact" && Math.abs((o.value.alpha ?? 1) - (g.anchor.value.alpha ?? 1)) > 0.05) continue;
      const d = colorDistance(o.value.hex, g.anchor.value.hex);
      if (d <= colorTolerance(o.precision, g.anchor.precision) && (!best || d < best.d)) best = { group: g, d };
    }
    if (best) best.group.members.push(o);
    else groups.push({ members: [o], anchor: o });
  }

  const covering = Math.max(1, ctx.covering("color").length);
  const scored = groups.map((g) => {
    let share = 0;
    for (const m of g.members) share += normShare(m);
    const sources = new Set(g.members.map((m) => m.sourceId));
    const count = g.members.reduce((s, m) => s + m.count, 0);
    return { group: g, share: share / covering, sources, count };
  });
  const kept = scored
    .filter((s) => s.share >= 0.003 || s.count >= 3 || s.sources.size >= 2 || s.group.members.some((m) => m.precision === "declared"))
    .sort((a, b) => b.share - a.share || b.count - a.count)
    .slice(0, 48);

  const tokens: ColorToken[] = [];
  const membership = new Map<string, string>();
  const used = new Set<string>();
  const uniqueName = (name: string): string => {
    let candidate = name;
    let i = 2;
    while (used.has(candidate)) candidate = `${name}-${i++}`;
    used.add(candidate);
    return candidate;
  };
  for (const { group, share } of kept) {
    const anchor = group.anchor;
    const hex = anchor.value.hex;
    const oklch = oklchOf(hex);
    const usages = [...new Set(group.members.map((m) => m.context.usage).filter((u): u is string => Boolean(u)))].sort();
    const declared = group.members.find((m) => m.precision === "declared" && m.context.role) ?? group.members.find((m) => m.context.usage === "variable");
    const id = `color-${hex.slice(1)}${anchor.value.alpha < 1 ? `-a${Math.round(anchor.value.alpha * 100)}` : ""}`;
    tokens.push({
      id,
      name: "",
      hex,
      oklch,
      family: colorFamily(oklch),
      usages,
      share: Math.round(share * 10000) / 10000,
      variants: [...new Set(group.members.map((m) => m.value.hex).filter((h) => h !== hex))].slice(0, 8),
      ...(declared?.context.role ? { declaredAs: declared.context.role } : {}),
      support: ctx.support(group.members),
    });
    for (const m of group.members) membership.set(m.id, id);
  }

  // Semantic names where usage makes the role clear; perceptual names otherwise.
  const pick = (pred: (t: ColorToken) => boolean) => tokens.filter((t) => !t.name && pred(t)).sort((a, b) => b.share - a.share)[0];
  const assign = (t: ColorToken | undefined, name: string) => {
    if (t) (t as { name: string }).name = uniqueName(name);
  };
  assign(pick((t) => t.usages.includes("background") || t.usages.includes("image") || t.usages.includes("frame")), "canvas");
  assign(pick((t) => t.usages.includes("text") && isNeutral(t.oklch)), "text-primary");
  assign(pick((t) => t.usages.includes("text") && isNeutral(t.oklch)), "text-secondary");
  assign(pick((t) => !isNeutral(t.oklch) && t.usages.some((u) => u.startsWith("interactive"))), "accent");
  for (const t of tokens) {
    if (!t.name) assign(t, `${t.family}-${Math.round(t.oklch.l * 100)}`);
  }

  const neutralsShare = tokens.filter((t) => isNeutral(t.oklch)).reduce((s, t) => s + t.share, 0);
  const totalShare = tokens.reduce((s, t) => s + t.share, 0) || 1;
  const accentHues = new Set(tokens.filter((t) => !isNeutral(t.oklch) && t.share >= 0.002).map((t) => t.family));
  return {
    tokens,
    neutralsShare: Math.round((neutralsShare / totalShare) * 1000) / 1000,
    accentCount: accentHues.size,
    membership,
  };
};
