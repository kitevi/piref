# Pi VS Code References

A small, automatically activated companion for [kitevi/piref](https://github.com/kitevi/piref).

Open a saved file or select lines in VS Code, then run `/ide` in Pi. The companion writes only the active path, line range, and timestamp to `~/.pi/ide-selection.json`; it does not store the selected source text.

There are no companion commands, keybindings, or settings. Nothing is displayed in Pi's footer.

## Install without a Microsoft account

Run `/ide-setup` in Pi, or download `piref-vscode.vsix` from the repository's GitHub releases and install it:

```sh
code --install-extension piref-vscode.vsix --force
```

Reload the VS Code window after installing. No Marketplace publishing or login is involved. The companion uses the `kitevi.piref-vscode` extension ID.

## Build locally

From this directory:

```sh
npm install
npm run package
code --install-extension piref-vscode.vsix --force
```

The package command compiles the extension automatically. Run the repository's **Release** workflow in GitHub Actions to publish a VSIX with an automatically generated timestamp version. No manual version bump, tag push, or Microsoft account is needed.
