import { join } from "node:path";

import type { Browser } from "playwright";

import { download, mapLimit, resolveStream, saveStream, USER_AGENT, youtubeId, type Collection, type CollectedItem, type CollectOptions } from "./media.js";

/**
 * Generic collector for any page that shows a set of works (Dribbble shots,
 * portfolios, case studies, Pinterest pins, Are.na). It renders the page,
 * scrolls to load lazy media, then keeps the large images (best srcset
 * candidate) and the videos, skipping avatars, logos and icons by size.
 */

interface Found {
  readonly images: { url: string; w: number; h: number }[];
  readonly videos: string[];
  readonly players: string[];
  readonly title: string;
}

/** Runs in the page. Self-contained. */
function scan(minSide: number): Found {
  const best = (img: HTMLImageElement): string => {
    const set = img.getAttribute("srcset") || img.getAttribute("data-srcset") || "";
    let url = img.currentSrc || img.src || img.getAttribute("data-src") || "";
    let top = 0;
    for (const part of set.split(",")) {
      const [u, d] = part.trim().split(/\s+/);
      const n = d ? parseFloat(d) * (d.endsWith("x") ? 1000 : 1) : 0;
      if (u && n > top) { top = n; url = u; }
    }
    return new URL(url, location.href).href;
  };
  const images: { url: string; w: number; h: number }[] = [];
  for (const img of Array.from(document.images)) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const rect = img.getBoundingClientRect();
    if (Math.min(w, h) < minSide && Math.min(rect.width, rect.height) < minSide * 0.6) continue;
    const url = best(img);
    if (!/^https?:/.test(url) || /avatar|profile|logo|icon|sprite/i.test(url)) continue;
    images.push({ url, w, h });
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[style*='background-image']"))) {
    const m = el.style.backgroundImage.match(/url\(["']?([^"')]+)/);
    const r = el.getBoundingClientRect();
    if (m && Math.min(r.width, r.height) >= minSide) images.push({ url: new URL(m[1]!, location.href).href, w: r.width, h: r.height });
  }
  const og = document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content;
  if (og) images.unshift({ url: new URL(og, location.href).href, w: 9999, h: 9999 });
  const videos: string[] = [];
  for (const v of Array.from(document.querySelectorAll("video"))) {
    const srcs = [v.currentSrc, v.src, ...Array.from(v.querySelectorAll("source")).map((s) => s.src)];
    for (const s of srcs) if (s && /^https?:/.test(s)) videos.push(s);
  }
  const players = Array.from(document.querySelectorAll("iframe")).map((f) => f.src).filter((s) => /vimeo\.com|youtube|youtu\.be|adobe\.io|player\./i.test(s));
  return { images, videos, players, title: document.title };
}

const normalize = (url: string): string => {
  try {
    const u = new URL(url);
    // Pinterest and Dribbble serve sized copies; ask for the original.
    if (/pinimg\.com$/.test(u.hostname)) u.pathname = u.pathname.replace(/^\/\d+x\//, "/originals/");
    if (/dribbble\.com$/.test(u.hostname)) u.search = "";
    return u.href;
  } catch {
    return url;
  }
};

export const collectGallery = async (browser: Browser, url: string, opts: CollectOptions): Promise<Collection> => {
  const { workDir, log } = opts;
  const limitations: string[] = [];
  const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const streams: string[] = [];
  page.on("request", (r) => { if (/\.(m3u8|mp4)(\?|$)/i.test(r.url())) streams.push(r.url()); });
  let found: Found;
  try {
    log(`gallery: opening ${url}`);
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => undefined);
    await page.evaluate(async () => {
      for (let i = 0; i < 30 && window.scrollY + innerHeight < document.documentElement.scrollHeight; i++) {
        window.scrollBy(0, innerHeight * 0.9);
        await new Promise((r) => setTimeout(r, 250));
      }
    });
    await page.waitForTimeout(800);
    await page.evaluate("window.__name = (f) => f;");
    found = (await page.evaluate(scan, 400)) as Found;
  } finally {
    await context.close();
  }
  const seen = new Set<string>();
  const images = found.images.map((i) => normalize(i.url)).filter((u) => (seen.has(u) ? false : (seen.add(u), true)));
  const videos = [...new Set([...found.videos, ...streams.filter((s) => /\.mp4/i.test(s))])];
  const max = opts.maxItems ?? 60;
  const plan: { kind: "image" | "video" | "player"; url: string }[] = [
    ...images.map((u) => ({ kind: "image" as const, url: u })),
    ...videos.map((u) => ({ kind: "video" as const, url: u })),
    ...found.players.map((u) => ({ kind: "player" as const, url: u })),
  ];
  if (plan.length > max) limitations.push(`Page has ${plan.length} media items; kept the first ${max}.`);
  if (!plan.length) limitations.push("No large images or videos were found on the page (it may need a login, or load media only after interaction).");
  log(`gallery: ${Math.min(plan.length, max)} media item(s) on "${found.title}"`);
  const results = await mapLimit(plan.slice(0, max), 4, async (item, i): Promise<CollectedItem> => {
    const n = String(i + 1).padStart(3, "0");
    if (item.kind === "image") return { kind: "image", file: await download(item.url, workDir, n, url), origin: item.url, label: `${found.title} · ${n}` };
    if (item.kind === "video") return { kind: "video", file: await saveStream(item.url, join(workDir, `${n}.mp4`), url, opts.maxVideoSeconds ?? 180), origin: item.url, label: `${found.title} · ${n} (vídeo)` };
    const yt = youtubeId(item.url);
    if (yt) return { kind: "image", file: await download(`https://i.ytimg.com/vi/${yt}/hqdefault.jpg`, workDir, `${n}-youtube-cover`), origin: item.url, label: `${found.title} · ${n} (capa do vídeo)` };
    const stream = await resolveStream(browser, item.url, url);
    if (!stream) throw new Error("no playable stream");
    return { kind: "video", file: await saveStream(stream, join(workDir, `${n}.mp4`), item.url, opts.maxVideoSeconds ?? 180), origin: item.url, label: `${found.title} · ${n} (vídeo)` };
  });
  const items: CollectedItem[] = [];
  results.forEach((r, i) => { if (r instanceof Error) limitations.push(`Item ${i + 1} failed: ${r.message}`); else items.push(r); });
  return { title: found.title, items, limitations, meta: { platform: new URL(url).hostname, found: plan.length } };
};
