import { stableId } from "../core/ids.js";
import type { Evidence, Extraction, Observation, ObservationContext, ObservationValue, Precision, Source } from "../core/types.js";
import type { Project } from "../core/project.js";

export interface ExtractContext {
  readonly project: Project;
  readonly source: Source;
  readonly log: (message: string) => void;
}

export interface Extractor {
  readonly name: string;
  readonly version: string;
  extract(context: ExtractContext): Promise<Extraction>;
}

const MAX_EVIDENCE = 4;

/**
 * Collects raw readings and folds identical ones (same value in the same context)
 * into a single Observation with a count. Agents get one line per distinct fact,
 * not one per DOM node or pixel cluster, and every line keeps sample evidence.
 */
export class ObservationCollector {
  private readonly byKey = new Map<string, Observation>();

  constructor(
    private readonly sourceId: string,
    private readonly extractor: string,
    private readonly precision: Precision,
  ) {}

  add(input: {
    value: ObservationValue;
    evidence: Evidence | readonly Evidence[];
    context?: ObservationContext;
    confidence?: number;
    count?: number;
    precision?: Precision;
    /** Override the identity used to merge readings. */
    key?: string;
  }): void {
    const context = stripUndefined(input.context ?? {});
    const precision = input.precision ?? this.precision;
    const key = input.key ?? JSON.stringify([valueKey(input.value), context, precision]);
    const evidence = Array.isArray(input.evidence) ? input.evidence : [input.evidence as Evidence];
    const existing = this.byKey.get(key);
    if (existing) {
      const merged: Observation = {
        ...existing,
        count: existing.count + (input.count ?? 1),
        confidence: Math.max(existing.confidence, input.confidence ?? existing.confidence),
        // Evidence with a visual artifact (crop, frame) is the most useful to a reviewer.
        evidence: [...evidence.filter((e) => e.artifact && e.note === "cropped sample"), ...existing.evidence, ...evidence.filter((e) => !(e.artifact && e.note === "cropped sample"))].slice(0, MAX_EVIDENCE),
        value: mergeShare(existing.value, input.value),
      };
      this.byKey.set(key, merged);
      return;
    }
    this.byKey.set(key, {
      id: stableId("obs", this.sourceId, key),
      sourceId: this.sourceId,
      precision,
      confidence: clamp(input.confidence ?? 0.9),
      value: input.value,
      context,
      count: Math.max(1, input.count ?? 1),
      evidence: evidence.slice(0, MAX_EVIDENCE),
      extractor: this.extractor,
    });
  }

  get size(): number {
    return this.byKey.size;
  }

  list(): Observation[] {
    return [...this.byKey.values()];
  }
}

/** Value identity for merging: ignore descriptive fields such as share or samples. */
const valueKey = (value: ObservationValue): unknown => {
  switch (value.kind) {
    case "color":
      return [value.kind, value.hex, value.alpha];
    case "typography":
      return [value.kind, value.family, value.sizePx, value.weight, value.lineHeight, value.trackingEm, value.transform];
    case "voice":
      return [value.kind, value.text];
    default: {
      const { ...rest } = value as Record<string, unknown>;
      return rest;
    }
  }
};

const mergeShare = (a: ObservationValue, b: ObservationValue): ObservationValue => {
  if (a.kind === "color" && b.kind === "color" && (a.share !== undefined || b.share !== undefined)) {
    return { ...a, share: round((a.share ?? 0) + (b.share ?? 0)) };
  }
  return a;
};

const stripUndefined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== "")) as T;

const clamp = (n: number): number => Math.min(1, Math.max(0, n));
const round = (n: number): number => Math.round(n * 10000) / 10000;

export const finishExtraction = (
  source: Source,
  extractor: { name: string; version: string },
  startedAt: Date,
  observations: Observation[],
  coverage: string[],
  limitations: string[],
  meta: Record<string, unknown> = {},
): Extraction => ({
  sourceId: source.id,
  extractor: extractor.name,
  extractorVersion: extractor.version,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  observations,
  coverage: [...new Set(coverage)].sort(),
  limitations: [...new Set(limitations)],
  meta,
});
