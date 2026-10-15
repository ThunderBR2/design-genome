import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

import type { Genome } from "../core/genome.js";
import { invariantLine } from "../export/anatomy.js";
import type { Project } from "../core/project.js";
import { aspectName } from "./layout.js";
import { KIND_COLORS } from "./overlay.js";
import { projectAnatomy, type ProjectAnatomy } from "./reading.js";
import type { Block, BlockKind, Box, Piece } from "./types.js";

/**
 * Creation blueprint: the bridge from what was dissected to a new piece.
 * Picks the reference pieces closest to the request and format, re-lays the
 * best one out on the new canvas (margins and type scale with the short side,
 * stacks keep their gaps, one flexible image absorbs the change in aspect),
 * and gathers the concept, the constants, the reasons and the rules that the
 * new piece has to keep.
 */

export const FORMATS: Record<string, { w: number; h: number; label: string; group: "visual" | "web"; safe?: { top: number; bottom: number; note: string } }> = {
  "instagram-post": { w: 1080, h: 1350, label: "Instagram post 4:5", group: "visual" },
  "instagram-square": { w: 1080, h: 1080, label: "Instagram square 1:1", group: "visual" },
  story: { w: 1080, h: 1920, label: "Story / Reels 9:16", group: "visual", safe: { top: 250, bottom: 340, note: "the app covers about 250px at the top and 340px at the bottom" } },
  "youtube-thumbnail": { w: 1280, h: 720, label: "YouTube thumbnail 16:9", group: "visual" },
  "landscape-16x9": { w: 1920, h: 1080, label: "Landscape 16:9", group: "visual" },
  "linkedin-post": { w: 1200, h: 627, label: "LinkedIn / link image 1.91:1", group: "visual" },
  "a4-portrait": { w: 2480, h: 3508, label: "A4 portrait @300dpi", group: "visual" },
  "a4-landscape": { w: 3508, h: 2480, label: "A4 landscape @300dpi", group: "visual" },
  "poster-2x3": { w: 2000, h: 3000, label: "Poster 2:3", group: "visual" },
  "banner-wide": { w: 1920, h: 600, label: "Wide banner 3.2:1", group: "visual" },
  "web-desktop": { w: 1440, h: 900, label: "Web section, desktop 1440", group: "web" },
  "web-mobile": { w: 390, h: 844, label: "Web section, mobile 390", group: "web" },
};

export interface BlueprintInput {
  readonly request: string;
  readonly format?: string;
  readonly width?: number;
  readonly height?: number;
  readonly pieceType?: string;
  readonly references?: readonly string[];
}

export interface PlacedElement {
  readonly n: number;
  readonly from: number;
  readonly kind: BlockKind;
  readonly role: string;
  readonly box: Box;
  readonly rel: Box;
  readonly sizePx?: number;
  readonly lines?: number;
  readonly color?: string;
  readonly on?: string;
  readonly why?: string;
  readonly content?: string;
  readonly parent?: number;
}

export interface Blueprint {
  readonly id: string;
  readonly request: string;
  readonly canvas: { readonly w: number; readonly h: number; readonly aspectName: string; readonly label: string };
  readonly references: readonly { readonly id: string; readonly label: string; readonly score: number; readonly reason: string; readonly overlay: string }[];
  readonly base: string | null;
  readonly margins: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
  readonly elements: readonly PlacedElement[];
  readonly alignments: readonly string[];
  readonly warnings: readonly string[];
  readonly wireframe: string | null;
  readonly markdown: string;
}

