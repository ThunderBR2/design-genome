import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { randomId } from "../core/ids.js";
import { SOURCE_KINDS, type SourceKind } from "../core/model.js";
import { EXPORT_FORMATS, exportGenome, type ExportFormat } from "../export/index.js";
import { GenomeService } from "../service.js";

/**
 * Local web Studio: add links and upload files, run extraction, browse the
 * genome with its evidence, resolve conflicts, verify candidates and export.
 * Binds to localhost by default; it can read and write the project directory.
 */

const STUDIO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "studio");
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".pdf": "application/pdf", ".md": "text/markdown; charset=utf-8" };

interface Job {
  id: string;
  action: string;
  status: "running" | "done" | "failed";
  log: string[];
  result?: unknown;
  error?: string;
  startedAt: string;
}

const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
};

const send = (res: ServerResponse, status: number, body: unknown, type = "application/json"): void => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

/** Serve a file only if it sits inside `root` (no traversal). */
const serveFile = async (res: ServerResponse, root: string, rel: string): Promise<void> => {
  const abs = normalize(join(root, rel));
  if (!abs.startsWith(root + sep) && abs !== root) return send(res, 403, { error: "forbidden" });
  try {
    const info = await stat(abs);
    if (!info.isFile()) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": MIME[extname(abs).toLowerCase()] ?? "application/octet-stream", "content-length": info.size });
    createReadStream(abs).pipe(res);
  } catch {
    send(res, 404, { error: "not found" });
  }
};

