import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Genome } from "./core/genome.js";
import { Project, type AddSourceInput } from "./core/project.js";
import type { Source } from "./core/model.js";
import { EXPORT_FORMATS, exportGenome, type ExportFormat } from "./export/index.js";
import { PRIMARY, extractSources, type ExtractOutcome } from "./extractors/index.js";
import { queryGenome, type Facet, type QueryOptions } from "./query.js";
import { buildGenome } from "./reconcile/build.js";
import { verify, type VerifyReport } from "./verify/index.js";
import { visionExtraction, visionImages, type VisionImage, type VisionReply } from "./extractors/vision.js";
import { buildBlueprint, type Blueprint, type BlueprintInput } from "./anatomy/blueprint.js";
import { ANATOMY_KINDS, ensureAnatomy, loadAnatomy, measureSource } from "./anatomy/pieces.js";
import { contactSheet, pieceImages, projectAnatomy, saveConcept, skipPiece, submitReading, type ConceptInput, type PieceImages, type ProjectAnatomy, type ReadingInput } from "./anatomy/reading.js";
import { isReadable, needsReading, type Concept, type Piece } from "./anatomy/types.js";

const MEDIA = /\.(png|jpe?g|webp|gif|avif|tiff?|bmp|svg|mp4|mov|m4v|webm|mkv|avi|pdf|md|markdown|txt)$/i;

/** A local folder becomes every image, video and document inside it (two levels deep). */
export const expandFolders = async (inputs: readonly AddSourceInput[]): Promise<AddSourceInput[]> => {
  const out: AddSourceInput[] = [];
  for (const input of inputs) {
    if (/^https?:/i.test(input.uri) || input.file) { out.push(input); continue; }
    const info = await stat(input.uri).catch(() => null);
    if (!info?.isDirectory()) { out.push(input); continue; }
    const walk = async (dir: string, depth: number): Promise<void> => {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory() && depth < 2) await walk(path, depth + 1);
        else if (entry.isFile() && MEDIA.test(entry.name)) out.push({ ...input, uri: path, label: entry.name.replace(/\.[^.]+$/, "") });
      }
    };
    await walk(input.uri, 0);
  }
  return out;
};

export const DEFAULT_PROJECT_DIR = process.env.GENOME_PROJECT ?? ".genome";

