import { isNeutral } from "../core/color.js";
import { briefAnatomy, toAnatomy } from "./anatomy.js";
import type { Genome, Support, TypeStyleToken } from "../core/genome.js";

/** Exports for tools (W3C tokens, CSS, Tailwind) and for agents (a compact brief). */

const MARK: Record<Support["status"], string> = { confirmed: "●", "single-source": "◐", "declared-only": "○", conflicted: "⚠" };
const mark = (s: Support): string => `${MARK[s.status]} ${Math.round(s.confidence * 100)}%`;
const cssName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
const familyFor = (g: Genome, family: string, open: boolean): string => {
  const f = g.typography.families.find((x) => x.family.toLowerCase() === family.replace(/\s+(display|text)$/i, "").toLowerCase());
  return open && f?.reuse === "restricted" && f.substitute ? f.substitute : family;
};

const widest = (g: Genome): TypeStyleToken[] => {
  const max = Math.max(0, ...g.typography.styles.map((s) => s.viewport ?? 0));
  return g.typography.styles.filter((s) => (s.viewport ?? 0) === max);
};

/**
 * Named styles at the widest viewport: every distinct size per role, largest
 * first ("display", "display-2", ...), so no measured step is dropped.
 */
const ramp = (g: Genome, styles = widest(g)): (TypeStyleToken & { name: string })[] => {
  const count = (s: TypeStyleToken) => s.support.sources.reduce((n, x) => n + x.count, 0);
  const byRole = new Map<string, TypeStyleToken[]>();
  for (const s of styles) byRole.set(s.role, [...(byRole.get(s.role) ?? []), s]);
  const out: (TypeStyleToken & { name: string })[] = [];
  for (const [role, list] of byRole) {
    const bySize = new Map<number, TypeStyleToken>();
    for (const s of list) if (!bySize.has(s.sizePx) || count(s) > count(bySize.get(s.sizePx)!)) bySize.set(s.sizePx, s);
    [...bySize.values()].sort((a, b) => b.sizePx - a.sizePx).slice(0, 3).forEach((s, i) => out.push({ ...s, name: i ? `${role}-${i + 1}` : role }));
  }
  return out.sort((a, b) => b.sizePx - a.sizePx);
};

export interface ExportOptions {
  /** Replace restricted typefaces with their open substitutes (default true). */
  readonly openFonts?: boolean;
}

export const toDesignTokens = (g: Genome, options: ExportOptions = {}): Record<string, unknown> => {
  const open = options.openFonts ?? true;
  const color: Record<string, unknown> = {};
  for (const t of g.color.tokens) color[t.name] = { $type: "color", $value: t.hex, $description: `${t.usages.join(", ")}; share ${t.share}; ${t.support.status}`, $extensions: { "design-genome": { oklch: t.oklch, confidence: t.support.confidence, declaredAs: t.declaredAs } } };
  const typography: Record<string, unknown> = {};
  for (const s of ramp(g)) {
    typography[s.name] = {
      $type: "typography",
      $value: { fontFamily: familyFor(g, s.family, open), fontSize: `${s.sizePx}px`, fontWeight: s.weight ?? 400, letterSpacing: `${s.trackingEm ?? 0}em`, lineHeight: s.lineHeight ?? 1.2 },
      $extensions: { "design-genome": { status: s.support.status, confidence: s.support.confidence } },
    };
  }
  const dimension = (prefix: string, items: readonly { value: number; name?: string }[]) =>
    Object.fromEntries(items.map((t, i) => [t.name ?? `${prefix}-${i + 1}`, { $type: "dimension", $value: t.value >= 9999 ? "9999px" : `${t.value}px` }]));
  return {
    $description: `Design genome "${g.name}", built ${g.builtAt} from ${g.sources.length} source(s).`,
    color,
    typography,
    spacing: dimension("space", g.spacing.scale),
    radius: dimension("radius", g.radius),
    duration: Object.fromEntries(g.motion.durations.map((d, i) => [`duration-${i + 1}`, { $type: "duration", $value: `${d.value}ms` }])),
    easing: Object.fromEntries(g.motion.easings.filter((e) => e.easing.startsWith("cubic-bezier")).map((e, i) => [`easing-${i + 1}`, { $type: "cubicBezier", $value: e.easing.match(/[-\d.]+/g)!.map(Number) }])),
  };
};

