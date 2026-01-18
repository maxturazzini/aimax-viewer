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

### 5. Create GitHub Release
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
