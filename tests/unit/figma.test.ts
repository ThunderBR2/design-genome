import { describe, expect, it } from "vitest";

import { figmaFileKey, observeFigmaDocument } from "../../src/extractors/figma.js";
import { ObservationCollector } from "../../src/extractors/support.js";

describe("figma extractor", () => {
  it("parses file keys", () => {
    expect(figmaFileKey("https://www.figma.com/design/AbC123xyz/My-File?node-id=1-2")).toBe("AbC123xyz");
  });

  it("reads fills, text styles, radii, auto-layout and shadows as exact observations", () => {
    const collector = new ObservationCollector("fig", "figma", "exact");
    observeFigmaDocument(
      {
        id: "0:0", name: "Doc", type: "DOCUMENT",
        children: [{
          id: "1:1", name: "Card", type: "FRAME", cornerRadius: 18, itemSpacing: 16, paddingTop: 32,
          fills: [{ type: "SOLID", color: { r: 0.96, g: 0.96, b: 0.97, a: 1 } }],
          effects: [{ type: "DROP_SHADOW", radius: 24, offset: { x: 0, y: 8 }, color: { r: 0, g: 0, b: 0, a: 0.12 } }],
          absoluteBoundingBox: { width: 300, height: 200 },
          children: [
            { id: "1:2", name: "Title", type: "TEXT", characters: "Lumen Air", style: { fontFamily: "Inter", fontSize: 48, fontWeight: 600, lineHeightPx: 52, letterSpacing: -0.48 }, fills: [{ type: "SOLID", color: { r: 0.11, g: 0.11, b: 0.12, a: 1 } }] },
            { id: "1:3", name: "Body", type: "TEXT", characters: "Impossibly thin and seriously bright all day long.", style: { fontFamily: "Inter", fontSize: 17, fontWeight: 400 } },
          ],
        }],
      },
      "fig",
      collector,
    );
    const observations = collector.list();
    expect(observations.map((o) => o.value.kind)).toEqual(expect.arrayContaining(["color", "typography", "radius", "spacing", "shadow", "voice"]));
    const title = observations.find((o) => o.value.kind === "typography" && o.value.sizePx === 48)!;
    expect(title.value).toMatchObject({ trackingEm: -0.01, lineHeight: 1.083 });
    expect(title.context.role).toBe("display");
    expect(observations.every((o) => o.precision === "exact")).toBe(true);
  });
});
