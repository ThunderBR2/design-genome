import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { FORMATS } from "./anatomy/blueprint.js";
import { SOURCE_KINDS } from "./core/model.js";
import { EXPORT_FORMATS } from "./export/index.js";
import { FACETS } from "./query.js";
import type { ToolResult } from "./tools.js";

/**
 * Thin MCP server. It only declares tools; every call runs in a fresh worker
 * process that loads the tool logic from disk, so an update (genome_update, or
 * new files) takes effect on the next call without restarting Claude.
 */

const INSTRUCTIONS = `Design Genome: a cross-checked, evidence-backed model of a visual system built from sites, Behance projects, galleries, documents, images, videos and Figma files.
Users can give links directly: a site URL, a Behance project URL (every image, video and text in the project is downloaded), a Dribbble shot or any gallery page, a Figma link, a direct image/video/PDF URL, or a local file or folder path. Pass them to genome_add_sources; never ask the user to download files first.
Files the user attaches in chat are not on this computer: if you can, save them to a folder on the user's computer first and pass that folder.
Several brands can coexist: genome_projects lists or creates projects; pass project: "<name>" to any tool.
Start with genome_brief (compact, everything an agent needs to design in the system) or genome_query facet "overview".
Every fact carries support: confirmed (2+ sources agree), single-source, declared-only (stated, not seen in practice) or conflicted.
Prefer confirmed facts; ask the user about open conflicts instead of picking a side; never invent values listed as unknown.
After you produce a design, call genome_verify on it and fix the reported deviations.
Every image, video shot and page section is also a "piece" with a measured anatomy: element boxes, margins, distances, alignment edges, grid, spacing rhythm, hierarchy, balance, proportion, whitespace and reading path (exact for sites, estimated for pixels). You are the one who reads why: call genome_dissect_request, first identify the piece and check the picture shows what was measured (skip it with genome_dissect_skip when it does not, or when it adds nothing), then look at the annotated overlay and the grid reading and answer with genome_dissect_submit (what it is, role and reason of each element, the grid it is built on, composition, why it works, intent, what is fragile, reusable rules). Repeat until every piece is read, then call genome_concept_request and genome_concept_submit for the project as a whole (big idea, why it is this way, constants, variables, grammar, adaptation). No API key is needed.
To create a new piece, call genome_blueprint with the request and the format: it picks the closest references, re-lays the best one out on the new canvas in px, and gathers the concept, constants, reasons and rules to keep. Build from it, then genome_verify.
The older genome_vision_request/submit pass reads a whole source at once; dissection supersedes it when you have time to read piece by piece.
Logos, icons, photography, copy and restricted typefaces of reference brands must not be copied into deliverables.`;

const project = z.string().optional().describe('project name (see genome_projects); default is the configured project');

const runTool = (cliPath: string, projectDir: string, client: () => string) =>
  async (tool: string, args: Record<string, unknown>): Promise<ToolResult> => {
    if (process.env.GENOME_INPROCESS === "1") {
      const { TOOLS } = await import("./tools.js");
      try {
        return await TOOLS[tool]!(args, { projectDir, client: client(), log: (m) => process.stderr.write(`[genome] ${m}\n`) });
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
      }
    }
    return new Promise((done) => {
      const child = spawn(process.execPath, [cliPath, "worker"], { stdio: ["pipe", "pipe", "pipe"], env: process.env, windowsHide: true });
      const out: Buffer[] = [];
      const err: string[] = [];
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.on("data", (d: Buffer) => { const s = d.toString(); err.push(s); process.stderr.write(s); });
      child.on("close", (code) => {
        const raw = Buffer.concat(out).toString("utf8");
        try {
          done(JSON.parse(raw) as ToolResult);
        } catch {
          done({ isError: true, content: [{ type: "text", text: `Worker exited with code ${code}. ${err.join("").slice(-2000) || raw.slice(0, 500)}` }] });
        }
      });
      child.stdin.end(JSON.stringify({ tool, args, projectDir, client: client() }));
    });
  };

