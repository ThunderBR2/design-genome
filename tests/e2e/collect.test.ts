import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GenomeService } from "../../src/service.js";
import { serveDirectory } from "../support/server.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");
const root = join(import.meta.dirname, "..", "..");

describe("collecting references from links and folders", () => {
  let dir: string;
  let server: Awaited<ReturnType<typeof serveDirectory>>;

  beforeAll(async () => {
    if (!existsSync(join(fixtures, "out", "player-clip.mp4"))) execFileSync("npx", ["tsx", join(root, "scripts", "make-fixtures.ts")], { stdio: "inherit" });
    dir = await mkdtemp(join(tmpdir(), "genome-collect-"));
    server = await serveDirectory(fixtures);
  });
  afterAll(async () => {
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("downloads large images and videos from a gallery page, skipping small ones", async () => {
    const svc = new GenomeService(join(dir, "gallery"));
    await svc.init("Gallery");
    const { sources, outcomes } = await svc.ingest([{ uri: `${server.url}gallery/`, kind: "collection" }]);
    const project = await svc.project();
    const children = project.sources.filter((s) => s.parent === sources[0]!.id);
    const kinds = children.map((c) => c.kind).sort();
    expect(kinds.filter((k) => k === "image").length).toBe(4); // og cover + 3 works, avatar skipped
    expect(kinds.filter((k) => k === "video").length).toBe(2); // <video> and the iframe player
    expect(children.some((c) => c.uri.endsWith("gallery-1.jpg"))).toBe(true); // best srcset candidate
    expect(children.some((c) => c.uri.includes("avatar"))).toBe(false);
    expect(project.source(sources[0]!.id).label).toBe("Fixture gallery");
    expect(outcomes.filter((o) => o.status === "failed")).toEqual([]);
    expect(outcomes.filter((o) => o.extractor === "video" && o.status === "extracted").length).toBe(2);
    await svc.remove(sources[0]!.id);
    expect((await svc.project()).sources.length).toBe(0);
  });

  it("adds every media file inside a folder", async () => {
    const folder = join(dir, "refs");
    await mkdir(join(folder, "sub"), { recursive: true });
    await copyFile(join(fixtures, "out", "gallery-2.png"), join(folder, "a.png"));
    await copyFile(join(fixtures, "out", "campaign.mp4"), join(folder, "sub", "film.mp4"));
    await copyFile(join(fixtures, "out", "gallery-2.png"), join(folder, "_ignore.png"));
    const svc = new GenomeService(join(dir, "folder"));
    await svc.init("Folder");
    const added = await svc.add([{ uri: folder }]);
    expect(added.map((s) => s.kind).sort()).toEqual(["image", "video"]);
  });

  it("runs MCP tool calls in a fresh worker and accepts plain links", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "dist", "cli.js"), "-p", join(dir, "mcp", "Lumino"), "mcp"] });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toEqual(expect.arrayContaining(["genome_add_sources", "genome_projects", "genome_update", "genome_remove_source"]));
      const add = (await client.callTool({ name: "genome_add_sources", arguments: { links: [join(fixtures, "out", "gallery-2.png")] } })) as { content: { text: string }[] };
      const body = JSON.parse(add.content[0]!.text);
      expect(body.added).toBe(1);
      const created = (await client.callTool({ name: "genome_projects", arguments: { create: "Outra" } })) as { content: { text: string }[] };
      expect(JSON.parse(created.content[0]!.text).created).toBe("Outra");
      const list = (await client.callTool({ name: "genome_projects", arguments: {} })) as { content: { text: string }[] };
      expect(JSON.parse(list.content[0]!.text).projects.map((p: { name: string }) => p.name).sort()).toEqual(["Lumino", "Outra"]);
      const other = (await client.callTool({ name: "genome_sources", arguments: { project: "Outra" } })) as { content: { text: string }[] };
      expect(JSON.parse(other.content[0]!.text)).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
