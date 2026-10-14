import sharp from "sharp";

import { normalizeColor } from "../core/color.js";
import type { Evidence } from "../core/types.js";
import { analyzeImage, type ImageAnalysis } from "./image.analyze.js";
import { ensureLocal } from "./local.js";
import { ObservationCollector, finishExtraction, type ExtractContext, type Extractor } from "./support.js";

export const IMAGERY_DESCRIPTIONS: Record<string, string> = {
  lightness: "mean lightness (0 dark – 1 bright)",
  contrast: "tonal contrast (lightness spread)",
  chroma: "saturation (mean chroma)",
  warmth: "temperature (>0 warm, <0 cool)",
  tint: "tint (>0 magenta, <0 green)",
  negativeSpace: "negative space share",
  detail: "visual busyness",
  symmetry: "left-right symmetry",
  focusX: "horizontal center of visual weight",
  focusY: "vertical center of visual weight",
  shadowsShare: "share of crushed shadows",
  highlightsShare: "share of clipped highlights",
  aspect: "aspect ratio (w/h)",
};

/** Turn one pixel analysis into observations. Shared with the video extractor. */
export const addImageObservations = (
  collector: ObservationCollector,
  analysis: ImageAnalysis,
  sourceId: string,
  evidenceFor: (region?: { x: number; y: number; w: number; h: number }) => Evidence,
  weight = 1,
  usage = "image",
): void => {
  for (const entry of analysis.palette) {
    const color = normalizeColor(entry.hex);
    if (!color) continue;
    collector.add({
      value: { kind: "color", ...color, share: entry.share * weight },
      context: { usage },
      evidence: evidenceFor(entry.region),
      confidence: 0.7,
    });
  }
  for (const [metric, value] of Object.entries(analysis.metrics)) {
    collector.add({ value: { kind: "imagery", metric, value }, evidence: evidenceFor(), confidence: 0.65, key: `${metric}|${sourceId}|${collector.size}` });
  }
  collector.add({ value: { kind: "imagery", metric: "aspect", value: analysis.aspect }, evidence: evidenceFor(), confidence: 0.95, key: `aspect|${collector.size}` });
  for (const [side, value] of Object.entries(analysis.margins)) {
    collector.add({ value: { kind: "layout", metric: `margin-${side}`, value, unit: "share" }, evidence: evidenceFor(), confidence: 0.45, key: `margin-${side}|${collector.size}` });
  }
  if (analysis.columns > 0) {
    collector.add({ value: { kind: "layout", metric: "columns", value: analysis.columns }, evidence: evidenceFor(), confidence: 0.35, key: `columns|${collector.size}` });
  }
};

export const imageExtractor: Extractor = {
  name: "image",
  version: "1.0.0",
  async extract(context: ExtractContext) {
    const { project, source } = context;
    const started = new Date();
    const path = await ensureLocal(context);
    const analysis = await analyzeImage(path);
    const collector = new ObservationCollector(source.id, "image", "estimated");
    const preview = await project.artifact(source.id, "preview.jpg");
    await sharp(path, { failOn: "none" }).rotate().resize({ width: 1200, withoutEnlargement: true }).flatten({ background: "#fff" }).jpeg({ quality: 80 }).toFile(preview.abs);
    const evidenceFor = (region?: { x: number; y: number; w: number; h: number }): Evidence => ({
      sourceId: source.id,
      locator: region ? { type: "region", box: region, imageWidth: analysis.width, imageHeight: analysis.height } : { type: "whole" },
      artifact: preview.rel,
    });
    addImageObservations(collector, analysis, source.id, evidenceFor);
    const limitations = [
      "Pixel measurements are relative: absolute sizes need calibration against an exact source (link this image to the page it depicts).",
      "Typography, components and copy are not read from pixels without the vision extractor.",
    ];
    return finishExtraction(source, imageExtractor, started, collector.list(), ["color", "imagery", "layout"], limitations, {
      width: analysis.width,
      height: analysis.height,
      aspect: analysis.aspect,
      margins: analysis.margins,
    });
  },
};
