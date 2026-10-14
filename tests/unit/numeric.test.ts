import { describe, expect, it } from "vitest";

import { cluster1D, detectGrid, fitModularScale, linearFit } from "../../src/core/numeric.js";

const weighted = (values: number[]) => values.map((value) => ({ value, weight: 1 }));

describe("numeric derivations", () => {
  it("clusters close values and keeps distinct ones apart", () => {
    expect(cluster1D(weighted([8, 8.2, 16, 16.4, 32]), 0.5).map((c) => c.center)).toEqual([8.1, 16.2, 32]);
  });

  it("finds the largest grid that still explains the spacing", () => {
    const fit = detectGrid(weighted([8, 16, 24, 32, 48, 64, 80]));
    expect(fit?.unit).toBe(8);
    expect(fit?.adherence).toBe(1);
    expect(detectGrid(weighted([16, 32, 48, 64, 96]))?.unit).toBe(16);
    expect(detectGrid(weighted([7, 13, 22, 31]))?.adherence).toBeLessThan(0.85);
  });

  it("recognises a true modular scale and rejects arbitrary ramps", () => {
    const fit = fitModularScale(weighted([16, 20, 25, 31.25, 39.06, 48.83]), 16);
    expect(fit?.modular).toBe(true);
    expect(fit?.ratio).toBeCloseTo(1.25, 2);
    expect(fit?.namedRatio).toBe("major third");
    expect(fitModularScale(weighted([11, 12, 17, 21, 28, 32, 48, 80]), 17)?.modular).toBe(false);
  });

  it("fits a line", () => {
    const fit = linearFit([{ x: 1, y: 3 }, { x: 2, y: 5 }, { x: 3, y: 7 }]);
    expect(fit?.slope).toBeCloseTo(2);
    expect(fit?.intercept).toBeCloseTo(1);
    expect(fit?.r2).toBe(1);
  });
});
