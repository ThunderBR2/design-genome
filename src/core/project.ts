import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

import type { Genome } from "./genome.js";
import { randomId, sha256File } from "./ids.js";
import { extractionSchema, sourceSchema, type Extraction, type Source, type SourceKind } from "./model.js";

const PROJECT_FILE = "genome.project.json";

interface ProjectFile {
  readonly schema: "design-genome-project/1";
  name: string;
  createdAt: string;
  sources: Source[];
}

export interface AddSourceInput {
  readonly uri: string;
  readonly kind?: SourceKind;
  readonly label?: string;
  readonly depicts?: string;
  readonly tags?: readonly string[];
  readonly options?: Record<string, unknown>;
  /** Local file holding the bytes when `uri` is where they came from (collected assets). */
  readonly file?: string;
  readonly parent?: string;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".tif", ".tiff", ".bmp", ".svg"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]);
const DOC_EXT = new Set([".pdf", ".md", ".markdown", ".txt", ".html", ".htm"]);

/** Decide the source kind from a URL or path. Explicit kinds always win. */
/** Pages that hold a set of works rather than one design: their media are collected as child sources. */
export const COLLECTION_PATTERNS: readonly RegExp[] = [
  /^https?:\/\/(www\.)?behance\.net\/gallery\/\d+/i,
  /^https?:\/\/(www\.)?dribbble\.com\/shots\/\d+/i,
  /^https?:\/\/(www\.)?(br\.)?pinterest\.[a-z.]+\/pin\//i,
  /^https?:\/\/(www\.)?are\.na\//i,
  /^https?:\/\/(www\.)?savee\.(it|com)\//i,
];

