import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import sharp from "sharp";

import { normalizeColor } from "../core/color.js";
import { primaryFamily } from "../core/fonts.js";
import type { Evidence } from "../core/types.js";
import { ObservationCollector, finishExtraction, type ExtractContext, type Extractor } from "./support.js";
import { collectPage, dismissOverlays, hideScreenChrome, interstitialProbe, paintCheck, tagElements, type PageCollection, type PageElement, type PaintRecord } from "./web.page.js";

export const DEFAULT_VIEWPORTS = [390, 1440] as const;
const MAX_ELEMENTS = 5000;
const MAX_SCREENSHOT_HEIGHT = 16000;

/** Text role from size relative to the page's body size, plus the tag as a hint. */
export const textRole = (el: Pick<PageElement, "tag" | "fontSize" | "isInteractive">, bodySize: number): string => {
  const ratio = el.fontSize / bodySize;
  if (el.isInteractive && ratio < 1.6) return el.tag === "button" ? "button" : "link";
  if (ratio >= 2.6) return "display";
  if (ratio >= 1.75) return "headline";
  if (ratio >= 1.2) return "title";
  if (ratio >= 0.95) return "body";
  if (ratio >= 0.8) return "callout";
  return "caption";
};

export const parseLineHeight = (value: string, size: number): number | undefined => {
  if (!value || value === "normal") return undefined;
  const n = parseFloat(value);
  if (!Number.isFinite(n) || size <= 0) return undefined;
  return Math.round((value.endsWith("px") ? n / size : n) * 1000) / 1000;
};

export const parseTracking = (value: string, size: number): number => {
  if (!value || value === "normal" || size <= 0) return 0;
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((value.endsWith("em") ? n : n / size) * 10000) / 10000;
};

export const parseDurations = (value: string): number[] =>
  value
    .split(",")
    .map((d) => d.trim())
    .map((d) => (d.endsWith("ms") ? parseFloat(d) : parseFloat(d) * 1000))
    .filter((d) => Number.isFinite(d));

export const splitTopLevel = (value: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
};

export const mediaBreakpoints = (query: string): number[] => {
  const out: number[] = [];
  const re = /(min|max)-width\s*:\s*([\d.]+)(px|em|rem)|width\s*[<>]=?\s*([\d.]+)(px|em|rem)/gi;
  for (const m of query.matchAll(re)) {
    const value = parseFloat(m[2] ?? m[4] ?? "");
    const unit = (m[3] ?? m[5] ?? "px").toLowerCase();
    const pxValue = unit === "px" ? value : value * 16;
    if (Number.isFinite(pxValue) && pxValue >= 200 && pxValue <= 3000) out.push(Math.round(m[1]?.toLowerCase() === "max" ? pxValue + 1 : pxValue));
  }
  return out;
};

