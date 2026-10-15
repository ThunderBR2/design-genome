import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";

import { normalizeColor } from "../core/color.js";
import type { ObservationValue } from "../core/types.js";
import { ensureLocal } from "./local.js";
import { ObservationCollector, finishExtraction, type ExtractContext, type Extractor } from "./support.js";

const run = promisify(execFile);

/** What a brand document declares. Everything here is "declared" precision. */
export interface DocumentFinding {
  readonly page: number;
  readonly quote: string;
  readonly value: ObservationValue;
  readonly role?: string;
}

const KNOWN_FAMILIES = [
  "SF Pro Display", "SF Pro Text", "SF Pro", "SF Compact", "New York", "Helvetica Neue", "Helvetica", "Inter", "Roboto",
  "Open Sans", "Montserrat", "Poppins", "Lato", "Futura", "Gotham", "Proxima Nova", "Avenir Next", "Avenir", "Circular",
  "Graphik", "Aeonik", "Neue Haas Grotesk", "Suisse Int'l", "DM Sans", "Manrope", "Playfair Display", "Garamond",
  "Didot", "Bodoni", "Gilroy", "Satoshi", "Space Grotesk", "Geist", "Work Sans", "IBM Plex Sans", "Source Sans Pro",
  "Noto Sans", "Google Sans", "Product Sans", "Segoe UI", "Arial",
];

const ROLE_WORDS: readonly [RegExp, string][] = [
  [/\b(display|hero)\b/i, "display"],
  [/\b(headline|heading|h1|h2|título|titulo|manchete)\b/i, "headline"],
  [/\b(title|subtitle|subtítulo|subtitulo|h3|h4)\b/i, "title"],
  [/\b(body|paragraph|texto|corpo)\b/i, "body"],
  [/\b(caption|legal|footnote|legenda|nota)\b/i, "caption"],
  [/\b(button|cta|botão|botao)\b/i, "button"],
];

