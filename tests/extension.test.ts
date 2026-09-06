import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pide from "../index";

const files = vi.hoisted(() => ({
  readFile: vi.fn(),
  mkdtemp: vi.fn(),
  writeFile: vi.fn(),
  rm: vi.fn(),
}));
vi.mock("node:fs/promises", () => files);

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
const NOW = 1_700_000_000_000;
const selection = { file: "/project/file.ts", ide: "vscode", timestamp: NOW };
const success = { code: 0, stdout: "", stderr: "", killed: false };
let commands: Map<string, Command>;
let exec: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let setEditorText: ReturnType<typeof vi.fn>;
let notify: ReturnType<typeof vi.fn>;
let setWidget: ReturnType<typeof vi.fn>;
let ctx: ExtensionCommandContext;
let on: ReturnType<typeof vi.fn>;
let registerShortcut: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  files.readFile.mockResolvedValue(JSON.stringify(selection));
  files.mkdtemp.mockResolvedValue("/tmp/pide-install-test");
  files.writeFile.mockResolvedValue(undefined);
  files.rm.mockResolvedValue(undefined);
  commands = new Map();
  exec = vi.fn().mockResolvedValue(success);
  on = vi.fn();
  registerShortcut = vi.fn();
  setEditorText = vi.fn();
  notify = vi.fn();
  setWidget = vi.fn();
  ctx = { ui: { setEditorText, notify, setWidget } } as unknown as ExtensionCommandContext;
  fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([80, 75, 3, 4])));
  vi.stubGlobal("fetch", fetchMock);
  pide({
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    exec,
    on,
    registerShortcut,
  } as unknown as ExtensionAPI);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function run(name: string, args = "") {
  await commands.get(name)!.handler(args, ctx);
}

describe("minimal Pi integration", () => {
  it("registers only /ide and /ide-setup, without shortcuts or lifecycle hooks", () => {
    expect([...commands.keys()]).toEqual(["ide", "ide-setup"]);
    expect(on).not.toHaveBeenCalled();
    expect(registerShortcut).not.toHaveBeenCalled();
    expect(files.readFile).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("reads the current file only when /ide runs", async () => {
    await run("ide");
    expect(files.readFile).toHaveBeenCalledWith(expect.stringContaining("ide-selection.json"), "utf8");
    expect(setEditorText).toHaveBeenCalledWith("Referencing /project/file.ts\n");
    expect(notify).not.toHaveBeenCalled();
  });

  it.each(["", "explain this"])("requests a repaint after setting editor text (%j)", async args => {
    await run("ide", args);
    expect(setWidget).toHaveBeenCalledExactlyOnceWith("pide-repaint", undefined);
    expect(setWidget.mock.invocationCallOrder[0]).toBeGreaterThan(setEditorText.mock.invocationCallOrder[0]!);
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    { startLine: 4, endLine: 4, suffix: ":4" },
    { startLine: 4, endLine: 8, suffix: ":4-8" },
  ])("preserves selected line references: $suffix", async ({ startLine, endLine, suffix }) => {
    files.readFile.mockResolvedValue(JSON.stringify({ ...selection, startLine, endLine, selection: "not copied" }));
    await run("ide");
    expect(setEditorText).toHaveBeenCalledWith(`Referencing /project/file.ts${suffix}\n`);
  });

  it("re-reads rather than caching an old selection", async () => {
    await run("ide");
    files.readFile.mockResolvedValue(JSON.stringify({ ...selection, file: "/project/new.ts" }));
    await run("ide");
    expect(setEditorText).toHaveBeenLastCalledWith("Referencing /project/new.ts\n");
    expect(files.readFile).toHaveBeenCalledTimes(2);
  });

  it("leaves the input untouched if the selection file is missing", async () => {
    files.readFile.mockRejectedValue(new Error("ENOENT"));
    await run("ide");
    expect(setEditorText).not.toHaveBeenCalled();
    expect(setWidget).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("No recent VS Code selection"), "warning");
  });

  it("appends trailing prompt text after the reference without submitting", async () => {
    await run("ide", "explain this");
    expect(setEditorText).toHaveBeenCalledWith("Referencing /project/file.ts\nexplain this");
    expect(notify).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace but preserves inner newlines", async () => {
    await run("ide", "  explain\nmore  ");
    expect(setEditorText).toHaveBeenCalledWith("Referencing /project/file.ts\nexplain\nmore");
  });

  it("keeps legacy output for whitespace-only args", async () => {
    await run("ide", "   \n  ");
    expect(setEditorText).toHaveBeenCalledWith("Referencing /project/file.ts\n");
  });

  it("restores trailing prompt text when no selection is available", async () => {
    files.readFile.mockRejectedValue(new Error("ENOENT"));
    await run("ide", "don't lose me");
    expect(setEditorText).toHaveBeenCalledWith("don't lose me");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("No recent VS Code selection"), "warning");
  });

  it.each([
    "{",
    "null",
    "[]",
    "{}",
    "42",
    JSON.stringify({ ...selection, file: "relative.ts" }),
    JSON.stringify({ ...selection, file: 42 }),
    JSON.stringify({ ...selection, ide: "other-editor" }),
    JSON.stringify({ ...selection, timestamp: undefined }),
    JSON.stringify({ ...selection, timestamp: "now" }),
    JSON.stringify({ ...selection, timestamp: NOW - 3_600_001 }),
    JSON.stringify({ ...selection, startLine: 1 }),
    JSON.stringify({ ...selection, endLine: 2 }),
    JSON.stringify({ ...selection, startLine: 0, endLine: 1 }),
    JSON.stringify({ ...selection, startLine: 3, endLine: 2 }),
    JSON.stringify({ ...selection, startLine: 1.5, endLine: 2 }),
    JSON.stringify({ ...selection, startLine: "1", endLine: "2" }),
  ])("ignores invalid or expired selection data: %s", async content => {
    files.readFile.mockResolvedValue(content);
    await run("ide");
    expect(setEditorText).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.any(String), "warning");
  });
});

