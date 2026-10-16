import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

import { colorDistance, normalizeColor } from "../core/color.js";
import type { Project } from "../core/project.js";
import type { Source } from "../core/model.js";
import type { LayoutDump, LayoutElement } from "../extractors/web.js";
import { backgroundOf, detectBlocks } from "./blocks.js";
import { analyzeLayout, type LayoutInput } from "./layout.js";
import { renderGridOverlay, renderOverlay } from "./overlay.js";
import { dHash, decide, describePiece, hamming, imageSpread, inkInBox, type TriageCheck } from "./triage.js";
import type { Anatomy, Box, Piece, SourceAnatomy } from "./types.js";

/**
 * Splits each source into pieces and measures them:
 *  - an image is one piece;
 *  - a video gives up to six of its shots, spread over the film;
 *  - a page gives its sections at the widest and narrowest viewport, measured
 *    from the boxes the browser rendered (exact), cropped from the capture.
 */

export const ANATOMY_VERSION = "1.1.0";
export const ANATOMY_KINDS = new Set(["image", "video", "web"]);
const MAX_SHOTS = 6;
const MAX_SECTIONS = 8;

const anatomyDir = (project: Project): string => join(project.root, "anatomy");
const anatomyPath = (project: Project, sourceId: string): string => join(anatomyDir(project), `${sourceId}.json`);

export const loadAnatomy = async (project: Project, sourceId: string): Promise<SourceAnatomy | null> => {
  try {
    return JSON.parse(await readFile(anatomyPath(project, sourceId), "utf8")) as SourceAnatomy;
  } catch {
    return null;
  }
};

export const saveAnatomy = async (project: Project, anatomy: SourceAnatomy): Promise<void> => {
  await mkdir(anatomyDir(project), { recursive: true });
  await writeFile(anatomyPath(project, anatomy.sourceId), JSON.stringify(anatomy, null, 2));
};

export const loadAllAnatomy = async (project: Project): Promise<SourceAnatomy[]> => {
  const ids = new Set(project.sources.map((s) => s.id));
  const files = await readdir(anatomyDir(project)).catch(() => [] as string[]);
  const out: SourceAnatomy[] = [];
  for (const f of files.filter((f) => f.endsWith(".json")).sort()) {
    const a = JSON.parse(await readFile(join(anatomyDir(project), f), "utf8")) as SourceAnatomy;
    if (ids.has(a.sourceId)) out.push(a);
  }
  return out;
};

const pieceLabel = (source: Source, suffix: string): string => `${source.label ?? source.uri.split(/[\\/]/).pop() ?? source.id}${suffix}`;

const counts = (a: Anatomy) => ({
  texts: a.blocks.filter((b) => b.kind === "text").length,
  images: a.blocks.filter((b) => b.kind === "image").length,
  controls: a.blocks.filter((b) => b.kind === "control").length,
  panels: a.blocks.filter((b) => b.kind === "panel").length,
  headline: a.blocks.find((b) => b.n === a.hierarchy.textScale[0]?.block)?.text?.sample,
});

/** Near-duplicate check against the pieces already measured in this pass. */
const duplicateCheck = (hash: bigint, seen: { id: string; hash: bigint; group: string }[], group: string): TriageCheck => {
  const twin = seen.find((s) => s.group === group && hamming(s.hash, hash) <= 4);
  return { name: "duplicate", ok: !twin, detail: twin ? `looks the same as ${twin.id}` : "distinct from the other pieces" };
};

/** Measure one image file as a piece. */
const imagePiece = async (project: Project, source: Source, index: number, image: string, kind: Piece["kind"], label: string, extra: Partial<Piece> = {}, seen: { id: string; hash: bigint; group: string }[] = []): Promise<{ piece: Piece; limitations: string[] }> => {
  const reading = await detectBlocks(image);
  const anatomy = analyzeLayout(reading.width, reading.height, reading.background, reading.blocks, { web: kind === "web-section", exact: false });
  const overlay = await project.artifact(source.id, `anatomy-${index}.jpg`);
  await renderOverlay(image, anatomy, overlay.abs);
  const grid = await project.artifact(source.id, `grid-${index}.jpg`);
  await renderGridOverlay(image, anatomy, grid.abs);
  const artifact = image.startsWith(project.root) ? image.slice(project.root.length + 1).replace(/\\/g, "/") : image;
  const spread = await imageSpread(image);
  const hash = await dHash(image);
  const id = `${source.id}#${index}`;
  const checks: TriageCheck[] = [
    { name: "blank", ok: spread >= 4, detail: spread >= 4 ? `visible variation (σ ${spread.toFixed(1)})` : `one flat color (σ ${spread.toFixed(1)}): nothing to read` },
    duplicateCheck(hash, seen, `${source.id}|${kind}`),
    { name: "composition", ok: anatomy.blocks.length >= 1, detail: anatomy.blocks.length ? `${anatomy.blocks.length} block(s) found` : "no blocks found in the pixels" },
  ];
  seen.push({ id, hash, group: `${source.id}|${kind}` });
  const triage = decide(checks, describePiece({ kind, ...(extra.viewport ? { viewport: extra.viewport } : {}), ...counts(anatomy) }), ["blank", "duplicate"]);
  return {
    piece: { id, sourceId: source.id, index, kind, label, precision: "estimated", artifact, overlay: overlay.rel.replace(/\\/g, "/"), gridOverlay: grid.rel.replace(/\\/g, "/"), ...extra, anatomy, triage },
    limitations: reading.limitations,
  };
};

