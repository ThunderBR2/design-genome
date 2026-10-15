import { z } from "zod";

/**
 * The evidence model. Every fact in a genome traces back to one or more
 * Observations, and every Observation carries the Evidence that produced it.
 *
 * Precision says how a fact was obtained, and therefore how far it can be trusted:
 *  - exact:     measured by the engine that renders it (computed CSS, Figma node values)
 *  - declared:  stated by the brand (guidelines, brand books, documentation)
 *  - estimated: measured from pixels (images, video frames); relative unless calibrated
 *  - inferred:  a judgement (vision model, heuristic) anchored to cited evidence
 * Anything not observed is unknown. Missing coverage is never treated as absence.
 */
export const PRECISIONS = ["exact", "declared", "estimated", "inferred"] as const;
export const precisionSchema = z.enum(PRECISIONS);
export type Precision = z.infer<typeof precisionSchema>;

export const PRECISION_WEIGHT: Record<Precision, number> = {
  exact: 1,
  declared: 0.85,
  estimated: 0.6,
  inferred: 0.4,
};

export const SOURCE_KINDS = ["web", "image", "video", "document", "figma", "collection"] as const;
export const sourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const sourceSchema = z.object({
  id: z.string(),
  kind: sourceKindSchema,
  /** URL, Figma file URL, or the original local path of an uploaded file. */
  uri: z.string(),
  label: z.string().optional(),
  /** Stored copy inside the project, for files. */
  storedPath: z.string().optional(),
  sha256: z.string().optional(),
  addedAt: z.string(),
  /** Optional link to a source this one depicts, e.g. a screenshot of a web page. */
  depicts: z.string().optional(),
  /** The collection (Behance project, gallery page) this source was collected from. */
  parent: z.string().optional(),
  /** Free-form tags the user attaches, e.g. "campaign-2025", "mobile". */
  tags: z.array(z.string()).default([]),
  options: z.record(z.unknown()).default({}),
});
export type Source = z.infer<typeof sourceSchema>;

const bbox = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

export const locatorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("css"), selector: z.string(), viewport: z.number().optional(), url: z.string().optional(), box: bbox.optional() }),
  z.object({ type: z.literal("region"), box: bbox, imageWidth: z.number(), imageHeight: z.number() }),
  z.object({ type: z.literal("frame"), timeSec: z.number(), box: bbox.optional() }),
  z.object({ type: z.literal("span"), startSec: z.number(), endSec: z.number() }),
  z.object({ type: z.literal("page"), page: z.number(), quote: z.string().optional() }),
  z.object({ type: z.literal("figma-node"), nodeId: z.string(), name: z.string().optional() }),
  z.object({ type: z.literal("stylesheet"), href: z.string().optional(), rule: z.string().optional() }),
  z.object({ type: z.literal("whole") }),
]);
export type Locator = z.infer<typeof locatorSchema>;

