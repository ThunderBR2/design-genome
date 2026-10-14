import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Evidence } from "../core/types.js";
import { analyzeImage, frameDifference } from "./image.analyze.js";
import { addImageObservations } from "./image.js";
import { ensureLocal } from "./local.js";
import { ObservationCollector, finishExtraction, type ExtractContext, type Extractor } from "./support.js";

const run = promisify(execFile);
const MAX_SHOTS = 48;

export interface VideoProbe {
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly hasAudio: boolean;
}

export const probeVideo = async (path: string): Promise<VideoProbe> => {
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { maxBuffer: 16 * 1024 * 1024 });
  const info = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string }[] };
  const video = info.streams?.find((s) => s.codec_type === "video");
  if (!video) throw new Error("No video stream found");
  const [num, den] = (video.avg_frame_rate ?? "0/1").split("/").map(Number);
  return {
    durationSec: Number(info.format?.duration ?? video.duration ?? 0),
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: den ? Math.round(((num ?? 0) / den) * 100) / 100 : 0,
    hasAudio: Boolean(info.streams?.some((s) => s.codec_type === "audio")),
  };
};

/** Scene-cut timestamps from ffmpeg's scene score. */
export const detectCuts = async (path: string, threshold = 0.3): Promise<number[]> => {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", path, "-an", "-vf", `select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"], { maxBuffer: 64 * 1024 * 1024 });
  const cuts: number[] = [];
  for (const m of stderr.matchAll(/pts_time:([\d.]+)/g)) cuts.push(Number(m[1]));
  return cuts.filter((t, i, all) => i === 0 || t - (all[i - 1] ?? 0) > 0.2);
};

const grabFrame = async (path: string, timeSec: number, out: string): Promise<void> => {
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", timeSec.toFixed(3), "-i", path, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "3", out]);
};

export const videoExtractor: Extractor = {
  name: "video",
  version: "1.0.0",
  async extract(context: ExtractContext) {
    const { project, source, log } = context;
    const started = new Date();
    const path = await ensureLocal(context);
    const probe = await probeVideo(path);
    log(`video: ${probe.durationSec.toFixed(1)}s ${probe.width}x${probe.height} @${probe.fps}fps`);
    const threshold = (source.options.sceneThreshold as number | undefined) ?? 0.3;
    const cuts = await detectCuts(path, threshold);
    const bounds = [0, ...cuts.filter((t) => t > 0.05 && t < probe.durationSec - 0.05), probe.durationSec];
    const shots = bounds.slice(1).map((end, i) => ({ start: bounds[i]!, end })).filter((s) => s.end - s.start > 0.04);
    const collector = new ObservationCollector(source.id, "video", "estimated");
    const limitations: string[] = [];
    const sampled = shots.length > MAX_SHOTS ? shots.filter((_, i) => i % Math.ceil(shots.length / MAX_SHOTS) === 0) : shots;
    if (sampled.length < shots.length) limitations.push(`Analysed ${sampled.length} of ${shots.length} shots for color and grade.`);

    for (const shot of shots) {
      collector.add({
        value: { kind: "motion", type: "cut", durationMs: Math.round((shot.end - shot.start) * 1000) },
        evidence: { sourceId: source.id, locator: { type: "span", startSec: round(shot.start), endSec: round(shot.end) } },
        confidence: 0.85,
        key: `shot|${shot.start}`,
      });
    }

    let index = 0;
    for (const shot of sampled) {
      const mid = shot.start + (shot.end - shot.start) / 2;
      const frame = await project.artifact(source.id, `shot-${String(index).padStart(3, "0")}.jpg`);
      await grabFrame(path, mid, frame.abs);
      const analysis = await analyzeImage(frame.abs);
      const weight = (shot.end - shot.start) / probe.durationSec;
      const evidenceFor = (region?: { x: number; y: number; w: number; h: number }): Evidence => ({
        sourceId: source.id,
        locator: { type: "frame", timeSec: round(mid), ...(region ? { box: region } : {}) },
        artifact: frame.rel,
      });
      addImageObservations(collector, analysis, source.id, evidenceFor, weight, "frame");
      const span = shot.end - shot.start;
      if (span > 0.4) {
        const next = await project.artifact(source.id, `shot-${String(index).padStart(3, "0")}-b.jpg`);
        await grabFrame(path, Math.min(shot.end - 0.04, mid + Math.min(0.5, span / 3)), next.abs);
        const diff = await frameDifference(frame.abs, next.abs);
        collector.add({
          value: { kind: "motion", type: "intensity", magnitude: diff },
          evidence: { sourceId: source.id, locator: { type: "span", startSec: round(mid), endSec: round(mid + Math.min(0.5, span / 3)) }, artifact: frame.rel, note: "frame difference within shot" },
          confidence: 0.55,
          key: `intensity|${index}`,
        });
      }
      index++;
    }
    limitations.push(
      "Camera moves (dolly, pan, orbit) and on-screen typography are not classified from pixels alone; enable the vision extractor for that.",
      "Cut detection uses a scene-change threshold; dissolves and match cuts can be missed.",
    );
    if (probe.hasAudio) limitations.push("Audio (music, sound design, voice) is present but not analysed.");
    return finishExtraction(source, videoExtractor, started, collector.list(), ["color", "imagery", "motion", "layout"], limitations, {
      ...probe,
      shots: shots.length,
      cutThreshold: threshold,
    });
  },
};

const round = (n: number): number => Math.round(n * 1000) / 1000;