describe("VS Code setup without Marketplace access", () => {
  it("downloads the fork's release, sideloads it, and removes temporary files", async () => {
    await run("ide-setup");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/kitevi/pide/releases/latest/download/pide-vscode.vsix",
      { signal: expect.any(AbortSignal) },
    );
    expect(exec.mock.calls).toEqual([
      ["code", ["--version"], { timeout: 10_000 }],
      ["code", ["--install-extension", "/tmp/pide-install-test/pide-vscode.vsix", "--force"], { timeout: 60_000 }],
    ]);
    expect(files.writeFile).toHaveBeenCalledWith("/tmp/pide-install-test/pide-vscode.vsix", new Uint8Array([80, 75, 3, 4]));
    expect(files.rm).toHaveBeenCalledWith("/tmp/pide-install-test", { recursive: true, force: true });
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("companion installed"), "info");
    expect(files.readFile).not.toHaveBeenCalled();
  });

  it.each(["missing", "nonzero"])("does not download when the code CLI is %s", async reason => {
    if (reason === "missing") exec.mockRejectedValueOnce(new Error("ENOENT"));
    else exec.mockResolvedValueOnce({ ...success, code: 1 });
    await run("ide-setup");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("Add it to PATH"), "error");
  });

  it("explains a missing GitHub release without attempting installation", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    await run("ide-setup");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(files.mkdtemp).not.toHaveBeenCalled();
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("A release containing pide-vscode.vsix must exist"), "error");
  });

  it("reports network errors", async () => {
    fetchMock.mockRejectedValue(new Error("network unavailable"));
    await run("ide-setup");
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("network unavailable"), "error");
    expect(files.writeFile).not.toHaveBeenCalled();
  });

  it("cleans up after a failed response body download", async () => {
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: () => Promise.reject(new Error("download interrupted")) });
    await run("ide-setup");
    expect(files.rm).toHaveBeenCalled();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("download interrupted"), "error");
  });

  it("reports installation errors and still cleans up", async () => {
    exec.mockResolvedValueOnce(success).mockResolvedValueOnce({ ...success, code: 1, stderr: "invalid VSIX" });
    await run("ide-setup");
    expect(files.rm).toHaveBeenCalled();
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("invalid VSIX"), "error");
  });
});