const parsePx = (value: string | undefined, size: number): number | undefined => {
  if (!value || value === "normal") return size ? Math.round(size * 1.2) : undefined;
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return undefined;
  return value.endsWith("px") ? n : n * size;
};

const isTransparent = (c?: string): boolean => !c || c === "transparent" || /rgba\(.*,\s*0\)$/.test(c);
const hexOf = (c?: string): string | undefined => (c && !isTransparent(c) ? normalizeColor(c)?.hex : undefined);
const inside = (outer: Box, inner: Box, tol = 1): boolean => inner.x >= outer.x - tol && inner.y >= outer.y - tol && inner.x + inner.w <= outer.x + outer.w + tol && inner.y + inner.h <= outer.y + outer.h + tol;

/** Elements of a page that read as pieces of the composition. */
const leavesOf = (els: readonly LayoutElement[], viewport: number): LayoutElement[] => {
  const MEDIA = new Set(["img", "svg", "video", "picture", "canvas", "iframe"]);
  const out = els.filter((e) => {
    if (e.box.w < 4 || e.box.h < 4 || e.box.x >= viewport || e.box.x + e.box.w <= 0) return false;
    return Boolean(e.text) || MEDIA.has(e.tag) || e.interactive || (e.hasBackgroundImage && e.box.w * e.box.h > 6000) || (!isTransparent(e.background) && e.box.w < viewport * 0.98) || (e.borderWidth ?? 0) > 0;
  });
  // A text element inside another text element is the same paragraph; an svg inside a link is the link's icon.
  return out.filter((e) => !(e.text && out.some((o) => o !== e && o.text && inside(o.box, e.box) && (o.box.w * o.box.h > e.box.w * e.box.h))));
};

/** Cut a page into sections at the vertical gaps between content. */
const sectionsOf = (leaves: readonly LayoutElement[], docHeight: number, vh: number): Box[] => {
  const sorted = [...leaves].sort((a, b) => a.box.y - b.box.y);
  const cuts: number[] = [0];
  let bottom = 0;
  for (const e of sorted) {
    if (e.box.h > vh * 1.5) continue;
    if (e.box.y > bottom + 32 && bottom > 0) cuts.push(Math.round((bottom + e.box.y) / 2));
    bottom = Math.max(bottom, e.box.y + e.box.h);
  }
  cuts.push(docHeight);
  const sections: Box[] = [];
  let start = 0;
  for (let i = 1; i < cuts.length; i++) {
    const end = cuts[i]!;
    const last = i === cuts.length - 1;
    if (end - start >= vh * 0.5 || last) {
      if (end - start > 40) sections.push({ x: 0, y: start, w: 0, h: end - start });
      start = end;
    } else if (end - start > vh * 1.5) {
      sections.push({ x: 0, y: start, w: 0, h: end - start });
      start = end;
    }
  }
  return sections;
};

