import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";

export const sha256 = (input: string | Buffer): string => createHash("sha256").update(input).digest("hex");

export const sha256File = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });

/** Deterministic id from content, so re-extraction yields the same ids. */
export const stableId = (prefix: string, ...parts: readonly unknown[]): string =>
  `${prefix}_${sha256(JSON.stringify(parts)).slice(0, 12)}`;

export const randomId = (prefix: string): string => `${prefix}_${randomBytes(6).toString("hex")}`;

export const slug = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "item";