/** The one application layer that the CLI, the MCP server and the Studio all call. */
export class GenomeService {
  constructor(
    readonly dir: string = DEFAULT_PROJECT_DIR,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  async project(createName?: string): Promise<Project> {
    const existing = await Project.tryOpen(this.dir);
    if (existing) return existing;
    if (createName !== undefined) return Project.create(this.dir, createName);
    return Project.create(this.dir, "Untitled genome");
  }

  async init(name: string): Promise<Project> {
    const project = await Project.create(this.dir, name);
    if (project.name !== name) await project.rename(name);
    return project;
  }

  async add(inputs: readonly AddSourceInput[]): Promise<Source[]> {
    const project = await this.project();
    const out: Source[] = [];
    for (const input of await expandFolders(inputs)) out.push(await project.addSource(input));
    return out;
  }

  async remove(id: string): Promise<void> {
    await (await this.project()).removeSource(id);
  }

  async extract(ids: readonly string[] | "all" = "all", options: { vision?: boolean; force?: boolean } = {}): Promise<ExtractOutcome[]> {
    return extractSources(await this.project(), ids, { ...options, log: this.log });
  }

  async build(): Promise<Genome> {
    const project = await this.project();
    const genome = await buildGenome(project);
    await project.saveGenome(genome);
    return genome;
  }

  /** Add, extract and rebuild in one step. Already-extracted sources are reused. */
  async ingest(inputs: readonly AddSourceInput[], options: { vision?: boolean } = {}): Promise<{ sources: Source[]; outcomes: ExtractOutcome[]; genome: Genome }> {
    const sources = await this.add(inputs);
    const outcomes = await this.extract(sources.map((s) => s.id), options);
    await this.measure(outcomes.filter((o) => o.status === "extracted").map((o) => o.sourceId));
    const genome = await this.build();
    return { sources, outcomes, genome };
  }

  /** Sources whose images have been extracted but not yet read by a vision pass. */
  async visionPending(): Promise<Source[]> {
    const project = await this.project();
    const out: Source[] = [];
    for (const s of project.sources) {
      if (!["image", "video", "web"].includes(s.kind)) continue; // collections are read through their children
      if (!(await project.hasExtraction(s.id, PRIMARY[s.kind].name))) continue;
      if (await project.hasExtraction(s.id, "vision")) continue;
      // A dissected source has been looked at piece by piece, which covers the vision pass.
      if (await project.hasExtraction(s.id, "dissect")) continue;
      out.push(s);
    }
    return out;
  }

  /** Images for the host model to read. Defaults to the next source without a vision reading. */
  async visionRequest(sourceId?: string, maxWidth = 1024): Promise<{ source: Source; images: VisionImage[]; remaining: number } | null> {
    const project = await this.project();
    const pending = await this.visionPending();
    const source = sourceId ? project.source(sourceId) : pending[0];
    if (!source) return null;
    const images = await visionImages(project, source, maxWidth);
    return { source, images, remaining: pending.filter((s) => s.id !== source.id).length };
  }

  /** Store what the host model read from genome_vision_request images, then rebuild. */
  async visionSubmit(sourceId: string, reply: VisionReply, reader: string): Promise<{ observations: number; genome: Genome }> {
    const project = await this.project();
    const source = project.source(sourceId);
    const images = await visionImages(project, source, 64);
    const extraction = visionExtraction(source, images, reply, reader);
    await project.saveExtraction(extraction);
    return { observations: extraction.observations.length, genome: await this.build() };
  }

  /** Measure the anatomy of sources (all extracted image, video and web sources by default). Failures stay per source. */
  async measure(ids: readonly string[] | "all" = "all", force = false): Promise<{ sourceId: string; pieces?: number; error?: string }[]> {
    const project = await this.project();
    const wanted = ids === "all" ? project.sources.map((s) => s.id) : [...new Set(ids)];
    const out: { sourceId: string; pieces?: number; error?: string }[] = [];
    for (const id of wanted) {
      const source = project.source(id);
      if (!ANATOMY_KINDS.has(source.kind) || !(await project.hasExtraction(id, PRIMARY[source.kind].name))) continue;
      try {
        const had = !force && (await loadAnatomy(project, id));
        const a = force ? await measureSource(project, source) : await ensureAnatomy(project, source);
        out.push({ sourceId: id, pieces: a.pieces.length });
        if (!had || had.measuredAt !== a.measuredAt) this.log(`anatomy: ${a.pieces.length} piece(s) from ${source.label ?? source.uri}`);
      } catch (error) {
        out.push({ sourceId: id, error: error instanceof Error ? error.message : String(error) });
        this.log(`anatomy failed for ${source.uri}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return out;
  }

  async anatomy(): Promise<ProjectAnatomy> {
    await this.measure("all");
    return projectAnatomy(await this.project());
  }

  /** The next piece without a reading (or a given one), with its images and measurements. */
  async dissectRequest(pieceId?: string, maxSide = 1280): Promise<{ images: PieceImages; remaining: number; total: number; setAside: { id: string; label: string; reason: string }[] } | null> {
    const pa = await this.anatomy();
    const piece = pieceId ? pa.pieces.find((p) => p.id === pieceId) : pa.pieces.find(needsReading);
    if (pieceId && !piece) throw new Error(`Unknown piece ${pieceId}. Known: ${pa.pieces.map((p) => p.id).join(", ") || "none"}`);
    if (!piece) return null;
    const remaining = pa.pieces.filter((p) => needsReading(p) && p.id !== piece.id).length;
    const setAside = pa.pieces.filter((p) => !isReadable(p)).map((p) => ({ id: p.id, label: p.label, reason: p.skipped?.reason ?? p.triage?.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ") ?? "" }));
    return { images: await pieceImages(await this.project(), piece, maxSide), remaining, total: pa.pieces.filter(isReadable).length, setAside };
  }

  /** Set a piece aside with the reason; it leaves the reading queue, the invariants and the blueprints. */
  async dissectSkip(pieceId: string, reason: string, by: string): Promise<{ piece: Piece; remaining: number; genome: Genome }> {
    const project = await this.project();
    const piece = await skipPiece(project, pieceId, reason, by);
    const genome = await this.build();
    const pa = await projectAnatomy(project);
    return { piece, remaining: pa.pieces.filter(needsReading).length, genome };
  }

  async dissectSubmit(pieceId: string, input: ReadingInput, reader: string): Promise<{ piece: Piece; rules: number; remaining: number; genome: Genome }> {
    const project = await this.project();
    const { piece, rules } = await submitReading(project, pieceId, input, reader);
    const genome = await this.build();
    const remaining = (await projectAnatomy(project)).pieces.filter(needsReading).length;
    return { piece, rules, remaining, genome };
  }

  async conceptRequest(): Promise<{ anatomy: ProjectAnatomy; sheet: Buffer; genome: Genome | null }> {
    const project = await this.project();
    const anatomy = await this.anatomy();
    if (!anatomy.pieces.length) throw new Error("No pieces yet: add images, videos or sites and extract them first.");
    const readable = { ...anatomy, pieces: anatomy.pieces.filter(isReadable) };
    if (!readable.pieces.length) throw new Error("Every piece was set aside as not worth reading; add better references first.");
    return { anatomy: readable, sheet: await contactSheet(project, readable.pieces), genome: await project.loadGenome() };
  }

  async conceptSubmit(input: ConceptInput, reader: string): Promise<{ concept: Concept; genome: Genome }> {
    const project = await this.project();
    const pa = await projectAnatomy(project);
    const concept = await saveConcept(project, input, reader, pa.pieces.map((p) => p.id));
    return { concept, genome: await this.build() };
  }

  async blueprint(input: BlueprintInput): Promise<Blueprint> {
    const project = await this.project();
    const anatomy = await this.anatomy();
    return buildBlueprint(project, await project.loadGenome(), input, { ...anatomy, pieces: anatomy.pieces.filter(isReadable) });
  }

  async genome(): Promise<Genome> {
    const genome = await (await this.project()).loadGenome();
    if (!genome) throw new Error('No genome built yet. Add sources and run "genome build".');
    return genome;
  }

  async query(facet: Facet, options: QueryOptions = {}): Promise<unknown> {
    return queryGenome(await this.genome(), facet, options);
  }

  async resolve(conflictId: string, choice: string, note?: string): Promise<Genome> {
    const project = await this.project();
    await project.resolveConflict(conflictId, choice, note);
    return this.build();
  }

  async verify(target: string, viewports?: number[]): Promise<VerifyReport> {
    return verify(await this.genome(), /^https?:|^file:/i.test(target) ? target : resolve(target), { viewports, log: this.log });
  }

  async export(formats: readonly ExportFormat[] | "all", outDir?: string, openFonts = true): Promise<string[]> {
    const genome = await this.genome();
    const dir = outDir ?? join((await this.project()).root, "exports");
    await mkdir(dir, { recursive: true });
    const written: string[] = [];
    for (const format of formats === "all" ? EXPORT_FORMATS : formats) {
      const { filename, content } = exportGenome(genome, format, { openFonts });
      const path = join(dir, filename);
      await writeFile(path, content);
      written.push(path);
    }
    return written;
  }
}
