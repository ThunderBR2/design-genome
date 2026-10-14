import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { SOURCE_KINDS } from "./core/model.js";
import { EXPORT_FORMATS, exportGenome } from "./export/index.js";
import { FACETS } from "./query.js";
import { GenomeService } from "./service.js";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
const fail = (error: unknown) => ({ isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] });

const INSTRUCTIONS = `Design Genome: a cross-checked, evidence-backed model of a visual system built from sites, documents, images, videos and Figma files.
Start with genome_brief (compact, everything an agent needs to design in the system) or genome_query facet "overview".
Every fact carries support: confirmed (2+ sources agree), single-source, declared-only (the brand says it, not seen in practice) or conflicted.
Prefer confirmed facts; ask the user about open conflicts instead of picking a side; never invent values listed as unknown.
After you produce a design, call genome_verify on it and fix the reported deviations.
Restricted typefaces, logos, icons and photography of the source brand must not be copied into deliverables; use the substitutes given.`;

export const createMcpServer = (projectDir: string): McpServer => {
  const svc = new GenomeService(projectDir, (m) => process.stderr.write(`[genome] ${m}\n`));
  const server = new McpServer({ name: "design-genome", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "genome_brief",
    { title: "Design brief", description: "The genome as a compact markdown brief: rules ranked by confidence, palette, type ramp, space/shape/motion, imagery direction, voice, open conflicts and unknowns.", inputSchema: { originalFonts: z.boolean().optional().describe("keep restricted typefaces instead of open substitutes") }, annotations: { readOnlyHint: true } },
    async ({ originalFonts }) => {
      try {
        return text(exportGenome(await svc.genome(), "brief", { openFonts: !originalFonts }).content);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "genome_query",
    {
      title: "Query the genome",
      description: "Return one facet of the genome as JSON. Summary detail keeps one evidence reference per fact; full detail returns all evidence.",
      inputSchema: {
        facet: z.enum(FACETS),
        detail: z.enum(["summary", "full"]).optional(),
        role: z.string().optional().describe("typography role: display, headline, title, body, callout, caption, button, link"),
        viewport: z.number().optional(),
        topic: z.string().optional().describe("rules topic: color, typography, spacing, shape, motion, imagery, voice, logo, ..."),
        status: z.enum(["confirmed", "single-source", "declared-only", "conflicted"]).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ facet, ...options }) => {
      try {
        return text(await svc.query(facet, options));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "genome_add_sources",
    {
      title: "Add and ingest sources",
      description: "Add URLs (sites, Figma files, remote media) or local file paths (images, videos, PDFs, markdown), extract them and rebuild the genome. Set extract=false to only register them.",
      inputSchema: {
        sources: z.array(z.object({
          uri: z.string(),
          kind: z.enum(SOURCE_KINDS).optional(),
          label: z.string().optional(),
          depicts: z.string().optional().describe("source id this image/video shows, for calibration"),
          viewports: z.array(z.number()).optional(),
          dark: z.boolean().optional(),
        })).min(1),
        extract: z.boolean().optional(),
        vision: z.boolean().optional().describe("also run the vision extractor (needs ANTHROPIC_API_KEY)"),
      },
    },
    async ({ sources, extract, vision }) => {
      try {
        const inputs = sources.map((s) => ({ uri: s.uri, kind: s.kind, label: s.label, depicts: s.depicts, options: { ...(s.viewports ? { viewports: s.viewports } : {}), ...(s.dark ? { colorScheme: "dark" } : {}) } }));
        if (extract === false) return text(await svc.add(inputs));
        const { sources: added, outcomes, genome } = await svc.ingest(inputs, { vision });
        return text({ sources: added.map((s) => ({ id: s.id, kind: s.kind, uri: s.uri })), outcomes, genome: { colors: genome.color.tokens.length, typeStyles: genome.typography.styles.length, rules: genome.rules.length, openConflicts: genome.conflicts.filter((c) => !c.resolution).length } });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "genome_sources",
    { title: "List sources", description: "Sources in the project with their extraction coverage and limitations.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => {
      try {
        const project = await svc.project();
        const genome = await project.loadGenome();
        return text(genome?.sources ?? project.sources);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "genome_rebuild",
    { title: "Re-extract and rebuild", description: "Re-run extractors (all or some sources) and rebuild the genome.", inputSchema: { sourceIds: z.array(z.string()).optional(), force: z.boolean().optional(), vision: z.boolean().optional() } },
    async ({ sourceIds, force, vision }) => {
      try {
        const outcomes = await svc.extract(sourceIds?.length ? sourceIds : "all", { force, vision });
        const g = await svc.build();
        return text({ outcomes, rules: g.rules.length, openConflicts: g.conflicts.filter((c) => !c.resolution).length });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "genome_resolve_conflict",
    { title: "Record a conflict decision", description: "Store the user's decision for a conflict (only with the user's explicit choice) and rebuild.", inputSchema: { conflictId: z.string(), choice: z.string(), note: z.string().optional() } },
    async ({ conflictId, choice, note }) => {
      try {
        await svc.resolve(conflictId, choice, note);
        return text(`Recorded: ${conflictId} → ${choice}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "genome_verify",
    { title: "Verify a design", description: "Measure a URL, local HTML file or image with the same extractors and score it against the genome. Returns per-facet scores and every deviation with the nearest valid value.", inputSchema: { target: z.string(), viewports: z.array(z.number()).optional(), maxViolations: z.number().optional() }, annotations: { readOnlyHint: true } },
    async ({ target, viewports, maxViolations }) => {
      try {
        const report = await svc.verify(target, viewports);
        return text({ ...report, violations: report.violations.slice(0, maxViolations ?? 30), facets: Object.fromEntries(Object.entries(report.facets).map(([k, v]) => [k, { score: v.score, checked: v.checked, violations: v.violations.length }])) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "genome_export",
    { title: "Export", description: "Return one export as text: tokens (W3C design tokens JSON), css, tailwind, brief, image-direction.", inputSchema: { format: z.enum(EXPORT_FORMATS), originalFonts: z.boolean().optional() }, annotations: { readOnlyHint: true } },
    async ({ format, originalFonts }) => {
      try {
        return text(exportGenome(await svc.genome(), format, { openFonts: !originalFonts }).content);
      } catch (e) {
        return fail(e);
      }
    },
  );
  return server;
};

export const startMcpServer = async (projectDir: string): Promise<void> => {
  const server = createMcpServer(projectDir);
  await server.connect(new StdioServerTransport());
};