export const toCss = (g: Genome, options: ExportOptions = {}): string => {
  const open = options.openFonts ?? true;
  const lines = [`/* Design genome "${g.name}" — generated ${g.builtAt}. Values are measured; see genome.json for evidence. */`, ":root {"];
  for (const t of g.color.tokens) lines.push(`  --color-${cssName(t.name)}: ${t.hex};`);
  for (const s of ramp(g)) {
    const r = cssName(s.name);
    lines.push(`  --font-${r}-family: "${familyFor(g, s.family, open)}", system-ui, sans-serif;`, `  --font-${r}-size: ${s.sizePx}px;`, `  --font-${r}-weight: ${s.weight ?? 400};`, `  --font-${r}-tracking: ${s.trackingEm ?? 0}em;`, `  --font-${r}-leading: ${s.lineHeight ?? 1.2};`);
  }
  g.spacing.scale.forEach((t, i) => lines.push(`  --space-${i + 1}: ${t.value}px;`));
  if (g.spacing.grid) lines.push(`  --grid-unit: ${g.spacing.grid.unit}px;`);
  g.radius.forEach((t, i) => lines.push(`  --radius-${t.name ?? i + 1}: ${t.value >= 9999 ? "9999px" : `${t.value}px`};`));
  g.motion.durations.forEach((t, i) => lines.push(`  --duration-${i + 1}: ${t.value}ms;`));
  g.motion.easings.forEach((e, i) => lines.push(`  --easing-${i + 1}: ${e.easing};`));
  lines.push("}");
  for (const s of ramp(g)) {
    const r = cssName(s.name);
    lines.push(`.text-${r} { font-family: var(--font-${r}-family); font-size: var(--font-${r}-size); font-weight: var(--font-${r}-weight); letter-spacing: var(--font-${r}-tracking); line-height: var(--font-${r}-leading); }`);
  }
  return `${lines.join("\n")}\n`;
};

export const toTailwind = (g: Genome, options: ExportOptions = {}): string => {
  const open = options.openFonts ?? true;
  const theme = {
    colors: Object.fromEntries(g.color.tokens.map((t) => [cssName(t.name), t.hex])),
    fontFamily: Object.fromEntries(g.typography.families.slice(0, 3).map((f) => [cssName(f.family), [open && f.reuse === "restricted" && f.substitute ? f.substitute : f.family, "system-ui", "sans-serif"]])),
    fontSize: Object.fromEntries(ramp(g).map((s) => [cssName(s.name), [`${s.sizePx}px`, { lineHeight: String(s.lineHeight ?? 1.2), letterSpacing: `${s.trackingEm ?? 0}em`, fontWeight: String(s.weight ?? 400) }]])),
    spacing: Object.fromEntries(g.spacing.scale.map((t) => [String(t.value), `${t.value}px`])),
    borderRadius: Object.fromEntries(g.radius.map((t, i) => [t.name ?? `r${i + 1}`, t.value >= 9999 ? "9999px" : `${t.value}px`])),
    transitionDuration: Object.fromEntries(g.motion.durations.map((d) => [String(d.value), `${d.value}ms`])),
    transitionTimingFunction: Object.fromEntries(g.motion.easings.map((e, i) => [`genome-${i + 1}`, e.easing])),
  };
  return `// Tailwind preset generated from design genome "${g.name}" (${g.builtAt}).\n/** @type {import('tailwindcss').Config} */\nexport default { theme: { extend: ${JSON.stringify(theme, null, 2)} } };\n`;
};