export const evidenceSchema = z.object({
  sourceId: z.string(),
  locator: locatorSchema,
  /** Project-relative path of a crop, frame or snapshot backing this evidence. */
  artifact: z.string().optional(),
  note: z.string().optional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const OBSERVATION_KINDS = [
  "color",
  "typography",
  "font-face",
  "spacing",
  "radius",
  "shadow",
  "motion",
  "breakpoint",
  "layout",
  "imagery",
  "rule",
  "voice",
] as const;
export const observationKindSchema = z.enum(OBSERVATION_KINDS);
export type ObservationKind = z.infer<typeof observationKindSchema>;

/** Where and how a value is used. Extractors fill what they can see. */
export const contextSchema = z.object({
  role: z.string().optional(),
  usage: z.string().optional(),
  component: z.string().optional(),
  state: z.string().optional(),
  viewport: z.number().optional(),
  scheme: z.enum(["light", "dark"]).optional(),
});
export type ObservationContext = z.infer<typeof contextSchema>;

const colorValue = z.object({
  hex: z.string(),
  alpha: z.number().default(1),
  oklch: z.object({ l: z.number(), c: z.number(), h: z.number() }),
  /** Share of area (images) or of sampled elements (web) using this color. */
  share: z.number().optional(),
  pantone: z.string().optional(),
  cmyk: z.string().optional(),
});

const typographyValue = z.object({
  family: z.string(),
  stack: z.string().optional(),
  sizePx: z.number().optional(),
  weight: z.number().optional(),
  lineHeight: z.number().optional(),
  /** Letter spacing in em, the unit that compares across sizes. */
  trackingEm: z.number().optional(),
  transform: z.string().optional(),
  sample: z.string().optional(),
});

export const observationValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("color"), ...colorValue.shape }),
  z.object({ kind: z.literal("typography"), ...typographyValue.shape }),
  z.object({ kind: z.literal("font-face"), family: z.string(), weight: z.string().optional(), url: z.string().optional(), format: z.string().optional() }),
  z.object({ kind: z.literal("spacing"), px: z.number(), axis: z.enum(["x", "y", "both"]).optional() }),
  z.object({ kind: z.literal("radius"), px: z.number() }),
  z.object({ kind: z.literal("shadow"), css: z.string(), blurPx: z.number().optional(), offsetYPx: z.number().optional() }),
  z.object({
    kind: z.literal("motion"),
    type: z.enum(["transition", "animation", "cut", "camera", "intensity"]),
    durationMs: z.number().optional(),
    easing: z.string().optional(),
    property: z.string().optional(),
    magnitude: z.number().optional(),
  }),
  z.object({ kind: z.literal("breakpoint"), px: z.number(), query: z.string().optional() }),
  z.object({ kind: z.literal("layout"), metric: z.string(), value: z.number(), unit: z.string().optional() }),
  z.object({ kind: z.literal("imagery"), metric: z.string(), value: z.number(), unit: z.string().optional(), label: z.string().optional() }),
  z.object({
    kind: z.literal("rule"),
    statement: z.string(),
    polarity: z.enum(["must", "never", "should", "avoid", "fact"]),
    topic: z.string().optional(),
    /** Machine-checkable form, when the statement can be checked against observations. */
    check: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("font-family"), families: z.array(z.string()) }),
        z.object({ type: z.literal("palette"), hexes: z.array(z.string()) }),
        z.object({ type: z.literal("max-colors"), max: z.number() }),
        z.object({ type: z.literal("min-size"), px: z.number(), role: z.string().optional() }),
        z.object({ type: z.literal("spacing-unit"), px: z.number() }),
        z.object({ type: z.literal("no-uppercase") }),
      ])
      .optional(),
  }),
  z.object({ kind: z.literal("voice"), text: z.string(), words: z.number(), role: z.string().optional() }),
]);
export type ObservationValue = z.infer<typeof observationValueSchema>;
export type ValueOf<K extends ObservationKind> = Extract<ObservationValue, { kind: K }>;

export const observationSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  precision: precisionSchema,
  /** Extractor's own confidence in this reading, 0..1, before cross-checking. */
  confidence: z.number().min(0).max(1),
  value: observationValueSchema,
  context: contextSchema.default({}),
  /** How many raw occurrences were aggregated into this observation. */
  count: z.number().int().positive().default(1),
  evidence: z.array(evidenceSchema).min(1),
  extractor: z.string(),
});
export type Observation = z.infer<typeof observationSchema>;

/** What an extractor returns for one source: facts, plus what it could not see. */
export const extractionSchema = z.object({
  sourceId: z.string(),
  extractor: z.string(),
  extractorVersion: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  observations: z.array(observationSchema),
  /** Facets the extractor examined, so absence there means "not used". */
  coverage: z.array(z.string()),
  /** Things it could not determine. These stay unknown downstream. */
  limitations: z.array(z.string()),
  meta: z.record(z.unknown()).default({}),
});
export type Extraction = z.infer<typeof extractionSchema>;
