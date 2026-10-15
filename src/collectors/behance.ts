import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Browser } from "playwright";

import { download, htmlToText, mapLimit, resolveStream, saveStream, USER_AGENT, youtubeId, type Collection, type CollectedItem, type CollectOptions } from "./media.js";

/**
 * Behance project collector. Behance server-renders the whole project as JSON
 * in <script id="beconfig-store_state">: project.project.allModules lists every
 * module in order. Images come with every rendition (allAvailable); videos are
 * Adobe Creative Cloud player embeds (HLS) or Vimeo/YouTube iframes.
 */

interface Rendition { url: string; width?: number; type?: string }
interface Module {
  __typename: string;
  imageSizes?: { allAvailable?: Rendition[] };
  components?: { imageSizes?: { allAvailable?: Rendition[] } }[];
  embed?: string;
  originalEmbed?: string;
  fluidEmbed?: string;
  text?: string;
  caption?: string;
}
export interface BehanceProject {
  name: string;
  description?: string;
  url?: string;
  owners?: { displayName?: string; username?: string }[];
  tags?: ({ title?: string } | string)[];
  tools?: { title?: string }[];
  fields?: { label?: string }[];
  modules?: Module[];
  allModules?: Module[];
}

/** Largest rendition; at equal width prefer original formats (source/fs) over webp and stills. */
export const bestRendition = (list: readonly Rendition[] | undefined): string | null => {
  if (!list?.length) return null;
  const score = (r: Rendition): number => {
    const name = r.url.split("/project_modules/")[1]?.split("/")[0] ?? "";
    let s = (r.width ?? 0) * 10;
    if (r.type === "WEBP" || name.includes("webp")) s -= 3;
    if (name.includes("still")) s -= 5;
    if (name === "source") s += 2;
    if (name === "fs") s += 1;
    return s;
  };
  return [...list].sort((a, b) => score(b) - score(a))[0]!.url;
};

export interface PlannedAsset {
  readonly kind: "image" | "video-player" | "video-youtube" | "text";
  readonly url: string;
  readonly index: number;
}

/** Turn project modules into a download plan, in page order. Pure, for testing. */
export const planBehance = (project: BehanceProject): { assets: PlannedAsset[]; texts: string[]; skipped: string[] } => {
  const modules = project.allModules?.length ? project.allModules : project.modules ?? [];
  const assets: PlannedAsset[] = [];
  const texts: string[] = [];
  const skipped: string[] = [];
  let index = 0;
  const iframeSrc = (html: string | undefined): string | null => html?.match(/src=["']([^"']+)["']/)?.[1]?.replace(/&amp;/g, "&") ?? null;
  for (const m of modules) {
    switch (m.__typename) {
      case "ImageModule": {
        const url = bestRendition(m.imageSizes?.allAvailable);
        if (url) assets.push({ kind: "image", url, index: index++ });
        break;
      }
      case "MediaCollectionModule":
        for (const c of m.components ?? []) {
          const url = bestRendition(c.imageSizes?.allAvailable);
          if (url) assets.push({ kind: "image", url, index: index++ });
        }
        break;
      case "VideoModule":
      case "EmbedModule": {
        const src = iframeSrc(m.embed ?? m.originalEmbed ?? m.fluidEmbed);
        if (!src) { skipped.push(`${m.__typename} without a player URL`); break; }
        const abs = src.startsWith("//") ? `https:${src}` : src;
        if (youtubeId(abs)) assets.push({ kind: "video-youtube", url: abs, index: index++ });
        else if (/adobe\.io|vimeo\.com|behance\.net|player\./i.test(abs)) assets.push({ kind: "video-player", url: abs, index: index++ });
        else skipped.push(`embed from ${new URL(abs).hostname} (not a video)`);
        break;
      }
      case "TextModule": {
        const t = htmlToText(m.text ?? "");
        if (t) texts.push(t);
        break;
      }
      default:
        skipped.push(`${m.__typename} module`);
    }
    if (m.caption) {
      const c = htmlToText(m.caption);
      if (c) texts.push(c);
    }
  }
  return { assets, texts, skipped };
};