const webPieces = async (project: Project, source: Source, start: number): Promise<{ pieces: Piece[]; limitations: string[] }> => {
  const dir = join(project.root, "evidence", source.id);
  const files = await readdir(dir).catch(() => [] as string[]);
  const viewports = [...new Set(files.map((f) => f.match(/^page-(\d+)\.jpg$/)?.[1]).filter(Boolean).map(Number))].sort((a, b) => b - a);
  const chosen = viewports.length > 1 ? [viewports[0]!, viewports.at(-1)!] : viewports;
  const pieces: Piece[] = [];
  const limitations: string[] = [];
  const seen: { id: string; hash: bigint; group: string }[] = [];
  let index = start;
  for (const vp of chosen) {
    const shotPath = join(dir, `page-${vp}.jpg`);
    const meta = await sharp(shotPath).metadata();
    const shotH = meta.height ?? 0;
    const vh = vp < 700 ? 844 : 900;
    let dump: LayoutDump | null = null;
    try { dump = JSON.parse(await readFile(join(dir, `layout-${vp}.json`), "utf8")) as LayoutDump; } catch { dump = null; }
    if (!dump) {
      limitations.push(`No rendered boxes for ${vp}px (extracted before the anatomy existed): sections were measured from pixels. Re-extract the site for exact boxes.`);
    } else if (!dump.capture) {
      limitations.push(`The ${vp}px capture was taken before screen-by-screen capture existed: content revealed on scroll may be missing from the picture while its boxes were still measured. Run genome_rebuild on this source to capture it again.`);
    }
    const leaves = dump ? leavesOf(dump.elements, vp) : [];
    const sections = dump ? sectionsOf(leaves, Math.min(dump.docHeight, shotH), vh) : Array.from({ length: Math.ceil(shotH / vh) }, (_, i) => ({ x: 0, y: i * vh, w: 0, h: Math.min(vh, shotH - i * vh) }));
    if (sections.length > MAX_SECTIONS) limitations.push(`Page at ${vp}px has ${sections.length} sections; the first ${MAX_SECTIONS} were dissected.`);
    const used = sections.slice(0, MAX_SECTIONS);
    for (const [k, sec] of used.entries()) {
      const h = Math.min(sec.h, shotH - sec.y);
      if (h < 40) continue;
      const crop = await project.artifact(source.id, `section-${vp}-${index}.jpg`);
      await sharp(shotPath).extract({ left: 0, top: sec.y, width: meta.width ?? vp, height: h }).jpeg({ quality: 82 }).toFile(crop.abs);
      const label = pieceLabel(source, ` · ${vp}px · section ${index - start + 1}`);
      const pageBox = { x: 0, y: sec.y, w: vp, h };
      const where = { index: k + 1, of: used.length, top: k === 0, bottom: k === used.length - 1 };
      if (!dump) {
        const { piece, limitations: l } = await imagePiece(project, source, index, crop.abs, "web-section", label, { viewport: vp, pageBox }, seen);
        pieces.push(piece);
        limitations.push(...l);
        index++;
        continue;
      }
      const bg = await backgroundOf(crop.abs);
      const within = leaves.filter((e) => {
        const cy = e.box.y + e.box.h / 2;
        return cy >= sec.y && cy < sec.y + h && e.box.h < h * 1.05;
      });
      const local = within.map((e) => ({ ...e, box: { x: Math.max(0, e.box.x), y: Math.max(0, e.box.y - sec.y), w: Math.min(e.box.w, vp - Math.max(0, e.box.x)), h: Math.min(e.box.h, h - Math.max(0, e.box.y - sec.y)) } }));
      const raw = await sharp(crop.abs).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const pixels = { data: raw.data, width: raw.info.width, height: raw.info.height, channels: raw.info.channels };
      const inputs: LayoutInput[] = [];
      const containerIdx: number[] = [];
      const MEDIA = new Set(["img", "svg", "video", "picture", "canvas", "iframe"]);
      let textSeen = 0;
      const unpainted: string[] = [];
      for (const e of local.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)) {
        const area = e.box.w * e.box.h;
        const fill = hexOf(e.background);
        // Links without a surface read as text; a control has a fill or a border.
        const surface = Boolean(fill) || (e.borderWidth ?? 0) > 0;
        const kind: LayoutInput["kind"] = e.interactive && surface ? "control" : e.text ? "text" : MEDIA.has(e.tag) || e.hasBackgroundImage ? "image" : fill && area > vp * h * 0.06 ? "panel" : "shape";
        if (kind === "shape" && !fill && !(e.borderWidth ?? 0)) continue;
        const parentIdx = containerIdx.filter((i) => inside(inputs[i]!.box, e.box)).sort((a, b) => inputs[a]!.box.w * inputs[a]!.box.h - inputs[b]!.box.w * inputs[b]!.box.h)[0];
        const behind = parentIdx !== undefined ? inputs[parentIdx]!.color ?? bg.hex : bg.hex;
        const color = e.text ? hexOf(e.color) : fill ?? hexOf(e.color);
        // The page code is not the picture: text that left no ink in the capture is not part of this piece.
        if (kind === "text") {
          textSeen++;
          const ink = await inkInBox(pixels, e.box, color, behind);
          if (!ink.painted) { unpainted.push(e.text ?? e.selector); continue; }
        }
        const lineH = e.text ? parsePx(e.lineHeight, e.fontSize ?? 16) : undefined;
        inputs.push({
          kind,
          box: e.box,
          ...(color ? { color } : {}),
          background: behind,
          ...(color ? { contrast: Math.round(colorDistance(color, behind) * 10) / 10 } : {}),
          ...(parentIdx !== undefined ? { parentIndex: parentIdx } : {}),
          ...(e.text ? { text: { lines: Math.max(1, Math.round(e.box.h / Math.max(1, lineH ?? e.box.h))), ...(lineH ? { linePitchPx: Math.round(lineH) } : {}), ...(e.fontSize ? { sizePx: e.fontSize } : {}), sample: e.text.slice(0, 60), ...(e.fontWeight ? { weight: e.fontWeight } : {}), ...(e.fontFamily ? { family: e.fontFamily } : {}), exact: true } } : {}),
          selector: e.selector,
          tag: e.tag,
        });
        if (kind === "panel" || kind === "control") containerIdx.push(inputs.length - 1);
        // A control's label lives on the control.
        if (kind === "control" && e.text) inputs.push({ kind: "text", box: e.box, ...(hexOf(e.color) ? { color: hexOf(e.color)! } : {}), background: fill ?? behind, parentIndex: inputs.length - 1, text: { lines: 1, ...(e.fontSize ? { sizePx: e.fontSize } : {}), sample: e.text.slice(0, 60), exact: true }, selector: e.selector, tag: e.tag });
      }
      const anatomy = analyzeLayout(vp, h, bg, inputs.slice(0, 120), { web: true, exact: true });
      const overlay = await project.artifact(source.id, `anatomy-${index}.jpg`);
      await renderOverlay(crop.abs, anatomy, overlay.abs);
      const gridArt = await project.artifact(source.id, `grid-${index}.jpg`);
      await renderGridOverlay(crop.abs, anatomy, gridArt.abs);
      const id = `${source.id}#${index}`;
      const spread = await imageSpread(crop.abs);
      const hash = await dHash(crop.abs);
      const missing = textSeen ? unpainted.length / textSeen : 0;
      const content = anatomy.blocks.filter((b) => !b.bleed);
      const bleedImage = Math.min(1, Math.max(0, ...anatomy.blocks.filter((b) => b.bleed && b.kind === "image").map((b) => b.areaShare)));
      const checks: TriageCheck[] = [
        { name: "blank", ok: spread >= 4, detail: spread >= 4 ? `visible variation (σ ${spread.toFixed(1)})` : `the capture is one flat color (σ ${spread.toFixed(1)})` },
        duplicateCheck(hash, seen, `${source.id}|${vp}`),
        { name: "painted-text", ok: !(textSeen >= 3 && missing >= 0.5), detail: unpainted.length ? `${unpainted.length} of ${textSeen} text block(s) in the code left no ink in the picture (${unpainted.slice(0, 4).map((t) => `"${t.slice(0, 30)}"`).join(", ")}${unpainted.length > 4 ? "…" : ""}); they were left out` : `all ${textSeen} text block(s) are visible in the picture` },
        { name: "composition", ok: content.length >= 2, detail: content.length >= 2 ? `${content.length} composed block(s)` : "fewer than two composed blocks: a spacer, a background strip or a single line" },
        { name: "capture", ok: Boolean(dump.capture) && missing < 0.2, detail: !dump.capture ? "captured with the old one-frame method: content revealed on scroll may be missing" : missing >= 0.2 ? `${Math.round(missing * 100)}% of the text was not visible: part of the section may still be hidden by an animation or a layer` : `photographed screen by screen (${dump.capture.screens} screens)` },
        { name: "background", ok: !(bleedImage >= 0.8 && content.filter((b) => b.kind === "text").length <= 1), detail: bleedImage >= 0.8 ? `a full-bleed image or video frame covers ${Math.round(bleedImage * 100)}% of the section` : "no dominant background frame" },
      ];
      seen.push({ id, hash, group: `${source.id}|${vp}` });
      const triage = decide(checks, describePiece({ kind: "web-section", viewport: vp, ...where, ...counts(anatomy) }), ["blank", "duplicate", "painted-text", "composition"]);
      pieces.push({ id, sourceId: source.id, index, kind: "web-section", label, precision: "exact", artifact: crop.rel.replace(/\\/g, "/"), overlay: overlay.rel.replace(/\\/g, "/"), gridOverlay: gridArt.rel.replace(/\\/g, "/"), viewport: vp, pageBox, anatomy, triage });
      if (inputs.length > 120) limitations.push(`${label}: ${inputs.length} elements, the 120 largest were kept.`);
      index++;
    }
  }
  return { pieces, limitations };
};

