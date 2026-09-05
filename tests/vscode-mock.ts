import { vi } from "vitest";

export const window = {
  activeTextEditor: undefined as undefined | {
    document: { uri: { scheme: string; fsPath: string } };
    selection: { isEmpty: boolean; start: { line: number; character: number }; end: { line: number; character: number } };
  },
  onDidChangeTextEditorSelection: vi.fn((_listener: () => void) => ({ dispose: vi.fn() })),
  onDidChangeActiveTextEditor: vi.fn((_listener: () => void) => ({ dispose: vi.fn() })),
};
