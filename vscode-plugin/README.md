# Pi VS Code References

A small, automatically activated companion for [kitevi/pide](https://github.com/kitevi/pide).

Open a saved file or select lines in VS Code, then run `/ide` in Pi. The companion writes only the active path, line range, and timestamp to `~/.pi/ide-selection.json`; it does not store the selected source text.

There are no companion commands, keybindings, or settings. Nothing is displayed in Pi's footer.

## Install without a Microsoft account

Run `/ide-setup` in Pi, or download `pide-vscode.vsix` from the repository's GitHub releases and install it:

```sh
code --install-extension pide-vscode.vsix --force
```

Reload the VS Code window after installing. No Marketplace publishing or login is involved. The original `your-name.pide-vscode` extension ID is retained to upgrade existing sideloaded installations.

## Build locally

From this directory:

```sh
npm install
npm run package
code --install-extension pide-vscode.vsix --force
```

The package command compiles the extension automatically. Run the repository's **Release** workflow in GitHub Actions to publish a VSIX with an automatically generated timestamp version. No manual version bump, tag push, or Microsoft account is needed.
