import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SELECTION_FILE = join(homedir(), ".pi", "ide-selection.json");
const MAX_SELECTION_AGE_MS = 60 * 60 * 1000;
const RELEASES_URL = "https://github.com/kitevi/piref/releases";
const VSIX_URL = `${RELEASES_URL}/latest/download/piref-vscode.vsix`;

interface LineRange {
  startLine: number;
  endLine: number;
}

/** A git revision, or a stage of the git index (0 = staged, 1-3 = merge base, ours, theirs). */
type GitSource = { revision: string } | { stage: number };

interface Selection {
  file: string;
  ide: "vscode";
  timestamp: number;
  ranges: LineRange[];
  git?: GitSource;
  cell?: number;
}

const UNSUPPORTED_EDITOR_MESSAGE =
  "This editor doesn't support file references (for example, an unsaved file). Open a saved file in VS Code and select there instead.";

type SelectionResult = { kind: "file"; selection: Selection } | { kind: "unsupported" };

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function parseRange(startLine: unknown, endLine: unknown): LineRange | null {
  if (!isPositiveInteger(startLine) || !isPositiveInteger(endLine) || endLine < startLine) return null;
  return { startLine, endLine };
}

function parseGitSource(value: unknown): GitSource | null {
  if (!value || typeof value !== "object") return null;
  const { revision, stage } = value as Record<string, unknown>;
  if (revision !== undefined && stage !== undefined) return null;
  // The revision is inserted into Pi's input: allow a single short token only.
  if (typeof revision === "string" && /^\S{1,200}$/.test(revision)) return { revision };
  if (typeof stage === "number" && Number.isInteger(stage) && stage >= 0 && stage <= 3) return { stage };
  return null;
}

async function readSelection(): Promise<SelectionResult | null> {
  try {
    const data: unknown = JSON.parse(await readFile(SELECTION_FILE, "utf8"));
    if (!data || typeof data !== "object") return null;
    const record = data as Record<string, unknown>;
    const { file, ide, timestamp, startLine, endLine } = record;
    if (
      ide !== "vscode" ||
      typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) ||
      timestamp <= 0 || Date.now() - timestamp > MAX_SELECTION_AGE_MS
    ) return null;

    if (record.unsupported === true) {
      if (typeof record.scheme !== "string") return null;
      return { kind: "unsupported" };
    }
    if (typeof file !== "string" || !isAbsolute(file)) return null;

    const selection: Selection = { file, ide, timestamp, ranges: [] };
    if (startLine !== undefined || endLine !== undefined) {
      const range = parseRange(startLine, endLine);
      if (!range) return null;
      selection.ranges = [range];
    }
    if (record.ranges !== undefined) {
      // Several selections; startLine/endLine repeat the first for older Pi packages.
      if (!Array.isArray(record.ranges) || record.ranges.length === 0) return null;
      const ranges = record.ranges.map(range =>
        range && typeof range === "object" ? parseRange(range.startLine, range.endLine) : null);
      if (ranges.some(range => range === null)) return null;
      selection.ranges = ranges as LineRange[];
    }
    if (record.git !== undefined) {
      const git = parseGitSource(record.git);
      if (!git) return null;
      selection.git = git;
    }
    if (record.cell !== undefined) {
      if (!isPositiveInteger(record.cell)) return null;
      selection.cell = record.cell;
    }
    return { kind: "file", selection };
  } catch {
    return null;
  }
}

const INDEX_STAGES = ["staged", "merge base", "ours", "theirs"];

function formatGitSource(git: GitSource): string {
  return "revision" in git
    ? `git revision ${git.revision}`
    : `${INDEX_STAGES[git.stage]} version in the git index`;
}

function formatReference(selection: Selection): string {
  const lines = selection.ranges
    .map(({ startLine, endLine }) => startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`)
    .join(",");
  let reference = selection.file;
  if (selection.cell !== undefined) {
    reference += `, cell ${selection.cell}`;
    if (lines) reference += `, lines ${lines}`;
  } else if (lines) {
    reference += `:${lines}`;
  }
  if (selection.git) reference += ` (${formatGitSource(selection.git)})`;
  return `Referencing ${reference}\n`;
}

function buildIdeText(selection: Selection, rawArgs: string): string {
  const reference = formatReference(selection);
  const prompt = rawArgs.trim();
  if (prompt === "") return reference;
  return `${reference}${prompt}`;
}

function buildFallbackText(rawArgs: string): string | null {
  const prompt = rawArgs.trim();
  return prompt === "" ? null : prompt;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function piref(pi: ExtensionAPI) {
  pi.registerCommand("ide", {
    description: "Insert the current VS Code file or selection reference [prompt]",
    handler: async (args, ctx) => {
      const result = await readSelection();
      if (!result || result.kind === "unsupported") {
        const fallback = buildFallbackText(args);
        if (fallback !== null) ctx.ui.setEditorText(fallback);
        const message = result ? UNSUPPORTED_EDITOR_MESSAGE
          : "No recent VS Code selection. Open a file in VS Code, or run /ide-setup first.";
        ctx.ui.notify(message, "warning");
        return;
      }
      ctx.ui.setEditorText(buildIdeText(result.selection, args));
      // Older pi versions don't repaint after setEditorText; removing an unused widget does.
      ctx.ui.setWidget("piref-repaint", undefined);
    },
  });

  pi.registerCommand("ide-setup", {
    description: "Install the VS Code companion from GitHub (no Marketplace account needed)",
    handler: async (_args, ctx) => {
      let installDir: string | undefined;
      try {
        try {
          const result = await pi.exec("code", ["--version"], { timeout: 10_000 });
          if (result.code !== 0) throw new Error("code is unavailable");
        } catch {
          throw new Error("VS Code's code command is unavailable. Add it to PATH, then run /ide-setup again.");
        }

        ctx.ui.notify("Downloading the VS Code companion from GitHub…", "info");
        const response = await fetch(VSIX_URL, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) {
          throw new Error(`Download failed (HTTP ${response.status}). A release containing piref-vscode.vsix must exist at ${RELEASES_URL}.`);
        }

        installDir = await mkdtemp(join(tmpdir(), "piref-install-"));
        const vsixPath = join(installDir, "piref-vscode.vsix");
        await writeFile(vsixPath, new Uint8Array(await response.arrayBuffer()));
        const result = await pi.exec("code", ["--install-extension", vsixPath, "--force"], { timeout: 60_000 });
        if (result.code !== 0) {
          throw new Error(result.stderr.trim() || result.stdout.trim() || `code exited with ${result.code}`);
        }
        ctx.ui.notify("VS Code companion installed. Reload the VS Code window, then use /ide.", "info");
      } catch (error) {
        ctx.ui.notify(`VS Code setup failed: ${errorMessage(error)}`, "error");
      } finally {
        if (installDir) {
          try {
            await rm(installDir, { recursive: true, force: true });
          } catch (error) {
            ctx.ui.notify(`Could not clean up ${installDir}: ${errorMessage(error)}`, "warning");
          }
        }
      }
    },
  });
}
