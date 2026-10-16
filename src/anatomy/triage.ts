import sharp from "sharp";

import type { Box } from "./types.js";

/**
 * Before a piece is dissected: what is it, and is it worth reading? A capture
 * that does not show what was measured, a blank frame, a duplicate or a strip
 * with nothing composed in it would only produce confident nonsense, so it is
 * set aside with the reason — the host model can still overrule it.
 */

export interface TriageCheck {
  readonly name: "blank" | "duplicate" | "painted-text" | "composition" | "capture" | "background";
  readonly ok: boolean;
  readonly detail: string;
}

export interface Triage {
  /** ok: read it; doubtful: read it, but check the flagged points first; skip: not worth a reading. */
  readonly status: "ok" | "doubtful" | "skip";
  /** What the piece is, from the measurements alone (the host model confirms or corrects it). */
  readonly what: string;
  readonly checks: readonly TriageCheck[];
}

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

/** Standard deviation of the image, the largest over its channels (0 = one flat color). */
export const imageSpread = async (image: string | Buffer): Promise<number> => {
  const stats = await sharp(image, { failOn: "none" }).removeAlpha().stats();
  return Math.max(...stats.channels.map((c) => c.stdev));
};

/** 64-bit difference hash: near-identical pictures differ in a few bits. */
export const dHash = async (image: string | Buffer): Promise<bigint> => {
  const { data } = await sharp(image, { failOn: "none" }).removeAlpha().greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let h = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) h = (h << 1n) | (data[y * 9 + x]! > data[y * 9 + x + 1]! ? 1n : 0n);
  return h;
};

export const hamming = (a: bigint, b: bigint): number => {
  let x = a ^ b, n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
};

/**
 * Is the text of a measured box actually on the picture? Glyphs always leave
 * pixels that stand apart from the ground they sit on (whatever color the text
 * ends up painted in after opacity and blending), so it counts pixels far from
 * the ground color; when the ground is unknown, any clear variation counts.
 */
export const inkInBox = async (raw: { data: Buffer; width: number; height: number; channels: number }, box: Box, _textHex?: string, groundHex?: string): Promise<{ ink: number; spread: number; painted: boolean }> => {
  const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(raw.width, Math.ceil(box.x + box.w)), y1 = Math.min(raw.height, Math.ceil(box.y + box.h));
  if (x1 - x0 < 2 || y1 - y0 < 2) return { ink: 0, spread: 0, painted: false };
  const g = groundHex ? hexToRgb(groundHex) : null;
  let n = 0, inkN = 0, groundN = 0, sum = 0, sum2 = 0;
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 40000)));
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * raw.width + x) * raw.channels;
      const r = raw.data[i]!, gg = raw.data[i + 1]!, b = raw.data[i + 2]!;
      const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      sum += lum; sum2 += lum * lum; n++;
      if (g) {
        const d = Math.hypot(r - g[0], gg - g[1], b - g[2]);
        if (d > 60) inkN++;
        else if (d < 25) groundN++;
      }
    }
  }
  const mean = sum / n;
  const spread = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  const ink = inkN / n;
  // The box sits on its ground when most of it is that color; then glyphs must show as pixels far from it.
  const onGround = g ? groundN / n >= 0.4 : false;
  const painted = onGround ? ink >= 0.01 : spread >= 12;
  return { ink: Math.round(ink * 1000) / 1000, spread: Math.round(spread * 10) / 10, painted };
};

export const describePiece = (opts: { kind: "image" | "video-shot" | "web-section"; viewport?: number; index?: number; of?: number; texts: number; images: number; controls: number; panels: number; headline?: string; top?: boolean; bottom?: boolean }): string => {
  const parts: string[] = [];
  if (opts.kind === "web-section") {
    const where = opts.top ? "top of the page (header / hero)" : opts.bottom ? "end of the page (closing call or footer)" : "middle of the page";
    parts.push(`page section ${opts.index ?? "?"} of ${opts.of ?? "?"} at ${opts.viewport}px, ${where}`);
  } else parts.push(opts.kind === "video-shot" ? "a frame of a film" : "a still image");
  const content = [opts.texts ? `${opts.texts} text block(s)` : "", opts.images ? `${opts.images} image(s)` : "", opts.controls ? `${opts.controls} control(s)` : "", opts.panels ? `${opts.panels} panel(s)` : ""].filter(Boolean);
  parts.push(content.length ? content.join(", ") : "no measured blocks");
  if (opts.headline) parts.push(`largest text: "${opts.headline.slice(0, 70)}"`);
  return parts.join("; ");
};

export const decide = (checks: readonly TriageCheck[], what: string, hard: readonly TriageCheck["name"][]): Triage => {
  const failed = checks.filter((c) => !c.ok);
  const status = failed.some((c) => hard.includes(c.name)) ? "skip" : failed.length ? "doubtful" : "ok";
  return { status, what, checks };
};
