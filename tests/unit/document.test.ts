import { describe, expect, it } from "vitest";

import type { ObservationValue } from "../../src/core/model.js";
import { parseDocumentText } from "../../src/extractors/document.js";

const page = `Color
Primary Blue #0071E3 — Pantone 2175 C
Graphite #1D1D1F
Typeface: Helvetica Neue
Headlines must always be set in Helvetica Neue Bold.
The minimum text size is 12px for captions.
Nunca use títulos em caixa alta.
All spacing uses an 8px grid.`;

type RuleValue = Extract<ObservationValue, { kind: "rule" }>;

describe("document parsing", () => {
  const findings = parseDocumentText([page]);
  const rules = findings.filter((f) => f.value.kind === "rule").map((f) => f.value as RuleValue);

  it("reads declared colors with their labels and print references", () => {
    const blue = findings.find((f) => f.value.kind === "color" && f.value.hex === "#0071e3");
    expect(blue?.role).toBe("Primary Blue");
    expect((blue?.value as { pantone?: string }).pantone).toBe("2175 C");
  });

  it("turns checkable statements into machine checks", () => {
    expect(rules.find((r) => r.check?.type === "font-family")?.check).toMatchObject({ families: expect.arrayContaining(["Helvetica Neue"]) });
    expect(rules.find((r) => r.check?.type === "min-size")?.check).toMatchObject({ px: 12 });
    expect(rules.find((r) => r.check?.type === "spacing-unit")?.check).toMatchObject({ px: 8 });
    expect(rules.find((r) => r.check?.type === "palette")?.check).toMatchObject({ hexes: ["#0071e3", "#1d1d1f"] });
  });

  it("understands Portuguese polarity and topics", () => {
    const pt = rules.find((r) => r.statement.startsWith("Nunca"));
    expect(pt?.polarity).toBe("never");
    expect(pt?.topic).toBe("typography");
    expect(pt?.check?.type).toBe("no-uppercase");
  });
});
