import { describe, expect, it } from "vitest";

import { colorDistance, colorFamily, contrastRatio, normalizeColor } from "../../src/core/color.js";

describe("color", () => {
  it("normalizes CSS colors and drops transparency", () => {
    expect(normalizeColor("rgb(0, 113, 227)")?.hex).toBe("#0071e3");
    expect(normalizeColor("rgba(0, 0, 0, 0)")).toBeNull();
    expect(normalizeColor("rgba(0, 0, 0, 0.5)")?.alpha).toBe(0.5);
    expect(normalizeColor("not a color")).toBeNull();
  });

  it("measures perceptual distance and contrast", () => {
    expect(colorDistance("#ffffff", "#fefefe")).toBeLessThan(1);
    expect(colorDistance("#0071e3", "#ff3b30")).toBeGreaterThan(40);
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
  });

  it("names hue families", () => {
    expect(colorFamily(normalizeColor("#0071e3")!.oklch)).toBe("blue");
    expect(colorFamily(normalizeColor("#6e6e73")!.oklch)).toBe("neutral");
  });
});
