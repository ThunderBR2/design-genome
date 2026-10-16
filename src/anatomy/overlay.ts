import sharp from "sharp";

import type { Anatomy, BlockKind } from "./types.js";

/**
 * Draws the measured anatomy over the piece: numbered blocks, live area and
 * margins, shared alignment edges, gaps with their values and the thirds grid.
 * This picture is what the host model reads, so names and numbers always
 * refer to something it can see.
 */

export const KIND_COLORS: Record<BlockKind, string> = {
  text: "#ff2d6f",
  image: "#2f7bff",
  control: "#ffae00",
  panel: "#00b894",
  shape: "#a259ff",
  line: "#7a7a7a",
  unknown: "#9aa0a6",
};

const esc = (s: string): string => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

export const overlaySvg = (a: Anatomy, width: number, height: number): string => {
  const s = width / a.canvas.w;
  const u = Math.max(1, Math.round(Math.min(width, height) / 400));
  const font = Math.max(11, Math.round(Math.min(width, height) / 55));
  const parts: string[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number, color: string, dash = "", w = u, op = 1) =>
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${w}" ${dash ? `stroke-dasharray="${dash}"` : ""} opacity="${op}"/>`);
  const label = (x: number, y: number, text: string, color: string, fg = "#fff") => {
    const w = Math.round(text.length * font * 0.62 + font * 0.6);
    const h = Math.round(font * 1.35);
    const lx = Math.min(Math.max(0, x), width - w), ly = Math.min(Math.max(0, y), height - h);
    parts.push(`<rect x="${lx}" y="${ly}" width="${w}" height="${h}" rx="${Math.round(h / 4)}" fill="${color}" opacity="0.92"/>`);
    parts.push(`<text x="${lx + w / 2}" y="${ly + h * 0.74}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${font}" font-weight="700" fill="${fg}" text-anchor="middle">${esc(text)}</text>`);
  };

  // Thirds, faint.
  for (const t of [1 / 3, 2 / 3]) {
    line(width * t, 0, width * t, height, "#ffffff", `${4 * u} ${6 * u}`, u, 0.35);
    line(0, height * t, width, height * t, "#ffffff", `${4 * u} ${6 * u}`, u, 0.35);
  }
  // Live area and margins.
  const L = a.liveArea;
  parts.push(`<rect x="${L.x * s}" y="${L.y * s}" width="${L.w * s}" height="${L.h * s}" fill="none" stroke="#00e5ff" stroke-width="${u * 1.5}" stroke-dasharray="${8 * u} ${5 * u}"/>`);
  if (a.margins.left > 0) label(2, (L.y + L.h / 2) * s, `${a.margins.left}px`, "#008ea0");
  if (a.margins.right > 0) label(width - font * 4, (L.y + L.h / 2) * s, `${a.margins.right}px`, "#008ea0");
  if (a.margins.top > 0) label((L.x + L.w / 2) * s - font * 2, 2, `${a.margins.top}px`, "#008ea0");
  if (a.margins.bottom > 0) label((L.x + L.w / 2) * s - font * 2, height - font * 1.5, `${a.margins.bottom}px`, "#008ea0");
  // Alignment axes.
  for (const axis of a.axes.slice(0, 6)) {
    const vertical = axis.edge === "left" || axis.edge === "right" || axis.edge === "center-x";
    const p = axis.at * s;
    if (vertical) line(p, 0, p, height, "#ff00d4", `${6 * u} ${4 * u}`, u, 0.8);
    else line(0, p, width, p, "#ff00d4", `${6 * u} ${4 * u}`, u, 0.8);
  }
  // Blocks.
  for (const b of a.blocks) {
    const c = KIND_COLORS[b.kind];
    parts.push(`<rect x="${b.box.x * s}" y="${b.box.y * s}" width="${b.box.w * s}" height="${b.box.h * s}" fill="${c}" fill-opacity="0.08" stroke="${c}" stroke-width="${u * 2}"/>`);
  }
  for (const b of a.blocks) {
    const c = KIND_COLORS[b.kind];
    const text = b.text?.sizePx ? `${b.n} ${b.kind} ≈${b.text.sizePx}px` : `${b.n} ${b.kind}`;
    label(b.box.x * s, b.box.y * s - font * 1.4 < 0 ? b.box.y * s : b.box.y * s - font * 1.4, text, c);
  }
  // Gaps.
  const byN = new Map(a.blocks.map((b) => [b.n, b]));
  for (const g of a.gaps.filter((g) => g.px > 0 && g.rel <= 0.25).slice(0, 18)) {
    const [p, q] = [byN.get(g.between[0])!, byN.get(g.between[1])!];
    if (g.axis === "y") {
      const x = (Math.max(p.box.x, q.box.x) + Math.min(p.box.x + p.box.w, q.box.x + q.box.w)) / 2 * s;
      const y1 = (p.box.y + p.box.h) * s, y2 = q.box.y * s;
      line(x, y1, x, y2, "#ffe600", "", u * 2);
      label(x + 3 * u, (y1 + y2) / 2 - font * 0.7, `${g.px}`, "#3a3300", "#ffe600");
    } else {
      const y = (Math.max(p.box.y, q.box.y) + Math.min(p.box.y + p.box.h, q.box.y + q.box.h)) / 2 * s;
      const x1 = (p.box.x + p.box.w) * s, x2 = q.box.x * s;
      line(x1, y, x2, y, "#ffe600", "", u * 2);
      label((x1 + x2) / 2 - font, y + 3 * u, `${g.px}`, "#3a3300", "#ffe600");
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
};

/** Write the annotated overlay of a piece as a JPEG, at most `maxSide` px on the long side. */
export const renderOverlay = async (image: string, anatomy: Anatomy, out: string, maxSide = 1400): Promise<void> => {
  const scale = Math.min(1, maxSide / Math.max(anatomy.canvas.w, anatomy.canvas.h));
  const width = Math.max(1, Math.round(anatomy.canvas.w * scale));
  const height = Math.max(1, Math.round(anatomy.canvas.h * scale));
  const base = await sharp(image, { failOn: "none" }).rotate().resize(width, height, { fit: "fill" }).flatten({ background: "#ffffff" }).modulate({ brightness: 0.9 }).toBuffer();
  await sharp(base).composite([{ input: Buffer.from(overlaySvg(anatomy, width, height)), top: 0, left: 0 }]).jpeg({ quality: 82 }).toFile(out);
};

/**
 * The grid reading drawn alone, so it can be judged without the block clutter:
 * column bands (gutters left clear), row bands, the baseline every unit,
 * proportional lines, and each block's outline with the columns it spans.
 */
export const gridSvg = (a: Anatomy, width: number, height: number): string => {
  const s = width / a.canvas.w;
  const u = Math.max(1, Math.round(Math.min(width, height) / 400));
  const font = Math.max(11, Math.round(Math.min(width, height) / 55));
  const g = a.grids;
  const parts: string[] = [];
  const tag = (x: number, y: number, text: string, bg: string, fg = "#fff") => {
    const w = Math.round(text.length * font * 0.6 + font * 0.6), h = Math.round(font * 1.35);
    const lx = Math.min(Math.max(0, x), width - w), ly = Math.min(Math.max(0, y), height - h);
    parts.push(`<rect x="${lx}" y="${ly}" width="${w}" height="${h}" rx="${Math.round(h / 4)}" fill="${bg}" opacity="0.92"/><text x="${lx + w / 2}" y="${ly + h * 0.74}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${font}" font-weight="700" fill="${fg}" text-anchor="middle">${esc(text)}</text>`);
  };
  if (g?.baseline && g.baseline.unitPx * s >= 3) {
    for (let y = g.baseline.originPx; y <= a.canvas.h; y += g.baseline.unitPx) parts.push(`<line x1="0" y1="${y * s}" x2="${width}" y2="${y * s}" stroke="#ff3b30" stroke-width="${Math.max(0.5, u * 0.6)}" opacity="0.35"/>`);
  }
  if (g?.columns && g.columns.columns >= 1) {
    const c = g.columns;
    for (let k = 0; k < c.columns; k++) {
      const x = (c.marginPx + k * (c.columnPx + c.gutterPx)) * s;
      parts.push(`<rect x="${x}" y="0" width="${c.columnPx * s}" height="${height}" fill="#00e5ff" fill-opacity="0.13" stroke="#00e5ff" stroke-opacity="0.7" stroke-width="${u}"/>`);
      tag(x + 2 * u, 2 * u, `c${k + 1}`, "#007c8c");
    }
  }
  if (g?.rows) {
    const r = g.rows;
    for (let k = 0; k < r.count; k++) {
      const y = (r.startPx + k * (r.trackPx + r.gutterPx)) * s;
      parts.push(`<rect x="0" y="${y}" width="${width}" height="${r.trackPx * s}" fill="#ffd400" fill-opacity="0.08" stroke="#ffd400" stroke-opacity="0.7" stroke-width="${u}" stroke-dasharray="${6 * u} ${4 * u}"/>`);
      tag(2 * u, y + 2 * u, `r${k + 1}`, "#7a6500");
    }
  }
  if (g?.proportional) {
    for (const l of g.proportional.lines) {
      const p = l.at * s;
      parts.push(l.axis === "x" ? `<line x1="${p}" y1="0" x2="${p}" y2="${height}" stroke="#b16bff" stroke-width="${u * 2}" stroke-dasharray="${10 * u} ${6 * u}"/>` : `<line x1="0" y1="${p}" x2="${width}" y2="${p}" stroke="#b16bff" stroke-width="${u * 2}" stroke-dasharray="${10 * u} ${6 * u}"/>`);
    }
  }
  const spans = new Map((g?.columnSpans ?? []).map((sp) => [sp.block, sp]));
  for (const b of a.blocks.filter((b) => !b.bleed)) {
    const sp = spans.get(b.n);
    const off = sp && (sp.from === null || sp.to === null) && !sp.centered;
    const color = off ? "#ff7a00" : "#ffffff";
    parts.push(`<rect x="${b.box.x * s}" y="${b.box.y * s}" width="${b.box.w * s}" height="${b.box.h * s}" fill="none" stroke="${color}" stroke-width="${u * 1.5}" opacity="0.9"/>`);
    if (sp?.centered) tag(b.box.x * s, b.box.y * s, `#${b.n} centered`, "#111");
    else if (sp && !off) tag(b.box.x * s, b.box.y * s, `#${b.n} c${sp.from}${sp.to !== sp.from ? `–${sp.to}` : ""}`, "#111");
    else tag(b.box.x * s, b.box.y * s, `#${b.n}${off ? " off-grid" : ""}`, off ? "#a34700" : "#111");
  }
  const title = !g ? "grid not measured" : g.kind === "free" ? "free composition — no grid explains the edges" : g.kind === "modular" ? `modular grid ${g.columns!.columns}×${g.rows!.count}` : g.kind === "column" ? `${g.columns!.columns}-column grid · gutter ${g.columns!.gutterPx}px` : "single-column (manuscript) grid";
  const extra = [g?.baseline ? `baseline ${g.baseline.unitPx}px` : "", g?.proportional ? g.proportional.system : "", g?.container ? `container ${g.container.widthPx}px` : ""].filter(Boolean).join(" · ");
  tag(width / 2 - (title.length + extra.length) * font * 0.3, height - font * 1.8, `${title}${extra ? ` · ${extra}` : ""}`, "#000");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
};

export const renderGridOverlay = async (image: string, anatomy: Anatomy, out: string, maxSide = 1400): Promise<void> => {
  const scale = Math.min(1, maxSide / Math.max(anatomy.canvas.w, anatomy.canvas.h));
  const width = Math.max(1, Math.round(anatomy.canvas.w * scale));
  const height = Math.max(1, Math.round(anatomy.canvas.h * scale));
  const base = await sharp(image, { failOn: "none" }).rotate().resize(width, height, { fit: "fill" }).flatten({ background: "#ffffff" }).modulate({ brightness: 0.55 }).toBuffer();
  await sharp(base).composite([{ input: Buffer.from(gridSvg(anatomy, width, height)), top: 0, left: 0 }]).jpeg({ quality: 82 }).toFile(out);
};
