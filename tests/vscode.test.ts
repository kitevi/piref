import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate, deactivate } from "../vscode-plugin/src/extension";
import { window, workspace, type MockDocument, type MockSelection, type MockUri } from "./vscode-mock";

const files = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));
vi.mock("node:fs", () => files);

let disk: Map<string, string>;

function fileUri(fsPath: string): MockUri {
  return { scheme: "file", fsPath };
}

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number): MockSelection {
  return {
    isEmpty: startLine === endLine && startCharacter === endCharacter,
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function openEditor(uri: MockUri, ...selections: MockSelection[]) {
  if (selections.length === 0) selections = [range(0, 0, 0, 0)];
  window.activeTextEditor = { document: { uri }, selection: selections[0]!, selections };
}

function select(...selections: MockSelection[]) {
  window.activeTextEditor!.selection = selections[0]!;
  window.activeTextEditor!.selections = selections;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  disk = new Map();
  files.writeFileSync.mockImplementation((path: string, content: string) => disk.set(path, content));
  files.renameSync.mockImplementation((from: string, to: string) => {
    disk.set(to, disk.get(from)!);
    disk.delete(from);
  });
  files.readFileSync.mockImplementation((path: string) => {
    if (!disk.has(path)) throw new Error("ENOENT");
    return disk.get(path);
  });
  files.unlinkSync.mockImplementation((path: string) => disk.delete(path));
  window.state.focused = true;
  window.activeNotebookEditor = undefined;
  window.tabGroups.all = [{ tabs: [{}] }];
  workspace.notebookDocuments = [];
  openEditor(fileUri("/project/file.ts"));
});

afterEach(() => {
  deactivate();
  vi.useRealTimers();
});

function start() {
  const context = { subscriptions: [] } as unknown as Parameters<typeof activate>[0];
  activate(context);
  return context;
}

function lastData() {
  return JSON.parse(files.writeFileSync.mock.calls.at(-1)![1] as string);
}

function selectionPath(): string {
  return files.renameSync.mock.calls.at(-1)![1] as string;
}

function current() {
  return JSON.parse(disk.get(selectionPath())!);
}

function changeSelection() {
  window.onDidChangeTextEditorSelection.mock.calls[0]![0]();
  vi.advanceTimersByTime(100);
}

function changeEditor() {
  window.onDidChangeActiveTextEditor.mock.calls[0]![0]();
  vi.advanceTimersByTime(100);
}

function changeFocus(focused: boolean) {
  window.state.focused = focused;
  window.onDidChangeWindowState.mock.calls[0]![0]({ focused });
  vi.advanceTimersByTime(100);
}

describe("minimal VS Code companion", () => {
  it("automatically writes a file reference, without storing source text", () => {
    start();
    expect(lastData()).toEqual({ file: "/project/file.ts", ide: "vscode", timestamp: Date.now() });
    expect(window.onDidChangeActiveTextEditor).toHaveBeenCalledOnce();
    expect(window.onDidChangeTextEditorSelection).toHaveBeenCalledOnce();
  });

  it("writes atomically with private file permissions", () => {
    start();
    const [temporary, content, options] = files.writeFileSync.mock.calls[0]!;
    expect(temporary).toMatch(/[.]tmp$/);
    expect(options).toEqual({ mode: 0o600 });
    expect(files.renameSync).toHaveBeenCalledWith(temporary, expect.stringContaining("ide-selection.json"));
    expect(files.writeFileSync.mock.invocationCallOrder[0]).toBeLessThan(files.renameSync.mock.invocationCallOrder[0]!);
    expect(disk.get(selectionPath())).toBe(content);
    expect(disk.has(temporary)).toBe(false);
  });

  it.each([
    { endLine: 6, endCharacter: 5, expected: 7 },
    { endLine: 6, endCharacter: 0, expected: 6 },
    { endLine: 3, endCharacter: 4, expected: 4 },
  ])("reports correct inclusive line ranges: %j", ({ endLine, endCharacter, expected }) => {
    select(range(3, 0, endLine, endCharacter));
    start();
    expect(lastData()).toEqual({ ...lastData(), startLine: 4, endLine: expected });
    expect(lastData()).not.toHaveProperty("selection");
    expect(lastData()).not.toHaveProperty("ranges");
  });

  it("debounces repeated selection changes", () => {
    start();
    const listener = window.onDidChangeTextEditorSelection.mock.calls[0]![0];
    listener();
    listener();
    listener();
    expect(files.writeFileSync).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(files.writeFileSync).toHaveBeenCalledTimes(2);
  });

  it("reports a newly activated editor", () => {
    start();
    window.activeTextEditor!.document.uri.fsPath = "/project/next.ts";
    changeEditor();
    expect(lastData().file).toBe("/project/next.ts");
  });

  it.each(["untitled", "vscode-userdata"])("records an explicit unsupported status for %s editors, without storing source text", scheme => {
    start();
    openEditor({ scheme, fsPath: "/Untitled-1" }, range(55, 0, 62, 0));
    changeEditor();
    expect(lastData()).toEqual({
      ide: "vscode",
      timestamp: Date.now(),
      unsupported: true,
      scheme,
    });
  });

  it("replaces a stale file reference when moving to an unsupported editor", () => {
    start();
    expect(current()).toHaveProperty("file");
    openEditor({ scheme: "untitled", fsPath: "Untitled-1" });
    changeEditor();
    expect(current()).toMatchObject({ unsupported: true, scheme: "untitled" });
  });

  it("clears its selection when every editor tab is closed", () => {
    start();
    const path = selectionPath();
    window.activeTextEditor = undefined;
    window.tabGroups.all = [{ tabs: [] }];
    changeEditor();
    expect(disk.has(path)).toBe(false);
    expect(files.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("clears an unsupported status on shutdown", () => {
    openEditor({ scheme: "untitled", fsPath: "Untitled-1" });
    start();
    const path = selectionPath();
    expect(current()).toMatchObject({ unsupported: true });
    deactivate();
    expect(disk.has(path)).toBe(false);
  });

  it("cancels pending writes and clears its selection on shutdown", () => {
    start();
    const path = selectionPath();
    window.onDidChangeTextEditorSelection.mock.calls[0]![0]();
    deactivate();
    vi.advanceTimersByTime(100);
    expect(files.writeFileSync).toHaveBeenCalledTimes(1);
    expect(disk.has(path)).toBe(false);
  });

  it("does not clear a newer selection written by another VS Code window", () => {
    start();
    const path = selectionPath();
    disk.set(path, "another window's selection");
    deactivate();
    expect(disk.get(path)).toBe("another window's selection");
  });
});

describe("git diff editors", () => {
  function gitUri(path: string, ref: string, extra: Record<string, string> = {}): MockUri {
    return { scheme: "git", fsPath: path, query: JSON.stringify({ path, ref, ...extra }) };
  }

  it.each([
    { ref: "HEAD", git: { revision: "HEAD" } },
    { ref: "4beac8f97580daa60fc3483837151a5de264137d", git: { revision: "4beac8f97580daa60fc3483837151a5de264137d" } },
    { ref: "~", git: { stage: 0 } },
    { ref: "", git: { stage: 0 } },
    { ref: "~1", git: { stage: 1 } },
    { ref: ":2", git: { stage: 2 } },
    { ref: ":3", git: { stage: 3 } },
  ])("references selected lines in VS Code's git documents at ref $ref", ({ ref, git }) => {
    openEditor(gitUri("/project/file.ts", ref), range(9, 2, 14, 7));
    start();
    expect(lastData()).toEqual({
      file: "/project/file.ts",
      ide: "vscode",
      timestamp: Date.now(),
      startLine: 10,
      endLine: 15,
      git,
    });
  });

  it.each([
    { name: "submodule diffs", uri: gitUri("/project/sub", "HEAD", { submoduleOf: "/project" }) },
    { name: "malformed queries", uri: { scheme: "git", fsPath: "/project/file.ts", query: "{" } },
    { name: "relative paths", uri: gitUri("file.ts", "HEAD") },
  ])("reports $name as unsupported", ({ uri }) => {
    openEditor(uri);
    start();
    expect(lastData()).toMatchObject({ unsupported: true, scheme: "git" });
  });

  function speedyGitUri(revision: string, filePath: string, repo = "/my repo"): MockUri {
    return {
      scheme: "git-show",
      fsPath: "/file.ts (abc1234)",
      authority: revision,
      query: filePath,
      fragment: `repo=${encodeURIComponent(repo)}&nonce=1234`,
    };
  }

  it.each([
    { revision: "4beac8f97580daa60fc3483837151a5de264137d", git: { revision: "4beac8f97580daa60fc3483837151a5de264137d" } },
    { revision: "staged", git: { stage: 0 } },
  ])("references selected lines in Speedy Git documents at $revision", ({ revision, git }) => {
    openEditor(speedyGitUri(revision, "src/file.ts"), range(2, 0, 3, 1));
    start();
    expect(lastData()).toMatchObject({ file: "/my repo/src/file.ts", startLine: 3, endLine: 4, git });
  });

  it("reports Speedy Git submodule worktree documents as unsupported", () => {
    openEditor(speedyGitUri("worktree", "sub"));
    start();
    expect(lastData()).toMatchObject({ unsupported: true, scheme: "git-show" });
  });
});

describe("multiple selections", () => {
  it("reports every selected range in line order, merging overlaps", () => {
    select(range(20, 0, 21, 3), range(2, 0, 4, 1), range(4, 0, 5, 0), range(8, 3, 8, 3), range(9, 0, 9, 2));
    start();
    expect(lastData()).toMatchObject({
      startLine: 3,
      endLine: 5,
      ranges: [
        { startLine: 3, endLine: 5 },
        { startLine: 10, endLine: 10 },
        { startLine: 21, endLine: 22 },
      ],
    });
  });

  it("omits line numbers when every cursor is empty", () => {
    select(range(2, 1, 2, 1), range(5, 0, 5, 0));
    start();
    expect(lastData()).toEqual({ file: "/project/file.ts", ide: "vscode", timestamp: Date.now() });
  });
});

describe("non-reference editors", () => {
  it("keeps the last reference while the Output panel is focused", () => {
    start();
    openEditor({ scheme: "output", fsPath: "extension-output-1" }, range(0, 0, 3, 0));
    changeEditor();
    expect(files.writeFileSync).toHaveBeenCalledTimes(1);
    expect(current()).toMatchObject({ file: "/project/file.ts" });
  });

  it("keeps the last reference while a non-text tab such as Settings is active", () => {
    start();
    window.activeTextEditor = undefined;
    changeEditor();
    expect(current()).toMatchObject({ file: "/project/file.ts" });
  });

  it("references the notebook and cell for a notebook cell editor", () => {
    const cell: MockDocument = { uri: { scheme: "vscode-notebook-cell", fsPath: "/project/nb.ipynb" } };
    workspace.notebookDocuments = [{
      uri: fileUri("/project/nb.ipynb"),
      getCells: () => [{ index: 0, document: { uri: fileUri("/other") } }, { index: 1, document: cell }],
    }];
    window.activeTextEditor = { document: cell, selection: range(1, 0, 2, 4), selections: [range(1, 0, 2, 4)] };
    start();
    expect(lastData()).toEqual({
      file: "/project/nb.ipynb",
      ide: "vscode",
      timestamp: Date.now(),
      cell: 2,
      startLine: 2,
      endLine: 3,
    });
  });

  it("references the notebook file when a notebook is active without a cell editor", () => {
    window.activeTextEditor = undefined;
    window.activeNotebookEditor = { notebook: { uri: fileUri("/project/nb.ipynb") } };
    start();
    expect(lastData()).toEqual({ file: "/project/nb.ipynb", ide: "vscode", timestamp: Date.now() });
  });
});

describe("multiple windows", () => {
  it("reports this window's editor when the window regains focus", () => {
    start();
    disk.set(selectionPath(), JSON.stringify({ file: "/other-window/file.ts", ide: "vscode", timestamp: Date.now() }));
    changeFocus(false);
    expect(current().file).toBe("/other-window/file.ts");
    changeFocus(true);
    expect(current().file).toBe("/project/file.ts");
  });

  it("does not overwrite another window's reference from the background", () => {
    start();
    disk.set(selectionPath(), JSON.stringify({ file: "/other-window/file.ts", ide: "vscode", timestamp: Date.now() }));
    window.state.focused = false;
    select(range(1, 0, 2, 0));
    changeSelection();
    expect(current().file).toBe("/other-window/file.ts");
  });

  it("keeps updating its own reference from the background", () => {
    start();
    window.state.focused = false;
    select(range(1, 0, 3, 0));
    changeSelection();
    expect(current()).toMatchObject({ file: "/project/file.ts", startLine: 2, endLine: 3 });
  });

  it("does not take over another window's reference when activated in the background", () => {
    files.readFileSync.mockImplementation(() => JSON.stringify({ file: "/other-window/file.ts" }));
    window.state.focused = false;
    start();
    expect(files.writeFileSync).not.toHaveBeenCalled();
  });
});

describe("freshness", () => {
  it("refreshes the line range when the active document changes", () => {
    start();
    select(range(4, 0, 5, 0));
    workspace.onDidChangeTextDocument.mock.calls[0]![0]({ document: window.activeTextEditor!.document });
    vi.advanceTimersByTime(100);
    expect(current()).toMatchObject({ startLine: 5, endLine: 5 });
  });

  it("ignores changes to documents that are not active", () => {
    start();
    workspace.onDidChangeTextDocument.mock.calls[0]![0]({ document: { uri: fileUri("/project/other.ts") } });
    vi.advanceTimersByTime(100);
    expect(files.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("keeps an idle reference fresh while this window owns it", () => {
    select(range(1, 0, 2, 0));
    start();
    const started = Date.now();
    window.state.focused = false;
    vi.advanceTimersByTime(90 * 60 * 1000);
    expect(current()).toMatchObject({ file: "/project/file.ts", startLine: 2, endLine: 2 });
    expect(current().timestamp).toBeGreaterThan(started);
    expect(Date.now() - current().timestamp).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it("does not refresh another window's reference", () => {
    start();
    const other = JSON.stringify({ file: "/other-window/file.ts", ide: "vscode", timestamp: 1 });
    disk.set(selectionPath(), other);
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(disk.get(selectionPath())).toBe(other);
  });

  it("stops refreshing on shutdown", () => {
    start();
    deactivate();
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(files.writeFileSync).toHaveBeenCalledTimes(1);
  });
});
