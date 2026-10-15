import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp, { type OverlayOptions } from "sharp";

import type { Project } from "../core/project.js";
import type { Evidence, Extraction, ObservationValue, Source } from "../core/model.js";
import { ObservationCollector, finishExtraction } from "../extractors/support.js";
import { KIND_COLORS } from "./overlay.js";
import { loadAllAnatomy, loadAnatomy, saveAnatomy } from "./pieces.js";
import type { Anatomy, Concept, Invariant, Piece, PieceReading } from "./types.js";

/**
 * The reading half of the anatomy. The host model looks at a piece with its
 * measured anatomy drawn over it and says what each block is and why it is
 * there; then, across all pieces, what the project is and why it is that way.
 * Readings are inferred; their reusable rules join the genome and are
 * cross-checked like any other rule.
 */

export const DISSECT_PROMPT = `You are dissecting one design piece on the table, as a senior art director and design teacher would, so another designer could build new pieces in the same language without copying this one.

You get two images: (1) the piece; (2) the same piece with its measured anatomy drawn on it — numbered blocks (pink text, blue image, orange control, green panel, purple shape, grey line), the live area as a cyan dashed frame with the margins in px, shared alignment edges as magenta dashed lines, gaps between neighbours in yellow (px), and the thirds as faint white lines. The measurements below are facts (exact for web sections, estimated from pixels otherwise). Use their numbers; do not re-estimate positions or sizes. For estimated text, "≈Npx" is the ink height of one line (the cap height when the line is all caps), not the font size; say the likely font size in the treatment when it matters.

Your job is what measurement cannot do. Return:
- elements: every block by its number — role (headline, subhead, body, label, logo, product, person, photo, illustration, cta, price, badge, icon, nav, card, texture, ornament, divider…), what it says or shows, its treatment (type style, weight, case, color, crop, effects) and WHY it is there: why that position, that size and that distance, citing the measured margins, axes and gaps. Report wrong merges or splits in corrections; add an element the measurement missed with a share-of-canvas box (0..1).
- composition: the structure (e.g. "asymmetric two-column grid with a full-width image band"), the eye path, the balance, and the principles at work (scale contrast, alignment, proximity, repetition, figure-ground, tension, rhythm, framing, color contrast…) — each with how it is done here (block numbers, numbers) and why it works.
- whyItWorks: the reasons the piece succeeds, most important first.
- intent: the message, the audience, the emotion and the action it asks for.
- typography, color, imagery: the treatment of each and the reason for it.
- fragile: what would break the piece if changed (e.g. "shrinking the 9% margin crowds the headline against the edge").
- rules: reusable rules for new pieces in this language, measured where possible (e.g. "Headline flush-left on the same 8.8% margin as the image, set at ~7% of the canvas height"), with polarity and confidence.
Describe what is visible. When a reason is your interpretation, it is still welcome: it is stored as inferred and confirmed only if other pieces agree. Write every text field in the language the user is using with you.`;

export const CONCEPT_PROMPT = `You have dissected the pieces of one project. Now read the project as a whole, the way its creative director would explain it.

You get a contact sheet of the pieces (numbered), the reading of each piece, the measured invariants across pieces (what stays constant and what varies, with numbers) and the genome highlights (palette, type, rules).

Return:
- bigIdea: the one idea behind the project, in a sentence.
- concept: how that idea becomes visual — the concept and its logic.
- why: why the project is the way it is — the strategic and aesthetic reasons behind its choices (audience, category codes it follows or breaks, the brand's position, the medium).
- audience, personality (adjectives), narrative (the story the pieces tell together), metaphors (visual metaphors or devices).
- constants: what never changes across pieces and why (use the measured invariants: margins, axes, type ratios, whitespace, palette proportions).
- variables: what changes from piece to piece, within what range, and why it is allowed to change.
- grammar: the recipe for building a piece in this system, step by step (e.g. "1. full-bleed product photo on the right two thirds; 2. headline on the left margin at the top third…").
- signatureMoves: the recognisable moves that make it this project.
- adaptation: how to extend the system to new formats and new content without breaking it (what scales with the canvas, what stays fixed, what to drop first in small formats).
- avoid: what would feel off-brand.
Ground every claim in the pieces and the numbers. Write in the language the user is using with you.`;