const bodySizeOf = (elements: readonly PageElement[]): number => {
  const counts = new Map<number, number>();
  for (const el of elements) {
    if (!el.ownText || el.text.length < 40 || el.isInteractive) continue;
    counts.set(el.fontSize, (counts.get(el.fontSize) ?? 0) + el.text.length);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best?.[0] ?? 16;
};

export const webExtractor: Extractor = {
  name: "web",
  version: "1.2.0",
  /** 1.2 captures screen by screen and keeps only what was painted: older captures are redone. */
  recaptureBelow: "1.2.0",
  async extract({ project, source, log }: ExtractContext) {
    const started = new Date();
    const { chromium } = await import("playwright");
    const viewports = (source.options.viewports as number[] | undefined) ?? [...DEFAULT_VIEWPORTS];
    const collector = new ObservationCollector(source.id, "web", "exact");
    const limitations: string[] = [];
    const meta: Record<string, unknown> = { viewports, renderedFonts: {} as Record<string, string[]> };
    // A saved page (local .html added with kind "web") renders from its stored copy.
    const local = project.localPath(source);
    const target = local ? pathToFileURL(local).href : source.uri;
    const browser = await chromium.launch({ headless: true });
    try {
      for (const viewport of viewports) {
        log(`web: rendering ${target} at ${viewport}px`);
        const context = await browser.newContext({
          viewport: { width: viewport, height: viewport < 700 ? 844 : 900 },
          deviceScaleFactor: 1,
          colorScheme: (source.options.colorScheme as "light" | "dark" | undefined) ?? "light",
          reducedMotion: "no-preference",
        });
        // Bundlers may inject a __name helper into serialized functions.
        await context.addInitScript("window.__name = (f) => f;");
        const page = await context.newPage();
        try {
          const response = await page.goto(target, { waitUntil: "load", timeout: 60_000 });
          await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => limitations.push(`Network never went idle at ${viewport}px; late content may be missing.`));
          await page.evaluate("window.__name = (f) => f;");
          await assertRealPage(page, target, response?.status());
          const dismissed = (await page.evaluate(dismissOverlays)) as string[];
          if (dismissed.length) {
            limitations.push(`A consent layer was dismissed at ${viewport}px (clicked "${dismissed.join('", "')}").`);
            await page.waitForTimeout(600);
          }
          await autoScroll(page);
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          await page.evaluate(tagElements);
          const collected = (await page.evaluate(collectPage, MAX_ELEMENTS)) as PageCollection;
          if (collected.truncated) limitations.push(`Only the first ${MAX_ELEMENTS} visible elements were sampled at ${viewport}px.`);
          for (const href of collected.blockedSheets) limitations.push(`Stylesheet ${href} is cross-origin; its media queries and variables were not read (computed styles still are).`);

          const shot = await project.artifact(source.id, `page-${viewport}.jpg`);
          const capture = await captureScreens(page, viewport, viewport < 700 ? 844 : 900, shot.abs);
          limitations.push(...capture.limitations);
          // Boxes as they were painted on the screens the capture shows, and only what was painted.
          const data: PageCollection = { ...collected, docHeight: capture.height, elements: collected.elements.flatMap((el) => {
            const rec = capture.records.get(el.idx);
            if (!rec || !rec.painted) return [];
            return [{ ...el, box: rec.box, ...(rec.textBox ? { textBox: rec.textBox } : {}) }];
          }) };
          const unpainted = collected.elements.filter((el) => { const r = capture.records.get(el.idx); return r && !r.painted && el.ownText; }).length;
          if (unpainted) limitations.push(`${unpainted} text element(s) exist in the page code but were never painted at ${viewport}px (hidden, transparent or covered); they were left out of the measurements.`);

          const layout = await project.artifact(source.id, `layout-${viewport}.json`);
          await writeFile(layout.abs, JSON.stringify(layoutDump(data, { method: capture.method, screens: capture.screens, hiddenChrome: capture.hiddenChrome, unpaintedText: unpainted })));
          const rendered = await renderedFonts(page, data.elements);
          (meta.renderedFonts as Record<string, string[]>)[String(viewport)] = rendered;
          await collectObservations(collector, data, viewport, source.id, shot.rel, rendered, limitations);
          if (viewport === Math.max(...viewports)) await cropTypeSamples(project, source.id, shot.abs, data, collector);
          meta[`title`] = data.title;
          meta[`docHeight@${viewport}`] = data.docHeight;
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
    return finishExtraction(
      source,
      webExtractor,
      started,
      collector.list(),
      ["color", "typography", "font-face", "spacing", "radius", "shadow", "motion", "breakpoint", "layout", "voice"],
      limitations,
      meta,
    );
  },
};

/** First pass down the page, slow enough for scroll-triggered content to load and reveal. */
async function autoScroll(page: import("playwright").Page): Promise<void> {
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.7;
    for (let i = 0; i < 60 && window.scrollY + window.innerHeight < document.documentElement.scrollHeight; i++) {
      window.scrollBy(0, step);
      await new Promise((r) => setTimeout(r, 220));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 500));
  });
}

const BLOCKED = /just a moment|verify(ing)? (that )?you are (a )?human|performing security verification|checking (if the site connection is secure|your browser)|attention required|access denied|are you a robot|captcha|ddos protection|enable javascript and cookies to continue|request blocked|forbidden/i;

/**
 * Refuse to measure a bot check or an error page as if it were the design.
 * Challenges that clear themselves get a few seconds first.
 */
async function assertRealPage(page: import("playwright").Page, target: string, status?: number): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const probe = (await page.evaluate(interstitialProbe)) as { title: string; text: string; length: number };
    const blocked = BLOCKED.test(probe.title) || (probe.length < 2500 && BLOCKED.test(probe.text));
    if (!blocked && (!status || status < 400)) return;
    if (i === 3) {
      const what = blocked ? `a bot check or block page ("${(probe.title || probe.text).slice(0, 80)}")` : `HTTP ${status}`;
      throw new Error(`${target} answered with ${what} instead of the site, so there is nothing real to measure. Capture the page from your own browser (a full-page screenshot added as an image) or try again later.`);
    }
    await page.waitForTimeout(3000);
    status = undefined;
  }
}

