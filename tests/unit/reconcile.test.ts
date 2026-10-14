import { describe, expect, it } from "vitest";

import { normalizeColor } from "../../src/core/color.js";
import type { Genome } from "../../src/core/genome.js";
import type { Extraction, Observation, Precision, Source, SourceKind } from "../../src/core/model.js";
import { ReconcileContext, buildSupport } from "../../src/reconcile/context.js";
import { reconcilePalette } from "../../src/reconcile/palette.js";
import { expectedTracking } from "../../src/verify/index.js";

const source = (id: string, kind: SourceKind): Source => ({ id, kind, uri: id, addedAt: "", tags: [], options: {} });
const colorObs = (sourceId: string, hex: string, precision: Precision, share: number, usage = "background"): Observation => ({
  id: `${sourceId}-${hex}-${Math.random()}`,
  sourceId,
  precision,
  confidence: 0.9,
  value: { kind: "color", ...normalizeColor(hex)!, share },
  context: { usage },
  count: 3,
  evidence: [{ sourceId, locator: { type: "whole" } }],
  extractor: "test",
});
const extraction = (sourceId: string, observations: Observation[]): Extraction => ({
  sourceId, extractor: "test", extractorVersion: "1", startedAt: "", finishedAt: "", observations, coverage: ["color"], limitations: [], meta: {},
});

describe("cross-source reconciliation", () => {
  it("snaps estimated pixels onto exact colors and marks them confirmed", () => {
    const ctx = new ReconcileContext([source("web", "web"), source("img", "image")], [
      extraction("web", [colorObs("web", "#f5f5f7", "exact", 0.5), colorObs("web", "#1d1d1f", "exact", 0.5, "text")]),
      extraction("img", [colorObs("img", "#f3f4f6", "estimated", 0.7), colorObs("img", "#20201f", "estimated", 0.3)]),
    ]);
    const { tokens } = reconcilePalette(ctx);
    const surface = tokens.find((t) => t.hex === "#f5f5f7");
    expect(tokens).toHaveLength(2);
    expect(surface?.support.status).toBe("confirmed");
    expect(surface?.variants).toContain("#f3f4f6");
  });

  it("keeps distinct exact colors apart", () => {
    const ctx = new ReconcileContext([source("web", "web")], [extraction("web", [colorObs("web", "#1d1d1f", "exact", 0.5), colorObs("web", "#000000", "exact", 0.5)])]);
    expect(reconcilePalette(ctx).tokens).toHaveLength(2);
  });

  it("counts each source once and labels declared-only facts", () => {
    const kinds = (id: string): SourceKind => (id === "doc" ? "document" : "web");
    expect(buildSupport([colorObs("doc", "#ff3b30", "declared", 0)], kinds).status).toBe("declared-only");
    const many = buildSupport(Array.from({ length: 50 }, () => colorObs("web", "#000000", "exact", 0.01)), kinds);
    expect(many.status).toBe("single-source");
    expect(many.sources).toHaveLength(1);
    const two = buildSupport([colorObs("web", "#000000", "exact", 0.1), colorObs("doc", "#000000", "declared", 0)], kinds);
    expect(two.status).toBe("confirmed");
    expect(two.confidence).toBeGreaterThan(many.confidence);
  });

  it("interpolates tracking on a log-size axis", () => {
    const genome = { typography: { tracking: { table: [{ sizePx: 12, trackingEm: 0 }, { sizePx: 48, trackingEm: -0.02 }] } } } as unknown as Genome;
    expect(expectedTracking(genome, 24)).toBeCloseTo(-0.01, 3);
    expect(expectedTracking(genome, 100)).toBe(-0.02);
  });
});
