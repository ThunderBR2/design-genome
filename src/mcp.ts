import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { SOURCE_KINDS } from "./core/model.js";
import { VISION_PROMPT } from "./extractors/vision.js";
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
To name art direction (lighting, camera, framing, typographic treatment) in images, video frames and page captures, you are the vision model: call genome_vision_request, look at the images it returns, then call genome_vision_submit with what you see. Repeat while it reports remaining sources. No API key is needed.
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
        vision: z.boolean().optional().describe("headless vision via ANTHROPIC_API_KEY; without a key, use genome_vision_request/submit instead"),
      },
    },
    async ({ sources, extract, vision }) => {
      try {
        const inputs = sources.map((s) => ({ uri: s.uri, kind: s.kind, label: s.label, depicts: s.depicts, options: { ...(s.viewports ? { viewports: s.viewports } : {}), ...(s.dark ? { colorScheme: "dark" } : {}) } }));
        if (extract === false) return text(await svc.add(inputs));
        const { sources: added, outcomes, genome } = await svc.ingest(inputs, { vision });
        const visionPending = (await svc.visionPending()).length;
        return text({ sources: added.map((s) => ({ id: s.id, kind: s.kind, uri: s.uri })), outcomes, ...(visionPending ? { next: `${visionPending} source(s) have images without a vision reading: call genome_vision_request.` } : {}), genome: { colors: genome.color.tokens.length, typeStyles: genome.typography.styles.length, rules: genome.rules.length, openConflicts: genome.conflicts.filter((c) => !c.resolution).length } });
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

  server.registerTool(
    "genome_vision_request",
    {
      title: "Get images for the vision pass",
      description: "Returns up to eight evidence images (photos, video frames, page captures) of one source for you to read as an art director. Defaults to the next source that has no vision reading yet. Look at them, then call genome_vision_submit with sourceId and your rules and labels. Uses this conversation's model: no API key.",
      inputSchema: { sourceId: z.string().optional(), maxWidth: z.number().min(256).max(1600).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ sourceId, maxWidth }) => {
      try {
        const req = await svc.visionRequest(sourceId, maxWidth ?? 1024);
        if (!req) return text("Every extracted image, video and page already has a vision reading. Add sources or pass a sourceId to read one again.");
        const header = `Source ${req.source.id} (${req.source.kind}: ${req.source.label ?? req.source.uri}). ${req.images.length} image(s) follow, numbered. ${req.remaining} other source(s) still need a reading.\n\n${VISION_PROMPT}\n\nSubmit with genome_vision_submit { sourceId: "${req.source.id}", rules, labels }. Cite image numbers in each item.`;
        const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: header }];
        for (const img of req.images) {
          content.push({ type: "text", text: `Image ${img.n}` });
          content.push({ type: "image", data: img.jpeg.toString("base64"), mimeType: "image/jpeg" });
        }
        return { content };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "genome_vision_submit",
    {
      title: "Store vision readings",
      description: "Stores your art-direction readings of the images from genome_vision_request as inferred observations (citing the image numbers), replaces any earlier reading of that source, and rebuilds the genome. Rules agreed by other sources become confirmed.",
      inputSchema: {
        sourceId: z.string(),
        rules: z.array(z.object({
          topic: z.enum(["imagery", "composition", "lighting", "camera", "typography", "layout", "color", "voice", "iconography", "motion"]),
          statement: z.string().min(8).describe("one precise, reusable rule"),
          polarity: z.enum(["must", "never", "should", "avoid", "fact"]),
          confidence: z.number().min(0).max(1),
          images: z.array(z.number().int().positive()).min(1),
        })).max(24),
        labels: z.array(z.object({
          metric: z.enum(["camera-angle", "shot-size", "lighting", "background", "depth-of-field", "subject", "grade"]),
          label: z.string().min(1),
          confidence: z.number().min(0).max(1),
          images: z.array(z.number().int().positive()).min(1),
        })).max(16).optional(),
      },
    },
    async ({ sourceId, rules, labels }) => {
      try {
        const reader = `${server.server.getClientVersion()?.name ?? "MCP host"} (host model)`;
        const { observations, genome } = await svc.visionSubmit(sourceId, { rules, labels: labels ?? [] }, reader);
        const pending = await svc.visionPending();
        const confirmed = genome.rules.filter((r) => r.origin === "inferred" && r.support.status === "confirmed").length;
        return text({ stored: observations, reader, inferredRulesConfirmedAcrossSources: confirmed, remainingSources: pending.map((s) => ({ id: s.id, kind: s.kind, label: s.label ?? s.uri })) });
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerPrompt(
    "criar-marca-no-figma",
    {
      title: "Criar marca no Figma a partir do genoma",
      description: "Build a new brand system in Figma that follows the genome's structure (type ramp, spacing, shape, motion, imagery) with the brand's own name and identity.",
      argsSchema: {
        marca: z.string().describe("nome da nova marca"),
        descricao: z.string().optional().describe("o que é a marca, público, tom"),
        figma: z.string().optional().describe("link de um arquivo Figma existente; vazio para criar um novo"),
      },
    },
    ({ marca, descricao, figma }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            `Crie a marca "${marca}" no Figma usando o Design Genome como base.${descricao ? ` Sobre a marca: ${descricao}.` : ""}`,
            "1. Leia genome_brief. Se houver fontes com imagens sem leitura de visão, rode genome_vision_request/genome_vision_submit até acabar e leia o brief de novo.",
            "2. Liste os conflitos abertos e me pergunte antes de decidir qualquer um.",
            "3. Proponha a identidade: paleta própria da marca (siga a proporção de neutros e acentos do genoma, não copie cores de marcas de referência), tipografia aberta (use as substitutas indicadas), rampa de tamanhos, tracking, grid, raios e movimento do genoma. Mostre a proposta antes de construir.",
            `4. No Figma ${figma ? `(arquivo ${figma})` : "(crie um arquivo novo)"}: variáveis de cor e espaçamento, estilos de texto, componentes (botão, link, card, navegação) e uma página de exemplo (hero, grade de produtos, rodapé) com textos originais.`,
            "5. Verifique com genome_verify no link do frame da página de exemplo e corrija os desvios altos e médios. Me mostre a nota final e o que ficou fora de propósito.",
            "Não use logos, ícones, fotos ou textos das marcas de referência.",
          ].join("\n"),
        },
      }],
    }),
  );
  return server;
};

export const startMcpServer = async (projectDir: string): Promise<void> => {
  const server = createMcpServer(projectDir);
  await server.connect(new StdioServerTransport());
};