export const createMcpServer = (projectDir: string, cliPath = resolve(process.argv[1] ?? "dist/cli.js")): McpServer => {
  const server = new McpServer({ name: "design-genome", version: "0.3.0" }, { instructions: INSTRUCTIONS });
  const call = runTool(cliPath, resolve(projectDir), () => server.server.getClientVersion()?.name ?? "MCP host");
  interface ToolConfig { title: string; description: string; inputSchema: z.ZodRawShape; annotations?: { readOnlyHint?: boolean } }
  const tool = (name: string, config: ToolConfig): void => {
    (server.registerTool as (n: string, c: unknown, cb: unknown) => unknown)(name, config, async (args: Record<string, unknown>) => call(name, args ?? {}));
  };

  tool("genome_brief", { title: "Design brief", description: "The genome as a compact markdown brief: rules ranked by confidence, palette, type ramp, space/shape/motion, imagery direction, voice, open conflicts and unknowns.", inputSchema: { project, originalFonts: z.boolean().optional() }, annotations: { readOnlyHint: true } });

  tool("genome_query", {
    title: "Query the genome",
    description: "Return one facet of the genome as JSON. Summary detail keeps one evidence reference per fact; full detail returns all evidence.",
    inputSchema: {
      project,
      facet: z.enum(FACETS),
      detail: z.enum(["summary", "full"]).optional(),
      piece: z.string().optional().describe("anatomy: one piece id for its full measurements and reading"),
      role: z.string().optional().describe("typography role: display, headline, title, body, callout, caption, button, link"),
      viewport: z.number().optional(),
      topic: z.string().optional(),
      status: z.enum(["confirmed", "single-source", "declared-only", "conflicted"]).optional(),
      minConfidence: z.number().min(0).max(1).optional(),
    },
    annotations: { readOnlyHint: true },
  });

  tool("genome_add_sources", {
    title: "Add references",
    description:
      "Add references and measure them. Accepts: site URLs; Behance project links (downloads every image, image grid, Adobe/Vimeo video and the project texts); Dribbble shots, Pinterest pins, Are.na and other gallery pages (kind \"collection\" forces gallery mode on any page); Figma links; direct image, video or PDF URLs; local files; local folders (every media file inside). Use `links` for plain URLs or paths.",
    inputSchema: {
      project,
      links: z.array(z.string()).optional().describe("URLs, file paths or folder paths"),
      sources: z.array(z.object({
        uri: z.string(),
        kind: z.enum(SOURCE_KINDS).optional(),
        label: z.string().optional(),
        depicts: z.string().optional().describe("source id this image/video shows, for calibration"),
        viewports: z.array(z.number()).optional(),
        dark: z.boolean().optional(),
        maxItems: z.number().int().positive().optional().describe("collections: cap on downloaded items (default 80)"),
      })).optional(),
      extract: z.boolean().optional(),
      vision: z.boolean().optional().describe("headless vision via ANTHROPIC_API_KEY; without a key use genome_vision_request/submit"),
    },
  });

  tool("genome_sources", { title: "List sources", description: "Sources in the project (collections show their children through `parent`), with observation counts and limitations.", inputSchema: { project }, annotations: { readOnlyHint: true } });
  tool("genome_remove_source", { title: "Remove sources", description: "Remove sources (a collection removes its children too) and rebuild.", inputSchema: { project, sourceIds: z.array(z.string()).min(1) } });
  tool("genome_rebuild", { title: "Re-extract and rebuild", description: "Re-run extractors (all or some sources) and rebuild the genome.", inputSchema: { project, sourceIds: z.array(z.string()).optional(), force: z.boolean().optional(), vision: z.boolean().optional() } });
  tool("genome_resolve_conflict", { title: "Record a conflict decision", description: "Store the user's decision for a conflict (only with the user's explicit choice) and rebuild.", inputSchema: { project, conflictId: z.string(), choice: z.string(), note: z.string().optional() } });
  tool("genome_verify", { title: "Verify a design", description: "Measure a URL, local HTML file, image or Figma frame link with the same extractors and score it against the genome.", inputSchema: { project, target: z.string(), viewports: z.array(z.number()).optional(), maxViolations: z.number().optional() }, annotations: { readOnlyHint: true } });
  tool("genome_export", { title: "Export", description: "Return one export as text: tokens (W3C design tokens JSON), css, tailwind, brief, image-direction.", inputSchema: { project, format: z.enum(EXPORT_FORMATS), originalFonts: z.boolean().optional() }, annotations: { readOnlyHint: true } });
  tool("genome_vision_request", {
    title: "Get images for the vision pass",
    description: "Returns up to eight evidence images of one source for you to read as an art director. Defaults to the next source without a vision reading. Then call genome_vision_submit. Uses this conversation's model: no API key.",
    inputSchema: { project, sourceId: z.string().optional(), maxWidth: z.number().min(256).max(1600).optional() },
    annotations: { readOnlyHint: true },
  });
  tool("genome_vision_submit", {
    title: "Store vision readings",
    description: "Stores your readings of the images from genome_vision_request as inferred observations citing image numbers, and rebuilds. Rules other sources agree with become confirmed.",
    inputSchema: {
      project,
      sourceId: z.string(),
      rules: z.array(z.object({
        topic: z.enum(["imagery", "composition", "lighting", "camera", "typography", "layout", "color", "voice", "iconography", "motion"]),
        statement: z.string().min(8),
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
  });
  const reasoned = z.string().describe("write in the user's language");
  tool("genome_dissect_request", {
    title: "Dissect the next piece",
    description: "Returns the next readable piece without a reading (or the given pieceId): the piece, the same piece with its measured anatomy drawn on it (numbered blocks, margins, alignment edges, gaps), the grid reading (columns, rows, baseline, proportional lines, spans), the automatic pre-check and the measurements. First identify the piece and check the picture shows what was measured; then answer with genome_dissect_submit, or genome_dissect_skip when it is not worth reading.",
    inputSchema: { project, pieceId: z.string().optional().describe("e.g. src_ab12#1; default is the next unread piece"), maxWidth: z.number().min(512).max(1600).optional() },
    annotations: { readOnlyHint: true },
  });
  tool("genome_dissect_submit", {
    title: "Store a piece's dissection",
    description: "Stores your reading of one piece: what each numbered block is and why it is there, the composition and its principles, why the piece works, its intent, what is fragile, and reusable rules (which join the genome as inferred rules and are cross-checked against other sources). Then rebuilds.",
    inputSchema: {
      project,
      pieceId: z.string(),
      whatItIs: z.string().min(12).describe("what the piece is and shows, after checking the picture against the measured blocks (write in the user's language)"),
      pieceType: z.string().describe("poster, social post, story, banner, ad, packaging, landing hero, product section, slide, film frame…"),
      summary: reasoned,
      elements: z.array(z.object({
        block: z.number().int().positive().optional().describe("block number from the overlay"),
        box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional().describe("share-of-canvas box (0..1) for an element the measurement missed"),
        role: z.string(),
        content: z.string().optional(),
        treatment: z.string().optional(),
        why: z.string().describe("why it is there, at that position, size and distance — cite the measurements"),
      })).max(80),
      grid: z.object({
        system: z.string().describe("the grid you see: e.g. '12-column web grid, 24px gutter, 1200px container', 'modular 4×6 editorial grid', 'manuscript column on an 8px baseline', 'thirds', 'free composition'"),
        agrees: z.boolean().describe("whether the measured grid (image 3) is right"),
        why: z.string().optional().describe("why the piece is set on it, or what the measurement got wrong"),
      }).optional(),
      composition: z.object({
        structure: z.string(),
        eyePath: z.string(),
        balance: z.string().optional(),
        principles: z.array(z.object({ name: z.string(), how: z.string(), why: z.string() })).max(16),
      }),
      whyItWorks: z.array(z.string()).max(12),
      intent: z.object({ message: z.string(), audience: z.string().optional(), emotion: z.string().optional(), action: z.string().optional() }),
      typography: z.string().optional(),
      color: z.string().optional(),
      imagery: z.string().optional(),
      fragile: z.array(z.string()).max(12).optional(),
      corrections: z.array(z.string()).max(20).optional().describe("wrong merges/splits or misread kinds in the measurement"),
      rules: z.array(z.object({
        topic: z.enum(["composition", "layout", "typography", "imagery", "color", "voice", "iconography", "motion", "lighting", "camera"]),
        statement: z.string().min(8),
        polarity: z.enum(["must", "never", "should", "avoid", "fact"]),
        confidence: z.number().min(0).max(1),
      })).max(16).optional(),
    },
  });
  tool("genome_dissect_skip", {
    title: "Set a piece aside",
    description: "Marks a piece as not worth dissecting, with the reason (the picture does not show what was measured, a loader or cookie layer, a bot check, blank, a duplicate, a background strip or video frame with nothing composed). It leaves the reading queue, the measured constants and the blueprints.",
    inputSchema: { project, pieceId: z.string(), reason: reasoned },
  });
  tool("genome_concept_request", {
    title: "Read the project as a whole",
    description: "Returns a contact sheet of every piece, each piece's reading, the measured constants and variations across pieces, and the genome highlights, so you can explain the project: its big idea, why it is this way, what never changes, what varies, its grammar and how to adapt it. Answer with genome_concept_submit.",
    inputSchema: { project },
    annotations: { readOnlyHint: true },
  });
  tool("genome_concept_submit", {
    title: "Store the project concept",
    description: "Stores the project-level reading (big idea, concept, why, audience, personality, narrative, visual devices, constants, variables, grammar, signature moves, adaptation, what to avoid) and rebuilds. It then leads the brief and every blueprint.",
    inputSchema: {
      project,
      bigIdea: reasoned,
      concept: reasoned,
      why: reasoned,
      audience: z.string().optional(),
      personality: z.array(z.string()).max(12).optional(),
      narrative: z.string().optional(),
      metaphors: z.array(z.string()).max(12).optional(),
      constants: z.array(z.object({ what: z.string(), why: z.string() })).max(20),
      variables: z.array(z.object({ what: z.string(), range: z.string(), why: z.string().optional() })).max(20),
      grammar: z.array(z.string()).max(16),
      signatureMoves: z.array(z.string()).max(12).optional(),
      adaptation: z.array(z.string()).max(16).optional(),
      avoid: z.array(z.string()).max(16).optional(),
    },
  });
  tool("genome_blueprint", {
    title: "Plan a new piece",
    description: `Plans a new piece from the dissected references: picks the closest pieces for the request and format, re-lays the best one out on the new canvas (margins and type scale with the short side, stacks keep their gaps, the main image flexes), and returns the boxes in px with the reason for each element, the concept, measured constants, palette, type and rules to keep, a wireframe and the reference overlays. Formats: ${Object.keys(FORMATS).join(", ")}; or width and height.`,
    inputSchema: {
      project,
      request: z.string().describe("what to create, in the user's words"),
      format: z.string().optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      pieceType: z.string().optional(),
      references: z.array(z.string()).optional().describe("piece ids to base it on; default picks the closest"),
    },
  });
  tool("genome_projects", { title: "Projects", description: "List the brand projects, or create one with `create: \"<name>\"`. Each project is its own genome.", inputSchema: { create: z.string().optional() } });
  tool("genome_update", { title: "Update Design Genome", description: "Download and install the latest Design Genome from GitHub. Tool logic updates immediately; new tools or parameters appear after Claude restarts.", inputSchema: {} });

  server.registerPrompt(
    "criar-marca-no-figma",
    {
      title: "Criar marca no Figma a partir do genoma",
      description: "Build a new brand system in Figma that follows the genome's structure with the brand's own identity.",
      argsSchema: { marca: z.string(), descricao: z.string().optional(), figma: z.string().optional() },
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
            "3. Proponha a identidade: paleta própria (siga a proporção de neutros e acentos do genoma, sem copiar cores de marcas de referência), tipografia aberta, rampa de tamanhos, tracking, grid, raios e movimento. Mostre a proposta antes de construir.",
            `4. No Figma ${figma ? `(arquivo ${figma})` : "(crie um arquivo novo)"}: variáveis, estilos de texto, componentes e uma página de exemplo com textos originais.`,
            "5. Verifique com genome_verify e corrija os desvios altos e médios.",
            "Não use logos, ícones, fotos ou textos das marcas de referência.",
          ].join("\n"),
        },
      }],
    }),
  );
  server.registerPrompt(
    "criar-peca-a-partir-das-referencias",
    {
      title: "Criar uma peça nova a partir das referências",
      description: "Dissect the references (if needed), read the project concept, plan the new piece with a blueprint, build it and verify it.",
      argsSchema: { pedido: z.string(), formato: z.string().optional() },
    },
    ({ pedido, formato }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            `Quero criar: ${pedido}${formato ? ` (formato: ${formato})` : ""}.`,
            "1. Leia genome_brief. Se houver peças medidas e ainda não lidas, rode genome_dissect_request/genome_dissect_submit em cada uma (o que é cada elemento, por que está ali, por que a peça funciona).",
            "2. Se ainda não houver conceito do projeto, rode genome_concept_request/genome_concept_submit.",
            `3. Chame genome_blueprint com o pedido${formato ? ` e o formato ${formato}` : " e o formato certo"}. Me mostre a planta: referências escolhidas, o layout adaptado e o porquê de cada elemento, antes de produzir.`,
            "4. Produza a peça seguindo a planta, com conteúdo original (sem logos, fotos ou textos das referências).",
            "5. Verifique com genome_verify e corrija os desvios altos e médios.",
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
