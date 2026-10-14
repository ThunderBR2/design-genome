import { readdir } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

import type { Evidence, ObservationValue } from "../core/types.js";
import { ObservationCollector, finishExtraction, type ExtractContext, type Extractor } from "./support.js";

/**
 * Vision pass: asks a multimodal model for art-direction and composition rules
 * that pixels alone cannot name (lighting setup, camera angle, subject framing,
 * typographic treatment, copy tone). Output is "inferred" and must cite the frame
 * it came from; the reconciler only promotes it when other sources agree.
 *
 * Runs only when ANTHROPIC_API_KEY is set. It reads the evidence artifacts the
 * primary extractor already produced, so run it after "genome extract".
 */

const PROMPT = `You are a senior art director reverse-engineering a brand's visual system.
You get numbered images from one source. Describe only what is visible; never guess the brand.
Return strict JSON, no prose:
{"rules":[{"topic":"imagery|composition|lighting|camera|typography|layout|color|voice|iconography|motion",
 "statement":"one precise, reusable rule an AI could follow (e.g. 'Product isolated on a seamless light-grey background with a soft contact shadow')",
 "polarity":"must|never|should|avoid|fact","confidence":0.0-1.0,"images":[1,2]}],
 "labels":[{"metric":"camera-angle|shot-size|lighting|background|depth-of-field|subject|grade","label":"short value","confidence":0.0-1.0,"images":[1]}]}
Prefer rules that hold across several images. 6-16 rules, 3-10 labels.`;

interface VisionReply {
  rules?: { topic?: string; statement?: string; polarity?: string; confidence?: number; images?: number[] }[];
  labels?: { metric?: string; label?: string; confidence?: number; images?: number[] }[];
}

const MAX_IMAGES = 8;

export const visionExtractor: Extractor = {
  name: "vision",
  version: "1.0.0",
  async extract({ project, source, log }: ExtractContext) {
    const started = new Date();
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("The vision extractor needs ANTHROPIC_API_KEY.");
    const dir = join(project.root, "evidence", source.id);
    const files = (await readdir(dir).catch(() => [] as string[]))
      .filter((f) => /^(preview|shot-\d+|page-\d+|page-?\d*)\.(jpe?g|png)$/i.test(f) && !f.endsWith("-b.jpg"))
      .sort();
    if (files.length === 0) throw new Error(`No evidence images for ${source.id}. Run the primary extraction first.`);
    const step = Math.max(1, Math.ceil(files.length / MAX_IMAGES));
    const chosen = files.filter((_, i) => i % step === 0).slice(0, MAX_IMAGES);
    const content: unknown[] = [];
    for (const [i, file] of chosen.entries()) {
      const buffer = await sharp(join(dir, file)).resize({ width: 1280, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
      content.push({ type: "text", text: `Image ${i + 1}` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: buffer.toString("base64") } });
    }
    content.push({ type: "text", text: PROMPT });
    const model = process.env.GENOME_VISION_MODEL ?? "claude-sonnet-5-5";
    log(`vision: asking ${model} about ${chosen.length} image(s)`);
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 3000, messages: [{ role: "user", content }] }),
    });
    if (!response.ok) throw new Error(`Vision request failed (${response.status}): ${await response.text()}`);
    const body = (await response.json()) as { content: { type: string; text?: string }[] };
    const text = body.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    const reply = parseReply(text);
    const collector = new ObservationCollector(source.id, "vision", "inferred");
    const evidenceFor = (images: number[] | undefined): Evidence[] => {
      const picked = (images ?? [1]).map((n) => chosen[n - 1]).filter((f): f is string => Boolean(f));
      return (picked.length ? picked : [chosen[0]!]).map((f) => ({ sourceId: source.id, locator: { type: "whole" as const }, artifact: `evidence/${source.id}/${f}`, note: "vision model reading" }));
    };
    for (const rule of reply.rules ?? []) {
      if (!rule.statement) continue;
      const polarity = (["must", "never", "should", "avoid", "fact"].includes(rule.polarity ?? "") ? rule.polarity : "fact") as Extract<ObservationValue, { kind: "rule" }>["polarity"];
      collector.add({ value: { kind: "rule", statement: rule.statement, polarity, topic: rule.topic ?? "imagery" }, evidence: evidenceFor(rule.images), confidence: clamp(rule.confidence ?? 0.5) });
    }
    for (const label of reply.labels ?? []) {
      if (!label.metric || !label.label) continue;
      collector.add({ value: { kind: "imagery", metric: label.metric, value: 1, label: label.label }, evidence: evidenceFor(label.images), confidence: clamp(label.confidence ?? 0.5) });
    }
    return finishExtraction(source, visionExtractor, started, collector.list(), ["rule", "imagery"], [
      "Vision readings are inferred judgements; treat single-source ones as hypotheses.",
    ], { model, images: chosen });
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

const clamp = (n: number): number => Math.min(1, Math.max(0, n));
