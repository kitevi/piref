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

interface FileSelection {
  file: string;
  ide: "vscode";
  timestamp: number;
  startLine?: number;
  endLine?: number;
}

type SelectionPayload = FileSelection | {
  ide: "vscode";
  timestamp: number;
  unsupported: true;
  scheme: string;
};

function persistSelection(data: SelectionPayload) {
  try {
    fs.mkdirSync(path.dirname(SELECTION_FILE), { recursive: true, mode: 0o700 });
    const content = JSON.stringify(data);
    fs.writeFileSync(TEMP_FILE, content, { mode: 0o600 });
    fs.renameSync(TEMP_FILE, SELECTION_FILE);
    lastWrittenContent = content;
  } catch (error) {
    try { fs.unlinkSync(TEMP_FILE); } catch { /* Nothing to clean up. */ }
    console.error("piref: Failed to write VS Code selection:", error);
  }
}

function writeSelection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    clearSelection();
    return;
  }
  if (editor.document.uri.scheme !== "file") {
    // Historical diffs, unsaved files, and other virtual documents have no
    // working-tree path to reference. Record an explicit unsupported status so
    // /ide can explain this instead of reporting a stale or missing selection.
    // No source text is stored.
    persistSelection({
      ide: "vscode",
      timestamp: Date.now(),
      unsupported: true,
      scheme: editor.document.uri.scheme,
    });
    return;
  }

  const data: FileSelection = {
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

  persistSelection(data);
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
