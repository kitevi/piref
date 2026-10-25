# piref

piref lets Pi's `/ide` command insert a reference to what you are looking at in VS Code — a file path plus selected line ranges — without copying source text into the prompt.

## Language

**Reference**:
The text `/ide` puts into Pi's input, such as `Referencing /path/file.ts:10-15`. It names a location; it never contains source text.
_Avoid_: snippet, quote, context

**Companion**:
The VS Code extension in `vscode-plugin/`, sideloaded from GitHub releases by `/ide-setup`. One instance runs in every VS Code window.
_Avoid_: plugin, client

**Selection file**:
`~/.pi/ide-selection.json`, the only channel between the Companion and Pi. Written atomically by the Companion, read by Pi only when `/ide` runs. Pi ignores it once it is more than an hour old.
_Avoid_: state file, cache

**Owner**:
The Companion window whose content is currently in the Selection file. A focused window always becomes the Owner; a background window may only update the file while it is the Owner, and only the Owner refreshes or deletes it.

**Unsupported status**:
What the Companion records when the active editor has no file path to reference (an unsaved file, a submodule diff). Pi explains this instead of inserting an older Reference.

**Git source**:
For editors that show a historical Git version, which version the selected line numbers belong to: a revision (`HEAD`, a commit) or an index stage (0 = staged, 1–3 = merge base, ours, theirs). Included in the Reference because the working-tree file may differ.

## Agent instructions

- Work test-first: `npm test` covers both the Pi package (`tests/extension.test.ts`) and the Companion against a hand-written `vscode` mock (`tests/vscode-mock.ts`). Extend the mock when the Companion uses new VS Code API.
- Run `npm run typecheck` before finishing; it also compiles the Companion.
- Keep the Selection file backward compatible: an older Pi package may read a newer Companion's output, and vice versa.
- Releases are manual (see `README.md`); never edit version numbers or push tags.
