import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectBehance, isBehanceProject } from "../collectors/behance.js";
import { collectGallery } from "../collectors/gallery.js";
import { finishExtraction, type ExtractContext, type Extractor } from "./support.js";

/**
 * A collection (Behance project, Dribbble shot, gallery page) is not measured
 * itself: its images, videos and texts are downloaded and added as child
 * sources, which the normal extractors then measure. The collection keeps the
 * list of children and what could not be collected.
 */
export const collectionExtractor: Extractor = {
  name: "collector",
  version: "1.0.0",
  async extract({ project, source, log }: ExtractContext) {
    const started = new Date();
    const { chromium } = await import("playwright");
    const workDir = await mkdtemp(join(tmpdir(), "genome-collect-"));
    const browser = await chromium.launch({ headless: true });
    try {
      const opts = {
        workDir,
        log,
        maxItems: (source.options.maxItems as number | undefined) ?? undefined,
        maxVideoSeconds: (source.options.maxVideoSeconds as number | undefined) ?? undefined,
      };
      const collection = isBehanceProject(source.uri) ? await collectBehance(browser, source.uri, opts) : await collectGallery(browser, source.uri, opts);
      const children: string[] = [];
      for (const item of collection.items) {
        const child = await project.addSource({
          uri: item.origin,
          file: item.file,
          kind: item.kind,
          label: item.label,
          parent: source.id,
          tags: source.tags,
          options: item.kind === "document" ? { caseStudy: true } : {},
        });
        children.push(child.id);
      }
      if (!source.label) await project.setLabel(source.id, collection.title);
      log(`collector: ${children.length} item(s) added from "${collection.title}"`);
      return finishExtraction(source, collectionExtractor, started, [], [], collection.limitations, { ...collection.meta, title: collection.title, children });
    } finally {
      await browser.close();
      await rm(workDir, { recursive: true, force: true });
    }
  },
};