/** Wait until the screen stops changing: running finite animations end, then a short pause for script-driven reveals. */
async function settle(page: import("playwright").Page): Promise<void> {
  await page.waitForTimeout(450);
  await page.evaluate(() => Promise.race([
    Promise.all(document.getAnimations().filter((a) => a.playState === "running" && Number.isFinite(Number(a.effect?.getComputedTiming().endTime))).map((a) => a.finished.catch(() => undefined))),
    new Promise((r) => setTimeout(r, 1500)),
  ])).catch(() => undefined);
  await page.waitForTimeout(150);
}

const MAX_SCREENS = 24;

/**
 * Photograph the page one screen at a time, the way a visitor scrolls through it,
 * and stitch the screens. At every stop, record which elements are painted and
 * where. Fixed layers show on the first screen only. When the page does not
 * scroll natively (a custom scroll container), fall back to one tall render.
 */
async function captureScreens(page: import("playwright").Page, viewport: number, vh: number, out: string): Promise<{ height: number; records: Map<number, PaintRecord>; method: "screens" | "full"; screens: number; hiddenChrome: number; limitations: string[] }> {
  const limitations: string[] = [];
  const records = new Map<number, PaintRecord>();
  const keep = (list: readonly PaintRecord[]) => {
    for (const r of list) {
      const old = records.get(r.idx);
      // The truest box is from the screen that shows the element most completely; painted anywhere fully shown wins.
      const better = !old || (r.inView > old.inView + 0.05) || (Math.abs(r.inView - old.inView) <= 0.05 && r.painted && !old.painted);
      if (better) records.set(r.idx, r);
    }
  };
  const docHeight = async () => Math.min(MAX_SCREENSHOT_HEIGHT, (await page.evaluate(() => document.documentElement.scrollHeight)) as number);
  let height = await docHeight();
  const tiles: { y: number; png: Buffer }[] = [];
  let hiddenChrome = 0;
  let stuck = false;
  for (let target = 0, i = 0; i < MAX_SCREENS; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), target);
    await settle(page);
    const y = (await page.evaluate(() => Math.round(window.scrollY))) as number;
    if (i > 0 && y <= tiles.at(-1)!.y) { stuck = tiles.length === 1 && height > vh * 1.2; break; }
    tiles.push({ y, png: await page.screenshot({ type: "png" }) });
    keep((await page.evaluate(paintCheck)) as PaintRecord[]);
    if (i === 0) hiddenChrome = (await page.evaluate(hideScreenChrome)) as number;
    height = await docHeight();
    if (y + vh >= height) break;
    target = Math.min(y + vh, height - vh);
  }
  if (stuck) {
    limitations.push(`The page did not scroll natively at ${viewport}px (it likely scrolls inside a container); it was rendered in one tall frame, so scroll-triggered content may be missing.`);
    records.clear();
    await page.setViewportSize({ width: viewport, height: Math.max(600, height) });
    await settle(page);
    await page.screenshot({ path: out, type: "jpeg", quality: 72, clip: { x: 0, y: 0, width: viewport, height } });
    keep((await page.evaluate(paintCheck)) as PaintRecord[]);
    return { height, records, method: "full", screens: 1, hiddenChrome: 0, limitations };
  }
  const total = Math.min(MAX_SCREENSHOT_HEIGHT, tiles.at(-1)!.y + vh);
  const stitched = await sharp({ create: { width: viewport, height: total, channels: 3, background: "#ffffff" } })
    .composite(tiles.filter((t) => t.y < total).map((t) => ({ input: t.png, left: 0, top: t.y })))
    .png()
    .toBuffer();
  await sharp(stitched).extract({ left: 0, top: 0, width: viewport, height: total }).jpeg({ quality: 72 }).toFile(out);
  if (total < (await page.evaluate(() => document.documentElement.scrollHeight) as number)) limitations.push(`Capture at ${viewport}px stops at ${total}px of the page.`);
  if (hiddenChrome) limitations.push(`${hiddenChrome} fixed or edge-stuck layer(s) (header, badge, background) show on the first screen only at ${viewport}px.`);
  // Drop records below the stitched height.
  for (const [k, r] of records) if (r.box.y >= total) records.delete(k);
  return { height: total, records, method: "screens", screens: tiles.length, hiddenChrome, limitations };
}

