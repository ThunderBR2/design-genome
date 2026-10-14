import { readFile } from "node:fs/promises";

import { normalizeColor, rgbToHex } from "../core/color.js";
import type { Evidence } from "../core/types.js";
import { ObservationCollector, finishExtraction, type ExtractContext, type Extractor } from "./support.js";

interface FigmaColor { r: number; g: number; b: number; a: number }
interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  fills?: { type: string; color?: FigmaColor; opacity?: number; visible?: boolean }[];
  strokes?: { type: string; color?: FigmaColor; visible?: boolean }[];
  style?: { fontFamily?: string; fontSize?: number; fontWeight?: number; lineHeightPx?: number; letterSpacing?: number; textCase?: string };
  characters?: string;
  cornerRadius?: number;
  itemSpacing?: number;
  paddingLeft?: number; paddingRight?: number; paddingTop?: number; paddingBottom?: number;
  effects?: { type: string; visible?: boolean; radius?: number; offset?: { x: number; y: number }; color?: FigmaColor; spread?: number }[];
  absoluteBoundingBox?: { width: number; height: number };
}

export const figmaFileKey = (uri: string): string | null => uri.match(/figma\.com\/(?:file|design|proto)\/([A-Za-z0-9]+)/)?.[1] ?? null;

/** node-id from a Figma link ("1-23" in URLs is "1:23" in the API). */
export const figmaNodeId = (uri: string): string | null => {
  try {
    const id = new URL(uri).searchParams.get("node-id");
    return id ? id.replace(/-/g, ":") : null;
  } catch {
    return null;
  }
};

const hexOf = (c: FigmaColor): string => rgbToHex(Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255));

const roleForSize = (size: number, body: number): string => {
  const r = size / body;
  if (r >= 2.6) return "display";
  if (r >= 1.75) return "headline";
  if (r >= 1.2) return "title";
  if (r >= 0.95) return "body";
  if (r >= 0.8) return "callout";
  return "caption";
};

/** Walk a Figma document tree into observations. Exported for offline use and tests. */
export const observeFigmaDocument = (document: FigmaNode, sourceId: string, collector: ObservationCollector): number => {
  const texts: FigmaNode[] = [];
  const walk = (node: FigmaNode, fn: (n: FigmaNode) => void): void => {
    if (node.visible === false) return;
    fn(node);
    for (const child of node.children ?? []) walk(child, fn);
  };
  walk(document, (n) => { if (n.type === "TEXT" && n.style?.fontSize) texts.push(n); });
  const sizeWeight = new Map<number, number>();
  for (const t of texts) sizeWeight.set(t.style!.fontSize!, (sizeWeight.get(t.style!.fontSize!) ?? 0) + (t.characters?.length ?? 1));
  const body = [...sizeWeight.entries()].filter(([s]) => s >= 12 && s <= 20).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 16;
  let nodes = 0;
  walk(document, (node) => {
    nodes++;
    const ev: Evidence = { sourceId, locator: { type: "figma-node", nodeId: node.id, name: node.name } };
    for (const fill of node.fills ?? []) {
      if (fill.type !== "SOLID" || fill.visible === false || !fill.color) continue;
      const color = normalizeColor(hexOf(fill.color));
      if (color) collector.add({ value: { kind: "color", ...color, alpha: (fill.opacity ?? 1) * fill.color.a, share: 0 }, context: { usage: node.type === "TEXT" ? "text" : "fill" }, evidence: ev });
    }
    for (const stroke of node.strokes ?? []) {
      if (stroke.type !== "SOLID" || stroke.visible === false || !stroke.color) continue;
      const color = normalizeColor(hexOf(stroke.color));
      if (color) collector.add({ value: { kind: "color", ...color, share: 0 }, context: { usage: "border" }, evidence: ev });
    }
    if (node.type === "TEXT" && node.style?.fontFamily && node.style.fontSize) {
      const s = node.style;
      const size = s.fontSize!;
      collector.add({
        value: {
          kind: "typography",
          family: s.fontFamily!,
          sizePx: size,
          weight: s.fontWeight,
          lineHeight: s.lineHeightPx ? Math.round((s.lineHeightPx / size) * 1000) / 1000 : undefined,
          trackingEm: s.letterSpacing ? Math.round((s.letterSpacing / size) * 10000) / 10000 : 0,
          transform: s.textCase === "UPPER" ? "uppercase" : undefined,
          sample: node.characters?.slice(0, 60),
        },
        context: { role: roleForSize(size, body), component: node.name.slice(0, 40) },
        evidence: ev,
      });
      if (size / body >= 1.75 && node.characters) {
        collector.add({ value: { kind: "voice", text: node.characters.slice(0, 160), words: node.characters.split(/\s+/).filter(Boolean).length, role: roleForSize(size, body) }, evidence: ev });
      }
    }
    if (node.cornerRadius && node.cornerRadius > 0) {
      const h = node.absoluteBoundingBox?.height ?? Infinity;
      collector.add({ value: { kind: "radius", px: node.cornerRadius >= h / 2 ? 9999 : node.cornerRadius }, context: { component: node.type.toLowerCase() }, evidence: ev });
    }
    for (const [value, axis, usage] of [
      [node.itemSpacing, "both", "gap"], [node.paddingTop, "y", "padding"], [node.paddingBottom, "y", "padding"],
      [node.paddingLeft, "x", "padding"], [node.paddingRight, "x", "padding"],
    ] as const) {
      if (value && value > 0) collector.add({ value: { kind: "spacing", px: value, axis }, context: { usage }, evidence: ev });
    }
    for (const effect of node.effects ?? []) {
      if (effect.type !== "DROP_SHADOW" || effect.visible === false || !effect.color) continue;
      const c = effect.color;
      const css = `${effect.offset?.x ?? 0}px ${effect.offset?.y ?? 0}px ${effect.radius ?? 0}px ${effect.spread ?? 0}px rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${Math.round(c.a * 100) / 100})`;
      collector.add({ value: { kind: "shadow", css, blurPx: effect.radius, offsetYPx: effect.offset?.y }, evidence: ev });
    }
  });
  return nodes;
};

