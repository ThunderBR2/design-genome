import { colorDistance, isNeutral } from "../core/color.js";
import { familyKey } from "../core/fonts.js";
import type { Conflict, ConflictClaim, Genome, Rule } from "../core/genome.js";
import { stableId } from "../core/ids.js";
import type { Observation } from "../core/model.js";
import type { ReconcileContext } from "./context.js";
import type { PaletteResult } from "./palette.js";

type Partial = Omit<Genome, "rules" | "conflicts" | "unknowns" | "schema" | "name" | "builtAt" | "sources" | "coverage">;
type RuleObs = Observation & { value: Extract<Observation["value"], { kind: "rule" }> };

const pct = (n: number): string => `${Math.round(n * 100)}%`;

const claim = (ctx: ReconcileContext, o: Observation, value: string): ConflictClaim => ({
  sourceId: o.sourceId,
  kind: ctx.kindOf(o.sourceId),
  precision: o.precision,
  value,
  evidence: o.evidence.slice(0, 2),
});

/** Rules the measurements imply. Each one cites the observations behind it. */
export const deriveRules = (ctx: ReconcileContext, g: Partial, palette: PaletteResult): Rule[] => {
  const rules: Rule[] = [];
  const add = (topic: string, statement: string, polarity: Rule["polarity"], support: Rule["support"], counterexamples: Rule["counterexamples"] = []) =>
    rules.push({ id: stableId("rule", topic, statement), topic, statement, polarity, origin: "derived", support, counterexamples });

  const colorTokens = g.color.tokens;
  if (colorTokens.length) {
    const accents = colorTokens.filter((t) => !isNeutral(t.oklch) && t.share >= 0.002);
    add(
      "color",
      `Neutrals carry ${pct(g.color.neutralsShare)} of color usage; ${accents.length ? `accents (${accents.slice(0, 3).map((a) => a.hex).join(", ")}) are used sparingly` : "there is no accent color"}.`,
      "fact",
      ctx.support(ctx.of("color").filter((o) => palette.membership.has(o.id)).slice(0, 60)),
    );
    for (const accent of accents.slice(0, 3)) {
      const members = ctx.of("color").filter((o) => palette.membership.get(o.id) === accent.id && o.context.usage && o.context.usage !== "variable" && o.precision !== "declared");
      const interactive = members.filter((o) => o.context.usage!.startsWith("interactive")).reduce((s, o) => s + o.count, 0);
      const total = members.reduce((s, o) => s + o.count, 0);
      if (total >= 3 && interactive / total >= 0.7) {
        add("color", `${accent.hex} is reserved for interactive elements (${pct(interactive / total)} of its uses are links or buttons).`, "must", accent.support);
      }
    }
  }

  const fam = g.typography.families;
  if (fam[0] && fam[0].share >= 0.85) {
    add("typography", `One family, ${fam[0].family}, sets ${pct(fam[0].share)} of all text.${fam[0].reuse === "restricted" ? ` It is restricted: use ${fam[0].substitute ?? "a licensed equivalent"} and re-fit tracking.` : ""}`, "must", fam[0].support);
  }
  if (g.typography.scale) add("typography", g.typography.scale.description, g.typography.scale.modular ? "must" : "fact", ctx.support(ctx.of("typography").filter((o) => o.precision === "exact").slice(0, 40)));
  if (g.typography.tracking) add("typography", g.typography.tracking.description, g.typography.tracking.fit.r2 >= 0.5 ? "must" : "fact", ctx.support(ctx.of("typography").filter((o) => o.precision === "exact" && o.value.trackingEm !== undefined).slice(0, 40)));
  const typeObs = ctx.of("typography").filter((o) => o.precision === "exact");
  const totalType = typeObs.reduce((s, o) => s + o.count, 0);
  if (totalType >= 20) {
    const upper = typeObs.filter((o) => o.value.transform === "uppercase");
    const upperShare = upper.reduce((s, o) => s + o.count, 0) / totalType;
    if (upperShare < 0.02) add("typography", `Text is set in sentence or title case; all-caps appears in ${pct(upperShare)} of text.`, "avoid", ctx.support(typeObs.slice(0, 30)), upper.slice(0, 3).map((o) => ({ sourceId: o.sourceId, detail: `uppercase "${o.value.sample ?? ""}"`, evidence: o.evidence[0] })));
    const heavy = typeObs.filter((o) => (o.value.weight ?? 400) >= 700);
    const display = typeObs.filter((o) => o.context.role === "display" || o.context.role === "headline");
    const displayWeights = [...new Set(display.map((o) => o.value.weight ?? 400))].sort();
    if (display.length) add("typography", `Display and headline text use weight ${displayWeights.join("/")}; bold (≥700) is ${pct(heavy.reduce((s, o) => s + o.count, 0) / totalType)} of all text.`, "fact", ctx.support(display));
  }
  if (g.typography.lineHeight?.display && g.typography.lineHeight.body) {
    add("typography", `Large text is set tight (line-height ${g.typography.lineHeight.display}) and body text open (line-height ${g.typography.lineHeight.body}).`, "should", ctx.support(typeObs.filter((o) => o.value.lineHeight).slice(0, 30)));
  }
  if (g.voice.headlineWords) {
    add("voice", `Headlines are short: median ${g.voice.headlineWords.median} words, longest ${g.voice.headlineWords.max}.`, "should", ctx.support(ctx.of("voice")));
  }

  if (g.spacing.grid) {
    const grid = g.spacing.grid;
    add("spacing", `Spacing sits on a ${grid.unit}px grid (${pct(grid.adherence)} of measured gaps, margins and paddings).`, grid.adherence >= 0.85 ? "must" : "should", ctx.support(ctx.of("spacing").slice(0, 60)), grid.offGrid.slice(0, 5).map((v) => ({ sourceId: "", detail: `${v}px is off-grid` })));
  }
  if (g.radius.length) {
    const pill = g.radius.find((r) => r.name === "pill");
    add("shape", `Corner radii come from a small set: ${g.radius.map((r) => (r.name === "pill" ? "pill" : `${r.value}px`)).join(", ")}.${pill && pill.share > 0.2 ? " Controls are pill-shaped." : ""}`, "should", ctx.support(ctx.of("radius")));
  }
  if (g.motion.durations.length) {
    const lo = Math.min(...g.motion.durations.map((d) => d.value));
    const hi = Math.max(...g.motion.durations.map((d) => d.value));
    const easing = g.motion.easings[0];
    add("motion", `UI transitions last ${lo}–${hi}ms${easing ? `, mostly with ${easing.name === "custom curve" ? easing.easing : easing.name}` : ""}.`, "should", ctx.support(ctx.of("motion").filter((o) => o.value.durationMs && o.value.type !== "cut")));
  }
  if (g.motion.editing) add("motion", g.motion.editing.description, "fact", g.motion.editing.support);
  if (g.motion.intensity) add("motion", g.motion.intensity.description, "fact", g.motion.intensity.support);
  for (const metric of g.imagery) {
    if (metric.label && ["lightness", "negativeSpace", "warmth", "chroma", "contrast", "focusX"].includes(metric.metric) && (metric.spread ?? 0) < 0.25) {
      add("imagery", `Imagery is ${metric.label} (${metric.metric} ${metric.value}).`, "fact", metric.support);
    }
  }
  return rules;
};

