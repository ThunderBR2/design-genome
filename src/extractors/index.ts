import type { Project } from "../core/project.js";
import type { Extraction, SourceKind } from "../core/types.js";
import { documentExtractor } from "./document.js";
import { figmaExtractor } from "./figma.js";
import { imageExtractor } from "./image.js";
import type { Extractor } from "./support.js";
import { videoExtractor } from "./video.js";
import { visionExtractor } from "./vision.js";
import { webExtractor } from "./web.js";

export const PRIMARY: Record<SourceKind, Extractor> = {
  web: webExtractor,
  image: imageExtractor,
  video: videoExtractor,
  document: documentExtractor,
  figma: figmaExtractor,
};

export const VISION_KINDS: readonly SourceKind[] = ["image", "video", "web"];

export interface ExtractOptions {
  readonly vision?: boolean;
  readonly force?: boolean;
  readonly log?: (message: string) => void;
}

export interface ExtractOutcome {
  readonly sourceId: string;
  readonly extractor: string;
  readonly status: "extracted" | "cached" | "failed" | "skipped";
  readonly observations?: number;
  readonly error?: string;
}

/** Run the primary extractor (and optionally vision) for each requested source. Failures stay per source. */
export const extractSources = async (project: Project, sourceIds: readonly string[] | "all", options: ExtractOptions = {}): Promise<ExtractOutcome[]> => {
  const log = options.log ?? (() => undefined);
  const ids = sourceIds === "all" ? project.sources.map((s) => s.id) : sourceIds;
  const outcomes: ExtractOutcome[] = [];
  for (const id of ids) {
    const source = project.source(id);
    const plan: Extractor[] = [PRIMARY[source.kind]];
    if (options.vision && VISION_KINDS.includes(source.kind)) plan.push(visionExtractor);
    for (const extractor of plan) {
      if (!options.force && (await project.hasExtraction(id, extractor.name))) {
        outcomes.push({ sourceId: id, extractor: extractor.name, status: "cached" });
        continue;
      }
      try {
        const result: Extraction = await extractor.extract({ project, source, log });
        await project.saveExtraction(result);
        outcomes.push({ sourceId: id, extractor: extractor.name, status: "extracted", observations: result.observations.length });
        log(`${extractor.name}: ${result.observations.length} observations from ${source.label ?? source.uri}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outcomes.push({ sourceId: id, extractor: extractor.name, status: "failed", error: message });
        log(`${extractor.name} failed for ${source.uri}: ${message}`);
      }
    }
  }
  return outcomes;
};

export { webExtractor, imageExtractor, videoExtractor, documentExtractor, figmaExtractor, visionExtractor };
export type { Extractor };