const pct = (n: number): string => `${Math.round(n * 1000) / 10}%`;

/** The anatomy of a piece as compact text for the host model. */
export const anatomyText = (piece: Piece): string => {
  const a = piece.anatomy;
  const lines = [
    `Piece ${piece.id} — ${piece.label} (${piece.kind}, measurements ${piece.precision}).`,
    ...a.summary.map((s) => `- ${s}`),
    "Blocks (number, kind, x,y, w×h px, as share of canvas, details):",
    ...a.blocks.map((b) => {
      const parts = [`#${b.n} ${b.kind}`, `${b.box.x},${b.box.y} ${b.box.w}×${b.box.h}px`, `(${pct(b.rel.x)}, ${pct(b.rel.y)} · ${pct(b.rel.w)}×${pct(b.rel.h)})`];
      if (b.text) parts.push(`${b.text.exact ? "" : "≈"}${b.text.sizePx ?? "?"}px${b.text.weight ? ` w${b.text.weight}` : ""}${b.text.family ? ` ${b.text.family}` : ""}, ${b.text.lines} line(s)${b.text.linePitchPx ? `, pitch ${b.text.linePitchPx}px` : ""}${b.text.sample ? ` "${b.text.sample}"` : ""}`);
      if (b.color) parts.push(`${b.color}${b.background ? ` on ${b.background}` : ""}${b.contrast !== undefined ? ` ΔE${Math.round(b.contrast)}` : ""}`);
      parts.push(`weight ${b.weight}`);
      if (b.parent) parts.push(`on #${b.parent}`);
      if (b.bleed) parts.push("full-bleed");
      return `  ${parts.join(" · ")}`;
    }),
  ];
  return lines.join("\n");
};

export interface PieceImages {
  readonly piece: Piece;
  readonly original: Buffer;
  readonly overlay: Buffer;
}

const jpeg = async (path: string, maxSide: number): Promise<Buffer> =>
  sharp(path, { failOn: "none" }).rotate().resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true }).flatten({ background: "#fff" }).jpeg({ quality: 80 }).toBuffer();

export const pieceImages = async (project: Project, piece: Piece, maxSide = 1280): Promise<PieceImages> => ({
  piece,
  original: await jpeg(join(project.root, piece.artifact), maxSide),
  overlay: await jpeg(join(project.root, piece.overlay), maxSide),
});

export const legendText = `Overlay colors: ${Object.entries(KIND_COLORS).map(([k, c]) => `${k} ${c}`).join(", ")}.`;