const words = (s: string): Set<string> => new Set(s.toLowerCase().replace(/[^a-z0-9à-ú\s-]/g, " ").split(/\s+/).filter((w) => w.length > 3));
const jaccard = (a: Set<string>, b: Set<string>): number => {
  const inter = [...a].filter((w) => b.has(w)).length;
  return inter / (a.size + b.size - inter || 1);
};

/** Declared (documents) and inferred (vision) rules, with similar statements merged across sources. */
export const collectStatedRules = (ctx: ReconcileContext): Rule[] => {
  const stated = ctx.of("rule") as RuleObs[];
  const groups: { members: RuleObs[]; tokens: Set<string> }[] = [];
  for (const o of stated) {
    const t = words(o.value.statement);
    const g = groups.find((x) => x.members[0]!.value.topic === o.value.topic && jaccard(x.tokens, t) >= 0.45);
    if (g) {
      g.members.push(o);
      for (const w of t) g.tokens.add(w);
    } else groups.push({ members: [o], tokens: t });
  }
  return groups.map(({ members }) => {
    const lead = [...members].sort((a, b) => (a.precision === "declared" ? -1 : 0) - (b.precision === "declared" ? -1 : 0) || b.confidence - a.confidence)[0]!;
    return {
      id: stableId("rule", lead.value.topic, lead.value.statement),
      topic: lead.value.topic ?? "general",
      statement: lead.value.statement,
      polarity: lead.value.polarity,
      origin: members.some((m) => m.precision === "declared") ? "declared" : "inferred",
      support: ctx.support(members),
      counterexamples: [],
    } satisfies Rule;
  });
};

/**
 * Does a declared, machine-checkable rule hold in what was measured? "pass"
 * returns the observations that corroborate it, so a brand rule followed in
 * practice becomes confirmed instead of staying declared-only.
 */