/** A prompt fragment for image and video models, built only from measured and cited facts. */
export const toImageDirection = (g: Genome): string => {
  const parts: string[] = [];
  const label = (metric: string) => g.imagery.find((m) => m.metric === metric && m.spread !== undefined)?.label;
  for (const m of ["lightness", "contrast", "chroma", "warmth", "negativeSpace", "focusX", "symmetry"]) {
    const l = label(m);
    if (l) parts.push(l);
  }
  const canvas = g.color.tokens.filter((t) => isNeutral(t.oklch)).slice(0, 3).map((t) => t.hex);
  const accents = g.color.tokens.filter((t) => !isNeutral(t.oklch)).slice(0, 2).map((t) => t.hex);
  if (canvas.length) parts.push(`neutral palette ${canvas.join(", ")}`);
  if (accents.length) parts.push(`accent color ${accents.join(", ")} used sparingly`);
  const visual = g.rules.filter((r) => ["imagery", "lighting", "camera", "composition"].includes(r.topic) && r.origin !== "derived" && r.support.status !== "conflicted");
  const named = g.imagery.filter((m) => m.label && m.spread === undefined && m.value >= 0.5).map((m) => `${m.metric}: ${m.label}`);
  const lines = [`Visual direction: ${parts.join(", ")}.`];
  if (named.length) lines.push(`Shot language: ${named.join("; ")}.`);
  if (visual.length) lines.push(...visual.slice(0, 8).map((r) => `- ${r.statement}`));
  if (g.motion.editing) lines.push(`Editing: ${g.motion.editing.description}`);
  if (g.motion.intensity) lines.push(`Motion: ${g.motion.intensity.description}`);
  const concept = g.anatomy?.concept;
  const visualInv = (g.anatomy?.invariants.visual ?? []).filter((i) => i.constant && ["margin-short-side", "whitespace", "focal-x", "focal-y", "image-share"].includes(i.feature));
  if (visualInv.length) lines.push(`Composition: ${visualInv.map((i) => `${i.description} ${Math.round(i.median * 100)}%`).join("; ")}.`);
  if (concept) {
    lines.push(`Concept: ${concept.bigIdea} — ${concept.concept}`);
    if (concept.signatureMoves.length) lines.push(`Signature moves: ${concept.signatureMoves.join("; ")}.`);
    if (concept.avoid.length) lines.push(`Avoid: ${concept.avoid.join("; ")}.`);
  }
  return lines.join("\n");
};

