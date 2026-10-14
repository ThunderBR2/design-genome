import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { ExtractContext } from "./support.js";

/** Local path for a file-backed source; downloads URL sources into the project once. */
export const ensureLocal = async ({ project, source, log }: ExtractContext): Promise<string> => {
  const existing = project.localPath(source);
  if (existing) return existing;
  if (!/^https?:\/\//i.test(source.uri)) throw new Error(`Source ${source.id} has no local file`);
  log(`downloading ${source.uri}`);
  const response = await fetch(source.uri, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${source.uri}`);
  const name = basename(new URL(source.uri).pathname) || "download.bin";
  const dir = join(project.root, "sources", source.id);
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  return path;
};