const videoPieces = async (project: Project, source: Source): Promise<{ pieces: Piece[]; limitations: string[] }> => {
  const dir = join(project.root, "evidence", source.id);
  const shots = (await readdir(dir).catch(() => [] as string[])).filter((f) => /^shot-\d+\.jpg$/.test(f)).sort();
  const step = Math.max(1, Math.ceil(shots.length / MAX_SHOTS));
  const chosen = shots.filter((_, i) => i % step === 0).slice(0, MAX_SHOTS);
  // Shot times come from the video extraction's evidence.
  const times = new Map<string, number>();
  for (const e of await project.loadExtractions()) {
    if (e.sourceId !== source.id || e.extractor !== "video") continue;
    for (const o of e.observations) for (const ev of o.evidence) if (ev.artifact && ev.locator.type === "frame") times.set(ev.artifact.split(/[\\/]/).pop()!, ev.locator.timeSec);
  }
  const pieces: Piece[] = [];
  const limitations: string[] = [];
  let index = 1;
  const seen: { id: string; hash: bigint; group: string }[] = [];
  for (const file of chosen) {
    const t = times.get(file);
    const { piece, limitations: l } = await imagePiece(project, source, index, join(dir, file), "video-shot", pieceLabel(source, ` · shot ${file.match(/\d+/)![0]}${t !== undefined ? ` @${t.toFixed(1)}s` : ""}`), t !== undefined ? { timeSec: t } : {}, seen);
    pieces.push(piece);
    limitations.push(...l);
    index++;
  }
  if (shots.length > chosen.length) limitations.push(`${chosen.length} of ${shots.length} sampled shots were dissected.`);
  return { pieces, limitations };
};

