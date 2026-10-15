import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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
To name art direction in images, video frames and page captures, you are the vision model: call genome_vision_request, look at the images, then genome_vision_submit. Repeat while sources remain. No API key is needed.
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
  const server = new McpServer({ name: "design-genome", version: "0.2.0" }, { instructions: INSTRUCTIONS });
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
  return server;
};

export const startMcpServer = async (projectDir: string): Promise<void> => {
  const server = createMcpServer(projectDir);
  await server.connect(new StdioServerTransport());
};
