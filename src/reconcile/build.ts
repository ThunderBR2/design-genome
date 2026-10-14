import { colorDistance } from "../core/color.js";
import type { Conflict, Genome, GenomeSource, Rule } from "../core/genome.js";
import type { Project } from "../core/project.js";
import type { Extraction, Source } from "../core/model.js";
import { ReconcileContext } from "./context.js";
import { reconcileBreakpoints, reconcileImagery, reconcileLayout, reconcileMotion, reconcileRadius, reconcileShadows, reconcileSpacing, reconcileVoice } from "./metrics.js";
import { reconcilePalette } from "./palette.js";
import { collectStatedRules, deriveRules, detectConflicts, evaluateCheck } from "./rules.js";
import { reconcileTypography } from "./typography.js";

const FACETS = ["color", "typography", "spacing", "radius", "shadow", "motion", "breakpoint", "layout", "imagery", "voice", "rule"] as const;

/**
 * Calibrate an image against the exact source it depicts: find the device pixel
 * ratio that maps its width to one of the rendered viewports, and measure color
 * drift between its pixels and that page's computed colors.
 */
const calibrate = (source: Source, extractions: readonly Extraction[]): GenomeSource["calibration"] | undefined => {
  if (!source.depicts) return undefined;
  const image = extractions.find((e) => e.sourceId === source.id && (e.extractor === "image" || e.extractor === "video"));
  const target = extractions.find((e) => e.sourceId === source.depicts && (e.extractor === "web" || e.extractor === "figma"));
  if (!image || !target) return undefined;
  const width = Number(image.meta.width ?? 0);
  const viewports = (target.meta.viewports as number[] | undefined) ?? [];
  let best: { v: number; dpr: number; err: number } | null = null;
  for (const v of viewports) for (const dpr of [1, 1.5, 2, 3]) {
    const err = Math.abs(width / dpr - v) / v;
    if (!best || err < best.err) best = { v, dpr, err };
  }
  const exactColors = target.observations.filter((o) => o.value.kind === "color").map((o) => (o.value as { hex: string }).hex);
  const imageColors = image.observations.filter((o) => o.value.kind === "color").map((o) => (o.value as { hex: string; share?: number }));
  let drift = 0, weight = 0;
  for (const c of imageColors) {
    const nearest = Math.min(...exactColors.map((h) => colorDistance(h, c.hex)));
    if (Number.isFinite(nearest) && nearest < 12) { drift += nearest * (c.share ?? 0); weight += c.share ?? 0; }
  }
  const driftText = weight ? `, color drift ΔE≈${Math.round((drift / weight) * 10) / 10} vs computed CSS` : "";
  if (best && best.err <= 0.05) {
    return { scale: Math.round((1 / best.dpr) * 1000) / 1000, method: `width ${width}px = ${best.v}px viewport @${best.dpr}x${driftText}`, against: source.depicts };
  }
  return { scale: 0, method: `width ${width}px matches no rendered viewport (${viewports.join(", ")}); sizes stay relative${driftText}`, against: source.depicts };
};