const clean = (s: unknown): string => (typeof s === "string" ? s.trim() : "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);

export interface ReadingRule { topic?: string; statement?: string; polarity?: string; confidence?: number }
export type ReadingInput = Partial<Omit<PieceReading, "reader" | "readAt">> & { rules?: ReadingRule[] };

/** Normalize what the host model sent into a stored reading. */
export const toReading = (input: ReadingInput, reader: string): PieceReading & { rules: ReadingRule[] } => ({
  reader,
  readAt: new Date().toISOString(),
  pieceType: clean(input.pieceType) || "piece",
  summary: clean(input.summary),
  elements: (input.elements ?? []).filter((e) => e && clean(e.role)).map((e) => ({
    ...(typeof e.block === "number" ? { block: e.block } : {}),
    ...(e.box ? { box: e.box } : {}),
    role: clean(e.role),
    ...(clean(e.content) ? { content: clean(e.content) } : {}),
    ...(clean(e.treatment) ? { treatment: clean(e.treatment) } : {}),
    why: clean(e.why),
  })),
  composition: {
    structure: clean(input.composition?.structure),
    eyePath: clean(input.composition?.eyePath),
    ...(clean(input.composition?.balance) ? { balance: clean(input.composition?.balance) } : {}),
    principles: (input.composition?.principles ?? []).filter((p) => clean(p?.name)).map((p) => ({ name: clean(p.name), how: clean(p.how), why: clean(p.why) })),
  },
  whyItWorks: list(input.whyItWorks),
  intent: { message: clean(input.intent?.message), ...(clean(input.intent?.audience) ? { audience: clean(input.intent?.audience) } : {}), ...(clean(input.intent?.emotion) ? { emotion: clean(input.intent?.emotion) } : {}), ...(clean(input.intent?.action) ? { action: clean(input.intent?.action) } : {}) },
  ...(clean(input.typography) ? { typography: clean(input.typography) } : {}),
  ...(clean(input.color) ? { color: clean(input.color) } : {}),
  ...(clean(input.imagery) ? { imagery: clean(input.imagery) } : {}),
  fragile: list(input.fragile),
  corrections: list(input.corrections),
  rules: (input.rules ?? []).filter((r) => clean(r.statement)),
});

const POLARITIES = ["must", "never", "should", "avoid", "fact"] as const;

/** Rules from every reading of a source, as an inferred extraction that joins the genome. */
export const dissectExtraction = (source: Source, pieces: readonly (Piece & { reading?: PieceReading & { rules?: ReadingRule[] } })[]): Extraction => {
  const collector = new ObservationCollector(source.id, "dissect", "inferred");
  for (const p of pieces) {
    const reading = p.reading;
    if (!reading) continue;
    const evidence: Evidence = { sourceId: source.id, locator: { type: "whole" }, artifact: p.overlay, note: `dissection of ${p.id} by ${reading.reader}` };
    for (const r of reading.rules ?? []) {
      const polarity = (POLARITIES as readonly string[]).includes(r.polarity ?? "") ? (r.polarity as (typeof POLARITIES)[number]) : "fact";
      collector.add({ value: { kind: "rule", statement: clean(r.statement), polarity, topic: clean(r.topic) || "composition" } satisfies ObservationValue, evidence, confidence: Math.min(1, Math.max(0, r.confidence ?? 0.55)) });
    }
    collector.add({ value: { kind: "imagery", metric: "piece-type", value: 1, label: reading.pieceType }, evidence, confidence: 0.6 });
    if (reading.composition.structure) collector.add({ value: { kind: "imagery", metric: "composition", value: 1, label: reading.composition.structure.slice(0, 120) }, evidence, confidence: 0.5 });
  }
  return finishExtraction(source, { name: "dissect", version: "1.0.0" }, new Date(), collector.list(), ["rule", "imagery"], ["Dissection readings are inferred judgements anchored to measured anatomy; single-source ones are hypotheses."], { pieces: pieces.filter((p) => p.reading).map((p) => p.id) });
};

/** Store a reading for one piece, refresh the source's dissect extraction. */
export const submitReading = async (project: Project, pieceId: string, input: ReadingInput, reader: string): Promise<{ piece: Piece; rules: number }> => {
  const sourceId = pieceId.split("#")[0]!;
  const source = project.source(sourceId);
  const anatomy = await loadAnatomy(project, sourceId);
  if (!anatomy) throw new Error(`No anatomy for ${sourceId}. Call genome_dissect_request first.`);
  const piece = anatomy.pieces.find((p) => p.id === pieceId);
  if (!piece) throw new Error(`Unknown piece ${pieceId}. Pieces of this source: ${anatomy.pieces.map((p) => p.id).join(", ")}`);
  const reading = toReading(input, reader);
  const pieces = anatomy.pieces.map((p) => (p.id === pieceId ? { ...p, reading } : p));
  await saveAnatomy(project, { ...anatomy, pieces });
  await project.saveExtraction(dissectExtraction(source, pieces as never));
  return { piece: { ...piece, reading }, rules: reading.rules.length };
};

// ---- Across pieces --------------------------------------------------------

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

type Feature = { feature: string; description: string; unit: string; absolute?: boolean; get: (a: Anatomy) => number | null };
const FEATURES: readonly Feature[] = [
  { feature: "margin-left", description: "left margin, share of width", unit: "share", absolute: true, get: (a) => a.margins.rel.left },
  { feature: "margin-right", description: "right margin, share of width", unit: "share", absolute: true, get: (a) => a.margins.rel.right },
  { feature: "margin-top", description: "top margin, share of height", unit: "share", absolute: true, get: (a) => a.margins.rel.top },
  { feature: "margin-bottom", description: "bottom margin, share of height", unit: "share", absolute: true, get: (a) => a.margins.rel.bottom },
  { feature: "margin-short-side", description: "smallest side margin, share of the short side", unit: "share", absolute: true, get: (a) => Math.min(a.margins.left, a.margins.right) / Math.min(a.canvas.w, a.canvas.h) },
  { feature: "headline-size", description: "largest text size, share of canvas height", unit: "share", absolute: true, get: (a) => { const t = a.hierarchy.textScale[0]; return t ? t.sizePx / a.canvas.h : null; } },
  { feature: "headline-size-short", description: "largest text size, share of the short side", unit: "share", absolute: true, get: (a) => { const t = a.hierarchy.textScale[0]; return t ? t.sizePx / Math.min(a.canvas.w, a.canvas.h) : null; } },
  { feature: "type-contrast", description: "largest text ÷ smallest text", unit: "×", get: (a) => a.hierarchy.textScale[0]?.ratioToSmallest ?? null },
  { feature: "blocks", description: "number of blocks", unit: "count", get: (a) => a.density.blocks },
  { feature: "text-blocks", description: "number of text blocks", unit: "count", get: (a) => a.density.textBlocks },
  { feature: "whitespace", description: "open ground, share of canvas", unit: "share", absolute: true, get: (a) => a.whitespace.share },
  { feature: "image-share", description: "image area, share of canvas", unit: "share", absolute: true, get: (a) => a.density.imageShare },
  { feature: "focal-x", description: "focal block center, share of width", unit: "share", absolute: true, get: (a) => { const b = a.blocks.find((x) => x.n === a.proportion.focal); return b ? (b.box.x + b.box.w / 2) / a.canvas.w : null; } },
  { feature: "focal-y", description: "focal block center, share of height", unit: "share", absolute: true, get: (a) => { const b = a.blocks.find((x) => x.n === a.proportion.focal); return b ? (b.box.y + b.box.h / 2) / a.canvas.h : null; } },
  { feature: "rhythm-unit", description: "spacing unit, share of height", unit: "share", absolute: true, get: (a) => (a.rhythm.unitPx ? a.rhythm.unitPx / a.canvas.h : null) },
];
const CATEGORIES: readonly { feature: string; description: string; get: (a: Anatomy) => string | null }[] = [
  { feature: "aspect", description: "canvas aspect", get: (a) => a.canvas.aspectName },
  { feature: "symmetry", description: "balance type", get: (a) => a.balance.symmetry },
  { feature: "reading-pattern", description: "reading path", get: (a) => a.readingPath.pattern },
  { feature: "grid", description: "column grid", get: (a) => (a.grid ? `${a.grid.columns} column(s)` : "no grid") },
  { feature: "background", description: "background", get: (a) => (a.background.uniform ? "flat color" : "image or texture") },
];

/** What stays constant across pieces of one kind, and what varies. */
export const invariants = (pieces: readonly Piece[]): Invariant[] => {
  if (pieces.length < 2) return [];
  const out: Invariant[] = [];
  for (const f of FEATURES) {
    const values = pieces.map((p) => f.get(p.anatomy)).filter((v): v is number => v !== null && Number.isFinite(v));
    if (values.length < 2) continue;
    const m = median(values);
    const spread = median(values.map((v) => Math.abs(v - m)));
    const constant = f.absolute ? spread <= 0.02 : spread <= Math.abs(m) * 0.2;
    out.push({ feature: f.feature, description: f.description, median: r3(m), spread: r3(spread), unit: f.unit, pieces: values.length, constant });
  }
  for (const c of CATEGORIES) {
    const values = pieces.map((p) => c.get(p.anatomy)).filter((v): v is string => Boolean(v));
    if (values.length < 2) continue;
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    out.push({ feature: c.feature, description: `${c.description}: ${top}${counts.size > 1 ? ` (others: ${[...counts.keys()].filter((k) => k !== top).join(", ")})` : ""}`, median: r3(n / values.length), spread: 0, unit: "share", pieces: values.length, constant: n / values.length >= 0.7 });
  }
  return out;
};

export const pieceGroup = (p: Piece): "visual" | "web" => (p.kind === "web-section" ? "web" : "visual");

export interface ProjectAnatomy {
  readonly pieces: readonly Piece[];
  readonly invariants: Readonly<Record<string, readonly Invariant[]>>;
  readonly concept: Concept | null;
  readonly limitations: readonly string[];
}

const conceptPath = (project: Project): string => join(project.root, "concept.json");

export const loadConcept = async (project: Project): Promise<Concept | null> => {
  try { return JSON.parse(await readFile(conceptPath(project), "utf8")) as Concept; } catch { return null; }
};

export type ConceptInput = Partial<Omit<Concept, "reader" | "readAt" | "pieces">>;

export const saveConcept = async (project: Project, input: ConceptInput, reader: string, pieces: readonly string[]): Promise<Concept> => {
  const concept: Concept = {
    reader,
    readAt: new Date().toISOString(),
    pieces: [...pieces],
    bigIdea: clean(input.bigIdea),
    concept: clean(input.concept),
    why: clean(input.why),
    ...(clean(input.audience) ? { audience: clean(input.audience) } : {}),
    personality: list(input.personality),
    ...(clean(input.narrative) ? { narrative: clean(input.narrative) } : {}),
    metaphors: list(input.metaphors),
    constants: (input.constants ?? []).filter((c) => clean(c?.what)).map((c) => ({ what: clean(c.what), why: clean(c.why) })),
    variables: (input.variables ?? []).filter((v) => clean(v?.what)).map((v) => ({ what: clean(v.what), range: clean(v.range), ...(clean(v.why) ? { why: clean(v.why) } : {}) })),
    grammar: list(input.grammar),
    signatureMoves: list(input.signatureMoves),
    adaptation: list(input.adaptation),
    avoid: list(input.avoid),
  };
  await writeFile(conceptPath(project), JSON.stringify(concept, null, 2));
  return concept;
};

export const projectAnatomy = async (project: Project): Promise<ProjectAnatomy> => {
  const all = await loadAllAnatomy(project);
  const order = new Map(project.sources.map((s, i) => [s.id, i]));
  const pieces = all.sort((a, b) => (order.get(a.sourceId) ?? 0) - (order.get(b.sourceId) ?? 0)).flatMap((a) => a.pieces);
  const groups: Record<string, readonly Invariant[]> = {};
  for (const g of ["visual", "web"] as const) {
    const inv = invariants(pieces.filter((p) => pieceGroup(p) === g));
    if (inv.length) groups[g] = inv;
  }
  return { pieces, invariants: groups, concept: await loadConcept(project), limitations: [...new Set(all.flatMap((a) => a.limitations))] };
};

/** A numbered grid of piece thumbnails, so the host model can see the project at once. */
export const contactSheet = async (project: Project, pieces: readonly Piece[], cell = 300): Promise<Buffer> => {
  const shown = pieces.slice(0, 24);
  const cols = Math.min(6, Math.max(1, Math.ceil(Math.sqrt(shown.length))));
  const rows = Math.ceil(shown.length / cols);
  const pad = 12, label = 26;
  const W = cols * (cell + pad) + pad, H = rows * (cell + label + pad) + pad;
  const composites: OverlayOptions[] = [];
  for (const [i, p] of shown.entries()) {
    const x = pad + (i % cols) * (cell + pad), y = pad + Math.floor(i / cols) * (cell + label + pad);
    const thumb = await sharp(join(project.root, p.artifact), { failOn: "none" }).rotate().resize(cell, cell, { fit: "contain", background: "#f2f2f2" }).flatten({ background: "#f2f2f2" }).png().toBuffer();
    composites.push({ input: thumb, left: x, top: y + label });
    const text = `${i + 1} · ${p.reading?.pieceType ?? p.kind}`.replace(/[<>&]/g, "");
    composites.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${label}"><text x="2" y="19" font-family="DejaVu Sans, Arial, sans-serif" font-size="16" font-weight="700" fill="#111">${text}</text></svg>`), left: x, top: y });
  }
  return sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } }).composite(composites).jpeg({ quality: 80 }).toBuffer();
};