export const toBrief = (g: Genome, options: ExportOptions = {}): string => {
  const open = options.openFonts ?? true;
  const out: string[] = [];
  const kinds = [...new Set(g.sources.map((s) => s.kind))].join(", ");
  out.push(`# ${g.name} — design genome brief`, "");
  out.push(`Built ${g.builtAt.slice(0, 10)} from ${g.sources.length} source(s) (${kinds}). Every value below was measured or stated by a source; nothing is guessed.`);
  out.push(`Legend: ● confirmed by 2+ sources · ◐ one source · ○ stated by the brand, not seen in practice · ⚠ sources disagree. Percent = confidence.`, "");
  out.push(...briefAnatomy(g));

  const ordered = [...g.rules].sort((a, b) => b.support.confidence - a.support.confidence);
  out.push("## Rules", "");
  for (const r of ordered.filter((r) => r.support.status !== "conflicted")) out.push(`- ${mark(r.support)} **${r.polarity}** · ${r.topic}: ${r.statement}`);
  out.push("");

  out.push("## Color", "", "| token | hex | used for | share | support |", "|---|---|---|---|---|");
  for (const t of g.color.tokens.slice(0, 24)) out.push(`| ${t.name}${t.declaredAs ? ` (${t.declaredAs})` : ""} | ${t.hex} | ${t.usages.join(", ") || "—"} | ${(t.share * 100).toFixed(1)}% | ${mark(t.support)} |`);
  out.push("");

  out.push("## Typography", "");
  for (const f of g.typography.families) {
    out.push(`- ${f.family}: ${Math.round(f.share * 100)}% of text, roles ${f.roles.join(", ") || "—"} · ${mark(f.support)}${f.reuse === "restricted" ? ` · RESTRICTED: ${f.reuseNote ?? ""} Use **${f.substitute ?? "a licensed equivalent"}**${open ? " (exports already substitute it)" : ""}.` : f.reuse === "unknown" ? " · license unknown" : ""}`);
  }
  out.push("", "| style | size | weight | line-height | tracking |", "|---|---|---|---|---|");
  for (const s of ramp(g)) out.push(`| ${s.name} | ${s.sizePx}px | ${s.weight ?? "—"} | ${s.lineHeight ?? "—"} | ${s.trackingEm ?? 0}em |`);
  const mobileWidth = Math.min(...g.typography.styles.map((s) => s.viewport ?? Infinity));
  const mobile = Number.isFinite(mobileWidth) ? ramp(g, g.typography.styles.filter((s) => s.viewport === mobileWidth)) : [];
  if (mobile.length && mobileWidth !== Math.max(...g.typography.styles.map((s) => s.viewport ?? 0))) {
    out.push("", `At ${mobileWidth}px: ${mobile.map((s) => `${s.name} ${s.sizePx}px`).join(", ")}.`);
  }
  if (g.typography.scale) out.push("", g.typography.scale.description);
  if (g.typography.tracking) out.push(g.typography.tracking.description);
  out.push("");

  out.push("## Space, shape, motion", "");
  if (g.spacing.grid) out.push(`- Grid: ${g.spacing.grid.unit}px (${Math.round(g.spacing.grid.adherence * 100)}% adherence). Common steps: ${g.spacing.scale.map((t) => t.value).join(", ")}px.`);
  if (g.radius.length) out.push(`- Radii: ${g.radius.map((r) => (r.value >= 9999 ? "pill" : `${r.value}px`)).join(", ")}.`);
  if (g.shadow.length) out.push(`- Shadows: ${g.shadow.slice(0, 3).map((s) => s.css).join(" | ")}.`);
  if (g.motion.durations.length) out.push(`- Durations: ${g.motion.durations.map((d) => `${d.value}ms`).join(", ")}; easing ${g.motion.easings.map((e) => e.easing).slice(0, 3).join(", ")}.`);
  if (g.breakpoints.length) out.push(`- Breakpoints: ${g.breakpoints.map((b) => `${b.value}px`).join(", ")}.`);
  for (const l of g.layout.filter((l) => l.metric === "content-max-width")) out.push(`- ${l.description}`);
  out.push("");

  if (g.imagery.length || g.motion.editing) {
    out.push("## Imagery and film", "", toImageDirection(g), "");
  }
  if (g.voice.samples.length) {
    out.push("## Voice", "");
    if (g.voice.headlineWords) out.push(`Headlines: median ${g.voice.headlineWords.median} words, max ${g.voice.headlineWords.max}. Reference lines (do not copy; match the rhythm):`);
    for (const s of g.voice.samples.slice(0, 8)) out.push(`- "${s.text}" (${s.role})`);
    out.push("");
  }

  const openConflicts = g.conflicts.filter((c) => !c.resolution);
  if (openConflicts.length) {
    out.push("## Open conflicts — ask before relying on these", "");
    for (const c of openConflicts) out.push(`- ⚠ ${c.severity} · ${c.topic}: ${c.description}`);
    out.push("");
  }
  const resolved = g.conflicts.filter((c) => c.resolution);
  if (resolved.length) {
    out.push("## Decisions", "");
    for (const c of resolved) out.push(`- ${c.subject}: ${c.resolution!.choice}${c.resolution!.note ? ` — ${c.resolution!.note}` : ""}`);
    out.push("");
  }
  if (g.unknowns.length) {
    out.push("## Unknown — do not invent", "");
    for (const u of g.unknowns) out.push(`- ${u}`);
    out.push("");
  }
  out.push("Reuse: learn the system, do not copy it. Logos, wordmarks, icons, photography and restricted typefaces of the source brand are not part of this genome's output.");
  return `${out.join("\n")}\n`;
};

export const EXPORT_FORMATS = ["tokens", "css", "tailwind", "brief", "image-direction", "anatomy"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const exportGenome = (g: Genome, format: ExportFormat, options: ExportOptions = {}): { filename: string; content: string } => {
  switch (format) {
    case "tokens": return { filename: "tokens.json", content: `${JSON.stringify(toDesignTokens(g, options), null, 2)}\n` };
    case "css": return { filename: "genome.css", content: toCss(g, options) };
    case "tailwind": return { filename: "tailwind.genome.js", content: toTailwind(g, options) };
    case "brief": return { filename: "BRIEF.md", content: toBrief(g, options) };
    case "image-direction": return { filename: "image-direction.md", content: `${toImageDirection(g)}\n` };
    case "anatomy": return { filename: "ANATOMY.md", content: `${toAnatomy(g)}\n` };
  }
};
