import { describe, expect, it } from "vitest";

import { bestRendition, planBehance, type BehanceProject } from "../../src/collectors/behance.js";
import { detectSourceKind } from "../../src/core/project.js";

const cdn = (size: string, file = "abc123.6a92b65.png") => `https://mir-s3-cdn-cf.behance.net/project_modules/${size}/${file}`;

// Shape mirrors the real beconfig-store_state payload (project.project.allModules).
const project: BehanceProject = {
  name: "NOMI — Finance App",
  allModules: [
    {
      __typename: "ImageModule",
      imageSizes: {
        allAvailable: [
          { url: cdn("max_632"), width: 819, type: "JPG" },
          { url: cdn("fs_webp"), width: 1400, type: "WEBP" },
          { url: cdn("1400"), width: 1400, type: "JPG" },
          { url: cdn("source"), width: 1400, type: "JPG" },
          { url: cdn("disp"), width: 600, type: "JPG" },
        ],
      },
    },
    { __typename: "TextModule", text: "<p>Calm money,<br>clear choices.</p>" },
    {
      __typename: "MediaCollectionModule",
      components: [
        { imageSizes: { allAvailable: [{ url: cdn("1400", "g1.jpg"), width: 1400 }, { url: cdn("max_1200_still", "g1.jpg"), width: 1200 }] } },
        { imageSizes: { allAvailable: [{ url: cdn("max_632", "g2.jpg"), width: 1124 }, { url: cdn("1400_webp", "g2.jpg"), width: 1400, type: "WEBP" }] } },
      ],
    },
    { __typename: "VideoModule", embed: '<div><iframe src="https://www-ccv.adobe.io/v1/player/ccv/HGLuq8mP-iE/embed?api_key=x&amp;bgcolor=%23191919"></iframe></div>' },
    { __typename: "EmbedModule", originalEmbed: '<iframe src="https://player.vimeo.com/video/1223813355"></iframe>' },
    { __typename: "EmbedModule", originalEmbed: '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>' },
    { __typename: "EmbedModule", originalEmbed: '<iframe src="https://open.spotify.com/embed/playlist/1D8"></iframe>' },
    { __typename: "SomethingNew" },
  ],
};

describe("behance collector", () => {
  it("recognises project links as collections", () => {
    expect(detectSourceKind("https://www.behance.net/gallery/254966683/NOMI-AI-Powered-Personal-Finance-App")).toBe("collection");
    expect(detectSourceKind("https://dribbble.com/shots/12345-Some-shot")).toBe("collection");
    expect(detectSourceKind("https://www.apple.com/iphone/")).toBe("web");
  });

  it("picks the largest original rendition over webp and stills", () => {
    expect(bestRendition(project.allModules![0]!.imageSizes!.allAvailable)).toBe(cdn("source"));
    expect(bestRendition([{ url: cdn("max_1200_still", "a.gif"), width: 1200 }, { url: cdn("max_1200", "a.gif"), width: 1200 }])).toBe(cdn("max_1200", "a.gif"));
  });

  it("plans every image, grid item, player and text in page order", () => {
    const plan = planBehance(project);
    expect(plan.assets.map((a) => a.kind)).toEqual(["image", "image", "image", "video-player", "video-player", "video-youtube"]);
    expect(plan.assets[1]!.url).toBe(cdn("1400", "g1.jpg"));
    expect(plan.assets[2]!.url).toBe(cdn("max_632", "g2.jpg").replace("max_632", "1400_webp"));
    expect(plan.assets[3]!.url).toContain("api_key=x&bgcolor");
    expect(plan.texts[0]).toContain("Calm money");
    expect(plan.skipped).toEqual(expect.arrayContaining(["embed from open.spotify.com (not a video)", "SomethingNew module"]));
  });
});