/** Ask the engine which font files actually painted the text, not just the declared stack. */
async function renderedFonts(page: import("playwright").Page, elements: readonly PageElement[]): Promise<string[]> {
  const out = new Set<string>();
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = (await cdp.send("DOM.getDocument", { depth: 0 })) as { root: { nodeId: number } };
    const seen = new Set<string>();
    for (const el of elements) {
      if (!el.ownText || seen.has(el.fontFamily) || seen.size > 24) continue;
      seen.add(el.fontFamily);
      try {
        const { nodeId } = (await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: el.selector })) as { nodeId: number };
        if (!nodeId) continue;
        const { fonts } = (await cdp.send("CSS.getPlatformFontsForNode", { nodeId })) as { fonts: { familyName: string; isCustomFont: boolean }[] };
        for (const f of fonts) out.add(`${f.familyName}${f.isCustomFont ? " (web font)" : " (local)"}`);
      } catch {
        /* selector no longer matches; skip */
      }
    }
    await cdp.detach();
  } catch {
    /* non-Chromium engine */
  }
  return [...out];
}

async function collectObservations(
  collector: ObservationCollector,
  data: PageCollection,
  viewport: number,
  sourceId: string,
  screenshot: string,
  rendered: readonly string[],
  limitations: string[],
): Promise<void> {
  const ev = (el: PageElement): Evidence => ({
    sourceId,
    locator: { type: "css", selector: el.selector, viewport, url: data.url, box: el.box },
    artifact: screenshot,
  });
  const bodySize = bodySizeOf(data.elements);
  const textElements = data.elements.filter((e) => e.ownText && e.text.length > 0);
  const totalText = textElements.length || 1;
  const pageArea = viewport * Math.max(1, data.docHeight);

  const declaredFamilies = new Set(textElements.map((e) => primaryFamily(e.fontFamily).toLowerCase()));
  const renderedNames = rendered.map((r) => r.replace(/ \((web font|local)\)$/, "").toLowerCase());
  for (const family of declaredFamilies) {
    if (renderedNames.length && !renderedNames.some((r) => r.includes(family.split(" ")[0] ?? family))) {
      limitations.push(`"${family}" is declared but the engine painted ${rendered.join(", ")} at ${viewport}px; metrics are the declared CSS values.`);
    }
  }

  for (const el of textElements) {
    const role = textRole(el, bodySize);
    collector.add({
      value: {
        kind: "typography",
        family: primaryFamily(el.fontFamily),
        stack: el.fontFamily,
        sizePx: el.fontSize,
        weight: el.fontWeight,
        lineHeight: parseLineHeight(el.lineHeight, el.fontSize),
        trackingEm: parseTracking(el.letterSpacing, el.fontSize),
        transform: el.textTransform !== "none" ? el.textTransform : undefined,
        sample: el.text.slice(0, 60),
      },
      context: { role, component: el.tag, viewport },
      evidence: ev(el),
    });
    const color = normalizeColor(el.color);
    if (color) collector.add({ value: { kind: "color", ...color, share: 1 / totalText }, context: { usage: el.isInteractive ? "interactive-text" : "text", viewport }, evidence: ev(el) });
    if ((role === "display" || role === "headline" || role === "title") && el.text.length >= 2) {
      collector.add({ value: { kind: "voice", text: el.text, words: el.text.split(/\s+/).filter(Boolean).length, role }, context: { role, viewport }, evidence: ev(el) });
    }
  }

  for (const el of data.elements) {
    const area = el.box.w * el.box.h;
    const bg = normalizeColor(el.background);
    if (bg && area > 400) {
      collector.add({
        value: { kind: "color", ...bg, share: area / pageArea },
        context: { usage: el.isInteractive ? "interactive-background" : "background", viewport },
        evidence: ev(el),
      });
    }
    if (el.borderWidth > 0) {
      const border = normalizeColor(el.borderColor);
      if (border) collector.add({ value: { kind: "color", ...border, share: 0 }, context: { usage: "border", viewport }, evidence: ev(el) });
    }
    if (el.radius > 0 && el.radius < 2000) {
      const pill = el.radius >= el.box.h / 2;
      collector.add({ value: { kind: "radius", px: pill ? 9999 : Math.round(el.radius * 10) / 10 }, context: { component: el.isInteractive ? "control" : el.tag, viewport }, evidence: ev(el) });
    }
    if (el.shadow) collector.add({ value: { kind: "shadow", css: el.shadow }, context: { component: el.tag, viewport }, evidence: ev(el) });
    const [pt, pr, pb, pl] = el.padding;
    const [mt, , mb] = el.margin;
    const spacings: [number, "x" | "y", string][] = [
      [pt, "y", "padding"], [pb, "y", "padding"], [pl, "x", "padding"], [pr, "x", "padding"],
      [mt, "y", "margin"], [mb, "y", "margin"], [el.gap[0], "y", "gap"], [el.gap[1], "x", "gap"],
    ];
    for (const [value, axis, usage] of spacings) {
      if (value > 0 && value <= 480) collector.add({ value: { kind: "spacing", px: Math.round(value * 10) / 10, axis }, context: { usage, viewport }, evidence: ev(el) });
    }
    const durations = parseDurations(el.transition.duration);
    const easings = splitTopLevel(el.transition.easing);
    const props = splitTopLevel(el.transition.property);
    durations.forEach((d, i) => {
      if (d <= 0) return;
      collector.add({
        value: { kind: "motion", type: "transition", durationMs: d, easing: easings[i % easings.length] ?? "ease", property: props[i % props.length] ?? "all" },
        context: { component: el.tag, viewport },
        evidence: ev(el),
      });
    });
    if (el.animation.name && el.animation.name !== "none") {
      const ad = parseDurations(el.animation.duration);
      ad.forEach((d) => {
        if (d > 0) collector.add({ value: { kind: "motion", type: "animation", durationMs: d, easing: splitTopLevel(el.animation.easing)[0] ?? "ease", property: el.animation.name }, context: { component: el.tag, viewport }, evidence: ev(el) });
      });
    }
    if (el.maxWidth.endsWith("px")) {
      const mw = parseFloat(el.maxWidth);
      if (mw >= 400 && mw <= 2400 && el.width >= Math.min(mw, viewport) * 0.9) {
        collector.add({ value: { kind: "layout", metric: "content-max-width", value: mw, unit: "px" }, context: { viewport }, evidence: ev(el) });
      }
    }
  }

  for (const anim of data.animations) {
    if (anim.duration > 0) {
      collector.add({
        value: { kind: "motion", type: "animation", durationMs: Math.round(anim.duration), easing: anim.easing, property: anim.properties.join(" ") || "unknown" },
        context: { viewport },
        evidence: { sourceId, locator: { type: "css", selector: anim.target || "document", viewport, url: data.url }, note: "Web Animations API" },
      });
    }
  }

  for (const v of data.vars) {
    const color = normalizeColor(v.value);
    if (color && /^(#|rgb|hsl|oklch|lab|lch|color\()/i.test(v.value)) {
      collector.add({
        value: { kind: "color", ...color, share: 0 },
        context: { usage: "variable", role: v.name },
        evidence: { sourceId, locator: { type: "stylesheet", href: v.href ?? undefined, rule: `${v.selector} { ${v.name}: ${v.value} }` } },
      });
    }
  }
  for (const face of data.fontFaces) {
    collector.add({
      value: { kind: "font-face", family: face.family, weight: face.weight || undefined, url: face.src.match(/url\(["']?([^"')]+)/)?.[1] },
      evidence: { sourceId, locator: { type: "stylesheet", href: face.href ?? undefined, rule: `@font-face ${face.family}` } },
    });
  }
  for (const m of data.media) {
    for (const bp of mediaBreakpoints(m.query)) {
      collector.add({ value: { kind: "breakpoint", px: bp, query: m.query.slice(0, 120) }, evidence: { sourceId, locator: { type: "stylesheet", href: m.href ?? undefined, rule: `@media ${m.query.slice(0, 120)}` } } });
    }
  }
}

/** Crop one sample of each distinct large text style, so reviewers can see the evidence. */
async function cropTypeSamples(
  project: ExtractContext["project"],
  sourceId: string,
  screenshotAbs: string,
  data: PageCollection,
  collector: ObservationCollector,
): Promise<void> {
  const meta = await sharp(screenshotAbs).metadata();
  const width = meta.width ?? data.viewport;
  const height = meta.height ?? 0;
  const seen = new Set<string>();
  const candidates = data.elements
    .filter((e) => e.ownText && e.text.length > 1 && e.fontSize >= 12)
    .sort((a, b) => b.fontSize - a.fontSize);
  let n = 0;
  for (const el of candidates) {
    const key = `${el.fontSize}|${el.fontWeight}|${el.letterSpacing}`;
    if (seen.has(key) || n >= 14) continue;
    seen.add(key);
    const left = Math.max(0, el.box.x);
    const top = Math.max(0, el.box.y);
    const w = Math.min(el.box.w, width - left);
    const h = Math.min(el.box.h, height - top);
    if (w < 4 || h < 4) continue;
    const crop = await project.artifact(sourceId, `type-${n}.png`);
    await sharp(screenshotAbs).extract({ left, top, width: w, height: h }).png().toFile(crop.abs);
    n++;
    collector.add({
      value: { kind: "typography", family: primaryFamily(el.fontFamily), sizePx: el.fontSize, weight: el.fontWeight, lineHeight: parseLineHeight(el.lineHeight, el.fontSize), trackingEm: parseTracking(el.letterSpacing, el.fontSize), transform: el.textTransform !== "none" ? el.textTransform : undefined, sample: el.text.slice(0, 60) },
      context: { role: textRole(el, bodySizeOf(data.elements)), component: el.tag, viewport: data.viewport },
      evidence: { sourceId, locator: { type: "css", selector: el.selector, viewport: data.viewport, url: data.url }, artifact: crop.rel, note: "cropped sample" },
      count: 0,
    });
  }
}

/** The boxes the anatomy needs from a rendered page: text, media, controls and colored surfaces. */
export interface LayoutElement {
  readonly selector: string;
  readonly tag: string;
  readonly box: { x: number; y: number; w: number; h: number };
  readonly text?: string;
  readonly fontSize?: number;
  readonly fontWeight?: number;
  readonly fontFamily?: string;
  readonly lineHeight?: string;
  readonly color?: string;
  readonly background?: string;
  readonly hasBackgroundImage?: boolean;
  readonly borderWidth?: number;
  readonly radius?: number;
  readonly interactive?: boolean;
}

export interface CaptureInfo {
  /** screens: photographed screen by screen while scrolling; full: one tall render. */
  readonly method: "screens" | "full";
  readonly screens: number;
  readonly hiddenChrome: number;
  /** Text elements present in the code but never painted. */
  readonly unpaintedText: number;
}

export interface LayoutDump {
  readonly url: string;
  readonly viewport: number;
  readonly docHeight: number;
  readonly elements: readonly LayoutElement[];
  /** Absent in dumps written before 1.2: those boxes include content that may not have been painted. */
  readonly capture?: CaptureInfo;
}

const MEDIA_TAGS = new Set(["img", "svg", "video", "picture", "canvas", "iframe"]);

export const layoutDump = (data: PageCollection, capture?: CaptureInfo): LayoutDump => {
  const out: LayoutElement[] = [];
  for (const el of data.elements) {
    const area = el.box.w * el.box.h;
    const transparent = !el.background || /rgba\(.*,\s*0\)$/.test(el.background) || el.background === "transparent";
    const keep = (el.ownText && el.text.length > 0) || MEDIA_TAGS.has(el.tag) || el.isInteractive || (!transparent && area > 2000) || (el.borderWidth > 0 && area > 2000) || (Boolean(el.backgroundImage) && area > 4000);
    if (!keep || el.box.w < 2 || el.box.h < 2) continue;
    out.push({
      selector: el.selector,
      tag: el.tag,
      // Text is measured by its own extent; a paragraph's block is usually as wide as its container.
      box: el.ownText && el.textBox && !el.isInteractive ? el.textBox : el.box,
      ...(el.ownText && el.text ? { text: el.text.slice(0, 80), fontSize: el.fontSize, fontWeight: el.fontWeight, fontFamily: primaryFamily(el.fontFamily), lineHeight: el.lineHeight } : {}),
      color: el.color,
      ...(!transparent ? { background: el.background } : {}),
      ...(el.backgroundImage ? { hasBackgroundImage: true } : {}),
      ...(el.borderWidth ? { borderWidth: el.borderWidth } : {}),
      ...(el.radius ? { radius: el.radius } : {}),
      ...(el.isInteractive ? { interactive: true } : {}),
    });
  }
  return { url: data.url, viewport: data.viewport, docHeight: data.docHeight, elements: out, ...(capture ? { capture } : {}) };
};
