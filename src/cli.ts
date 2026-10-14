#!/usr/bin/env node
import { Command, Option } from "commander";

import type { AddSourceInput } from "./core/project.js";
import { SOURCE_KINDS, type SourceKind } from "./core/model.js";
import { EXPORT_FORMATS, type ExportFormat } from "./export/index.js";
import { FACETS, type Facet } from "./query.js";
import { DEFAULT_PROJECT_DIR, GenomeService } from "./service.js";

const program = new Command();
program
  .name("genome")
  .description("Reverse-engineer design systems from sites, documents, images, videos and Figma files — with evidence for every fact.")
  .version("0.1.0")
  .option("-p, --project <dir>", "project directory", DEFAULT_PROJECT_DIR)
  .option("-q, --quiet", "no progress output");

const service = (): GenomeService => {
  const opts = program.opts<{ project: string; quiet?: boolean }>();
  return new GenomeService(opts.project, opts.quiet ? () => undefined : (m) => process.stderr.write(`· ${m}\n`));
};

const print = (value: unknown, json?: boolean): void => {
  process.stdout.write(typeof value === "string" && !json ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);
};

const sourceInputs = (uris: string[], o: { kind?: SourceKind; label?: string; depicts?: string; tag?: string[]; viewports?: string; dark?: boolean; sceneThreshold?: string; figmaJson?: string }): AddSourceInput[] =>
  uris.map((uri) => ({
    uri,
    ...(o.kind ? { kind: o.kind } : {}),
    ...(o.label && uris.length === 1 ? { label: o.label } : {}),
    ...(o.depicts ? { depicts: o.depicts } : {}),
    tags: o.tag ?? [],
    options: {
      ...(o.viewports ? { viewports: o.viewports.split(",").map(Number) } : {}),
      ...(o.dark ? { colorScheme: "dark" } : {}),
      ...(o.sceneThreshold ? { sceneThreshold: Number(o.sceneThreshold) } : {}),
      ...(o.figmaJson ? { json: o.figmaJson } : {}),
    },
  }));

const addOptions = (cmd: Command): Command =>
  cmd
    .addOption(new Option("-k, --kind <kind>", "force the source kind").choices([...SOURCE_KINDS]))
    .option("-l, --label <label>", "human label (single source)")
    .option("-d, --depicts <sourceId>", "this image/video depicts that source (enables calibration)")
    .option("-t, --tag <tag...>", "tags")
    .option("--viewports <list>", "web: comma-separated widths, default 390,1440")
    .option("--dark", "web: render with prefers-color-scheme: dark")
    .option("--scene-threshold <n>", "video: scene-change threshold 0..1, default 0.3")
    .option("--figma-json <path>", "figma: read an exported file JSON instead of the API");

program
  .command("init")
  .argument("[name]", "genome name", "My genome")
  .description("create a project")
  .action(async (name: string) => {
    const p = await service().init(name);
    print(`Project "${p.name}" at ${p.root}`);
  });

addOptions(program.command("add").argument("<uris...>", "URLs, file paths or Figma links").description("add sources without extracting")).action(async (uris: string[], o) => {
  const sources = await service().add(sourceInputs(uris, o));
  for (const s of sources) print(`${s.id}  ${s.kind.padEnd(8)} ${s.label ?? s.uri}`);
});

addOptions(program.command("ingest").argument("<uris...>", "URLs, file paths or Figma links").description("add, extract and rebuild in one step"))
  .option("--vision", "also run the vision extractor (needs ANTHROPIC_API_KEY)")
  .action(async (uris: string[], o) => {
    const { outcomes, genome } = await service().ingest(sourceInputs(uris, o), { vision: o.vision });
    for (const r of outcomes) print(`${r.status.padEnd(9)} ${r.extractor.padEnd(8)} ${r.sourceId}${r.observations !== undefined ? `  ${r.observations} observations` : ""}${r.error ? `  ${r.error}` : ""}`);
    print(`Genome: ${genome.color.tokens.length} colors, ${genome.typography.styles.length} type styles, ${genome.rules.length} rules, ${genome.conflicts.filter((c) => !c.resolution).length} open conflicts.`);
  });

program
  .command("sources")
  .description("list sources")
  .option("--json", "JSON output")
  .action(async (o) => {
    const p = await service().project();
    if (o.json) return print(p.sources, true);
    for (const s of p.sources) print(`${s.id}  ${s.kind.padEnd(8)} ${s.label ?? s.uri}${s.depicts ? `  (depicts ${s.depicts})` : ""}`);
  });

program.command("remove").argument("<sourceId>").description("remove a source and its evidence").action(async (id: string) => {
  await service().remove(id);
  print(`Removed ${id}. Run "genome build" to update the genome.`);
});

