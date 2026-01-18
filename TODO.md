# AIMax Viewer - TODO

## WIP (Work in Progress)

### Export PDF
- **Status**: Disabled in UI
- **Issue**: VS Code webview intercepts download attempts and opens external browser
- **Solution needed**: Use `vscode.workspace.fs.writeFile` API to save PDF
  1. Generate PDF as blob in webview using html2pdf.js
  2. Convert blob to base64
  3. Send via postMessage to extension
  4. Use `vscode.window.showSaveDialog()` to let user choose location
  5. Write file using `vscode.workspace.fs.writeFile()`
- **Code location**: `src/extension.ts` lines 792-857 (exportPdf function exists but button hidden)

## Completed

- YAML metadata display in (i) popup via postMessage
- Code block rendering with placeholder technique
- Copy button for code blocks
- Port conflict resolution (hash-based for default, fixed for custom)
- Documentation guides (EN/IT)
