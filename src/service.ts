import { mkdir, writeFile } from "node:fs/promises";
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
    for (const input of inputs) out.push(await project.addSource(input));
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
    const genome = await this.build();
    return { sources, outcomes, genome };
  }

  /** Sources whose images have been extracted but not yet read by a vision pass. */
  async visionPending(): Promise<Source[]> {
    const project = await this.project();
    const out: Source[] = [];
    for (const s of project.sources) {
      if (!["image", "video", "web"].includes(s.kind)) continue;
      if (!(await project.hasExtraction(s.id, PRIMARY[s.kind].name))) continue;
      if (await project.hasExtraction(s.id, "vision")) continue;
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
