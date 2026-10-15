import type { Genome } from "../core/genome.js";
import type { Invariant } from "../anatomy/types.js";

const pct = (n: number): string => `${Math.round(n * 1000) / 10}%`;

export const invariantLine = (i: Invariant): string => {
  const value = i.description.includes(":") ? `${pct(i.median)} of pieces` : i.unit === "share" ? pct(i.median) : `${i.median}${i.unit === "×" ? "×" : ""}`;
  const spread = i.spread ? ` (±${i.unit === "share" && !i.description.includes(":") ? pct(i.spread) : i.spread})` : "";
  return `${i.description} — ${value}${spread}`;
};

/** The concept and the constants, for the top of the brief. Empty when nothing was dissected. */
export const briefAnatomy = (g: Genome): string[] => {
  const a = g.anatomy;
  if (!a || !a.pieces.length) return [];
  const out: string[] = [];
  const read = a.pieces.filter((p) => p.reading).length;
  if (a.concept) {
    const c = a.concept;
    out.push("## Concept", "", `- **Big idea:** ${c.bigIdea}`, `- **Concept:** ${c.concept}`, `- **Why it is this way:** ${c.why}`);
    if (c.personality.length) out.push(`- **Personality:** ${c.personality.join(", ")}`);
    if (c.constants.length) out.push(`- **Constants:** ${c.constants.map((k) => k.what).join("; ")}`);
    if (c.variables.length) out.push(`- **Variables:** ${c.variables.map((v) => `${v.what} (${v.range})`).join("; ")}`);
    if (c.grammar.length) out.push(`- **Grammar:** ${c.grammar.map((x, i) => `${i + 1}. ${x.replace(/^\d+[.)]\s*/, "")}`).join(" ")}`);
    if (c.signatureMoves.length) out.push(`- **Signature moves:** ${c.signatureMoves.join("; ")}`);
    if (c.adaptation.length) out.push(`- **Adapting:** ${c.adaptation.join("; ")}`);
    if (c.avoid.length) out.push(`- **Avoid:** ${c.avoid.join("; ")}`);
    out.push("");
  }
  const groups = Object.entries(a.invariants);
  if (groups.length) {
    out.push("## Composition constants (measured across pieces)", "");
    for (const [group, inv] of groups) {
      const constant = inv.filter((i) => i.constant);
      const varying = inv.filter((i) => !i.constant && i.unit !== "count");
      if (constant.length) out.push(`- ${group === "web" ? "Page sections" : "Images and shots"} keep: ${constant.map(invariantLine).join("; ")}.`);
      if (varying.length) out.push(`- ${group === "web" ? "Page sections" : "Images and shots"} vary: ${varying.map(invariantLine).join("; ")}.`);
    }
    out.push("");
  }
  out.push(`Anatomy: ${a.pieces.length} piece(s) measured, ${read} read. Use genome_blueprint to plan a new piece from them, and genome_export "anatomy" for the full dissection.`, "");
  return out;
};

/** Every piece, its measurements and its reading, then the concept: the full dissection. */
export const toAnatomy = (g: Genome): string => {
  const a = g.anatomy;
  const out: string[] = [`# ${g.name} — anatomy`, ""];
  if (!a || !a.pieces.length) return [...out, "No pieces measured yet. Add images, videos or sites, then call genome_dissect_request."].join("\n");
  out.push(...briefAnatomy(g));
  if (a.concept) {
    const c = a.concept;
    out.push("## The project in depth", "");
    if (c.audience) out.push(`- Audience: ${c.audience}`);
    if (c.narrative) out.push(`- Narrative: ${c.narrative}`);
    if (c.metaphors.length) out.push(`- Visual devices: ${c.metaphors.join("; ")}`);
    if (c.constants.length) out.push("", "Constants and why:", ...c.constants.map((k) => `- ${k.what} — ${k.why}`));
    if (c.variables.length) out.push("", "Variables and why:", ...c.variables.map((v) => `- ${v.what}: ${v.range}${v.why ? ` — ${v.why}` : ""}`));
    out.push("");
  }
  for (const p of a.pieces) {
    out.push(`## ${p.label}`, "", `\`${p.id}\` · ${p.kind} · ${p.canvas.w}×${p.canvas.h}px (${p.canvas.aspectName}) · measurements ${p.precision} · overlay \`${p.overlay}\``, "");
    out.push("### Measured", ...p.measured.map((m) => `- ${m}`), "");
    const r = p.reading;
    if (!r) { out.push("_Not read yet._", ""); continue; }
    out.push(`### Read (${r.pieceType})`, "", r.summary, "");
    if (r.elements.length) {
      out.push("| # | Role | Content | Treatment | Why |", "|---|---|---|---|---|");
      for (const e of r.elements) out.push(`| ${e.block ?? "+"} | ${e.role} | ${(e.content ?? "").replace(/\|/g, "/")} | ${(e.treatment ?? "").replace(/\|/g, "/")} | ${e.why.replace(/\|/g, "/")} |`);
      out.push("");
    }
    out.push(`- Structure: ${r.composition.structure}`, `- Eye path: ${r.composition.eyePath}`);
    if (r.composition.balance) out.push(`- Balance: ${r.composition.balance}`);
    for (const pr of r.composition.principles) out.push(`- ${pr.name}: ${pr.how} — ${pr.why}`);
    if (r.whyItWorks.length) out.push("", "Why it works:", ...r.whyItWorks.map((w) => `- ${w}`));
    out.push("", `Intent: ${r.intent.message}${r.intent.audience ? ` · audience: ${r.intent.audience}` : ""}${r.intent.emotion ? ` · emotion: ${r.intent.emotion}` : ""}${r.intent.action ? ` · action: ${r.intent.action}` : ""}`);
    if (r.typography) out.push(`- Typography: ${r.typography}`);
    if (r.color) out.push(`- Color: ${r.color}`);
    if (r.imagery) out.push(`- Imagery: ${r.imagery}`);
    if (r.fragile.length) out.push("", "Fragile:", ...r.fragile.map((f) => `- ${f}`));
    if (r.corrections.length) out.push("", "Corrections to the measurement:", ...r.corrections.map((f) => `- ${f}`));
    out.push("");
  }
  return out.join("\n");
};
