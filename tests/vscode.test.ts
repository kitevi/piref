import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate, deactivate } from "../vscode-plugin/src/extension";
import { window } from "./vscode-mock";

const files = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));
vi.mock("node:fs", () => files);

let disk: Map<string, string>;

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
  window.activeTextEditor = {
    document: { uri: { scheme: "file", fsPath: "/project/file.ts" } },
    selection: { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  };
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

describe("minimal VS Code companion", () => {
  it("automatically writes a file reference, without storing source text", () => {
    const context = start();
    expect(lastData()).toEqual({ file: "/project/file.ts", ide: "vscode", timestamp: Date.now() });
    expect(context.subscriptions).toHaveLength(2);
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
    window.activeTextEditor!.selection = {
      isEmpty: false,
      start: { line: 3, character: 0 },
      end: { line: endLine, character: endCharacter },
    };
    start();
    expect(lastData()).toEqual({ ...lastData(), startLine: 4, endLine: expected });
    expect(lastData()).not.toHaveProperty("selection");
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
    window.onDidChangeActiveTextEditor.mock.calls[0]![0]();
    vi.advanceTimersByTime(100);
    expect(lastData().file).toBe("/project/next.ts");
  });

  it.each(["git", "untitled"])("records an explicit unsupported status for %s editors, without storing source text", scheme => {
    start();
    window.activeTextEditor!.document.uri.scheme = scheme;
    window.activeTextEditor!.selection = {
      isEmpty: false,
      start: { line: 55, character: 0 },
      end: { line: 62, character: 0 },
    };
    window.onDidChangeActiveTextEditor.mock.calls[0]![0]();
    vi.advanceTimersByTime(100);
    expect(lastData()).toEqual({
      ide: "vscode",
      timestamp: Date.now(),
      unsupported: true,
      scheme,
    });
  });

  it("replaces a stale file reference when moving to an unsupported editor", () => {
    start();
    const path = selectionPath();
    expect(JSON.parse(disk.get(path)!)).toHaveProperty("file");
    window.activeTextEditor!.document.uri.scheme = "git";
    window.onDidChangeActiveTextEditor.mock.calls[0]![0]();
    vi.advanceTimersByTime(100);
    expect(JSON.parse(disk.get(path)!)).toMatchObject({ unsupported: true, scheme: "git" });
  });

  it("clears its selection when no editor is active", () => {
    start();
    const path = selectionPath();
    window.activeTextEditor = undefined;
    window.onDidChangeActiveTextEditor.mock.calls[0]![0]();
    vi.advanceTimersByTime(100);
    expect(disk.has(path)).toBe(false);
    expect(files.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("clears an unsupported status on shutdown", () => {
    window.activeTextEditor!.document.uri.scheme = "git";
    start();
    const path = selectionPath();
    expect(JSON.parse(disk.get(path)!)).toMatchObject({ unsupported: true });
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
