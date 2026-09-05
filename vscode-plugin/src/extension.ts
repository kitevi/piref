import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const SELECTION_FILE = path.join(os.homedir(), ".pi", "ide-selection.json");
const TEMP_FILE = `${SELECTION_FILE}.${process.pid}.tmp`;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let lastWrittenContent: string | undefined;

function clearSelection() {
  try {
    // A different VS Code window may have written a newer selection.
    if (lastWrittenContent !== undefined && fs.readFileSync(SELECTION_FILE, "utf8") === lastWrittenContent) {
      fs.unlinkSync(SELECTION_FILE);
    }
  } catch {
    // A missing selection file is already clear.
  }
  lastWrittenContent = undefined;
}

function writeSelection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") {
    clearSelection();
    return;
  }

  const data: { file: string; ide: "vscode"; timestamp: number; startLine?: number; endLine?: number } = {
    file: editor.document.uri.fsPath,
    ide: "vscode",
    timestamp: Date.now(),
  };
  if (!editor.selection.isEmpty) {
    const { start, end } = editor.selection;
    data.startLine = start.line + 1;
    // VS Code's end position is exclusive: column zero belongs to the previous line.
    data.endLine = end.line > start.line && end.character === 0 ? end.line : end.line + 1;
  }

  try {
    fs.mkdirSync(path.dirname(SELECTION_FILE), { recursive: true, mode: 0o700 });
    const content = JSON.stringify(data);
    fs.writeFileSync(TEMP_FILE, content, { mode: 0o600 });
    fs.renameSync(TEMP_FILE, SELECTION_FILE);
    lastWrittenContent = content;
  } catch (error) {
    try { fs.unlinkSync(TEMP_FILE); } catch { /* Nothing to clean up. */ }
    console.error("pide: Failed to write VS Code selection:", error);
  }
}

function scheduleSelection() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    writeSelection();
  }, 100);
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(scheduleSelection),
    vscode.window.onDidChangeActiveTextEditor(scheduleSelection),
  );
  writeSelection();
}

export function deactivate() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = undefined;
  clearSelection();
}
