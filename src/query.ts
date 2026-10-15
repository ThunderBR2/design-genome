import type { Genome, Support } from "./core/genome.js";

/**
 * Token-efficient views of a genome for agents. "summary" drops evidence lists
 * down to one reference and observation ids; "full" returns everything.
 */

export const FACETS = ["overview", "anatomy", "concept", "color", "typography", "spacing", "shape", "motion", "imagery", "voice", "rules", "conflicts", "unknowns", "sources"] as const;
export type Facet = (typeof FACETS)[number];

export interface QueryOptions {
  readonly detail?: "summary" | "full";
  readonly role?: string;
  readonly viewport?: number;
  readonly topic?: string;
  readonly status?: Support["status"];
  readonly minConfidence?: number;
  /** anatomy: one piece id for its full measurements and reading. */
  readonly piece?: string;
}

const slimSupport = (s: Support) => ({
  status: s.status,
  confidence: s.confidence,
  sources: s.sources.map((x) => `${x.sourceId}:${x.precision}`),
  ...(s.evidence[0] ? { evidence: s.evidence[0] } : {}),
  ...(s.conflictIds?.length ? { conflictIds: s.conflictIds } : {}),
});

/** Replace every `support` with its slim form, recursively. */
const slim = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(slim);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = k === "support" ? slimSupport(v as Support) : slim(v);
    return out;
  }
  return value;
};

const passes = (s: Support | undefined, o: QueryOptions): boolean =>
  !s || ((o.status ? s.status === o.status : true) && (o.minConfidence ? s.confidence >= o.minConfidence : true));

export const queryGenome = (g: Genome, facet: Facet, options: QueryOptions = {}): unknown => {
  const view = (value: unknown) => (options.detail === "full" ? value : slim(value));
  switch (facet) {
    case "overview":
      return {
        name: g.name,
        builtAt: g.builtAt,
        sources: g.sources.map((s) => ({ id: s.id, kind: s.kind, label: s.label ?? s.uri, observations: s.observations })),
        anatomy: g.anatomy ? { pieces: g.anatomy.pieces.length, read: g.anatomy.pieces.filter((p) => p.reading).length, concept: Boolean(g.anatomy.concept) } : null,
        counts: {
          colors: g.color.tokens.length,
          families: g.typography.families.length,
          typeStyles: g.typography.styles.length,
          rules: g.rules.length,
          confirmedRules: g.rules.filter((r) => r.support.status === "confirmed").length,
          openConflicts: g.conflicts.filter((c) => !c.resolution).length,
          unknowns: g.unknowns.length,
        },
        headline: {
          palette: g.color.tokens.slice(0, 8).map((t) => `${t.name} ${t.hex}`),
          families: g.typography.families.map((f) => `${f.family}${f.reuse === "restricted" ? ` (restricted → ${f.substitute ?? "license"})` : ""}`),
          grid: g.spacing.grid ? `${g.spacing.grid.unit}px @ ${Math.round(g.spacing.grid.adherence * 100)}%` : null,
          topRules: [...g.rules].sort((a, b) => b.support.confidence - a.support.confidence).slice(0, 8).map((r) => `[${r.support.status}] ${r.statement}`),
        },
      };
    case "anatomy": {
      const a = g.anatomy;
      if (!a) return { pieces: [], note: "Built before the anatomy existed: call genome_rebuild." };
      if (options.piece) return a.pieces.find((p) => p.id === options.piece) ?? { error: `Unknown piece ${options.piece}`, pieces: a.pieces.map((p) => p.id) };
      return {
        pieces: a.pieces.map((p) => (options.detail === "full" ? p : {
          id: p.id, label: p.label, kind: p.kind, precision: p.precision, canvas: `${p.canvas.w}×${p.canvas.h} (${p.canvas.aspectName})`,
          measured: p.measured.slice(0, 4),
          ...(p.reading ? { pieceType: p.reading.pieceType, summary: p.reading.summary, structure: p.reading.composition.structure, whyItWorks: p.reading.whyItWorks.slice(0, 3) } : { read: false }),
        })),
        invariants: a.invariants,
        concept: a.concept ? { bigIdea: a.concept.bigIdea, concept: a.concept.concept } : null,
      };
    }
    case "concept":
      return g.anatomy?.concept ?? { concept: null, note: "No concept yet: dissect the pieces, then call genome_concept_request." };
    case "color":
      return view({ ...g.color, tokens: g.color.tokens.filter((t) => passes(t.support, options)) });
    case "typography":
      return view({
        ...g.typography,
        families: g.typography.families.filter((f) => passes(f.support, options)),
        styles: g.typography.styles.filter((s) => (!options.role || s.role === options.role) && (!options.viewport || s.viewport === options.viewport) && passes(s.support, options)),
      });
    case "spacing":
      return view({ ...g.spacing, layout: g.layout, breakpoints: g.breakpoints });
    case "shape":
      return view({ radius: g.radius, shadow: g.shadow });
    case "motion":
      return view(g.motion);
    case "imagery":
      return view({ imagery: g.imagery, layout: g.layout.filter((l) => l.metric !== "content-max-width") });
    case "voice":
      return g.voice;
    case "rules":
      return view(g.rules.filter((r) => (!options.topic || r.topic === options.topic) && passes(r.support, options)));
    case "conflicts":
      return g.conflicts.map((c) => (options.detail === "full" ? c : { id: c.id, type: c.type, severity: c.severity, topic: c.topic, description: c.description, resolution: c.resolution ?? null, claims: c.claims.map((cl) => `${cl.sourceId} (${cl.precision}): ${cl.value}`) }));
    case "unknowns":
      return g.unknowns;
    case "sources":
      return g.sources;
  }
};
