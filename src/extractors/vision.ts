import { readdir } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

import type { Project } from "../core/project.js";
import type { Evidence, Extraction, ObservationValue, Source } from "../core/types.js";
import { ObservationCollector, finishExtraction, type ExtractContext, type Extractor } from "./support.js";

/**
 * Vision pass: names art-direction and composition rules that pixels alone
 * cannot (lighting setup, camera angle, framing, typographic treatment, tone).
 * Output is "inferred", cites the images it came from, and only becomes
 * confirmed when other sources agree.
 *
 * Two ways to run it, same result:
 *  - Through the host (default, no API key): the MCP tool genome_vision_request
 *    hands the evidence images to the Claude conversation that is already
 *    connected, and genome_vision_submit stores what that Claude read.
 *  - Headless: with ANTHROPIC_API_KEY set, `genome extract --vision` calls the
 *    API directly. Useful for the CLI, the Studio and scheduled runs.
 * Both read the evidence artifacts the primary extractor produced.
 */

export const VISION_PROMPT = `You are a senior art director reverse-engineering a brand's visual system.
You get numbered images from one source. Describe only what is visible; never guess the brand.
Return strict JSON, no prose:
{"rules":[{"topic":"imagery|composition|lighting|camera|typography|layout|color|voice|iconography|motion",
 "statement":"one precise, reusable rule an AI could follow (e.g. 'Product isolated on a seamless light-grey background with a soft contact shadow')",
 "polarity":"must|never|should|avoid|fact","confidence":0.0-1.0,"images":[1,2]}],
 "labels":[{"metric":"camera-angle|shot-size|lighting|background|depth-of-field|subject|grade","label":"short value","confidence":0.0-1.0,"images":[1]}]}
Prefer rules that hold across several images. 6-16 rules, 3-10 labels.`;

export interface VisionReply {
  rules?: { topic?: string; statement?: string; polarity?: string; confidence?: number; images?: number[] }[];
  labels?: { metric?: string; label?: string; confidence?: number; images?: number[] }[];
}

export interface VisionImage {
  /** 1-based number the reply cites. */
  readonly n: number;
  /** Project-relative artifact path. */
  readonly artifact: string;
  readonly jpeg: Buffer;
}

const MAX_IMAGES = 8;
const VISION_KINDS = new Set(["image", "video", "web"]);

/** Pick up to eight evidence images for a source, spread across its shots or pages. */
export const visionImages = async (project: Project, source: Source, maxWidth = 1280): Promise<VisionImage[]> => {
  if (!VISION_KINDS.has(source.kind)) throw new Error(`${source.kind} sources have no images for the vision pass.`);
  const dir = join(project.root, "evidence", source.id);
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => /^(preview|shot-\d+|page-\d+)\.(jpe?g|png)$/i.test(f))
    .sort();
  if (files.length === 0) throw new Error(`No evidence images for ${source.id}. Extract the source first.`);
  const step = Math.max(1, Math.ceil(files.length / MAX_IMAGES));
  const chosen = files.filter((_, i) => i % step === 0).slice(0, MAX_IMAGES);
  const out: VisionImage[] = [];
  for (const file of chosen) {
    const path = join(dir, file);
    const { width = 0, height = 0 } = await sharp(path).metadata();
    // Tall page captures become screen-sized tiles so detail survives resizing.
    const tileH = Math.round(width * 0.7);
    const tiles = height > width * 1.6 && width > 0 ? Math.min(3, Math.ceil(height / tileH)) : 1;
    for (let t = 0; t < tiles && out.length < MAX_IMAGES + 4; t++) {
      const top = tiles === 1 ? 0 : Math.round(((height - tileH) * t) / Math.max(1, tiles - 1));
      const base = tiles === 1 ? sharp(path) : sharp(path).extract({ left: 0, top, width, height: Math.min(tileH, height - top) });
      const jpeg = await base.resize({ width: maxWidth, height: Math.round(maxWidth * 1.25), fit: "inside", withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
      out.push({ n: out.length + 1, artifact: `evidence/${source.id}/${file}`, jpeg });
    }
  }
  return out;
};

const POLARITIES = ["must", "never", "should", "avoid", "fact"] as const;
const clamp = (n: number): number => Math.min(1, Math.max(0, n));

/** Turn a vision reply into a stored extraction. The reader is recorded, so evidence says who looked. */
export const visionExtraction = (source: Source, images: readonly Pick<VisionImage, "n" | "artifact">[], reply: VisionReply, reader: string, started = new Date()): Extraction => {
  const collector = new ObservationCollector(source.id, "vision", "inferred");
  const evidenceFor = (cited: number[] | undefined): Evidence[] => {
    const picked = (cited?.length ? cited : [1]).map((n) => images.find((img) => img.n === n)).filter((x): x is Pick<VisionImage, "n" | "artifact"> => Boolean(x));
    return (picked.length ? picked : images.slice(0, 1)).map((img) => ({ sourceId: source.id, locator: { type: "whole" as const }, artifact: img.artifact, note: `vision reading by ${reader}` }));
  };
  for (const rule of reply.rules ?? []) {
    const statement = rule.statement?.trim();
    if (!statement) continue;
    const polarity = (POLARITIES as readonly string[]).includes(rule.polarity ?? "") ? (rule.polarity as (typeof POLARITIES)[number]) : "fact";
    collector.add({ value: { kind: "rule", statement, polarity, topic: rule.topic ?? "imagery" } satisfies ObservationValue, evidence: evidenceFor(rule.images), confidence: clamp(rule.confidence ?? 0.5) });
  }
  for (const label of reply.labels ?? []) {
    if (!label.metric || !label.label) continue;
    collector.add({ value: { kind: "imagery", metric: label.metric, value: 1, label: label.label }, evidence: evidenceFor(label.images), confidence: clamp(label.confidence ?? 0.5) });
  }
  return finishExtraction(source, visionExtractor, started, collector.list(), ["rule", "imagery"], ["Vision readings are inferred judgements; treat single-source ones as hypotheses."], {
    reader,
    images: images.map((i) => i.artifact),
  });
};

/** Headless path: call the Anthropic API directly (needs ANTHROPIC_API_KEY). */
export const visionExtractor: Extractor = {
  name: "vision",
  version: "1.1.0",
  async extract({ project, source, log }: ExtractContext) {
    const started = new Date();
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error("No ANTHROPIC_API_KEY. Without a key, run the vision pass from Claude through the MCP tools genome_vision_request and genome_vision_submit, which use the connected Claude conversation.");
    }
    const images = await visionImages(project, source);
    const content: unknown[] = [];
    for (const img of images) {
      content.push({ type: "text", text: `Image ${img.n}` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.jpeg.toString("base64") } });
    }
    content.push({ type: "text", text: VISION_PROMPT });
    const model = process.env.GENOME_VISION_MODEL ?? "claude-sonnet-5-5";
    log(`vision: asking ${model} about ${images.length} image(s)`);
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 3000, messages: [{ role: "user", content }] }),
    });
    if (!response.ok) throw new Error(`Vision request failed (${response.status}): ${await response.text()}`);
    const body = (await response.json()) as { content: { type: string; text?: string }[] };
    const text = body.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    return visionExtraction(source, images, parseReply(text), model, started);
  },
};

export const parseReply = (text: string): VisionReply => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    return JSON.parse(text.slice(start, end + 1)) as VisionReply;
  } catch {
    return {};
  }
};