export const evaluateCheck = (ctx: ReconcileContext, g: Partial, rule: RuleObs): { verdict: "pass" | "fail" | "unknown"; observations: Observation[] } => {
  const check = rule.value.check;
  const exactTypes = ctx.of("typography").filter((o) => o.precision === "exact");
  if (!check) return { verdict: "unknown", observations: [] };
  switch (check.type) {
    case "font-family": {
      if (!exactTypes.length) return { verdict: "unknown", observations: [] };
      const allowed = check.families.map(familyKey);
      const ok = exactTypes.filter((o) => allowed.some((a) => familyKey(o.value.family).startsWith(a) || a.startsWith(familyKey(o.value.family))));
      return ok.length / exactTypes.length >= 0.9 ? { verdict: "pass", observations: ok.slice(0, 20) } : { verdict: "fail", observations: [] };
    }
    case "palette": {
      const measured = ctx.of("color").filter((o) => o.precision === "exact" || o.precision === "estimated");
      if (!measured.length) return { verdict: "unknown", observations: [] };
      const inPalette = measured.filter((o) => check.hexes.some((h) => colorDistance(h, o.value.hex) <= 5));
      return { verdict: "pass", observations: inPalette.slice(0, 20) };
    }
    case "max-colors":
      if (!ctx.covering("color").some((id) => ctx.kindOf(id) !== "document")) return { verdict: "unknown", observations: [] };
      return g.color.accentCount <= check.max ? { verdict: "pass", observations: ctx.of("color").filter((o) => o.precision !== "declared").slice(0, 20) } : { verdict: "fail", observations: [] };
    case "no-uppercase": {
      if (!exactTypes.length) return { verdict: "unknown", observations: [] };
      return exactTypes.some((o) => o.value.transform === "uppercase") ? { verdict: "fail", observations: [] } : { verdict: "pass", observations: exactTypes.slice(0, 20) };
    }
    case "min-size": {
      if (!exactTypes.length) return { verdict: "unknown", observations: [] };
      return exactTypes.some((o) => (o.value.sizePx ?? 99) < check.px - 0.01) ? { verdict: "fail", observations: [] } : { verdict: "pass", observations: exactTypes.slice(0, 20) };
    }
    case "spacing-unit": {
      const spacing = ctx.of("spacing").filter((o) => o.precision === "exact");
      if (!spacing.length) return { verdict: "unknown", observations: [] };
      const on = spacing.filter((o) => Math.min(o.value.px % check.px, check.px - (o.value.px % check.px)) <= 0.5);
      const share = on.reduce((s, o) => s + o.count, 0) / spacing.reduce((s, o) => s + o.count, 0);
      return share >= 0.85 ? { verdict: "pass", observations: on.slice(0, 20) } : { verdict: "fail", observations: [] };
    }
  }
};