export const figmaExtractor: Extractor = {
  name: "figma",
  version: "1.0.0",
  async extract({ source, log }: ExtractContext) {
    const started = new Date();
    let file: { name?: string; document: FigmaNode };
    const offline = source.options.json as string | undefined;
    if (offline) {
      file = JSON.parse(await readFile(offline, "utf8"));
    } else {
      const key = figmaFileKey(source.uri);
      if (!key) throw new Error(`Not a Figma file URL: ${source.uri}`);
      const token = (source.options.token as string | undefined) ?? process.env.FIGMA_TOKEN;
      if (!token) throw new Error("Figma sources need a personal access token in FIGMA_TOKEN.");
      const nodeId = figmaNodeId(source.uri);
      log(`figma: fetching ${nodeId ? `frame ${nodeId} of ` : ""}file ${key}`);
      const url = nodeId ? `https://api.figma.com/v1/files/${key}/nodes?ids=${encodeURIComponent(nodeId)}&geometry=omit` : `https://api.figma.com/v1/files/${key}?geometry=omit`;
      const response = await fetch(url, { headers: { "X-Figma-Token": token } });
      if (!response.ok) throw new Error(`Figma API ${response.status}: ${await response.text()}`);
      const body = (await response.json()) as { name?: string; document?: FigmaNode; nodes?: Record<string, { document: FigmaNode }> };
      const document = nodeId ? body.nodes?.[nodeId]?.document : body.document;
      if (!document) throw new Error(`Figma returned no document${nodeId ? ` for node ${nodeId}` : ""}.`);
      file = { name: body.name, document };
    }
    const collector = new ObservationCollector(source.id, "figma", "exact");
    const nodes = observeFigmaDocument(file.document, source.id, collector);
    return finishExtraction(source, figmaExtractor, started, collector.list(), ["color", "typography", "spacing", "radius", "shadow", "voice"], [
      "Figma variables, prototype motion and component variants are not read by the REST file endpoint.",
      "Values are what the file specifies; shipped products may differ (add the live site to compare).",
    ], { name: file.name, nodes });
  },
};