export const buildGenome = async (project: Project): Promise<Genome> => {
  const extractions = await project.loadExtractions();
  const ctx = new ReconcileContext(project.sources, extractions);
  const palette = reconcilePalette(ctx);
  const typography = reconcileTypography(ctx);
  const partial = {
    color: { tokens: palette.tokens, neutralsShare: palette.neutralsShare, accentCount: palette.accentCount },
    typography,
    spacing: reconcileSpacing(ctx),
    radius: reconcileRadius(ctx),
    shadow: reconcileShadows(ctx),
    motion: reconcileMotion(ctx),
    breakpoints: reconcileBreakpoints(ctx),
    layout: reconcileLayout(ctx),
    imagery: reconcileImagery(ctx),
    voice: reconcileVoice(ctx),
  };

  const resolutions = await project.loadResolutions();
  const conflicts: Conflict[] = detectConflicts(ctx, partial).map((c) => (resolutions[c.id] ? { ...c, resolution: resolutions[c.id]! } : c));
  const open = conflicts.filter((c) => !c.resolution);
  const conflictFor = (subject: string) => open.filter((c) => c.subject.toLowerCase() === subject.toLowerCase()).map((c) => c.id);
  const tokens = partial.color.tokens.map((t) => {
    const ids = conflictFor(t.hex);
    return ids.length ? { ...t, support: { ...t.support, status: "conflicted" as const, conflictIds: ids } } : t;
  });
  const families = partial.typography.families.map((f) => {
    const ids = conflictFor(f.family);
    return ids.length ? { ...f, support: { ...f.support, status: "conflicted" as const, conflictIds: ids } } : f;
  });

  const ruleObs = new Map(ctx.of("rule").map((o) => [o.id, o]));
  const stated = collectStatedRules(ctx).map((rule): Rule => {
    if (rule.origin !== "declared") return rule;
    const memberIds = rule.support.observationIds;
    const related = open.filter((c) => c.ruleObservationId && memberIds.includes(c.ruleObservationId));
    if (related.length) {
      return {
        ...rule,
        support: { ...rule.support, status: "conflicted", conflictIds: related.map((c) => c.id) },
        counterexamples: related.flatMap((c) => c.claims.filter((cl) => cl.precision !== "declared").map((cl) => ({ sourceId: cl.sourceId, detail: c.description, evidence: cl.evidence[0] }))).slice(0, 6),
      };
    }
    // A declared rule that the measured product follows is corroborated by it.
    const members = memberIds.map((id) => ruleObs.get(id)).filter((o): o is NonNullable<typeof o> => Boolean(o));
    const corroborating = members.flatMap((m) => {
      const result = evaluateCheck(ctx, partial, m as Parameters<typeof evaluateCheck>[2]);
      return result.verdict === "pass" ? result.observations : [];
    });
    return corroborating.length ? { ...rule, support: ctx.support([...members, ...corroborating]) } : rule;
  });
  const rules = [...deriveRules(ctx, { ...partial, color: { ...partial.color, tokens } }, palette), ...stated];

  const coverage: Record<string, string[]> = {};
  for (const facet of FACETS) coverage[facet] = ctx.covering(facet);
  const unknowns: string[] = [];
  for (const facet of FACETS) if (!coverage[facet]!.length) unknowns.push(`${facet}: no source examined it, so nothing is known (not "none").`);
  const kinds = new Set(project.sources.map((s) => s.kind));
  if (!kinds.has("web") && !kinds.has("figma")) unknowns.push("No exact source (site or Figma): every size and color is estimated from pixels.");
  if (!project.sources.some((s) => s.options.colorScheme === "dark")) unknowns.push("Dark appearance not sampled; add a site with options.colorScheme = dark to learn it.");
  if (!extractions.some((e) => e.extractor === "vision") && (kinds.has("image") || kinds.has("video"))) unknowns.push("Art direction of images/video (lighting, camera, framing) is unnamed: ask Claude to run the vision pass (genome_vision_request), or extract with --vision and an API key.");
  if (!kinds.has("document")) unknowns.push("No brand document: intent cannot be compared with practice.");

  const sources: GenomeSource[] = project.sources.map((s) => {
    const mine = extractions.filter((e) => e.sourceId === s.id);
    const calibration = calibrate(s, extractions);
    return {
      id: s.id,
      kind: s.kind,
      uri: s.uri,
      ...(s.label ? { label: s.label } : {}),
      observations: mine.reduce((n, e) => n + e.observations.length, 0),
      coverage: [...new Set(mine.flatMap((e) => e.coverage))],
      limitations: [...new Set(mine.flatMap((e) => e.limitations))],
      ...(calibration ? { calibration } : {}),
    };
  });
  for (const s of sources) if (s.calibration && s.calibration.scale === 0) {
    conflicts.push({ id: `conflict_calibration_${s.id}`, topic: "calibration", subject: s.id, type: "calibration", severity: "low", description: `${s.label ?? s.uri}: ${s.calibration.method}.`, claims: [] });
  }
  for (const s of project.sources) if (!extractions.some((e) => e.sourceId === s.id)) unknowns.push(`${s.label ?? s.uri} has not been extracted yet.`);

  return {
    schema: "design-genome/1",
    name: project.name,
    builtAt: new Date().toISOString(),
    sources,
    coverage,
    ...partial,
    color: { ...partial.color, tokens },
    typography: { ...partial.typography, families },
    rules,
    conflicts,
    unknowns,
  };
};
