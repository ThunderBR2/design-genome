import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import type { Browser } from "playwright";

const run = promisify(execFile);

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

/** One asset found inside a collection page. */
export interface CollectedItem {
  readonly kind: "image" | "video" | "document";
  /** Local file with the bytes. */
  readonly file: string;
  /** Where it came from (CDN URL, player URL or the page itself). */
  readonly origin: string;
  readonly label: string;
}

export interface Collection {
  readonly title: string;
  readonly items: CollectedItem[];
  readonly limitations: string[];
  readonly meta: Record<string, unknown>;
}

export interface CollectOptions {
  readonly workDir: string;
  readonly log: (message: string) => void;
  /** Cap on downloaded assets per collection. */
  readonly maxItems?: number;
  /** Cap on seconds kept from each video. */
  readonly maxVideoSeconds?: number;
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif", "image/svg+xml": ".svg",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
};

/** Download a URL to `dir/name.ext`, picking the extension from the response type when the URL has none. */
export const download = async (url: string, dir: string, name: string, referer?: string): Promise<string> => {
  await mkdir(dir, { recursive: true });
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, ...(referer ? { Referer: referer } : {}) }, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
  const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const fromUrl = extname(new URL(url).pathname).toLowerCase();
  const ext = EXT_BY_TYPE[type] ?? (fromUrl && fromUrl.length <= 5 ? fromUrl : ".bin");
  const path = join(dir, `${name}${ext}`);
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(path));
  return path;
};

/** Run async tasks with bounded concurrency, keeping per-task failures. */
export const mapLimit = async <T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<(R | Error)[]> => {
  const out: (R | Error)[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!, i);
      } catch (error) {
        out[i] = error instanceof Error ? error : new Error(String(error));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

/**
 * Open a video player page (Adobe CCV, Vimeo, plain pages) and capture the
 * stream it loads. Returns the best HLS manifest or progressive MP4 URL.
 */
export const resolveStream = async (browser: Browser, playerUrl: string, referer: string, timeoutMs = 15_000): Promise<string | null> => {
  const context = await browser.newContext({ userAgent: USER_AGENT, extraHTTPHeaders: { Referer: referer } });
  const page = await context.newPage();
  const found: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (/\.m3u8(\?|$)/i.test(url) || /\.mp4(\?|$)/i.test(url)) found.push(url);
  });
  try {
    await page.goto(playerUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const deadline = Date.now() + timeoutMs;
    let clicked = false;
    while (Date.now() < deadline && !found.some((u) => /master\.m3u8|\.mp4/i.test(u))) {
      if (!clicked) {
        clicked = true;
        for (const frame of page.frames()) {
          await frame.evaluate(() => {
            const v = document.querySelector("video");
            if (v) { v.muted = true; void v.play().catch(() => undefined); }
            (document.querySelector('[class*="play"], button[aria-label*="Play" i], .vjs-big-play-button') as HTMLElement | null)?.click();
          }).catch(() => undefined);
        }
        const box = page.viewportSize();
        if (box) await page.mouse.click(box.width / 2, box.height / 2).catch(() => undefined);
      }
      await page.waitForTimeout(500);
    }
  } finally {
    await context.close();
  }
  return found.find((u) => /master\.m3u8/i.test(u)) ?? found.find((u) => /\.m3u8/i.test(u)) ?? found.find((u) => /\.mp4/i.test(u)) ?? null;
};

/** Save a stream (HLS or MP4) to an MP4 file with ffmpeg, keeping at most `maxSeconds`. */
export const saveStream = async (url: string, path: string, referer: string, maxSeconds = 180): Promise<string> => {
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-user_agent", USER_AGENT, "-headers", `Referer: ${referer}\r\n`,
    "-i", url, "-t", String(maxSeconds), "-c", "copy", "-bsf:a", "aac_adtstoasc", path,
  ], { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 }).catch(async () => {
    // Some streams need re-encoding (e.g. odd audio); retry without stream copy.
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-user_agent", USER_AGENT, "-headers", `Referer: ${referer}\r\n`, "-i", url, "-t", String(maxSeconds), "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", path], { maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60_000 });
  });
  const info = await stat(path);
  if (info.size < 1024) throw new Error("Downloaded video is empty");
  return path;
};

export const htmlToText = (html: string): string =>
  html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();

export const youtubeId = (url: string): string | null =>
  url.match(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})/)?.[1] ?? null;
