import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Project } from "./core/project.js";
import { exportGenome, type ExportFormat } from "./export/index.js";
import { VISION_PROMPT } from "./extractors/vision.js";
import { CONCEPT_PROMPT, DISSECT_PROMPT, anatomyText, legendText } from "./anatomy/reading.js";
import type { Facet, QueryOptions } from "./query.js";
import { GenomeService } from "./service.js";

/**
 * Tool logic, run in a fresh worker process per call (see mcp.ts). Because the
 * worker loads this file from disk every time, updates apply without
 * restarting Claude.
 */

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolResult { content: Content[]; isError?: boolean }
export interface ToolContext { readonly projectDir: string; readonly client: string; readonly log: (m: string) => void }

const run = promisify(execFile);
const text = (value: unknown): ToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

/** Projects live side by side: "<root>/<name>". A bare name picks one; a path is used as is. */
export const projectDirFor = (defaultDir: string, project?: string): string => {
  if (!project) return defaultDir;
  if (/[\\/]/.test(project) || /^[a-z]:/i.test(project)) return resolve(project);
  return join(dirname(resolve(defaultDir)), project);
};

type Args = Record<string, unknown>;
const svcFor = (ctx: ToolContext, args: Args) => new GenomeService(projectDirFor(ctx.projectDir, args.project as string | undefined), ctx.log);

interface SourceArg { uri: string; kind?: string; label?: string; depicts?: string; viewports?: number[]; dark?: boolean; maxItems?: number }