const POLARITY: readonly [RegExp, "must" | "never" | "should" | "avoid"][] = [
  [/\b(never|do not|don't|must not|cannot|nunca|não (use|utilize|aplique|altere|distorça|coloque)|nao (use|utilize)|proibido|jamais)\b/i, "never"],
  [/\b(avoid|evite|evitar)\b/i, "avoid"],
  [/\b(must|always|required|minimum|maximum|at least|at most|no more than|sempre|deve|devem|obrigatório|obrigatorio|mínimo|minimo|máximo|maximo|pelo menos|no máximo)\b/i, "must"],
  [/\b(should|prefer|recommended|recomendado|prefira|preferencialmente|ideal)\b/i, "should"],
];

const TOPICS: readonly [RegExp, string][] = [
  [/\b(colou?r|palette|cor(es)?|paleta|pantone|cmyk|rgb|hex)\b/i, "color"],
  [/\b(logo|logotipo|marca|símbolo|simbolo|wordmark|lockup)\b/i, "logo"],
  [/\b(type|typeface|font|fonts|typography|fonte|tipografia|letra|headlines?|uppercase|caps|caixa alta|títulos?|titulos?)\b/i, "typography"],
  [/\b(spacing|margin|grid|padding|espaçamento|espacamento|margem|respiro|grade)\b/i, "spacing"],
  [/\b(photo|photography|image|imagery|backgrounds?|props|foto|fotografia|imagem|imagens|fundos?|cenário|cenario)\b/i, "imagery"],
  [/\b(motion|animation|transition|animação|animacao|movimento)\b/i, "motion"],
  [/\b(tone|voice|copy|tom|voz|linguagem|texto)\b/i, "voice"],
  [/\b(icon|ícone|icone|iconografia)\b/i, "iconography"],
];

const sentenceSplit = (text: string): string[] =>
  text
    .split(/(?<=[.!?;])\s+|\n+|•|·|▪|–\s/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 8 && s.length <= 280);

const nearestLabel = (line: string, index: number): string | undefined => {
  const before = line.slice(Math.max(0, index - 40), index).replace(/[:#\-–|]+\s*$/, "").trim();
  const words = before.split(/\s{2,}|[|,;]/).pop()?.trim();
  return words && /[A-Za-zÀ-ú]/.test(words) && words.length <= 36 ? words : undefined;
};

/** Parse declared design facts out of plain text pages. Pure, for testing. */
export const parseDocumentText = (pages: readonly string[]): DocumentFinding[] => {
  const findings: DocumentFinding[] = [];
  pages.forEach((text, i) => {
    const page = i + 1;
    for (const line of text.split(/\n/)) {
      for (const m of line.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
        const color = normalizeColor(`#${m[1]}`);
        if (!color) continue;
        const label = nearestLabel(line, m.index ?? 0);
        const pantone = line.match(/\b(?:pantone|pms)\s*([\w-]+(?:\s?[cu])?)\b/i)?.[1];
        const cmyk = line.match(/\bcmyk\s*[:=]?\s*([\d.]+[\s,/]+[\d.]+[\s,/]+[\d.]+[\s,/]+[\d.]+)/i)?.[1];
        findings.push({ page, quote: line.trim().slice(0, 160), role: label, value: { kind: "color", ...color, share: 0, pantone, cmyk } });
      }
      for (const m of line.matchAll(/\brgb\s*[:(]?\s*(\d{1,3})[\s,/]+(\d{1,3})[\s,/]+(\d{1,3})\)?/gi)) {
        const color = normalizeColor(`rgb(${m[1]}, ${m[2]}, ${m[3]})`);
        if (color && !findings.some((f) => f.page === page && f.value.kind === "color" && f.value.hex === color.hex)) {
          findings.push({ page, quote: line.trim().slice(0, 160), role: nearestLabel(line, m.index ?? 0), value: { kind: "color", ...color, share: 0 } });
        }
      }
      for (const family of KNOWN_FAMILIES) {
        const re = new RegExp(`\\b${family.replace(/[.*+?^${}()|[\]\\']/g, "\\$&")}\\b`, "i");
        if (re.test(line) && !findings.some((f) => f.page === page && f.value.kind === "typography" && f.value.family === family && f.quote === line.trim().slice(0, 160))) {
          // Longer names first in KNOWN_FAMILIES; skip "SF Pro" when "SF Pro Display" already matched this line.
          if (findings.some((f) => f.page === page && f.value.kind === "typography" && f.quote === line.trim().slice(0, 160) && f.value.family.startsWith(family))) continue;
          const role = ROLE_WORDS.find(([r]) => r.test(line))?.[1];
          const size = line.match(/\b(\d{1,3}(?:\.\d+)?)\s*(px|pt)\b/i);
          const weightWord = line.match(/\b(thin|light|regular|medium|semibold|bold|heavy|black)\b/i)?.[1]?.toLowerCase();
          findings.push({
            page,
            quote: line.trim().slice(0, 160),
            role,
            value: {
              kind: "typography",
              family,
              ...(size ? { sizePx: Math.round(Number(size[1]) * (size[2]!.toLowerCase() === "pt" ? 4 / 3 : 1) * 10) / 10 } : {}),
              ...(weightWord ? { weight: WEIGHTS[weightWord] } : {}),
            },
          });
        }
      }
    }
    for (const sentence of sentenceSplit(text)) {
      const polarity = POLARITY.find(([r]) => r.test(sentence))?.[1];
      if (!polarity) continue;
      const check = checkFor(sentence, polarity);
      const checkTopic = check ? ({ "font-family": "typography", "no-uppercase": "typography", "min-size": "typography", "max-colors": "color", palette: "color", "spacing-unit": "spacing" } as const)[check.type] : undefined;
      const topic = checkTopic ?? TOPICS.find(([r]) => r.test(sentence))?.[1] ?? "general";
      findings.push({ page, quote: sentence, value: { kind: "rule", statement: sentence, polarity, topic, check } });
    }
    const unit = text.match(/\b(\d{1,2})\s*(?:px|pt)?\s*(?:grid|base unit|unidade base|grade de)\b|\b(?:grid|grade)\s*(?:de|of)?\s*(\d{1,2})\s*px\b/i);
    if (unit) {
      const px = Number(unit[1] ?? unit[2]);
      if (px >= 2 && px <= 24) findings.push({ page, quote: unit[0], value: { kind: "rule", statement: `Spacing uses a ${px}px base unit.`, polarity: "must", topic: "spacing", check: { type: "spacing-unit", px } } });
    }
  });
  const colors = findings.filter((f) => f.value.kind === "color");
  if (colors.length >= 2) {
    const hexes = [...new Set(colors.map((f) => (f.value as { hex: string }).hex))];
    findings.push({ page: colors[0]!.page, quote: `${hexes.length} colors listed`, value: { kind: "rule", statement: `The official palette is ${hexes.join(", ")}.`, polarity: "fact", topic: "color", check: { type: "palette", hexes } } });
  }
  return findings;
};

const WEIGHTS: Record<string, number> = { thin: 100, light: 300, regular: 400, medium: 500, semibold: 600, bold: 700, heavy: 800, black: 900 };

const checkFor = (sentence: string, polarity: string): Extract<ObservationValue, { kind: "rule" }>["check"] => {
  const maxColors = sentence.match(/(?:no more than|maximum of|max(?:imum)?|até|máximo de|maximo de|no máximo)\s*(\d+)\s*(?:colou?rs|cores)/i);
  if (maxColors) return { type: "max-colors", max: Number(maxColors[1]) };
  if (/(uppercase|all caps|caixa alta|maiúsculas|maiusculas)/i.test(sentence) && (polarity === "never" || polarity === "avoid")) return { type: "no-uppercase" };
  const minSize = sentence.match(/(?:minimum|at least|mínimo|minimo|pelo menos)[^.\d]{0,30}(\d{1,3})\s*(px|pt)/i);
  if (minSize) return { type: "min-size", px: Number(minSize[1]) * (minSize[2]!.toLowerCase() === "pt" ? 4 / 3 : 1) };
  const families = KNOWN_FAMILIES.filter((f) => new RegExp(`\\b${f.replace(/[.*+?^${}()|[\]\\']/g, "\\$&")}\\b`, "i").test(sentence));
  if (families.length && polarity === "must") return { type: "font-family", families };
  return undefined;
};

const htmlToText = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ");

const readPdfPages = async (path: string): Promise<string[]> => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await readFile(path));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = "";
    let lastY: number | null = null;
    for (const item of content.items as { str: string; transform: number[]; hasEOL?: boolean }[]) {
      const y = item.transform[5] ?? 0;
      if (lastY !== null && Math.abs(y - lastY) > 2) text += "\n";
      text += item.str + (item.hasEOL ? "\n" : " ");
      lastY = y;
    }
    pages.push(text);
  }
  await doc.destroy();
  return pages;
};

export const documentExtractor: Extractor = {
  name: "document",
  version: "1.0.0",
  async extract(context: ExtractContext) {
    const { project, source, log } = context;
    const started = new Date();
    const path = await ensureLocal(context);
    const ext = extname(path).toLowerCase();
    const limitations: string[] = [];
    let pages: string[];
    const previews = new Map<number, string>();
    if (ext === ".pdf") {
      pages = await readPdfPages(path);
      try {
        const dir = (await project.artifact(source.id, "x")).abs.replace(/x$/, "");
        await run("pdftoppm", ["-r", "60", "-jpeg", "-l", "60", path, join(dir, "page")]);
        for (const file of await readdir(dir)) {
          const m = file.match(/^page-0*(\d+)\.jpg$/);
          if (m) previews.set(Number(m[1]), `evidence/${source.id}/${file}`);
        }
      } catch {
        limitations.push("Page previews need pdftoppm (poppler); text was still read.");
      }
      if (pages.every((p) => p.trim().length < 20)) limitations.push("The PDF has little or no text layer (scanned or outlined). Run it through OCR or add its pages as images.");
    } else {
      const raw = await readFile(path, "utf8");
      pages = [ext === ".html" || ext === ".htm" ? htmlToText(raw) : raw];
    }
    log(`document: ${pages.length} page(s)`);
    // A case study written by a third party describes the work; it is not the brand declaring rules.
    const collector = new ObservationCollector(source.id, "document", source.options.caseStudy ? "inferred" : "declared");
    for (const finding of parseDocumentText(pages)) {
      collector.add({
        value: finding.value,
        context: finding.role ? { role: finding.value.kind === "color" ? finding.role : finding.role } : {},
        evidence: { sourceId: source.id, locator: { type: "page", page: finding.page, quote: finding.quote }, artifact: previews.get(finding.page) },
        confidence: finding.value.kind === "rule" ? 0.75 : 0.9,
      });
    }
    limitations.push("Declared rules come from the document's wording; layouts and visuals on its pages are not measured.");
    return finishExtraction(source, documentExtractor, started, collector.list(), ["color", "typography", "rule"], limitations, { pages: pages.length });
  },
};
