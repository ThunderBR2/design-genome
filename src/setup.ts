import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly required: boolean;
  readonly detail: string;
  readonly fix?: string;
}

const isWin = platform() === "win32";
const isMac = platform() === "darwin";

const tool = async (cmd: string, args: string[]): Promise<string | null> => {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout: 20_000 });
    return (stdout || stderr).split("\n")[0]!.trim();
  } catch {
    return null;
  }
};

/** Everything the extractors depend on, with the fix for each missing piece. */
export const doctor = async (): Promise<Check[]> => {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "Node.js 22+", ok: major >= 22, required: true, detail: `v${process.versions.node}`, fix: "Install Node.js 22 LTS or newer from nodejs.org." });
  let chromium = "";
  try {
    const { chromium: c } = await import("playwright");
    const browser = await c.launch({ headless: true });
    chromium = browser.version();
    await browser.close();
  } catch {
    /* reported below */
  }
  checks.push({ name: "Chromium (sites, verification)", ok: Boolean(chromium), required: true, detail: chromium || "not installed", fix: "npx playwright install chromium" });
  const ffmpeg = await tool("ffmpeg", ["-version"]);
  const ffprobe = await tool("ffprobe", ["-version"]);
  checks.push({ name: "ffmpeg + ffprobe (video)", ok: Boolean(ffmpeg && ffprobe), required: false, detail: ffmpeg ?? "not found on PATH", fix: isWin ? "winget install Gyan.FFmpeg  (then reopen the terminal)" : isMac ? "brew install ffmpeg" : "sudo apt install ffmpeg" });
  const pdftoppm = await tool("pdftoppm", ["-v"]);
  checks.push({ name: "pdftoppm (PDF page previews)", ok: Boolean(pdftoppm), required: false, detail: pdftoppm ?? "not found (PDF text still works)", fix: isWin ? "winget install oschwartz10612.Poppler" : isMac ? "brew install poppler" : "sudo apt install poppler-utils" });
  checks.push({ name: "FIGMA_TOKEN (read/verify Figma files)", ok: Boolean(process.env.FIGMA_TOKEN), required: false, detail: process.env.FIGMA_TOKEN ? "set" : "not set", fix: "Figma → Settings → Security → Personal access tokens; put it in the MCP config env." });
  checks.push({ name: "ANTHROPIC_API_KEY (headless vision only)", ok: Boolean(process.env.ANTHROPIC_API_KEY), required: false, detail: process.env.ANTHROPIC_API_KEY ? "set" : "not set — fine: through MCP, Claude reads the images itself", fix: "Optional." });
  return checks;
};

export const cliPath = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");

/** Claude Desktop config locations, most specific first (Windows Store installs keep it in the package folder). */
export const claudeDesktopConfigCandidates = (): string[] => {
  const home = homedir();
  if (isMac) return [join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")];
  if (isWin) {
    const out: string[] = [];
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const packages = join(local, "Packages");
    if (existsSync(packages)) {
      for (const dir of readdirSync(packages).filter((d) => /^Claude_/i.test(d))) out.push(join(packages, dir, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
    }
    out.push(join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json"));
    return out;
  }
  return [join(home, ".config", "Claude", "claude_desktop_config.json")];
};

/** Folders holding ffmpeg/ffprobe/pdftoppm on this machine's current PATH. */
export const toolDirs = async (): Promise<string[]> => {
  const dirs = new Set<string>();
  for (const name of ["ffmpeg", "ffprobe", "pdftoppm"]) {
    try {
      const { stdout } = await run(isWin ? "where" : "which", [name], { timeout: 10_000 });
      const first = stdout.split(/\r?\n/).find(Boolean);
      if (first) dirs.add(dirname(first.trim()));
    } catch {
      /* not installed */
    }
  }
  return [...dirs];
};

export const mcpServerEntry = (projectDir: string, env: Record<string, string> = {}) => ({
  command: process.execPath,
  args: [cliPath(), "-p", resolve(projectDir), "mcp"],
  ...(Object.keys(env).length ? { env } : {}),
});

/**
 * Add (or update) the design-genome server in Claude Desktop's config. Additive:
 * other servers and settings are kept, and the previous file is backed up.
 */
export const installClaudeDesktop = async (projectDir: string, env: Record<string, string>): Promise<{ path: string; backup: string | null }> => {
  const candidates = claudeDesktopConfigCandidates();
  const path = candidates.find((p) => existsSync(p)) ?? candidates.find((p) => existsSync(dirname(p))) ?? candidates.at(-1)!;
  let config: Record<string, unknown> = {};
  let backup: string | null = null;
  if (existsSync(path)) {
    const raw = await readFile(path, "utf8");
    try {
      config = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      throw new Error(`${path} is not valid JSON; fix it or paste the block from "genome mcp-config" by hand.`);
    }
    backup = `${path}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(path, backup);
  } else {
    await mkdir(dirname(path), { recursive: true });
  }
  const servers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
  const previous = (servers["design-genome"] as { env?: Record<string, string> } | undefined)?.env ?? {};
  const tools = await toolDirs();
  const toolPath: Record<string, string> = tools.length ? { GENOME_TOOL_PATH: tools.join(isWin ? ";" : ":") } : {};
  servers["design-genome"] = mcpServerEntry(projectDir, { ...previous, ...toolPath, ...env });
  config.mcpServers = servers;
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return { path, backup };
};
