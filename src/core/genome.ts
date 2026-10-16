import type { GridFit, LinearFit, ScaleFit } from "./numeric.js";
import type { Concept, Invariant, PieceReading } from "../anatomy/types.js";
import type { Evidence, Oklch, Precision, SourceKind } from "./types.js";

/**
 * How strongly the cross-checked sources back a fact.
 *  confirmed      two or more independent sources agree
 *  single-source  only one source shows it (still evidence, not yet corroborated)
 *  declared-only  the brand says it, nothing observed shows it in practice
 *  conflicted     sources disagree; see the linked conflict
 */
export type SupportStatus = "confirmed" | "single-source" | "declared-only" | "conflicted";

export interface SourceSupport {
  readonly sourceId: string;
  readonly kind: SourceKind;
  readonly precision: Precision;
  readonly count: number;
}

export interface Support {
  readonly status: SupportStatus;
  readonly confidence: number;
  readonly sources: readonly SourceSupport[];
  readonly observationIds: readonly string[];
  /** A few representative pieces of evidence, enough to check the claim. */
  readonly evidence: readonly Evidence[];
  readonly conflictIds?: readonly string[];
}

export type Reuse = "open" | "restricted" | "unknown";

export interface ColorToken {
  readonly id: string;
  readonly name: string;
  readonly hex: string;
  readonly oklch: Oklch;
  readonly family: string;
  readonly usages: readonly string[];
  readonly share: number;
  /** Close readings merged into this token (compression, rendering drift). */
  readonly variants: readonly string[];
  readonly declaredAs?: string;
  readonly support: Support;
}

export interface FontFamilyToken {
  readonly family: string;
  readonly roles: readonly string[];
  readonly share: number;
  readonly reuse: Reuse;
  readonly reuseNote?: string;
  readonly substitute?: string;
  readonly support: Support;
}

export interface TypeStyleToken {
  readonly id: string;
  readonly role: string;
  readonly family: string;
  readonly sizePx: number;
  readonly weight?: number;
  readonly lineHeight?: number;
  readonly trackingEm?: number;
  readonly transform?: string;
  readonly viewport?: number;
  readonly support: Support;
}

export interface TrackingCurve {
  /** trackingEm = slope * ln(sizePx) + intercept */
  readonly fit: LinearFit;
  readonly formula: string;
  readonly description: string;
  /** Dominant tracking per size: the lookup to interpolate when no formula fits. */
  readonly table: readonly { readonly sizePx: number; readonly trackingEm: number }[];
}

export interface ScalarToken {
  readonly id: string;
  readonly value: number;
  readonly unit: string;
  readonly share: number;
  readonly name?: string;
  readonly support: Support;
}

export interface MotionTokens {
  readonly durations: readonly ScalarToken[];
  readonly easings: readonly { readonly easing: string; readonly name: string; readonly share: number; readonly support: Support }[];
  readonly editing?: {
    readonly medianShotSec: number;
    readonly meanShotSec: number;
    readonly variation: number;
    readonly cutsPerMinute: number;
    readonly description: string;
    readonly support: Support;
  };
  readonly intensity?: { readonly value: number; readonly description: string; readonly support: Support };
}

export interface MetricToken {
  readonly metric: string;
  readonly value: number;
  readonly unit?: string;
  readonly spread?: number;
  readonly label?: string;
  readonly description: string;
  readonly support: Support;
}

export interface Rule {
  readonly id: string;
  readonly topic: string;
  readonly statement: string;
  readonly polarity: "must" | "never" | "should" | "avoid" | "fact";
  readonly origin: "derived" | "declared" | "inferred";
  readonly support: Support;
  readonly counterexamples: readonly { readonly sourceId: string; readonly detail: string; readonly evidence?: Evidence }[];
}

export interface ConflictClaim {
  readonly sourceId: string;
  readonly kind: SourceKind;
  readonly precision: Precision;
  readonly value: string;
  readonly evidence: readonly Evidence[];
}

export interface Conflict {
  readonly id: string;
  readonly topic: string;
  readonly subject: string;
  readonly description: string;
  readonly severity: "high" | "medium" | "low";
  /** "declared-vs-observed" is the brand saying one thing and doing another. */
  readonly type: "declared-vs-observed" | "cross-source" | "calibration";
  readonly claims: readonly ConflictClaim[];
  /** The declared rule observation this conflict tests, when there is one. */
  readonly ruleObservationId?: string;
  readonly resolution?: { readonly choice: string; readonly note?: string; readonly at: string };
}

export interface GenomeSource {
  readonly id: string;
  readonly kind: SourceKind;
  readonly uri: string;
  readonly label?: string;
  readonly observations: number;
  readonly coverage: readonly string[];
  readonly limitations: readonly string[];
  readonly calibration?: { readonly scale: number; readonly method: string; readonly against: string };
}

/** One dissected piece as the genome carries it: measurements as sentences, plus the reading. */
export interface GenomePiece {
  readonly id: string;
  readonly sourceId: string;
  readonly label: string;
  readonly kind: "image" | "video-shot" | "web-section";
  readonly precision: "exact" | "estimated";
  readonly overlay: string;
  readonly canvas: { readonly w: number; readonly h: number; readonly aspectName: string };
  readonly measured: readonly string[];
  /** Pre-check status, and the reason when the piece was set aside. */
  readonly triage?: "ok" | "doubtful" | "skip";
  readonly what?: string;
  readonly skipped?: string;
  readonly reading?: PieceReading;
}

export interface GenomeAnatomy {
  readonly pieces: readonly GenomePiece[];
  /** Per group ("visual" for images and shots, "web" for page sections): what stays constant across pieces. */
  readonly invariants: Readonly<Record<string, readonly Invariant[]>>;
  readonly concept: Concept | null;
}

export interface Genome {
  readonly schema: "design-genome/1";
  readonly name: string;
  readonly builtAt: string;
  readonly sources: readonly GenomeSource[];
  /** Facet -> which sources examined it. Facets nobody examined are unknown, not empty. */
  readonly coverage: Readonly<Record<string, readonly string[]>>;
  readonly color: {
    readonly tokens: readonly ColorToken[];
    readonly neutralsShare: number;
    readonly accentCount: number;
  };
  readonly typography: {
    readonly families: readonly FontFamilyToken[];
    readonly styles: readonly TypeStyleToken[];
    readonly scale: (ScaleFit & { readonly description: string }) | null;
    readonly tracking: TrackingCurve | null;
    readonly lineHeight: { readonly display: number | null; readonly body: number | null } | null;
  };
  readonly spacing: { readonly grid: GridFit | null; readonly scale: readonly ScalarToken[] };
  readonly radius: readonly ScalarToken[];
  readonly shadow: readonly { readonly css: string; readonly share: number; readonly support: Support }[];
  readonly motion: MotionTokens;
  readonly breakpoints: readonly ScalarToken[];
  readonly layout: readonly MetricToken[];
  readonly imagery: readonly MetricToken[];
  readonly voice: {
    readonly headlineWords: { readonly median: number; readonly max: number } | null;
    readonly samples: readonly { readonly text: string; readonly role: string; readonly sourceId: string }[];
  };
  readonly rules: readonly Rule[];
  readonly conflicts: readonly Conflict[];
  readonly unknowns: readonly string[];
  /** Dissection of each piece and the project concept. Absent in genomes built before the anatomy existed. */
  readonly anatomy?: GenomeAnatomy;
}
