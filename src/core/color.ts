import { converter, differenceCiede2000, formatHex, parse } from "culori";

/** Perceptual color in OKLCH plus its sRGB hex, the unit every extractor reports. */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

export interface NormalizedColor {
  readonly hex: string;
  readonly alpha: number;
  readonly oklch: Oklch;
}

const toOklch = converter("oklch");
const toRgb = converter("rgb");
const deltaE = differenceCiede2000();

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** Parse any CSS color string. Returns null for transparent or unparseable input. */
export const normalizeColor = (input: string): NormalizedColor | null => {
  const parsed = parse(input.trim());
  if (!parsed) return null;
  const alpha = parsed.alpha ?? 1;
  if (alpha <= 0.01) return null;
  const rgb = toRgb(parsed);
  const hex = formatHex({ ...rgb, alpha: undefined });
  if (!hex) return null;
  return { hex, alpha: round(alpha, 3), oklch: oklchOf(hex) };
};

export const oklchOf = (hex: string): Oklch => {
  const value = toOklch(hex);
  return {
    l: round(value?.l ?? 0, 4),
    c: round(value?.c ?? 0, 4),
    h: round(Number.isFinite(value?.h) ? (value?.h as number) : 0, 2),
  };
};

export const rgbToHex = (r: number, g: number, b: number): string =>
  formatHex({ mode: "rgb", r: r / 255, g: g / 255, b: b / 255 }) ?? "#000000";

/** CIEDE2000 distance. Below ~2.3 is a just-noticeable difference. */
export const colorDistance = (a: string, b: string): number => deltaE(a, b);

/** WCAG 2 relative-luminance contrast ratio. */
export const contrastRatio = (a: string, b: string): number => {
  const lum = (hex: string): number => {
    const rgb = toRgb(hex);
    const channel = (v: number): number =>
      v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    return (
      0.2126 * channel(rgb?.r ?? 0) +
      0.7152 * channel(rgb?.g ?? 0) +
      0.0722 * channel(rgb?.b ?? 0)
    );
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return round((hi + 0.05) / (lo + 0.05), 2);
};

/** Neutral means low chroma: greys, near-blacks and near-whites. */
export const isNeutral = (color: Oklch): boolean => color.c < 0.03;

export type ColorFamily =
  | "neutral"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "teal"
  | "blue"
  | "purple"
  | "pink";

export const colorFamily = (color: Oklch): ColorFamily => {
  if (isNeutral(color)) return "neutral";
  const h = color.h;
  if (h < 20 || h >= 345) return "pink";
  if (h < 45) return "red";
  if (h < 75) return "orange";
  if (h < 110) return "yellow";
  if (h < 165) return "green";
  if (h < 210) return "teal";
  if (h < 275) return "blue";
  if (h < 320) return "purple";
  return "pink";
};

/** Warmth in OKLab b-axis terms: positive is warm, negative is cool. */
export const warmthOf = (color: Oklch): number =>
  round(color.c * Math.sin((color.h * Math.PI) / 180), 4);
