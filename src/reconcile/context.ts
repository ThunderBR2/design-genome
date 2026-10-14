import type { Support, SupportStatus } from "../core/genome.js";
import { PRECISION_WEIGHT, type Evidence, type Extraction, type Observation, type Precision, type Source, type SourceKind } from "../core/model.js";

const PRECISION_RANK: Record<Precision, number> = { exact: 0, declared: 1, estimated: 2, inferred: 3 };

export const byPrecision = (a: Observation, b: Observation): number => PRECISION_RANK[a.precision] - PRECISION_RANK[b.precision];

/** Everything reconciliation needs: observations grouped and the sources they came from. */
export class ReconcileContext {
  readonly observations: readonly Observation[];
  private readonly sources = new Map<string, Source>();
  private readonly coverageBySource = new Map<string, Set<string>>();

  constructor(
    sources: readonly Source[],
    readonly extractions: readonly Extraction[],
  ) {
    for (const s of sources) this.sources.set(s.id, s);
    this.observations = extractions.flatMap((e) => e.observations);
    for (const e of extractions) {
      const set = this.coverageBySource.get(e.sourceId) ?? new Set<string>();
      for (const facet of e.coverage) set.add(facet);
      this.coverageBySource.set(e.sourceId, set);
    }
  }

  of<K extends Observation["value"]["kind"]>(kind: K): (Observation & { value: Extract<Observation["value"], { kind: K }> })[] {
    return this.observations.filter((o) => o.value.kind === kind) as (Observation & { value: Extract<Observation["value"], { kind: K }> })[];
  }

  source(id: string): Source | undefined {
    return this.sources.get(id);
  }

  kindOf(id: string): SourceKind {
    return this.sources.get(id)?.kind ?? "web";
  }

  /** Sources that examined a facet. Only these can say "not used". */
  covering(facet: string): string[] {
    return [...this.coverageBySource.entries()].filter(([, set]) => set.has(facet)).map(([id]) => id);
  }

  support(observations: readonly Observation[], conflictIds: readonly string[] = []): Support {
    return buildSupport(observations, (id) => this.kindOf(id), conflictIds);
  }
}

const round = (n: number, d = 3): number => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Corroboration math. Each source contributes once (its strongest reading), so
 * a thousand nodes on one page never outweigh two independent sources agreeing.
 */
export const buildSupport = (
  observations: readonly Observation[],
  kindOf: (sourceId: string) => SourceKind,
  conflictIds: readonly string[] = [],
): Support => {
  const perSource = new Map<string, { precision: Precision; count: number; confidence: number }>();
  for (const o of observations) {
    const current = perSource.get(o.sourceId);
    if (!current) {
      perSource.set(o.sourceId, { precision: o.precision, count: o.count, confidence: o.confidence });
      continue;
    }
    current.count += o.count;
    if (PRECISION_RANK[o.precision] < PRECISION_RANK[current.precision]) current.precision = o.precision;
    current.confidence = Math.max(current.confidence, o.confidence);
  }
  let doubt = 1;
  for (const s of perSource.values()) {
    const volume = 0.7 + 0.3 * Math.min(1, s.count / 5);
    doubt *= 1 - PRECISION_WEIGHT[s.precision] * s.confidence * volume;
  }
  const sources = [...perSource.entries()].map(([sourceId, s]) => ({ sourceId, kind: kindOf(sourceId), precision: s.precision, count: s.count }));
  let status: SupportStatus;
  if (conflictIds.length) status = "conflicted";
  else if (sources.length >= 2) status = "confirmed";
  else if (sources.every((s) => s.precision === "declared")) status = "declared-only";
  else status = "single-source";
  return {
    status,
    confidence: round(1 - doubt),
    sources,
    observationIds: observations.slice(0, 40).map((o) => o.id),
    evidence: pickEvidence(observations),
    ...(conflictIds.length ? { conflictIds } : {}),
  };
};

/** One piece of evidence per source first, preferring visual artifacts. */
const pickEvidence = (observations: readonly Observation[]): Evidence[] => {
  const out: Evidence[] = [];
  const seen = new Set<string>();
  const sorted = [...observations].sort(byPrecision);
  for (const o of sorted) {
    const best = [...o.evidence].sort((a, b) => Number(Boolean(b.artifact && b.note === "cropped sample")) - Number(Boolean(a.artifact && a.note === "cropped sample")))[0];
    if (best && !seen.has(o.sourceId)) {
      out.push(best);
      seen.add(o.sourceId);
    }
    if (out.length >= 4) break;
  }
  for (const o of sorted) {
    if (out.length >= 4) break;
    const e = o.evidence[0];
    if (e && !out.includes(e)) out.push(e);
  }
  return out;
};
