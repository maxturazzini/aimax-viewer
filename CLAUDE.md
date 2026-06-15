# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Compile TypeScript
npm run compile

# Watch mode for development
npm run watch

# Package extension as VSIX
npx vsce package --allow-missing-repository

# Install extension locally (after packaging)
code --install-extension aimax-viewer-<version>.vsix --force

# Full build and install cycle
npm run compile && npx vsce package --allow-missing-repository && code --install-extension aimax-viewer-*.vsix --force
```

After installing, reload VS Code window (`Cmd+Shift+P` → "Developer: Reload Window") to activate changes.

## Architecture Overview

AIMax Viewer is a VS Code extension that provides an internal browser for viewing HTML/Markdown artifacts without leaving the editor.

### Core Components

```
src/
├── extension.ts       # Main entry point, commands, webview panels, inline HTTP server
├── server.ts          # Standalone HTTP server (alternative to inline)
├── markdown-parser.ts # Markdown→HTML conversion with YAML frontmatter extraction
├── treeview-provider.ts # Sidebar TreeView for artifact browsing
├── config.ts          # Configuration interface (partially used, main config in extension.ts)
└── utils.ts           # File utilities (workspace detection, artifact listing)
```

### Key Architectural Patterns

1. **Two Panel Types**: 
   - **Home Panel**: Direct webview content injection (supports external links)
   - **Browser Panel**: iframe-based with toolbar (dropdown, navigation, info popup)

2. **HTTP Server**: Serves workspace files on `127.0.0.1:<port>`. Port logic:
   - Default 3124 → hash-based unique port per workspace (avoids conflicts)
   - Custom value → used as-is (fixed)

3. **Cross-Origin Communication**: iframe content uses `postMessage` to communicate with parent webview (for YAML metadata in (i) popup)

4. **Markdown Processing**: Uses placeholder technique (`<!--CODEBLOCK-->`) to protect code blocks during regex processing

### Direct Save to Served Files (in-place edit mechanism)

The viewer can **write edits straight back to the source file on disk** for any
`.html` it serves, without leaving AIMax. This is the foundation to reuse for any
future "edit a rendered artifact and persist it" feature. Three facts make it work:

1. **The physical path is always recoverable from the HTTP URL.** A served URL
   like `http://127.0.0.1:<port>/Artifacts/deck.html` maps deterministically to
   `<workspace>/Artifacts/deck.html`. `urlToWorkspacePath(url)` does this with all
   safety gates (host/port must be AIMax's own server, path must end in `.html`,
   not `/__proxy__/` `/__presenter` `/api/`, file must exist). `filePathToWorkspacePath(filePath)`
   is the equivalent for a directly-supplied path (Home Panel case), and
   `resolveEditTarget(message)` accepts either `{url}` or `{filePath}`.