export const isBehanceProject = (url: string): boolean => /^https?:\/\/(www\.)?behance\.net\/gallery\/\d+/i.test(url);

export const collectBehance = async (browser: Browser, url: string, opts: CollectOptions): Promise<Collection> => {
  const { workDir, log } = opts;
  const limitations: string[] = [];
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: "en-US" });
  const page = await context.newPage();
  let project: BehanceProject;
  try {
    log(`behance: opening ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const raw = await page.locator("script#beconfig-store_state").textContent({ timeout: 20_000 }).catch(() => null);
    if (!raw) throw new Error("Behance page has no project data (the project may be private, removed or the page layout changed).");
    const state = JSON.parse(raw) as { project?: { project?: BehanceProject } };
    if (!state.project?.project) throw new Error("Behance project data not found on the page.");
    project = state.project.project;
  } finally {
    await context.close();
  }
  const plan = planBehance(project);
  const max = opts.maxItems ?? 80;
  if (plan.assets.length > max) limitations.push(`Project has ${plan.assets.length} media items; kept the first ${max}.`);
  for (const s of plan.skipped) limitations.push(`Skipped ${s}.`);
  const assets = plan.assets.slice(0, max);
  log(`behance: "${project.name}" has ${assets.length} media item(s)`);

  const results = await mapLimit(assets, 4, async (asset): Promise<CollectedItem> => {
    const n = String(asset.index + 1).padStart(3, "0");
    if (asset.kind === "image") {
      const file = await download(asset.url, workDir, `${n}`, "https://www.behance.net/");
      return { kind: "image", file, origin: asset.url, label: `${project.name} · ${n}` };
    }
    if (asset.kind === "video-youtube") {
      const id = youtubeId(asset.url)!;
      const file = await download(`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, workDir, `${n}-youtube-cover`).catch(() => download(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, workDir, `${n}-youtube-cover`));
      limitations.push(`YouTube video ${n} is represented by its cover image; the film itself is not downloaded.`);
      return { kind: "image", file, origin: asset.url, label: `${project.name} · ${n} (capa do vídeo)` };
    }
    const stream = await resolveStream(browser, asset.url, url);
    if (!stream) throw new Error(`no playable stream found in ${new URL(asset.url).hostname}`);
    log(`behance: saving video ${n}`);
    const file = await saveStream(stream, join(workDir, `${n}.mp4`), asset.url, opts.maxVideoSeconds ?? 180);
    return { kind: "video", file, origin: asset.url, label: `${project.name} · ${n} (vídeo)` };
  });
  const items: CollectedItem[] = [];
  results.forEach((r, i) => {
    if (r instanceof Error) limitations.push(`Item ${i + 1} (${assets[i]!.kind}) failed: ${r.message}`);
    else items.push(r);
  });

  const tags = (project.tags ?? []).map((t) => (typeof t === "string" ? t : t.title)).filter(Boolean);
  const owners = (project.owners ?? []).map((o) => o.displayName ?? o.username).filter(Boolean);
  const md = [
    `# ${project.name}`,
    "",
    `Behance: ${url}`,
    owners.length ? `Autoria: ${owners.join(", ")}` : "",
    tags.length ? `Tags: ${tags.join(", ")}` : "",
    project.tools?.length ? `Ferramentas: ${project.tools.map((t) => t.title).filter(Boolean).join(", ")}` : "",
    "",
    project.description ? htmlToText(project.description) : "",
    "",
    ...plan.texts,
  ].filter((l, i, all) => l !== "" || all[i - 1] !== "").join("\n");
  if (md.replace(/\s/g, "").length > project.name.length + 40) {
    const file = join(workDir, "projeto.md");
    await writeFile(file, md);
    items.push({ kind: "document", file, origin: url, label: `${project.name} · textos do projeto` });
  }
  return {
    title: project.name,
    items,
    limitations,
    meta: { platform: "behance", owners, tags, modules: (project.allModules ?? project.modules ?? []).length, planned: plan.assets.length },
  };
};