export const detectSourceKind = (uri: string): SourceKind => {
  if (/^https?:\/\/(www\.)?figma\.com\/(file|design|proto)\//i.test(uri)) return "figma";
  if (COLLECTION_PATTERNS.some((r) => r.test(uri))) return "collection";
  const isUrl = /^https?:\/\//i.test(uri);
  const ext = extname(isUrl ? new URL(uri).pathname : uri).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (ext === ".pdf" || ext === ".md" || ext === ".markdown" || ext === ".txt") return "document";
  if (!isUrl && DOC_EXT.has(ext)) return "document";
  if (isUrl) return "web";
  throw new Error(`Cannot tell what kind of source this is: ${uri}. Pass an explicit kind.`);
};

const isUrl = (uri: string): boolean => /^https?:\/\//i.test(uri);

/** A genome project on disk: sources, extractions, evidence artifacts and the built genome. */
export class Project {
  private constructor(
    readonly root: string,
    private data: ProjectFile,
  ) {}

  static async create(root: string, name: string): Promise<Project> {
    const abs = resolve(root);
    await mkdir(abs, { recursive: true });
    const existing = await Project.tryOpen(abs);
    if (existing) return existing;
    const project = new Project(abs, {
      schema: "design-genome-project/1",
      name,
      createdAt: new Date().toISOString(),
      sources: [],
    });
    await project.save();
    return project;
  }

  static async tryOpen(root: string): Promise<Project | null> {
    const abs = resolve(root);
    try {
      const raw = JSON.parse(await readFile(join(abs, PROJECT_FILE), "utf8")) as ProjectFile;
      raw.sources = raw.sources.map((s) => sourceSchema.parse(s));
      return new Project(abs, raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  static async open(root: string): Promise<Project> {
    const project = await Project.tryOpen(root);
    if (!project) throw new Error(`No genome project at ${resolve(root)}. Run "genome init" first.`);
    return project;
  }

  get name(): string {
    return this.data.name;
  }

  get sources(): readonly Source[] {
    return this.data.sources;
  }

  source(id: string): Source {
    const found = this.data.sources.find((s) => s.id === id);
    if (!found) throw new Error(`Unknown source ${id}`);
    return found;
  }

  async addSource(input: AddSourceInput): Promise<Source> {
    const kind = input.kind ?? detectSourceKind(input.uri);
    if (input.depicts) this.source(input.depicts);
    const id = randomId("src");
    let storedPath: string | undefined;
    let sha256: string | undefined;
    if (input.file || !isUrl(input.uri)) {
      const abs = resolve(input.file ?? input.uri);
      const info = await stat(abs);
      if (!info.isFile()) throw new Error(`Not a file: ${abs}`);
      const dir = join(this.root, "sources", id);
      await mkdir(dir, { recursive: true });
      const target = join(dir, basename(abs));
      await copyFile(abs, target);
      storedPath = relative(this.root, target);
      sha256 = await sha256File(target);
      const duplicate = this.data.sources.find((s) => s.sha256 === sha256);
      if (duplicate) {
        await rm(dir, { recursive: true, force: true });
        return duplicate;
      }
    } else {
      const duplicate = this.data.sources.find((s) => s.uri === input.uri && s.kind === kind);
      if (duplicate) return duplicate;
    }
    const source = sourceSchema.parse({
      id,
      kind,
      uri: isUrl(input.uri) ? input.uri : resolve(input.uri),
      label: input.label,
      storedPath,
      sha256,
      addedAt: new Date().toISOString(),
      depicts: input.depicts,
      parent: input.parent,
      tags: input.tags ?? [],
      options: input.options ?? {},
    });
    this.data.sources.push(source);
    await this.save();
    return source;
  }

  async removeSource(id: string): Promise<void> {
    this.source(id);
    for (const child of this.data.sources.filter((s) => s.parent === id)) await this.removeSource(child.id);
    this.data.sources = this.data.sources.filter((s) => s.id !== id);
    await rm(join(this.root, "sources", id), { recursive: true, force: true });
    await rm(join(this.root, "evidence", id), { recursive: true, force: true });
    for (const file of await readdir(join(this.root, "extractions")).catch(() => [] as string[])) {
      if (file.startsWith(`${id}--`)) await rm(join(this.root, "extractions", file), { force: true });
    }
    await this.save();
  }

  /** Absolute path to read a source's bytes from. URLs have none. */
  localPath(source: Source): string | null {
    return source.storedPath ? join(this.root, source.storedPath) : null;
  }

  /** Reserve a path for an evidence artifact. Returns both absolute and project-relative forms. */
  async artifact(sourceId: string, name: string): Promise<{ abs: string; rel: string }> {
    const dir = join(this.root, "evidence", sourceId);
    await mkdir(dir, { recursive: true });
    const abs = join(dir, name);
    return { abs, rel: relative(this.root, abs) };
  }

  async saveExtraction(extraction: Extraction): Promise<void> {
    const dir = join(this.root, "extractions");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${extraction.sourceId}--${extraction.extractor}.json`), JSON.stringify(extraction, null, 2));
  }

  async loadExtractions(): Promise<Extraction[]> {
    const dir = join(this.root, "extractions");
    const ids = new Set(this.data.sources.map((s) => s.id));
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const out: Extraction[] = [];
    for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
      const parsed = extractionSchema.parse(JSON.parse(await readFile(join(dir, file), "utf8")));
      if (ids.has(parsed.sourceId)) out.push(parsed);
    }
    return out;
  }

  async hasExtraction(sourceId: string, extractor: string): Promise<boolean> {
    try {
      await stat(join(this.root, "extractions", `${sourceId}--${extractor}.json`));
      return true;
    } catch {
      return false;
    }
  }

  async saveGenome(genome: Genome): Promise<string> {
    const path = join(this.root, "genome.json");
    await writeFile(path, JSON.stringify(genome, null, 2));
    return path;
  }

  async loadGenome(): Promise<Genome | null> {
    try {
      return JSON.parse(await readFile(join(this.root, "genome.json"), "utf8")) as Genome;
    } catch {
      return null;
    }
  }

  async loadResolutions(): Promise<Record<string, { choice: string; note?: string; at: string }>> {
    try {
      return JSON.parse(await readFile(join(this.root, "resolutions.json"), "utf8"));
    } catch {
      return {};
    }
  }

  async resolveConflict(conflictId: string, choice: string, note?: string): Promise<void> {
    const all = await this.loadResolutions();
    all[conflictId] = { choice, ...(note ? { note } : {}), at: new Date().toISOString() };
    await writeFile(join(this.root, "resolutions.json"), JSON.stringify(all, null, 2));
  }

  async setLabel(id: string, label: string): Promise<void> {
    const source = this.source(id);
    (source as { label?: string }).label = label;
    await this.save();
  }

  async rename(name: string): Promise<void> {
    this.data.name = name;
    await this.save();
  }

  private async save(): Promise<void> {
    await writeFile(join(this.root, PROJECT_FILE), JSON.stringify(this.data, null, 2));
  }
}
