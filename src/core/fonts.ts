import type { Reuse } from "./genome.js";

/**
 * Reuse guidance for common brand typefaces. A genome learns from a typeface's
 * metrics; it must not ship a proprietary font in work for someone else.
 * "restricted" means licensed to its owner or limited to specific platforms.
 * Substitutes are open-licensed families with comparable proportions; tracking
 * and size should be re-fitted to the substitute, not copied blindly.
 */
interface FontRule {
  readonly match: RegExp;
  readonly reuse: Reuse;
  readonly note: string;
  readonly substitute?: string;
}

const RULES: readonly FontRule[] = [
  { match: /^(sf pro|sf compact|sf mono|new york|-apple-system|system-ui|blinkmacsystemfont|\.sf ns)/i, reuse: "restricted", note: "Apple system typeface; licensed for mockups of software running on Apple platforms only.", substitute: "Inter" },
  { match: /^helvetica( neue)?/i, reuse: "restricted", note: "Commercial typeface (Monotype); needs a license.", substitute: "Inter" },
  { match: /^(google sans|product sans)/i, reuse: "restricted", note: "Google brand typeface, not publicly licensed.", substitute: "Outfit" },
  { match: /^(circular|lineto)/i, reuse: "restricted", note: "Commercial typeface (Lineto).", substitute: "DM Sans" },
  { match: /^(nike|futura)/i, reuse: "restricted", note: "Commercial or brand typeface.", substitute: "Jost" },
  { match: /^(graphik|gt america|gt walsheim|aeonik|neue haas|suisse|untitled sans|söhne|sohne)/i, reuse: "restricted", note: "Commercial typeface; needs a license.", substitute: "Inter" },
  { match: /^segoe ui/i, reuse: "restricted", note: "Microsoft system typeface; not for redistribution.", substitute: "Open Sans" },
  { match: /^(inter|roboto|open sans|lato|montserrat|poppins|dm sans|manrope|ibm plex|source sans|noto|work sans|outfit|jost|space grotesk|figtree|geist|plus jakarta sans|playfair display|merriweather)/i, reuse: "open", note: "Open-licensed (SIL OFL or Apache)." },
];

const GENERIC = /^(sans-serif|serif|monospace|cursive|fantasy|ui-sans-serif|ui-serif|ui-monospace|arial|times new roman|georgia|courier new)$/i;

export const fontReuse = (family: string): { reuse: Reuse; note?: string; substitute?: string } => {
  const clean = family.replace(/["']/g, "").trim();
  if (GENERIC.test(clean)) return { reuse: "open", note: "Generic or widely available system family." };
  const rule = RULES.find((r) => r.match.test(clean));
  if (!rule) return { reuse: "unknown", note: "License not identified; check before shipping." };
  return { reuse: rule.reuse, note: rule.note, ...(rule.substitute ? { substitute: rule.substitute } : {}) };
};

/** First concrete family in a CSS font stack. */
export const primaryFamily = (stack: string): string => {
  const families = stack.split(",").map((f) => f.replace(/["']/g, "").trim()).filter(Boolean);
  return families[0] ?? stack;
};

/** Normalize vendor variants ("SF Pro Display", "SF Pro Text") to one family for comparison. */
export const familyKey = (family: string): string =>
  family
    .replace(/["']/g, "")
    .replace(/\s+(display|text|rounded|web|variable|vf|regular|medium|bold|light)$/i, "")
    .trim()
    .toLowerCase();