program
  .command("extract")
  .argument("[sourceIds...]", "sources to extract (default all)")
  .option("--vision", "also run the vision extractor (needs ANTHROPIC_API_KEY)")
  .option("-f, --force", "re-extract even when cached")
  .description("run extractors")
  .action(async (ids: string[], o) => {
    const outcomes = await service().extract(ids.length ? ids : "all", { vision: o.vision, force: o.force });
    for (const r of outcomes) print(`${r.status.padEnd(9)} ${r.extractor.padEnd(8)} ${r.sourceId}${r.observations !== undefined ? `  ${r.observations} observations` : ""}${r.error ? `  ${r.error}` : ""}`);
  });

program.command("build").description("cross-check all extractions into genome.json").action(async () => {
  const g = await service().build();
  print(`Built "${g.name}": ${g.color.tokens.length} colors, ${g.typography.families.length} families, ${g.typography.styles.length} type styles, ${g.rules.length} rules (${g.rules.filter((r) => r.support.status === "confirmed").length} confirmed), ${g.conflicts.filter((c) => !c.resolution).length} open conflicts.`);
});

program
  .command("show")
  .argument("[facet]", `one of ${FACETS.join(", ")}`, "overview")
  .option("--full", "include all evidence")
  .option("--role <role>", "typography role filter")
  .option("--viewport <px>", "typography viewport filter")
  .option("--topic <topic>", "rules topic filter")
  .option("--min-confidence <n>", "drop facts below this confidence")
  .description("print part of the genome as JSON")
  .action(async (facet: Facet, o) => {
    if (!FACETS.includes(facet)) throw new Error(`Unknown facet ${facet}`);
    print(await service().query(facet, { detail: o.full ? "full" : "summary", role: o.role, viewport: o.viewport ? Number(o.viewport) : undefined, topic: o.topic, minConfidence: o.minConfidence ? Number(o.minConfidence) : undefined }), true);
  });

program.command("conflicts").description("list conflicts").action(async () => {
  const list = (await service().query("conflicts")) as { id: string; severity: string; description: string; resolution: unknown }[];
  if (!list.length) return print("No conflicts.");
  for (const c of list) print(`${c.resolution ? "✓" : "⚠"} ${c.id}  [${c.severity}] ${c.description}`);
});

program
  .command("resolve")
  .argument("<conflictId>")
  .argument("<choice>", 'your decision, e.g. "follow the site" or "use the brand book"')
  .option("--note <note>")
  .description("record a decision for a conflict and rebuild")
  .action(async (id: string, choice: string, o) => {
    await service().resolve(id, choice, o.note);
    print(`Recorded decision for ${id}.`);
  });

program
  .command("verify")
  .argument("<target>", "URL, local HTML file, or image")
  .option("--viewports <list>", "web: widths to check, default 1440")
  .option("--json", "full JSON report")
  .description("score a design against the genome and list deviations")
  .action(async (target: string, o) => {
    const report = await service().verify(target, o.viewports ? o.viewports.split(",").map(Number) : undefined);
    if (o.json) return print(report, true);
    print(report.summary);
    for (const [facet, r] of Object.entries(report.facets)) print(`  ${facet.padEnd(11)} ${Math.round(r.score * 100)}%  (${r.checked} checks)`);
    for (const v of report.violations.slice(0, 25)) print(`  - [${v.severity}] ${v.message}${v.where ? `  @ ${v.where}` : ""}`);
  });

program
  .command("export")
  .addOption(new Option("-f, --format <formats...>", "formats").choices([...EXPORT_FORMATS, "all"]).default(["all"]))
  .option("-o, --out <dir>", "output directory (default <project>/exports)")
  .option("--original-fonts", "keep restricted typefaces instead of open substitutes")
  .description("write tokens.json, genome.css, tailwind preset, BRIEF.md and image direction")
  .action(async (o) => {
    const formats = (o.format as string[]).includes("all") ? "all" : (o.format as ExportFormat[]);
    for (const path of await service().export(formats, o.out, !o.originalFonts)) print(path);
  });

program
  .command("studio")
  .option("--port <port>", "port", "4848")
  .option("--host <host>", "host", "127.0.0.1")
  .description("open the web Studio to add sources, review evidence and resolve conflicts")
  .action(async (o) => {
    const { startStudio } = await import("./studio/server.js");
    const { url } = await startStudio(service(), { port: Number(o.port), host: o.host });
    print(`Design Genome Studio running at ${url}`);
  });

program.command("mcp").description("serve the genome to AI agents over MCP (stdio)").action(async () => {
  const { startMcpServer } = await import("./mcp.js");
  await startMcpServer(program.opts<{ project: string }>().project);
});

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`genome: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