const r = Math.round;
const pct = (n: number): string => `${Math.round(n * 1000) / 10}%`;
const words = (s: string): Set<string> => new Set(s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/** Rank pieces for a request: format closeness, matching piece type and words, and having a reading. */
export const rankReferences = (pieces: readonly Piece[], input: BlueprintInput, canvas: { w: number; h: number }, group: "visual" | "web"): { piece: Piece; score: number; reason: string }[] => {
  const want = words(`${input.request} ${input.pieceType ?? ""}`);
  const ar = canvas.w / canvas.h;
  return pieces
    .map((p) => {
      const reasons: string[] = [];
      const par = p.anatomy.canvas.w / p.anatomy.canvas.h;
      const aspect = Math.max(0, 1 - Math.abs(Math.log(ar / par)) / 1.2);
      reasons.push(`aspect ${p.anatomy.canvas.aspectName} vs ${aspectName(canvas.w, canvas.h)}`);
      const sameGroup = (p.kind === "web-section" ? "web" : "visual") === group ? 1 : 0;
      const text = words(`${p.reading?.pieceType ?? ""} ${p.reading?.summary ?? ""} ${p.reading?.intent.message ?? ""} ${p.label}`);
      const overlap = [...want].filter((w) => text.has(w)).length;
      const typeHit = input.pieceType && p.reading?.pieceType && words(p.reading.pieceType).size && [...words(input.pieceType)].some((w) => words(p.reading!.pieceType).has(w)) ? 1 : 0;
      if (typeHit) reasons.push(`same piece type (${p.reading!.pieceType})`);
      if (overlap) reasons.push(`${overlap} matching word(s)`);
      if (p.reading) reasons.push("dissected");
      const score = aspect * 0.4 + sameGroup * 0.25 + typeHit * 0.2 + Math.min(1, overlap / 3) * 0.1 + (p.reading ? 0.05 : 0) + Math.min(0.05, p.anatomy.density.blocks / 200);
      return { piece: p, score: Math.round(score * 1000) / 1000, reason: reasons.join(", ") };
    })
    .sort((a, b) => b.score - a.score);
};

const roleOf = (p: Piece, b: Block): { role: string; why?: string; content?: string } => {
  const el = p.reading?.elements.find((e) => e.block === b.n);
  if (el) return { role: el.role, ...(el.why ? { why: el.why } : {}), ...(el.content ? { content: el.content } : {}) };
  return { role: b.kind === "text" ? (b.n === p.anatomy.hierarchy.textScale[0]?.block ? "headline" : "text") : b.kind, ...(b.text?.sample ? { content: b.text.sample } : {}) };
};

/** Re-lay a reference piece out on a new canvas. */
export const adaptLayout = (p: Piece, W: number, H: number, minMargins: { top?: number; bottom?: number } = {}): { elements: PlacedElement[]; margins: Blueprint["margins"]; warnings: string[]; alignments: string[] } => {
  const a = p.anatomy;
  const shortRef = Math.min(a.canvas.w, a.canvas.h), shortT = Math.min(W, H);
  const s = shortT / shortRef;
  const warnings: string[] = [];
  const margins = { left: r(a.margins.left * s), right: r(a.margins.right * s), top: Math.max(r(a.margins.top * s), minMargins.top ?? 0), bottom: Math.max(r(a.margins.bottom * s), minMargins.bottom ?? 0) };
  const liveR = a.liveArea;
  const liveT = { x: margins.left, y: margins.top, w: W - margins.left - margins.right, h: H - margins.top - margins.bottom };
  const top = a.blocks.filter((b) => !b.parent);
  const placed = new Map<number, Box>();

  // Bleed elements cover the new canvas the way they covered the old one.
  for (const b of top.filter((b) => b.bleed)) placed.set(b.n, { x: r(b.rel.x * W), y: r(b.rel.y * H), w: r(b.rel.w * W), h: r(b.rel.h * H) });

  const flow = top.filter((b) => !b.bleed);
  // Horizontal: keep the position in the live area; fixed-size things (type, controls) scale with the short side.
  const widthOf = (b: Block): number => (b.kind === "control" || b.kind === "shape" ? b.box.w * s : (b.box.w / Math.max(1, liveR.w)) * liveT.w);
  const xOf = (b: Block, w: number): number => {
    const leftR = b.box.x - liveR.x, rightR = liveR.x + liveR.w - (b.box.x + b.box.w);
    const center = Math.abs(b.box.x + b.box.w / 2 - (liveR.x + liveR.w / 2)) < liveR.w * 0.02;
    if (center) return liveT.x + (liveT.w - w) / 2;
    if (rightR < leftR * 0.5) return liveT.x + liveT.w - w - (rightR / Math.max(1, liveR.w)) * liveT.w;
    return liveT.x + (leftR / Math.max(1, liveR.w)) * liveT.w;
  };
  // Vertical: rows above the middle stack from the top margin, rows below from the bottom margin; one big image flexes.
  const rows: Block[][] = [];
  for (const b of [...flow].sort((x, y) => x.box.y - y.box.y)) {
    const row = rows.find((rw) => rw.some((o) => Math.min(o.box.y + o.box.h, b.box.y + b.box.h) - Math.max(o.box.y, b.box.y) > Math.min(o.box.h, b.box.h) * 0.5));
    if (row) row.push(b); else rows.push([b]);
  }
  const rowBox = (rw: Block[]) => ({ y: Math.min(...rw.map((b) => b.box.y)), b: Math.max(...rw.map((b) => b.box.y + b.box.h)) });
  const flexRow = rows.reduce<number>((best, rw, i) => {
    const big = rw.some((b) => (b.kind === "image" || b.kind === "panel") && b.box.h > liveR.h * 0.3);
    if (!big) return best;
    const h = rowBox(rw).b - rowBox(rw).y;
    return best < 0 || h > rowBox(rows[best]!).b - rowBox(rows[best]!).y ? i : best;
  }, -1);
  const mid = liveR.y + liveR.h / 2;
  const isTop = (i: number): boolean => (flexRow >= 0 ? i < flexRow : (rowBox(rows[i]!).y + rowBox(rows[i]!).b) / 2 < mid);
  const heightOf = (b: Block, flexH?: number): number => {
    if (flexH !== undefined && (b.kind === "image" || b.kind === "panel") && b.box.h > liveR.h * 0.3) return flexH;
    if (b.kind === "image" || b.kind === "panel") return widthOf(b) * (b.box.h / Math.max(1, b.box.w));
    return b.box.h * s;
  };
  const yPos = new Map<number, number>();
  // Top stack.
  let cursor = liveT.y, prevBottom = liveR.y;
  const topRows = rows.map((rw, i) => ({ rw, i })).filter(({ i }) => i !== flexRow && isTop(i));
  for (const { rw } of topRows) {
    const rb = rowBox(rw);
    const gap = (rb.y - prevBottom) * s;
    const y = cursor + gap;
    let maxH = 0;
    for (const b of rw) { const dy = (b.box.y - rb.y) * s; yPos.set(b.n, y + dy); maxH = Math.max(maxH, dy + heightOf(b)); }
    cursor = y + maxH; prevBottom = rb.b;
  }
  const topEnd = cursor;
  // Bottom stack, from the bottom margin up.
  let bcursor = liveT.y + liveT.h, nextTop = liveR.y + liveR.h;
  const bottomRows = rows.map((rw, i) => ({ rw, i })).filter(({ i }) => i !== flexRow && !isTop(i)).reverse();
  for (const { rw } of bottomRows) {
    const rb = rowBox(rw);
    const gap = (nextTop - rb.b) * s;
    let maxH = 0;
    for (const b of rw) maxH = Math.max(maxH, (b.box.y - rb.y) * s + heightOf(b));
    const y = bcursor - gap - maxH;
    for (const b of rw) yPos.set(b.n, y + (b.box.y - rb.y) * s);
    bcursor = y; nextTop = rb.y;
  }
  const bottomStart = bcursor;
  let flexH: number | undefined;
  if (flexRow >= 0) {
    const rw = rows[flexRow]!, rb = rowBox(rw);
    const prev = rows[flexRow - 1], next = rows[flexRow + 1];
    const gapAbove = ((prev ? rb.y - rowBox(prev).b : rb.y - liveR.y)) * s;
    const gapBelow = ((next ? rowBox(next).y - rb.b : liveR.y + liveR.h - rb.b)) * s;
    flexH = bottomStart - topEnd - gapAbove - gapBelow;
    if (flexH < liveT.h * 0.12) { warnings.push(`The new canvas leaves only ${r(Math.max(0, flexH))}px for the main image: drop or shorten secondary blocks, or choose a taller format.`); flexH = Math.max(liveT.h * 0.12, flexH); }
    for (const b of rw) yPos.set(b.n, topEnd + gapAbove + (b.box.y - rb.y) * s);
  }
  for (const b of flow) {
    const w = widthOf(b);
    const h = heightOf(b, flexH);
    placed.set(b.n, { x: r(xOf(b, w)), y: r(yPos.get(b.n) ?? liveT.y), w: r(w), h: r(h) });
  }
  if (topEnd > bottomStart + 1) warnings.push(`The stacked blocks need ${r(topEnd - bottomStart)}px more height than the new canvas has: shorten the copy, drop a block or reduce the type a step.`);

  // Children follow their parent's scaling.
  for (const b of a.blocks.filter((b) => b.parent)) {
    const parent = a.blocks.find((x) => x.n === b.parent)!;
    const pb = placed.get(parent.n);
    if (!pb) continue;
    const sx = pb.w / Math.max(1, parent.box.w), sy = pb.h / Math.max(1, parent.box.h);
    placed.set(b.n, { x: r(pb.x + (b.box.x - parent.box.x) * sx), y: r(pb.y + (b.box.y - parent.box.y) * sy), w: r(b.box.w * sx), h: r(b.box.h * (b.kind === "text" ? s : sy)) });
  }

  const elements: PlacedElement[] = a.blocks.filter((b) => placed.has(b.n)).map((b) => {
    const box = placed.get(b.n)!;
    const role = roleOf(p, b);
    return {
      n: b.n,
      from: b.n,
      kind: b.kind,
      role: role.role,
      box,
      rel: { x: Math.round((box.x / W) * 1000) / 1000, y: Math.round((box.y / H) * 1000) / 1000, w: Math.round((box.w / W) * 1000) / 1000, h: Math.round((box.h / H) * 1000) / 1000 },
      ...(b.text?.sizePx ? { sizePx: r(b.text.sizePx * s) } : {}),
      ...(b.text ? { lines: b.text.lines } : {}),
      ...(b.color ? { color: b.color } : {}),
      ...(b.background ? { on: b.background } : {}),
      ...(role.why ? { why: role.why } : {}),
      ...(role.content ? { content: role.content } : {}),
      ...(b.parent ? { parent: b.parent } : {}),
    };
  });
  const out = new Set<number>();
  for (const e of elements) if (e.box.x < -1 || e.box.y < -1 || e.box.x + e.box.w > W + 1 || e.box.y + e.box.h > H + 1) out.add(e.n);
  if (out.size) warnings.push(`Element(s) ${[...out].map((n) => `#${n}`).join(", ")} fall outside the canvas after adapting; reflow them by hand.`);
  const alignments = a.axes.slice(0, 5).map((ax) => `Keep ${ax.blocks.map((n) => `#${n}`).join(", ")} on one ${ax.edge} edge (it was at ${pct(ax.rel)} of the ${ax.edge.includes("y") || ax.edge === "top" || ax.edge === "bottom" ? "height" : "width"}).`);
  return { elements, margins, warnings, alignments };
};

const esc = (s: string): string => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

export const renderWireframe = async (W: number, H: number, margins: Blueprint["margins"], elements: readonly PlacedElement[], out: string): Promise<void> => {
  const scale = Math.min(1, 1200 / Math.max(W, H));
  const w = r(W * scale), h = r(H * scale);
  const font = Math.max(11, r(Math.min(w, h) / 50));
  const parts: string[] = [`<rect width="${w}" height="${h}" fill="#fafafa"/>`];
  parts.push(`<rect x="${margins.left * scale}" y="${margins.top * scale}" width="${(W - margins.left - margins.right) * scale}" height="${(H - margins.top - margins.bottom) * scale}" fill="none" stroke="#00b7d4" stroke-width="2" stroke-dasharray="8 5"/>`);
  for (const e of [...elements].sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0))) {
    const c = KIND_COLORS[e.kind];
    const fill = e.kind === "panel" || e.kind === "control" ? e.color ?? c : c;
    parts.push(`<rect x="${e.box.x * scale}" y="${e.box.y * scale}" width="${e.box.w * scale}" height="${e.box.h * scale}" fill="${fill}" fill-opacity="${e.kind === "panel" || e.kind === "control" ? 0.35 : 0.12}" stroke="${c}" stroke-width="2"/>`);
    const label = `${e.n} ${e.role}${e.sizePx ? ` ${e.sizePx}px` : ""}`;
    parts.push(`<text x="${e.box.x * scale + 4}" y="${e.box.y * scale + font + 2}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${font}" font-weight="700" fill="${c}">${esc(label.slice(0, 48))}</text>`);
  }
  parts.push(`<text x="${w - 6}" y="${h - 6}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${font}" fill="#888" text-anchor="end">${W}×${H}px</text>`);
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${parts.join("")}</svg>`)).png().toFile(out);
};

/** Formats with app overlays (stories): warn about text and controls under them. */
const withSafeArea = <T extends { elements: PlacedElement[]; warnings: string[] }>(layout: T, safe: { top: number; bottom: number; note: string } | undefined, H: number): T => {
  if (!safe) return layout;
  const under = layout.elements.filter((e) => (e.kind === "text" || e.kind === "control") && (e.box.y < safe.top || e.box.y + e.box.h > H - safe.bottom));
  const warnings = [...layout.warnings, `Safe area: ${safe.note}; keep text and buttons between y=${safe.top}px and y=${H - safe.bottom}px.`];
  if (under.length) warnings.push(`Element(s) ${under.map((e) => `#${e.n} (${e.role})`).join(", ")} sit under the app overlay: move them inside the safe area, letting the image keep the edges.`);
  return { ...layout, warnings };
};

const bullet = (xs: readonly string[] | undefined, prefix = "- "): string[] => (xs ?? []).filter(Boolean).map((x) => `${prefix}${x}`);

export const buildBlueprint = async (project: Project, genome: Genome | null, input: BlueprintInput, anatomy?: ProjectAnatomy): Promise<Blueprint> => {
  const pa = anatomy ?? (await projectAnatomy(project));
  const preset = input.format ? FORMATS[input.format] : undefined;
  if (input.format && !preset && !(input.width && input.height)) throw new Error(`Unknown format "${input.format}". Known: ${Object.keys(FORMATS).join(", ")}; or pass width and height.`);
  const W = input.width ?? preset?.w ?? 1080;
  const H = input.height ?? preset?.h ?? 1350;
  const group = preset?.group ?? (W >= 1200 && W / H > 1.3 && /site|web|landing|página|pagina|section|seção|secao/i.test(input.request) ? "web" : "visual");
  const label = preset?.label ?? `${W}×${H}px`;
  const ranked = input.references?.length
    ? input.references.map((id) => { const p = pa.pieces.find((x) => x.id === id); if (!p) throw new Error(`Unknown piece ${id}`); return { piece: p, score: 1, reason: "chosen by the user" }; })
    : rankReferences(pa.pieces, input, { w: W, h: H }, group).slice(0, 3);
  const base = ranked[0]?.piece ?? null;
  const adapted = base ? withSafeArea(adaptLayout(base, W, H, preset?.safe ?? {}), preset?.safe, H) : { elements: [], margins: { left: 0, right: 0, top: 0, bottom: 0 }, warnings: ["No dissected pieces yet: add references and run the dissection first."], alignments: [] };
  const id = `bp_${Date.now().toString(36)}`;
  let wireframe: string | null = null;
  if (base) {
    const dir = join(project.root, "blueprints");
    await mkdir(dir, { recursive: true });
    await renderWireframe(W, H, adapted.margins, adapted.elements, join(dir, `${id}.png`));
    wireframe = `blueprints/${id}.png`;
  }

  const c = pa.concept;
  const inv = pa.invariants[group] ?? pa.invariants.visual ?? pa.invariants.web ?? [];
  const md: string[] = [`# Blueprint: ${input.request}`, "", `Canvas ${W}×${H}px — ${label} (${aspectName(W, H)}).`, ""];
  if (c) {
    md.push("## Concept to keep", `- Big idea: ${c.bigIdea}`, `- Concept: ${c.concept}`, `- Why the project is this way: ${c.why}`);
    if (c.personality.length) md.push(`- Personality: ${c.personality.join(", ")}`);
    if (c.constants.length) md.push("", "Constants (never change):", ...c.constants.map((k) => `- ${k.what} — ${k.why}`));
    if (c.variables.length) md.push("", "Variables (free within range):", ...c.variables.map((v) => `- ${v.what}: ${v.range}${v.why ? ` — ${v.why}` : ""}`));
    if (c.grammar.length) md.push("", "Grammar (how a piece is built):", ...c.grammar.map((g, i) => `${i + 1}. ${g.replace(/^\d+[.)]\s*/, "")}`));
    if (c.adaptation.length) md.push("", "Adapting to a new format:", ...bullet(c.adaptation));
    if (c.signatureMoves.length) md.push("", "Signature moves:", ...bullet(c.signatureMoves));
    if (c.avoid.length) md.push("", "Avoid:", ...bullet(c.avoid));
    md.push("");
  } else md.push("_No project concept yet: run genome_concept_request after dissecting the pieces, so the why of the whole project guides the new piece._", "");
  const constants = inv.filter((i) => i.constant);
  if (constants.length) {
    md.push("## Measured constants across the references", ...constants.map((i) => `- ${invariantLine(i)} (${i.pieces} pieces)`));
    const shortSide = Math.min(W, H);
    const m = inv.find((i) => i.feature === "margin-short-side" && i.constant);
    const hs = inv.find((i) => i.feature === "headline-size-short" && i.constant);
    if (m || hs) md.push(`- On this canvas that is${m ? ` a ${r(m.median * shortSide)}px side margin` : ""}${m && hs ? " and" : ""}${hs ? ` a headline of about ${r(hs.median * shortSide)}px` : ""}.`);
    md.push("");
  }
  if (ranked.length) {
    md.push("## References", ...ranked.map((x, i) => `${i + 1}. ${x.piece.id} — ${x.piece.label}${x.piece.reading ? ` (${x.piece.reading.pieceType})` : ""}: ${x.reason}.`), "");
  }
  if (base) {
    md.push(`## Layout adapted from ${base.id}`, `Margins: left ${adapted.margins.left}px, right ${adapted.margins.right}px, top ${adapted.margins.top}px, bottom ${adapted.margins.bottom}px.`, "");
    md.push("| # | Role | Box (x, y, w × h) | Share of canvas | Type | Color | Why |", "|---|---|---|---|---|---|---|");
    for (const e of adapted.elements) {
      md.push(`| ${e.n}${e.parent ? ` (on #${e.parent})` : ""} | ${e.role} | ${e.box.x}, ${e.box.y}, ${e.box.w} × ${e.box.h}px | ${pct(e.rel.x)}, ${pct(e.rel.y)} · ${pct(e.rel.w)} × ${pct(e.rel.h)} | ${e.sizePx ? `${e.sizePx}px${e.lines ? `, ${e.lines} line(s)` : ""}` : "—"} | ${e.color ? `${e.color}${e.on ? ` on ${e.on}` : ""}` : "—"} | ${(e.why ?? "").replace(/\|/g, "/").slice(0, 220) || "—"} |`);
    }
    md.push("", ...bullet(adapted.alignments));
    if (adapted.warnings.length) md.push("", "Warnings:", ...bullet(adapted.warnings));
    const rd = base.reading;
    if (rd) {
      md.push("", `## Why the reference works (keep these reasons, not its content)`, `- Structure: ${rd.composition.structure}`, `- Eye path: ${rd.composition.eyePath}`);
      md.push(...rd.composition.principles.map((p) => `- ${p.name}: ${p.how} — ${p.why}`));
      md.push(...bullet(rd.whyItWorks));
      if (rd.fragile.length) md.push("", "Fragile (do not break):", ...bullet(rd.fragile));
    }
    md.push("");
  }
  if (genome) {
    const palette = genome.color.tokens.filter((t) => t.support.status !== "conflicted").slice(0, 8).map((t) => `${t.name} ${t.hex} (${pct(t.share)})`);
    if (palette.length) md.push("## Palette and type from the genome", `- Palette by share: ${palette.join(", ")}`);
    const fam = genome.typography.families.map((f) => (f.reuse === "restricted" ? `${f.family} → use ${f.substitute ?? "a licensed substitute"}` : f.family));
    if (fam.length) md.push(`- Typefaces: ${fam.join("; ")}`);
    const rules = genome.rules.filter((x) => ["composition", "layout", "typography", "imagery", "color"].includes(x.topic) && x.support.status !== "conflicted").sort((a, b) => b.support.confidence - a.support.confidence).slice(0, 12);
    if (rules.length) md.push("", "## Rules", ...rules.map((x) => `- [${x.support.status}] ${x.polarity !== "fact" ? `${x.polarity.toUpperCase()}: ` : ""}${x.statement}`));
    md.push("");
  }
  md.push(
    "## Build it",
    "1. Write the new content for each role; keep the role, position logic and hierarchy, never the reference's copy, logo or photos.",
    "2. Place the elements on the boxes above (or the wireframe), then adjust to the real copy length while keeping margins, shared edges and gap ratios.",
    "3. Apply palette proportions and type from the genome; keep the measured type contrast between levels.",
    "4. Render the piece and call genome_verify on it; fix high and medium deviations. For images, compare its anatomy with genome_dissect_request on the result if needed.",
  );
  const markdown = md.join("\n");
  const blueprint: Blueprint = {
    id,
    request: input.request,
    canvas: { w: W, h: H, aspectName: aspectName(W, H), label },
    references: ranked.map((x) => ({ id: x.piece.id, label: x.piece.label, score: x.score, reason: x.reason, overlay: x.piece.overlay })),
    base: base?.id ?? null,
    margins: adapted.margins,
    elements: adapted.elements,
    alignments: adapted.alignments,
    warnings: adapted.warnings,
    wireframe,
    markdown,
  };
  if (base) await writeFile(join(project.root, "blueprints", `${id}.json`), JSON.stringify(blueprint, null, 2));
  return blueprint;
};