/** Measure (or re-measure) every piece of a source. Readings already given are kept when the piece still exists. */
export const measureSource = async (project: Project, source: Source): Promise<SourceAnatomy> => {
  if (!ANATOMY_KINDS.has(source.kind)) throw new Error(`${source.kind} sources have no pieces to dissect.`);
  const previous = await loadAnatomy(project, source.id);
  let result: { pieces: Piece[]; limitations: string[] };
  if (source.kind === "image") {
    const path = project.localPath(source);
    const preview = join(project.root, "evidence", source.id, "preview.jpg");
    const file = path && !/\.(svg|gif)$/i.test(path) ? path : preview;
    const { piece, limitations } = await imagePiece(project, source, 1, file, "image", pieceLabel(source, ""));
    result = { pieces: [piece], limitations };
  } else if (source.kind === "video") result = await videoPieces(project, source);
  else result = await webPieces(project, source, 1);
  // A page captured again is a different picture: readings of the old capture no longer describe it.
  const captured = await capturedAt(project, source.id);
  const recaptured = source.kind === "web" && previous && captured !== null && captured > previous.measuredAt;
  const kept = result.pieces.map((p) => {
    const old = recaptured ? undefined : previous?.pieces.find((q) => q.id === p.id);
    if (!old) return p;
    return { ...p, ...(old.reading ? { reading: old.reading } : {}), ...(old.skipped ? { skipped: old.skipped } : {}) };
  });
  const anatomy: SourceAnatomy = { schema: "design-genome-anatomy/1", sourceId: source.id, version: ANATOMY_VERSION, measuredAt: new Date().toISOString(), pieces: kept, limitations: [...new Set(result.limitations)] };
  await saveAnatomy(project, anatomy);
  // Rules read from the old capture go with it.
  if (recaptured) await rm(join(project.root, "extractions", `${source.id}--dissect.json`), { force: true });
  return anatomy;
};

/** When the source was last captured (its primary extraction), to know whether pieces still show the same picture. */
const capturedAt = async (project: Project, sourceId: string): Promise<string | null> => {
  const dir = join(project.root, "extractions");
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith(`${sourceId}--`) && !/--(dissect|vision)\.json$/.test(f));
  let latest: string | null = null;
  for (const f of files) {
    try {
      const at = (JSON.parse(await readFile(join(dir, f), "utf8")) as { finishedAt?: string }).finishedAt;
      if (at && (!latest || at > latest)) latest = at;
    } catch { /* unreadable extraction: ignore */ }
  }
  return latest;
};

/** Anatomy of a source, measuring it the first time it is asked for, and again when the source was captured again. */
export const ensureAnatomy = async (project: Project, source: Source): Promise<SourceAnatomy> => {
  const existing = await loadAnatomy(project, source.id);
  const captured = await capturedAt(project, source.id);
  if (existing && existing.version === ANATOMY_VERSION && existing.pieces.length && !(captured && captured > existing.measuredAt)) return existing;
  return measureSource(project, source);
};
