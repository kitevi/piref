import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SELECTION_FILE = join(homedir(), ".pi", "ide-selection.json");
const MAX_SELECTION_AGE_MS = 60 * 60 * 1000;
const RELEASES_URL = "https://github.com/kitevi/pide/releases";
const VSIX_URL = `${RELEASES_URL}/latest/download/pide-vscode.vsix`;

interface Selection {
  file: string;
  ide: "vscode";
  timestamp: number;
  startLine?: number;
  endLine?: number;
}

async function readSelection(): Promise<Selection | null> {
  try {
    const data: unknown = JSON.parse(await readFile(SELECTION_FILE, "utf8"));
    if (!data || typeof data !== "object") return null;
    const selection = data as Partial<Selection>;
    if (
      typeof selection.file !== "string" || !isAbsolute(selection.file) ||
      selection.ide !== "vscode" ||
      typeof selection.timestamp !== "number" || !Number.isSafeInteger(selection.timestamp) ||
      selection.timestamp <= 0 || Date.now() - selection.timestamp > MAX_SELECTION_AGE_MS
    ) return null;

    if (selection.startLine !== undefined || selection.endLine !== undefined) {
      if (
        !Number.isSafeInteger(selection.startLine) || !Number.isSafeInteger(selection.endLine) ||
        selection.startLine! < 1 || selection.endLine! < selection.startLine!
      ) return null;
    }
    return selection as Selection;
  } catch {
    return null;
  }
}

function formatReference(selection: Selection): string {
  let reference = selection.file;
  if (selection.startLine !== undefined && selection.endLine !== undefined) {
    reference += selection.startLine === selection.endLine
      ? `:${selection.startLine}`
      : `:${selection.startLine}-${selection.endLine}`;
  }
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

export default function pide(pi: ExtensionAPI) {
  pi.registerCommand("ide", {
    description: "Insert the current VS Code file or selection reference [prompt]",
    handler: async (args, ctx) => {
      const selection = await readSelection();
      if (!selection) {
        const fallback = buildFallbackText(args);
        if (fallback !== null) ctx.ui.setEditorText(fallback);
        ctx.ui.notify("No recent VS Code selection. Open a file in VS Code, or run /ide-setup first.", "warning");
        return;
      }
      ctx.ui.setEditorText(buildIdeText(selection, args));
      // Older pi versions don't repaint after setEditorText; removing an unused widget does.
      ctx.ui.setWidget("pide-repaint", undefined);
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
          throw new Error(`Download failed (HTTP ${response.status}). A release containing pide-vscode.vsix must exist at ${RELEASES_URL}.`);
        }

        installDir = await mkdtemp(join(tmpdir(), "pide-install-"));
        const vsixPath = join(installDir, "pide-vscode.vsix");
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
