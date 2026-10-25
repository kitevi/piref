import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const SELECTION_FILE = path.join(os.homedir(), ".pi", "ide-selection.json");
const TEMP_FILE = `${SELECTION_FILE}.${process.pid}.tmp`;
// Pi ignores references older than an hour; keep an idle one well inside that.
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
// Panels that VS Code exposes as text editors but that nobody wants to reference.
const IGNORED_SCHEMES = new Set(["output"]);
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let lastWritten: { content: string; data: SelectionPayload } | undefined;

function ownsSelectionFile(): boolean {
  try {
    return lastWritten !== undefined && fs.readFileSync(SELECTION_FILE, "utf8") === lastWritten.content;
  } catch {
    return false;
  }
}

function selectionFileExists(): boolean {
  try {
    fs.readFileSync(SELECTION_FILE, "utf8");
    return true;
  } catch {
    return false;
  }
}

// Every window runs its own companion. The focused window takes over the
// reference; a background window only updates a reference it already owns, so
// reloads or edits in a window you are not looking at cannot steal it.
function mayWrite(): boolean {
  return vscode.window.state.focused || ownsSelectionFile() || !selectionFileExists();
}

function clearSelection() {
  try {
    // A different VS Code window may have written a newer selection.
    if (ownsSelectionFile()) fs.unlinkSync(SELECTION_FILE);
  } catch {
    // A missing selection file is already clear.
  }
  lastWritten = undefined;
}

interface LineRange {
  startLine: number;
  endLine: number;
}

/** Where a git document's content comes from: a revision, or a stage of the index (0 = staged, 1-3 = merge). */
type GitSource = { revision: string } | { stage: number };

interface Location {
  file: string;
  git?: GitSource;
  cell?: number;
}

interface FileSelection extends Location {
  ide: "vscode";
  timestamp: number;
  startLine?: number;
  endLine?: number;
  ranges?: LineRange[];
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
    lastWritten = { content, data };
  } catch (error) {
    try { fs.unlinkSync(TEMP_FILE); } catch { /* Nothing to clean up. */ }
    console.error("piref: Failed to write VS Code selection:", error);
  }
}

/** Map a ref from VS Code's git extension to what `git show <ref>:<path>` would read. */
function gitSource(ref: string): GitSource {
  // "~" is the index if the file is staged, otherwise HEAD: the index content either way.
  if (ref === "" || ref === "~") return { stage: 0 };
  const stage = /^[~:]([0-3])$/.exec(ref);
  return stage ? { stage: Number(stage[1]) } : { revision: ref };
}

/** VS Code's git extension: git:/path?{"path":"/abs/path","ref":"HEAD"} */
function locateGitDocument(uri: vscode.Uri): Location | undefined {
  let query: unknown;
  try {
    query = JSON.parse(uri.query);
  } catch {
    return undefined;
  }
  if (!query || typeof query !== "object") return undefined;
  const { path: file, ref, submoduleOf } = query as Record<string, unknown>;
  // Submodule entries show a generated diff, not a file.
  if (submoduleOf !== undefined || typeof file !== "string" || !path.isAbsolute(file) || typeof ref !== "string") {
    return undefined;
  }
  return { file, git: gitSource(ref) };
}

/** Speedy Git: git-show://<revision>/<label>?<repo-relative path>#repo=<encoded repo path> */
function locateSpeedyGitDocument(uri: vscode.Uri): Location | undefined {
  const revision = uri.authority;
  const filePath = uri.query;
  let repo: string | undefined;
  for (const part of uri.fragment.split("&")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator) === "repo") {
      try {
        repo = decodeURIComponent(part.slice(separator + 1));
      } catch {
        repo = part.slice(separator + 1);
      }
    }
  }
  // "worktree" documents are submodule summaries, not files.
  if (!revision || revision === "worktree" || !filePath || path.isAbsolute(filePath) || !repo || !path.isAbsolute(repo)) {
    return undefined;
  }
  return {
    file: path.join(repo, filePath),
    git: revision === "staged" ? { stage: 0 } : { revision },
  };
}

function locateNotebookCell(document: vscode.TextDocument): Location | undefined {
  for (const notebook of vscode.workspace.notebookDocuments) {
    const cell = notebook.getCells().find(candidate => candidate.document === document);
    if (cell) return notebook.uri.scheme === "file" ? { file: notebook.uri.fsPath, cell: cell.index + 1 } : undefined;
  }
  return undefined;
}

function locate(document: vscode.TextDocument): Location | undefined {
  const { uri } = document;
  switch (uri.scheme) {
    case "file": return { file: uri.fsPath };
    case "git": return locateGitDocument(uri);
    case "git-show": return locateSpeedyGitDocument(uri);
    case "vscode-notebook-cell": return locateNotebookCell(document);
    default: return undefined;
  }
}

/** Inclusive 1-based line ranges of the non-empty selections, sorted, with overlapping or adjacent ranges merged. */
function lineRanges(selections: readonly vscode.Selection[]): LineRange[] {
  const ranges = selections
    .filter(selection => !selection.isEmpty)
    .map(({ start, end }) => ({
      startLine: start.line + 1,
      // VS Code's end position is exclusive: column zero belongs to the previous line.
      endLine: end.line > start.line && end.character === 0 ? end.line : end.line + 1,
    }))
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const merged: LineRange[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, range.endLine);
    else merged.push({ ...range });
  }
  return merged;
}

function hasOpenTabs(): boolean {
  return vscode.window.tabGroups.all.some(group => group.tabs.length > 0);
}

function writeSelection() {
  if (!mayWrite()) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    const notebook = vscode.window.activeNotebookEditor?.notebook;
    if (notebook?.uri.scheme === "file") {
      persistSelection({ file: notebook.uri.fsPath, ide: "vscode", timestamp: Date.now() });
    } else if (!hasOpenTabs()) {
      clearSelection();
    }
    // Otherwise a non-text tab (Settings, an image, a preview) is active: keep the last reference.
    return;
  }
  const { scheme } = editor.document.uri;
  if (IGNORED_SCHEMES.has(scheme)) return;

  const location = locate(editor.document);
  if (!location) {
    // Unsaved files and other virtual documents have no path to reference.
    // Record an explicit unsupported status so /ide can explain this instead of
    // reporting a stale or missing selection. No source text is stored.
    persistSelection({ ide: "vscode", timestamp: Date.now(), unsupported: true, scheme });
    return;
  }

  const data: FileSelection = { file: location.file, ide: "vscode", timestamp: Date.now() };
  if (location.git) data.git = location.git;
  if (location.cell !== undefined) data.cell = location.cell;
  const ranges = lineRanges(editor.selections);
  if (ranges.length > 0) {
    // startLine/endLine hold the first range so older Pi packages still read something sensible.
    data.startLine = ranges[0]!.startLine;
    data.endLine = ranges[0]!.endLine;
    if (ranges.length > 1) data.ranges = ranges;
  }
  persistSelection(data);
}

function refreshSelection() {
  if (lastWritten && ownsSelectionFile()) persistSelection({ ...lastWritten.data, timestamp: Date.now() });
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
    vscode.window.onDidChangeActiveNotebookEditor(scheduleSelection),
    vscode.window.onDidChangeWindowState(state => {
      if (state.focused) scheduleSelection();
    }),
    // Edits (including Pi's) can move the selected lines.
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document === vscode.window.activeTextEditor?.document) scheduleSelection();
    }),
  );
  refreshTimer = setInterval(refreshSelection, REFRESH_INTERVAL_MS);
  writeSelection();
}

export function deactivate() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = undefined;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = undefined;
  clearSelection();
}