/** Where sources disagree, and where the brand's words disagree with its practice. */
export const detectConflicts = (ctx: ReconcileContext, g: Partial): Conflict[] => {
  const conflicts: Conflict[] = [];
  const add = (c: Omit<Conflict, "id">): void => void conflicts.push({ id: stableId("conflict", c.topic, c.subject, c.type), ...c });
  const exactColors = ctx.of("color").filter((o) => o.precision === "exact" && o.context.usage !== "variable");
  const exactTypes = ctx.of("typography").filter((o) => o.precision === "exact");

  for (const rule of ctx.of("rule") as RuleObs[]) {
    const check = rule.value.check;
    if (!check) continue;
    const addRule = (c: Omit<Conflict, "id" | "ruleObservationId">): void => {
      add({ ...c, ruleObservationId: rule.id });
    };
    if (check.type === "palette") {
      const offPalette = g.color.tokens.filter(
        (t) => !isNeutral(t.oklch) && t.share >= 0.01 && t.support.sources.some((s) => s.precision === "exact" || s.precision === "estimated") && check.hexes.every((h) => colorDistance(h, t.hex) > 5),
      );
      for (const t of offPalette.slice(0, 6)) {
        const evidenceObs = ctx.of("color").find((o) => t.support.observationIds.includes(o.id) && o.precision !== "declared");
        addRule({
          topic: "color",
          subject: t.hex,
          type: "declared-vs-observed",
          severity: t.share >= 0.05 ? "high" : "medium",
          description: `${t.hex} covers ${pct(t.share)} of observed color but is not in the declared palette (${check.hexes.join(", ")}).`,
          claims: [claim(ctx, rule, `palette ${check.hexes.join(", ")}`), ...(evidenceObs ? [claim(ctx, evidenceObs, `${t.hex} used`)] : [])],
        });
      }
    }
    if (check.type === "font-family" && exactTypes.length) {
      const allowed = check.families.map(familyKey);
      const offenders = g.typography.families.filter((f) => f.share >= 0.05 && !allowed.some((a) => familyKey(f.family).startsWith(a) || a.startsWith(familyKey(f.family))) && f.support.sources.some((s) => s.precision === "exact"));
      for (const f of offenders) {
        const o = exactTypes.find((t) => familyKey(t.value.family) === familyKey(f.family));
        addRule({ topic: "typography", subject: f.family, type: "declared-vs-observed", severity: "high", description: `The document requires ${check.families.join(" or ")}, but ${f.family} sets ${pct(f.share)} of observed text.`, claims: [claim(ctx, rule, check.families.join(", ")), ...(o ? [claim(ctx, o, f.family)] : [])] });
      }
    }
    if (check.type === "max-colors" && g.color.accentCount > check.max) {
      addRule({ topic: "color", subject: "color count", type: "declared-vs-observed", severity: "medium", description: `The document allows at most ${check.max} colors; ${g.color.accentCount} accent hue families are observed.`, claims: [claim(ctx, rule, `max ${check.max}`)] });
    }
    if (check.type === "no-uppercase") {
      const upper = exactTypes.filter((o) => o.value.transform === "uppercase");
      if (upper.length) addRule({ topic: "typography", subject: "uppercase", type: "declared-vs-observed", severity: "low", description: `The document avoids all-caps, yet ${upper.length} uppercase text style(s) are in use.`, claims: [claim(ctx, rule, "no uppercase"), claim(ctx, upper[0]!, `uppercase "${upper[0]!.value.sample ?? ""}"`)] });
    }
    if (check.type === "min-size") {
      const small = exactTypes.filter((o) => (o.value.sizePx ?? 99) < check.px - 0.01).sort((a, b) => (a.value.sizePx ?? 0) - (b.value.sizePx ?? 0));
      if (small[0]) addRule({ topic: "typography", subject: "minimum size", type: "declared-vs-observed", severity: "medium", description: `Minimum declared size is ${check.px}px; text as small as ${small[0].value.sizePx}px is observed.`, claims: [claim(ctx, rule, `≥ ${check.px}px`), claim(ctx, small[0], `${small[0].value.sizePx}px`)] });
    }
    if (check.type === "spacing-unit" && g.spacing.grid && g.spacing.grid.unit % check.px !== 0) {
      addRule({ topic: "spacing", subject: "base unit", type: "declared-vs-observed", severity: "medium", description: `Declared base unit is ${check.px}px, but measured spacing fits a ${g.spacing.grid.unit}px grid (${pct(g.spacing.grid.adherence)}).`, claims: [claim(ctx, rule, `${check.px}px`)] });
    }
  }

  // Declared palette colors that the product never uses at all.
  const declaredColors = ctx.of("color").filter((o) => o.precision === "declared");
  for (const d of declaredColors) {
    if (!exactColors.length) break;
    const used = exactColors.some((o) => colorDistance(o.value.hex, d.value.hex) <= 2.5);
    if (!used && !isNeutral(d.value.oklch)) {
      add({ topic: "color", subject: d.value.hex, type: "declared-vs-observed", severity: "low", description: `${d.value.hex}${d.context.role ? ` ("${d.context.role}")` : ""} is declared but never rendered by the measured products.`, claims: [claim(ctx, d, `${d.value.hex} declared`)] });
    }
  }

  // Exact sources that disagree with each other on the same role.
  const byRoleSource = new Map<string, Map<string, number[]>>();
  for (const o of exactTypes) {
    const role = o.context.role;
    if (!role || !o.value.sizePx || !["display", "headline", "body"].includes(role)) continue;
    const vp = o.context.viewport ?? 0;
    const key = `${role}|${vp >= 1000 || vp === 0 ? "desktop" : "mobile"}`;
    const m = byRoleSource.get(key) ?? new Map<string, number[]>();
    m.set(o.sourceId, [...(m.get(o.sourceId) ?? []), ...Array(Math.min(o.count, 20)).fill(o.value.sizePx)]);
    byRoleSource.set(key, m);
  }
  for (const [key, perSource] of byRoleSource) {
    if (perSource.size < 2) continue;
    const medians = [...perSource.entries()].map(([sourceId, sizes]) => ({ sourceId, size: sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)]! }));
    const lo = Math.min(...medians.map((m) => m.size));
    const hi = Math.max(...medians.map((m) => m.size));
    if (hi / lo > 1.15) {
      const [role, form] = key.split("|");
      add({
        topic: "typography",
        subject: `${role} size (${form})`,
        type: "cross-source",
        severity: hi / lo > 1.4 ? "medium" : "low",
        description: `Sources disagree on ${role} size at ${form} widths: ${medians.map((m) => `${m.size}px`).join(" vs ")}.`,
        claims: medians.map((m) => {
          const o = exactTypes.find((t) => t.sourceId === m.sourceId && t.context.role === role && t.value.sizePx === m.size)!;
          return claim(ctx, o, `${m.size}px`);
        }),
      });
    }
  }
  return conflicts;
};