export const TOOLS: Record<string, (args: Args, ctx: ToolContext) => Promise<ToolResult>> = {
  async genome_brief(args, ctx) {
    return text(exportGenome(await svcFor(ctx, args).genome(), "brief", { openFonts: !args.originalFonts }).content);
  },

  async genome_query(args, ctx) {
    const { facet, project: _p, ...options } = args;
    return text(await svcFor(ctx, args).query(facet as Facet, options as QueryOptions));
  },

  async genome_add_sources(args, ctx) {
    const svc = svcFor(ctx, args);
    const list: SourceArg[] = [
      ...((args.sources as SourceArg[] | undefined) ?? []),
      ...((args.links as string[] | undefined) ?? []).map((uri) => ({ uri })),
    ];
    if (!list.length) throw new Error("Pass at least one link, file or folder in sources or links.");
    const inputs = list.map((s) => ({
      uri: s.uri.trim(),
      ...(s.kind ? { kind: s.kind as never } : {}),
      ...(s.label ? { label: s.label } : {}),
      ...(s.depicts ? { depicts: s.depicts } : {}),
      options: { ...(s.viewports ? { viewports: s.viewports } : {}), ...(s.dark ? { colorScheme: "dark" } : {}), ...(s.maxItems ? { maxItems: s.maxItems } : {}) },
    }));
    if (args.extract === false) return text(await svc.add(inputs));
    const { sources, outcomes, genome } = await svc.ingest(inputs, { vision: Boolean(args.vision) });
    const project = await svc.project();
    const collected = sources
      .filter((s) => s.kind === "collection")
      .map((s) => ({ collection: project.source(s.id).label ?? s.uri, items: project.sources.filter((c) => c.parent === s.id).length }));
    const failed = outcomes.filter((o) => o.status === "failed");
    const anatomy = (await svc.genome()).anatomy;
    const unread = anatomy?.pieces.filter((p) => !p.reading && !p.skipped && p.triage !== "skip").length ?? 0;
    const setAside = anatomy?.pieces.filter((p) => p.skipped || p.triage === "skip").length ?? 0;
    const pending = (await svc.visionPending()).length;
    return text({
      project: project.name,
      added: sources.length,
      ...(collected.length ? { collected } : {}),
      extracted: outcomes.filter((o) => o.status === "extracted").length,
      ...(failed.length ? { failed } : {}),
      ...(anatomy?.pieces.length ? { anatomy: { pieces: anatomy.pieces.length, unread, ...(setAside ? { setAsideByPreCheck: setAside } : {}) } } : {}),
      ...(unread ? { next: `${unread} piece(s) are measured but not dissected: call genome_dissect_request and read them one by one, then genome_concept_request.` } : pending ? { next: `${pending} source(s) have images without a vision reading: call genome_vision_request.` } : {}),
      genome: { colors: genome.color.tokens.length, typeStyles: genome.typography.styles.length, rules: genome.rules.length, openConflicts: genome.conflicts.filter((c) => !c.resolution).length },
    });
  },

  async genome_sources(args, ctx) {
    const project = await svcFor(ctx, args).project();
    const genome = await project.loadGenome();
    const byId = new Map(genome?.sources.map((s) => [s.id, s]) ?? []);
    return text(project.sources.map((s) => ({ id: s.id, kind: s.kind, label: s.label ?? s.uri, uri: s.uri, ...(s.parent ? { parent: s.parent } : {}), observations: byId.get(s.id)?.observations ?? 0, limitations: byId.get(s.id)?.limitations ?? [] })));
  },

  async genome_remove_source(args, ctx) {
    const svc = svcFor(ctx, args);
    for (const id of args.sourceIds as string[]) await svc.remove(id);
    const g = await svc.build();
    return text({ removed: (args.sourceIds as string[]).length, rules: g.rules.length });
  },

  async genome_rebuild(args, ctx) {
    const svc = svcFor(ctx, args);
    const ids = (args.sourceIds as string[] | undefined)?.length ? (args.sourceIds as string[]) : "all";
    const outcomes = await svc.extract(ids, { force: Boolean(args.force), vision: Boolean(args.vision) });
    await svc.measure(ids, Boolean(args.force));
    const g = await svc.build();
    return text({ outcomes: outcomes.filter((o) => o.status !== "cached"), rules: g.rules.length, openConflicts: g.conflicts.filter((c) => !c.resolution).length });
  },

  async genome_resolve_conflict(args, ctx) {
    await svcFor(ctx, args).resolve(args.conflictId as string, args.choice as string, args.note as string | undefined);
    return text(`Recorded: ${args.conflictId} → ${args.choice}`);
  },

  async genome_verify(args, ctx) {
    const report = await svcFor(ctx, args).verify(args.target as string, args.viewports as number[] | undefined);
    return text({ ...report, violations: report.violations.slice(0, (args.maxViolations as number | undefined) ?? 30), facets: Object.fromEntries(Object.entries(report.facets).map(([k, v]) => [k, { score: v.score, checked: v.checked, violations: v.violations.length }])) });
  },

  async genome_export(args, ctx) {
    return text(exportGenome(await svcFor(ctx, args).genome(), args.format as ExportFormat, { openFonts: !args.originalFonts }).content);
  },

  async genome_vision_request(args, ctx) {
    const req = await svcFor(ctx, args).visionRequest(args.sourceId as string | undefined, (args.maxWidth as number | undefined) ?? 1024);
    if (!req) return text("Every extracted image, video and page already has a vision reading. Add sources or pass a sourceId to read one again.");
    const header = `Source ${req.source.id} (${req.source.kind}: ${req.source.label ?? req.source.uri}). ${req.images.length} image(s) follow, numbered. ${req.remaining} other source(s) still need a reading.\n\n${VISION_PROMPT}\n\nSubmit with genome_vision_submit { sourceId: "${req.source.id}", rules, labels }. Cite image numbers in each item.`;
    const content: Content[] = [{ type: "text", text: header }];
    for (const img of req.images) {
      content.push({ type: "text", text: `Image ${img.n}` });
      content.push({ type: "image", data: img.jpeg.toString("base64"), mimeType: "image/jpeg" });
    }
    return { content };
  },

  async genome_vision_submit(args, ctx) {
    const svc = svcFor(ctx, args);
    const reader = `${ctx.client} (host model)`;
    const { observations, genome } = await svc.visionSubmit(args.sourceId as string, { rules: args.rules as never, labels: (args.labels as never) ?? [] }, reader);
    const pending = await svc.visionPending();
    const confirmed = genome.rules.filter((r) => r.origin === "inferred" && r.support.status === "confirmed").length;
    return text({ stored: observations, inferredRulesConfirmedAcrossSources: confirmed, remainingSources: pending.length, next: pending[0] ? { id: pending[0].id, label: pending[0].label ?? pending[0].uri } : null });
  },

  async genome_dissect_request(args, ctx) {
    const svc = svcFor(ctx, args);
    const req = await svc.dissectRequest(args.pieceId as string | undefined, (args.maxWidth as number | undefined) ?? 1280);
    if (!req) return text("Every readable piece already has a reading. Pass a pieceId to read one again, or call genome_concept_request to read the project as a whole.");
    const { piece } = req.images;
    const header = [
      `Dissect piece ${piece.id} (${req.total - req.remaining} of ${req.total} readable; ${req.remaining} more after this one).`,
      ...(req.setAside.length ? ["", `Set aside before reading (not worth dissecting): ${req.setAside.map((p) => `${p.id} — ${p.reason}`).join(" | ")}. Pass one as pieceId to look at it anyway.`] : []),
      "",
      DISSECT_PROMPT,
      "",
      legendText,
      "",
      "Measurements:",
      anatomyText(piece),
      "",
      `If it is worth reading, submit with genome_dissect_submit { pieceId: "${piece.id}", whatItIs, pieceType, summary, elements, grid, composition, whyItWorks, intent, typography, color, imagery, fragile, corrections, rules }. If not, call genome_dissect_skip { pieceId: "${piece.id}", reason }.`,
    ].join("\n");
    const content: Content[] = [
      { type: "text", text: header },
      { type: "text", text: "Image 1 — the piece" },
      { type: "image", data: req.images.original.toString("base64"), mimeType: "image/jpeg" },
      { type: "text", text: "Image 2 — measured anatomy" },
      { type: "image", data: req.images.overlay.toString("base64"), mimeType: "image/jpeg" },
    ];
    if (req.images.grid) content.push({ type: "text", text: "Image 3 — grid reading" }, { type: "image", data: req.images.grid.toString("base64"), mimeType: "image/jpeg" });
    return { content };
  },

  async genome_dissect_submit(args, ctx) {
    const svc = svcFor(ctx, args);
    const { pieceId, project: _p, ...reading } = args;
    const { piece, rules, remaining, genome } = await svc.dissectSubmit(pieceId as string, reading as never, `${ctx.client} (host model)`);
    const confirmed = genome.rules.filter((r) => r.origin === "inferred" && r.support.status === "confirmed").length;
    const next = genome.anatomy?.pieces.find((p) => !p.reading && !p.skipped && p.triage !== "skip");
    return text({ stored: piece.id, elements: piece.reading?.elements.length ?? 0, rules, inferredRulesConfirmedAcrossSources: confirmed, remainingPieces: remaining, next: next ? { pieceId: next.id, label: next.label } : "All readable pieces read: call genome_concept_request to read the project as a whole." });
  },

  async genome_dissect_skip(args, ctx) {
    const svc = svcFor(ctx, args);
    const { piece, remaining, genome } = await svc.dissectSkip(args.pieceId as string, args.reason as string, `${ctx.client} (host model)`);
    const next = genome.anatomy?.pieces.find((p) => !p.reading && !p.skipped && p.triage !== "skip");
    return text({ setAside: piece.id, reason: piece.skipped?.reason, remainingPieces: remaining, next: next ? { pieceId: next.id, label: next.label } : "All readable pieces read: call genome_concept_request to read the project as a whole." });
  },

  async genome_concept_request(args, ctx) {
    const svc = svcFor(ctx, args);
    const { anatomy, sheet, genome } = await svc.conceptRequest();
    const lines: string[] = [CONCEPT_PROMPT, "", `Pieces (${anatomy.pieces.length}; numbers match the contact sheet):`];
    anatomy.pieces.slice(0, 24).forEach((p, i) => {
      const r = p.reading;
      lines.push(`${i + 1}. ${p.id} — ${p.label} · ${p.anatomy.canvas.w}×${p.anatomy.canvas.h} (${p.anatomy.canvas.aspectName})`);
      if (r) {
        lines.push(`   ${r.pieceType}: ${r.summary}`, `   structure: ${r.composition.structure}; eye path: ${r.composition.eyePath}`);
        if (r.whyItWorks.length) lines.push(`   works because: ${r.whyItWorks.slice(0, 3).join(" / ")}`);
        lines.push(`   intent: ${r.intent.message}${r.intent.emotion ? ` (${r.intent.emotion})` : ""}`);
      } else lines.push(`   not read yet; measured: ${p.anatomy.summary.slice(1, 4).join(" ")}`);
    });
    if (anatomy.pieces.length > 24) lines.push(`… and ${anatomy.pieces.length - 24} more.`);
    const unread = anatomy.pieces.filter((p) => !p.reading).length;
    if (unread) lines.push("", `Note: ${unread} piece(s) are not dissected yet; the concept will be stronger after genome_dissect_request on them.`);
    for (const [group, inv] of Object.entries(anatomy.invariants)) {
      lines.push("", `Measured invariants (${group === "web" ? "page sections" : "images and shots"}):`);
      for (const i of inv) lines.push(`- ${i.constant ? "CONSTANT" : "varies"} · ${i.description}: ${i.median}${i.spread ? ` ±${i.spread}` : ""} ${i.unit} over ${i.pieces} pieces`);
    }
    if (genome) {
      lines.push("", "Genome highlights:", `- Palette: ${genome.color.tokens.slice(0, 8).map((t) => `${t.name} ${t.hex} ${Math.round(t.share * 100)}%`).join(", ")}`, `- Type: ${genome.typography.families.map((f) => f.family).join(", ") || "unknown"}`);
      for (const r of [...genome.rules].sort((a, b) => b.support.confidence - a.support.confidence).slice(0, 10)) lines.push(`- [${r.support.status}] ${r.statement}`);
    }
    lines.push("", "Submit with genome_concept_submit { bigIdea, concept, why, audience, personality, narrative, metaphors, constants, variables, grammar, signatureMoves, adaptation, avoid }.");
    return { content: [{ type: "text", text: lines.join("\n") }, { type: "text", text: "Contact sheet" }, { type: "image", data: sheet.toString("base64"), mimeType: "image/jpeg" }] };
  },

  async genome_concept_submit(args, ctx) {
    const svc = svcFor(ctx, args);
    const { project: _p, ...input } = args;
    const { concept } = await svc.conceptSubmit(input as never, `${ctx.client} (host model)`);
    return text({ stored: true, bigIdea: concept.bigIdea, constants: concept.constants.length, variables: concept.variables.length, grammarSteps: concept.grammar.length, next: "Use genome_blueprint to plan a new piece, or genome_brief to see the concept in the brief." });
  },

  async genome_blueprint(args, ctx) {
    const svc = svcFor(ctx, args);
    const bp = await svc.blueprint({
      request: String(args.request ?? ""),
      ...(args.format ? { format: args.format as string } : {}),
      ...(args.width ? { width: args.width as number } : {}),
      ...(args.height ? { height: args.height as number } : {}),
      ...(args.pieceType ? { pieceType: args.pieceType as string } : {}),
      ...(args.references ? { references: args.references as string[] } : {}),
    });
    const project = await svc.project();
    const content: Content[] = [{ type: "text", text: bp.markdown }];
    const sharp = (await import("sharp")).default;
    if (bp.wireframe) {
      content.push({ type: "text", text: `Wireframe of the adapted layout (${bp.canvas.w}×${bp.canvas.h}px), saved at ${bp.wireframe}` });
      content.push({ type: "image", data: (await sharp(join(project.root, bp.wireframe)).jpeg({ quality: 80 }).toBuffer()).toString("base64"), mimeType: "image/jpeg" });
    }
    for (const ref of bp.references.slice(0, 2)) {
      content.push({ type: "text", text: `Reference ${ref.id} with its anatomy` });
      content.push({ type: "image", data: (await sharp(join(project.root, ref.overlay)).resize({ width: 900, height: 900, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 76 }).toBuffer()).toString("base64"), mimeType: "image/jpeg" });
    }
    return { content };
  },

  async genome_projects(args, ctx) {
    const root = dirname(resolve(ctx.projectDir));
    if (args.create) {
      const name = String(args.create);
      const p = await Project.create(join(root, name), name);
      return text({ created: p.name, dir: p.root });
    }
    const out: { name: string; dir: string; sources: number; default: boolean }[] = [];
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const p = await Project.tryOpen(join(root, entry.name)).catch(() => null);
      if (p) out.push({ name: entry.name, dir: p.root, sources: p.sources.length, default: resolve(p.root) === resolve(ctx.projectDir) });
    }
    return text({ root, projects: out, usage: 'Pass project: "<name>" to any tool to work on that project.' });
  },

  async genome_update(_args, ctx) {
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const tmp = await mkdtemp(join(tmpdir(), "genome-update-"));
    const win = process.platform === "win32";
    try {
      ctx.log("update: downloading the latest version");
      const res = await fetch("https://github.com/ThunderBR2/design-genome/archive/refs/heads/main.zip");
      if (!res.ok) throw new Error(`GitHub download failed (${res.status})`);
      const zip = join(tmp, "src.zip");
      await writeFile(zip, Buffer.from(await res.arrayBuffer()));
      await run("tar", ["-xf", zip, "-C", tmp]);
      const folder = (await readdir(tmp, { withFileTypes: true })).find((d) => d.isDirectory())!;
      const src = join(tmp, folder.name);
      for (const entry of await readdir(src)) {
        if (entry === "node_modules") continue;
        await cp(join(src, entry), join(appRoot, entry), { recursive: true, force: true });
      }
      ctx.log("update: installing dependencies");
      const npm = win ? "npm.cmd" : "npm";
      await run(npm, ["install", "--no-audit", "--no-fund"], { cwd: appRoot, shell: win, maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000 });
      ctx.log("update: compiling");
      await run(npm, ["run", "build"], { cwd: appRoot, shell: win, maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000 });
      const pkg = JSON.parse(await (await import("node:fs/promises")).readFile(join(appRoot, "package.json"), "utf8")) as { version: string };
      return text({ updated: true, version: pkg.version, appRoot: basename(appRoot), note: "New tool logic is live now. New tools or changed tool parameters appear after Claude restarts." });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
};

/** Worker entry: read {tool, args, projectDir, client} from stdin, write a ToolResult to stdout. */
export const runWorker = async (): Promise<void> => {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const req = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tool: string; args: Args; projectDir: string; client: string };
  const ctx: ToolContext = { projectDir: req.projectDir, client: req.client, log: (m) => process.stderr.write(`[genome] ${m}\n`) };
  let result: ToolResult;
  try {
    const handler = TOOLS[req.tool];
    if (!handler) throw new Error(`Unknown tool ${req.tool}`);
    result = await handler(req.args ?? {}, ctx);
  } catch (error) {
    result = { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  }
  process.stdout.write(JSON.stringify(result));
};
