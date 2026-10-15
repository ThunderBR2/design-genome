/**
 * Anatomy: the dissection of each piece (an image, a video shot, a section of a
 * page) into measured elements and their relations, plus the reading of why the
 * piece is built that way, and a project-level concept across pieces.
 *
 * Measurements carry precision like everything else in the genome:
 *  - exact:     boxes from the rendered DOM (web sections)
 *  - estimated: boxes found in pixels (images, video shots, page captures)
 * Readings (roles, intent, the "why") are inferred and written by the host model.
 */

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type BlockKind = "text" | "image" | "shape" | "line" | "panel" | "control" | "unknown";

export interface Block {
  /** 1-based number, the same one drawn on the overlay. */
  readonly n: number;
  readonly kind: BlockKind;
  /** Pixels in the piece's own canvas. */
  readonly box: Box;
  /** The same box as a share of canvas width/height, 0..1. */
  readonly rel: Box;
  readonly areaShare: number;
  /** Dominant color inside the block (foreground pixels or computed color). */
  readonly color?: string;
  /** Color behind the block. */
  readonly background?: string;
  /** Perceptual distance to what is behind it (ΔE-like, 0..100). */
  readonly contrast?: number;
  /** area × contrast, normalized so the heaviest block is 1. */
  readonly weight: number;
  /** Number of the panel this block sits on, when nested. */
  readonly parent?: number;
  /** Text blocks: line count, line pitch and an estimate of the font size, in px. */
  readonly text?: { readonly lines: number; readonly linePitchPx?: number; readonly sizePx?: number; readonly sample?: string; readonly weight?: number; readonly family?: string; readonly exact: boolean };
  /** Touches two or more canvas edges: a full-bleed element. */
  readonly bleed?: boolean;
  /** DOM selector for exact blocks. */
  readonly selector?: string;
  readonly tag?: string;
}

export interface AlignmentAxis {
  readonly edge: "left" | "right" | "center-x" | "top" | "bottom" | "center-y";
  /** Position in px. */
  readonly at: number;
  /** Position as a share of the canvas side. */
  readonly rel: number;
  readonly blocks: readonly number[];
}

export interface Gap {
  readonly between: readonly [number, number];
  readonly axis: "x" | "y";
  readonly px: number;
  readonly rel: number;
}

export interface GridReading {
  readonly columns: number;
  readonly gutterPx: number;
  readonly marginPx: number;
  readonly columnPx: number;
  /** Share of block edges that land on a column line. */
  readonly fit: number;
  readonly description: string;
}

export interface Anatomy {
  readonly canvas: { readonly w: number; readonly h: number; readonly aspect: number; readonly aspectName: string };
  readonly background: { readonly hex: string; readonly uniform: boolean };
  readonly blocks: readonly Block[];
  /** Outer margins of the composition (non-bleed blocks), px and share of the side. */
  readonly margins: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number; readonly rel: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number } };
  /** The area all non-bleed content lives in. */
  readonly liveArea: Box;
  readonly axes: readonly AlignmentAxis[];
  readonly gaps: readonly Gap[];
  /** Distinct gap sizes and how they relate: the spacing rhythm. */
  readonly rhythm: { readonly values: readonly { readonly px: number; readonly rel: number; readonly count: number }[]; readonly unitPx: number | null; readonly multiples: readonly number[]; readonly description: string };
  readonly grid: GridReading | null;
  /** Blocks from heaviest to lightest, and the size ratios between text levels. */
  readonly hierarchy: { readonly order: readonly number[]; readonly textScale: readonly { readonly block: number; readonly sizePx: number; readonly ratioToSmallest: number }[]; readonly description: string };
  readonly balance: { readonly centroid: { readonly x: number; readonly y: number }; readonly quadrants: { readonly tl: number; readonly tr: number; readonly bl: number; readonly br: number }; readonly symmetry: "centered" | "mirrored" | "asymmetric"; readonly description: string };
  readonly proportion: { readonly focal: number | null; readonly nearestPowerPoint: string | null; readonly offsetRel: number | null; readonly description: string };
  readonly whitespace: { readonly share: number; readonly largestEmpty: Box | null; readonly description: string };
  readonly readingPath: { readonly order: readonly number[]; readonly pattern: string; readonly description: string };
  readonly density: { readonly blocks: number; readonly textBlocks: number; readonly textShare: number; readonly imageShare: number };
  /** Plain sentences that state the measurements, in reading order. */
  readonly summary: readonly string[];
}

export interface PieceReadingElement {
  readonly block?: number;
  /** Elements the measurement missed, given as a share-of-canvas box. */
  readonly box?: Box;
  readonly role: string;
  readonly content?: string;
  readonly treatment?: string;
  readonly why: string;
}

export interface PieceReading {
  readonly reader: string;
  readonly readAt: string;
  readonly pieceType: string;
  readonly summary: string;
  readonly elements: readonly PieceReadingElement[];
  readonly composition: { readonly structure: string; readonly eyePath: string; readonly balance?: string; readonly principles: readonly { readonly name: string; readonly how: string; readonly why: string }[] };
  readonly whyItWorks: readonly string[];
  readonly intent: { readonly message: string; readonly audience?: string; readonly emotion?: string; readonly action?: string };
  readonly typography?: string;
  readonly color?: string;
  readonly imagery?: string;
  readonly fragile: readonly string[];
  readonly corrections: readonly string[];
  /** Reusable rules the reader drew from this piece; they also join the genome as inferred rules. */
  readonly rules?: readonly { readonly topic?: string; readonly statement?: string; readonly polarity?: string; readonly confidence?: number }[];
}

export interface Piece {
  /** `<sourceId>#<n>`. */
  readonly id: string;
  readonly sourceId: string;
  readonly index: number;
  readonly kind: "image" | "video-shot" | "web-section";
  readonly label: string;
  readonly precision: "exact" | "estimated";
  /** Project-relative image of the piece and its annotated overlay. */
  readonly artifact: string;
  readonly overlay: string;
  /** Web sections: the viewport and the section's place in the page. */
  readonly viewport?: number;
  readonly pageBox?: Box;
  /** Video shots: start time and duration. */
  readonly timeSec?: number;
  readonly anatomy: Anatomy;
  readonly reading?: PieceReading;
}

export interface SourceAnatomy {
  readonly schema: "design-genome-anatomy/1";
  readonly sourceId: string;
  readonly version: string;
  readonly measuredAt: string;
  readonly pieces: readonly Piece[];
  readonly limitations: readonly string[];
}

/** A measured feature compared across pieces: constant when its spread is small. */
export interface Invariant {
  readonly feature: string;
  readonly description: string;
  readonly median: number;
  readonly spread: number;
  readonly unit: string;
  readonly pieces: number;
  readonly constant: boolean;
}

export interface Concept {
  readonly reader: string;
  readonly readAt: string;
  readonly pieces: readonly string[];
  readonly bigIdea: string;
  readonly concept: string;
  readonly why: string;
  readonly audience?: string;
  readonly personality: readonly string[];
  readonly narrative?: string;
  readonly metaphors: readonly string[];
  readonly constants: readonly { readonly what: string; readonly why: string }[];
  readonly variables: readonly { readonly what: string; readonly range: string; readonly why?: string }[];
  readonly grammar: readonly string[];
  readonly signatureMoves: readonly string[];
  readonly adaptation: readonly string[];
  readonly avoid: readonly string[];
}
