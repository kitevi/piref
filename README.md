# piref — VS Code references for Pi

A minimal, VS Code-only fork of [pierre-borckmans/pide](https://github.com/pierre-borckmans/pide).

Two Pi commands, nothing in the footer, no shortcuts, and no background polling in Pi:

| Command | Purpose |
| --- | --- |
| `/ide` | Put a reference to the current VS Code file or selected lines into Pi's input. |
| `/ide-setup` | Download and install the VS Code companion from this repository's latest GitHub release. |

## Install

```sh
pi install https://github.com/kitevi/piref
```

Or add `"https://github.com/kitevi/piref"` to the `packages` array in Pi's `settings.json`.

Run `/ide-setup`, then reload your VS Code window. Open a file or select some lines, and run `/ide` in Pi. For example:

```text
Referencing /path/to/file.ts:10-15
```

`/ide` replaces Pi's input with the reference. It does not submit a message or copy selected source text. You can also type `/ide your prompt` on one line: the prompt is kept after the reference so nothing is lost.

## No Microsoft account required

The companion is **sideloaded**, not published to the VS Code Marketplace. `/ide-setup` downloads `piref-vscode.vsix` from GitHub and runs:

```sh
code --install-extension /path/to/piref-vscode.vsix --force
```

VS Code's `code` CLI must be on `PATH`. The first GitHub release must exist before `/ide-setup` can download it; see below. You can also build and install the VSIX locally without any account.

The companion uses the `your-name.piref-vscode` extension ID. This publisher field is package metadata, not a Microsoft login. If you previously installed the old `your-name.pide-vscode` companion, uninstall it to avoid running two copies.

## How it works

The VS Code companion automatically writes the active file path, optional line range, and timestamp to `~/.pi/ide-selection.json`. It does not store the selected source text. Pi reads that file only when `/ide` runs. Missing, invalid, or more-than-one-hour-old selections are ignored.

Historical diffs, unsaved files, and other non-file editors cannot be referenced by path. The companion records an explicit unsupported status for those editors (still without storing source text), and `/ide` explains that limitation instead of inserting a stale reference.

All local Pi sessions share the most recently reported VS Code selection. No servers, ports, status widgets, or Pi file watchers are involved.

## Development

Node.js 22.17+ is required.

```sh
npm install
npm --prefix vscode-plugin install
npm test
npm run typecheck
npm run package:vscode
code --install-extension vscode-plugin/piref-vscode.vsix --force
```

The compiled companion is packaged into `vscode-plugin/piref-vscode.vsix`. Build artifacts are not committed. Project `.npmrc` files disable lockfile generation; dependencies resolve from the package manifests.

## Releases

Push the source changes to `kitevi/piref` before installing the remote Pi package. Changing a local checkout does not update the remote package.

There are no automatic push/PR checks. The manual release workflow installs and builds only the VS Code companion; it does not install the root Pi package or run the optional local tests/typechecks.

To publish, use the same process as `rfs`:

1. Commit and push your source changes to `main`.
2. Open **Actions → Release → Run workflow**, select **main**, and run it. If Actions is disabled for the fork, enable it first.
3. Wait for the build and release to finish, then run `/ide-setup` to install it.

The release workflow generates a version from the current UTC build time: `YYYY.MD.HMS`, with no leading zeroes. For example, `2026-07-09 20:01:11 UTC` becomes `2026.709.200111`. Each later build gets a higher version that VS Code can recognize as an upgrade.

The version is stamped into the VS Code package manifest only in the build checkout. The checked-in versions remain development defaults: **you do not edit version numbers or create/push tags**. GitHub creates the timestamp tag at the source commit being built and publishes `piref-vscode.vsix` as the latest release. Releases are serialized so builds do not race to publish out of order.

Only GitHub's automatically supplied `GITHUB_TOKEN` is used. No Marketplace credentials or npm publishing account are needed. `/ide-setup` continues to install the latest stable GitHub release.

## License

MIT. Original copyright retained in `LICENSE`.
