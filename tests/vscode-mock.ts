import { vi } from "vitest";

export interface MockUri {
  scheme: string;
  fsPath: string;
  authority?: string;
  query?: string;
  fragment?: string;
}

export interface MockSelection {
  isEmpty: boolean;
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface MockDocument {
  uri: MockUri;
}

export const window = {
  state: { focused: true },
  activeTextEditor: undefined as undefined | {
    document: MockDocument;
    selection: MockSelection;
    selections: MockSelection[];
  },
  activeNotebookEditor: undefined as undefined | { notebook: { uri: MockUri } },
  tabGroups: { all: [] as { tabs: unknown[] }[] },
  onDidChangeTextEditorSelection: vi.fn((_listener: () => void) => ({ dispose: vi.fn() })),
  onDidChangeActiveTextEditor: vi.fn((_listener: () => void) => ({ dispose: vi.fn() })),
  onDidChangeActiveNotebookEditor: vi.fn((_listener: () => void) => ({ dispose: vi.fn() })),
  onDidChangeWindowState: vi.fn((_listener: (state: { focused: boolean }) => void) => ({ dispose: vi.fn() })),
};

export const workspace = {
  notebookDocuments: [] as { uri: MockUri; getCells(): { index: number; document: MockDocument }[] }[],
  onDidChangeTextDocument: vi.fn((_listener: (event: { document: MockDocument }) => void) => ({ dispose: vi.fn() })),
};