2. **`applyHtmlEdits(absolutePath, edits[])` is the single write primitive.** Each
   edit is `{n, oldText, newText, selector?, occurrenceIndex?, outerHTML?}`. It does an
   **anchored verbatim text replace** in the raw source with three disambiguation
   levels: (1) `oldText` unique → replace; (2) ambiguous but `outerHTML` unique →
   replace inside it; (3) still ambiguous → pick the `occurrenceIndex`-th match
   (DOM order ≈ source order). On 0 matches → "Text not found"; on unresolved
   ambiguity → rejected. Per-edit failures don't block the rest of the batch. It
   writes a **one-per-file-per-session `.bak` backup** (`editBackupOnce: Set`)
   before the first edit. **`oldText` must match the file bytes verbatim** — so
   anchor on raw-source substrings, not DOM-serialized HTML (attribute order,
   entities, whitespace inside tags won't round-trip). Plain text inside an
   element survives verbatim; that's why edits target single text-node leaves.

3. **Two entry points reach `applyHtmlEdits`:**
   - **Webview → host (postMessage):** the panel scripts post
     `vscode.postMessage({ command: 'saveEdit', url|filePath, edits })`; the panel's
     `onDidReceiveMessage` calls `handleSaveEdit(message, panel)`, which resolves the
     target, applies the edits, and posts back `{ command: 'saveEditResult', applied, failed }`.
     Used by Edit mode (orange ✏ toggle) in Browser Panel and Home Panel.
   - **HTTP endpoint:** `POST /__save-notes` with body `{ url, oldText, newText }`
     resolves via `urlToWorkspacePath` and calls `applyHtmlEdits` directly, returning
     `{ ok, error? }`. Used by the **in-panel slide presenter's "Save notes" button**
     (`slide-presenter.html` → `agenticSaveNotes()`), which refetches the deck source,
     locates the slide's `<div class="speaker-notes">…</div>` block, checks it is
     unique, escapes the new inner text, and POSTs the `oldBlock`/`newBlock` pair.
     The HTTP route is the right choice when the editor lives outside the webview
     postMessage channel (e.g. a page served into an iframe or the system browser).

**To add a new direct-edit feature:** compute a verbatim `oldText`/`newText` pair from
the raw source (not from the DOM), then either post `saveEdit` (if inside a webview
panel) or add/extend an HTTP endpoint that calls `applyHtmlEdits`. Reuse
`urlToWorkspacePath`/`resolveEditTarget` for the path — never trust a client-supplied
filesystem path. The `.bak` backup and ambiguity gates come for free.

### Extension Points

- **URI Handler**: `vscode://aimax.aimax-viewer/openBrowser?<url>` for deep linking
- **Context Menu**: "Open in AIMax Viewer" for HTML files in explorer
- **Sidebar**: TreeView panel with artifacts organized by configured folders

## Configuration Namespace

All settings under `aimaxViewer.*`:
- `server.port` - HTTP port (default: 3124)
- `startup.mode` - home/browser/none
- `browser.folders` - Array of `{label, path}` for artifact locations
- `browser.layout` - top (dropdown) or sidebar (TreeView)
- `csp.mode` - strict/permissive/custom for Content Security Policy

## AI Agent Integration

When creating HTML/MD artifacts in `Artifacts/`, display them with:
```bash
open "vscode://aimax.aimax-viewer/openBrowser?http://127.0.0.1:3124/Artifacts/<filename>"
```

Naming convention: `YYYY-MM-DD_descriptive-slug.html` or `.md`

## Release & Deploy Checklist

### 1. Update Version
```bash
# In package.json, update "version": "X.Y.Z"
```

### 2. Update CHANGELOG.md
Add new section at top following this format:
```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- **Feature Name**: Description

### Fixed
- **Bug Name**: Description

### Changed
- **Change Name**: Description

### Technical
- Implementation details (optional)

---
```

### 3. Build & Test
```bash
npm run compile
npx vsce package --allow-missing-repository
code --install-extension aimax-viewer-X.Y.Z.vsix --force
# Reload window and test features
```

### 4. Commit & Push
```bash
git add .
git commit -m "release: vX.Y.Z - brief description"
git push origin main
```

### 5. Publish to VS Code Marketplace
```bash
# Publisher: maxturazzini (AIMax)
# PAT token: ~/.claude/secrets/vsce-pat.txt (expires 2027-04-22, rinnova su dev.azure.com/maxturazzini)
npx vsce publish --allow-missing-repository --pat $(cat ~/.claude/secrets/vsce-pat.txt)

# Extension URL (live after ~5 min):
# https://marketplace.visualstudio.com/items?itemName=maxturazzini.aimax-viewer
# Management:
# https://marketplace.visualstudio.com/manage/publishers/maxturazzini
```

### 6. Create GitHub Release
```bash
# IMPORTANT: Ensure correct account is active
gh auth switch --user maxturazzini

# Create and push tag
git tag vX.Y.Z
git push origin vX.Y.Z

# Create release with vsix attachment
gh release create vX.Y.Z aimax-viewer-X.Y.Z.vsix \
  --repo maxturazzini/aimax-viewer \
  --title "vX.Y.Z" \
  --notes "Copy from CHANGELOG.md"
```

## Git Remote Configuration

This repo uses SSH with multi-account setup:
```bash
# Remote must use github.com-maxtura (SSH alias for maxturazzini key)
git remote set-url origin git@github.com-maxtura:maxturazzini/aimax-viewer.git

# Verify
git remote -v
# Should show: git@github.com-maxtura:maxturazzini/aimax-viewer.git
```

SSH config (`~/.ssh/config`) maps `github.com-maxtura` to `~/.ssh/id_ed25519_maxturazzini`.
