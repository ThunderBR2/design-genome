import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Project } from "./core/project.js";
import { exportGenome, type ExportFormat } from "./export/index.js";
import { VISION_PROMPT } from "./extractors/vision.js";
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
    const pending = (await svc.visionPending()).length;
    return text({
      project: project.name,
      added: sources.length,
      ...(collected.length ? { collected } : {}),
      extracted: outcomes.filter((o) => o.status === "extracted").length,
      ...(failed.length ? { failed } : {}),
      ...(pending ? { next: `${pending} source(s) have images without a vision reading: call genome_vision_request.` } : {}),
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