export const startStudio = async (svc: GenomeService, options: { port?: number; host?: string } = {}): Promise<{ url: string; close: () => Promise<void> }> => {
  const jobs = new Map<string, Job>();
  let running: Job | null = null;

  const runJob = (action: string, work: (log: (m: string) => void) => Promise<unknown>): Job => {
    if (running && running.status === "running") throw new Error(`Another job (${running.action}) is still running.`);
    const job: Job = { id: randomId("job"), action, status: "running", log: [], startedAt: new Date().toISOString() };
    jobs.set(job.id, job);
    running = job;
    const log = (m: string) => {
      job.log.push(m);
      if (job.log.length > 400) job.log.shift();
    };
    work(log)
      .then((result) => { job.result = result; job.status = "done"; })
      .catch((e: unknown) => { job.error = e instanceof Error ? e.message : String(e); job.status = "failed"; });
    return job;
  };
  const withLog = (log: (m: string) => void) => new GenomeService(svc.dir, log);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (req.method === "GET" && (path === "/" || path === "/index.html")) return serveFile(res, STUDIO_DIR, "index.html");
      if (req.method === "GET" && path.startsWith("/studio/")) return serveFile(res, STUDIO_DIR, path.slice(8));
      if (req.method === "GET" && path.startsWith("/files/")) {
        const rel = decodeURIComponent(path.slice(7));
        if (!/^(evidence|sources|exports)\//.test(rel)) return send(res, 403, { error: "forbidden" });
        return serveFile(res, (await svc.project()).root, rel);
      }
      if (req.method === "GET" && path === "/api/crop") {
        const rel = url.searchParams.get("file") ?? "";
        if (!/^evidence\//.test(rel)) return send(res, 403, { error: "forbidden" });
        const root = (await svc.project()).root;
        const abs = normalize(join(root, rel));
        if (!abs.startsWith(root + sep)) return send(res, 403, { error: "forbidden" });
        const meta = await sharp(abs).metadata();
        const W = meta.width ?? 0, H = meta.height ?? 0;
        const srcW = Number(url.searchParams.get("srcW") ?? 0);
        const k = srcW > 0 ? W / srcW : 1;
        const n = (name: string) => Number(url.searchParams.get(name) ?? 0) * k;
        const pad = 16;
        const left = Math.max(0, Math.floor(n("x") - pad)), top = Math.max(0, Math.floor(n("y") - pad));
        const width = Math.max(1, Math.min(W - left, Math.ceil(n("w") + pad * 2))), height = Math.max(1, Math.min(H - top, Math.ceil(n("h") + pad * 2)));
        if (left >= W || top >= H) return send(res, 416, { error: "box outside capture" });
        const buf = await sharp(abs).extract({ left, top, width, height }).png().toBuffer();
        res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
        return res.end(buf);
      }
      if (req.method === "GET" && path === "/api/project") {
        const p = await svc.project();
        return send(res, 200, { name: p.name, root: p.root, sources: p.sources, extracted: await Promise.all(p.sources.map(async (s) => ({ id: s.id, done: (await p.loadExtractions()).some((e) => e.sourceId === s.id) }))) });
      }
      if (req.method === "GET" && path === "/api/genome") {
        const g = await (await svc.project()).loadGenome();
        return send(res, 200, g ?? null);
      }
      if (req.method === "POST" && path === "/api/name") {
        const body = await readJson(req);
        await svc.init(String(body.name ?? "Untitled genome"));
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && path === "/api/sources") {
        const body = await readJson(req);
        const uris = (Array.isArray(body.uris) ? body.uris : [body.uri]).map(String).filter(Boolean);
        const kind = SOURCE_KINDS.includes(body.kind as SourceKind) ? (body.kind as SourceKind) : undefined;
        const sources = await svc.add(uris.map((uri) => ({ uri, ...(kind ? { kind } : {}), ...(body.label ? { label: String(body.label) } : {}), ...(body.depicts ? { depicts: String(body.depicts) } : {}), options: { ...(body.dark ? { colorScheme: "dark" } : {}), ...(Array.isArray(body.viewports) ? { viewports: body.viewports.map(Number) } : {}) } })));
        return send(res, 200, sources);
      }
      if (req.method === "POST" && path === "/api/upload") {
        const name = basename(url.searchParams.get("name") ?? "upload.bin").replace(/[^\w.\- ()]+/g, "_");
        const p = await svc.project();
        const tmp = join(p.root, ".uploads", randomId("up"));
        await mkdir(tmp, { recursive: true });
        const file = join(tmp, name);
        try {
          await pipeline(req, createWriteStream(file));
          const kindParam = url.searchParams.get("kind") as SourceKind | null;
          const [source] = await svc.add([{ uri: file, ...(kindParam && SOURCE_KINDS.includes(kindParam) ? { kind: kindParam } : {}), label: url.searchParams.get("label") || name, ...(url.searchParams.get("depicts") ? { depicts: url.searchParams.get("depicts")! } : {}) }]);
          return send(res, 200, source);
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      }
      if (req.method === "DELETE" && path.startsWith("/api/sources/")) {
        await svc.remove(decodeURIComponent(path.slice(13)));
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && path === "/api/jobs") {
        const body = await readJson(req);
        const action = String(body.action);
        const ids = Array.isArray(body.sourceIds) && body.sourceIds.length ? body.sourceIds.map(String) : ("all" as const);
        const job =
          action === "extract-build"
            ? runJob(action, async (log) => {
                const s = withLog(log);
                const outcomes = await s.extract(ids, { vision: Boolean(body.vision), force: Boolean(body.force) });
                log("cross-checking sources");
                const g = await s.build();
                return { outcomes, rules: g.rules.length };
              })
            : action === "build"
              ? runJob(action, async (log) => { await withLog(log).build(); return { ok: true }; })
              : action === "verify"
                ? runJob(action, async (log) => withLog(log).verify(String(body.target)))
                : null;
        if (!job) return send(res, 400, { error: `Unknown action ${action}` });
        return send(res, 202, { id: job.id });
      }
      if (req.method === "GET" && path.startsWith("/api/jobs/")) {
        const job = jobs.get(path.slice(10));
        return job ? send(res, 200, job) : send(res, 404, { error: "unknown job" });
      }
      if (req.method === "POST" && path === "/api/resolve") {
        const body = await readJson(req);
        await svc.resolve(String(body.conflictId), String(body.choice), body.note ? String(body.note) : undefined);
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET" && path.startsWith("/api/export/")) {
        const format = path.slice(12) as ExportFormat;
        if (!EXPORT_FORMATS.includes(format)) return send(res, 400, { error: "unknown format" });
        const { filename, content } = exportGenome(await svc.genome(), format, { openFonts: url.searchParams.get("originalFonts") !== "1" });
        res.writeHead(200, { "content-type": MIME[extname(filename)] ?? "text/plain; charset=utf-8", "content-disposition": `${url.searchParams.get("download") ? "attachment" : "inline"}; filename="${filename}"` });
        return res.end(content);
      }
      if (req.method === "GET" && path === "/api/genome.json") {
        const g = await svc.genome();
        res.writeHead(200, { "content-type": "application/json", "content-disposition": 'attachment; filename="genome.json"' });
        return res.end(JSON.stringify(g, null, 2));
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  const port = options.port ?? 4848;
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((ok) => server.listen(port, host, ok));
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  await readFile(join(STUDIO_DIR, "index.html")).catch(() => {
    throw new Error(`Studio UI not found at ${STUDIO_DIR}`);
  });
  return { url: `http://${host}:${actual}/`, close: () => new Promise((ok) => server.close(() => ok())) };
};
