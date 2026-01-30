# Changelog

All notable changes to the AIMax Viewer extension will be documented in this file.

## [0.1.20] - 2026-01-30

### Added
- **Claude Bridge API**: New `/__claude` HTTP endpoint enabling direct communication between HTML artifacts and Claude Code
  - `vscode` mode: Opens Claude Code extension panel for a new conversation
  - `terminal` mode: Opens interactive Claude session in VS Code terminal with pre-filled prompt
  - `print` mode: Sends prompt to Claude CLI and returns the response as JSON (for inline AI responses in artifacts)
  - `copy` mode: Returns prompt text for clipboard operations
- **Artifact-to-Claude workflow**: HTML pages served by AIMax Viewer can now send prompts directly to Claude via `fetch()` calls

### Technical
- Uses safe command execution for child processes (no shell injection)
- JSON request body with plain-text fallback for backward compatibility
- CORS-enabled for cross-origin artifact requests

---

## [0.1.19] - 2026-01-30

### Fixed
- **ARTIFACTS panel empty without Artifacts folder**: The TreeView provider failed to initialize in workspaces lacking a root `Artifacts/` directory, ignoring the `browser.folders` setting entirely. Now uses the VS Code workspace folder directly.

---

## [0.1.18] - 2026-01-21

### Added
- **Apps Manager**: New sidebar panel to monitor and control local web applications
  - Start/Stop commands for configured apps
  - Auto-discovery of running web servers
  - Add discovered apps to configuration via "+" button
- **AIMax Viewer Detection**: Discovered apps are identified as AIMax Viewer instances with special orange home icon
- **API Endpoints**: `/api/apps`, `/api/ports`, `/api/apps/:id/start`, `/api/apps/:id/stop`

### Fixed
- **Tab Titles**: Tabs now show meaningful titles (page title, app name, or process name) instead of "127.0.0.1"
- **AIMax Detection**: Robust JSON validation to avoid false positives when detecting AIMax Viewer instances

### Technical
- Apps configuration via VS Code settings (`aimaxViewer.appsManager.apps`)
- Port scanning via `lsof` for auto-discovery
- Health check endpoints for app status monitoring

---

## [0.1.17] - 2026-01-18

### Added
- **YAML Metadata in Info Popup**: (i) button now displays frontmatter metadata from markdown files via postMessage API
- **Copy Button for Code Blocks**: Code blocks have a copy button with light gray background styling
- **Documentation Guides**: Comprehensive guides in English (`guide_en.md`) and Italian (`guide_it.md`)
- **Smart Port Management**: Default port 3124 uses hash-based calculation to avoid conflicts between VS Code windows; custom port values are fixed

### Fixed
- **Code Block Rendering**: Fixed issue where code blocks were rendered line-by-line instead of as single blocks
- **Cross-Origin Metadata**: Resolved iframe cross-origin restriction preventing YAML metadata display in toolbar

### Changed
- **Markdown Parser**: Improved code block handling with escape sequences and syntax highlighting
- **Default Folder**: Simplified to `Artifacts/` only

### Technical
- postMessage API for secure cross-origin iframe communication
- Code block placeholder technique (`<!--CODEBLOCK-->`) during markdown processing

---

## [0.1.1] - 2026-01-04

### Added
- **Back/Forward Navigation**: Added ← → buttons for session history navigation
- **Fallback Setup Page**: Shows setup instructions when `Artifacts/` folder not found

### Changed
- **Workspace Detection**: Extension now searches up parent directories to find `Artifacts/`
- **History Tracking**: Tracks navigation via dropdown AND iframe internal links

### Fixed
- Extension now works when VS Code is opened from a subdirectory of the workspace

---

## [0.1.0] - 2026-01-02

Fresh start with clean architecture and naming.

### Features
- **Home Panel**: Direct file reading with external link support
- **Browser Panel**: Iframe-based with artifacts dropdown selector
- **Multi-Tab**: Each artifact opens in a new tab (configurable)
- **Status Bar**: Quick Home access via $(home) icon
- **Startup Mode**: Choose "home", "browser", or "none"
- **HTTP Server**: Local server (port 3124) for serving workspace files
- **URI Handler**: Deep links via `vscode://aimax.aimax-viewer/...`

### Commands
- `aimaxViewer.openHome` - Open Home panel
- `aimaxViewer.openBrowser` - Open URL in Browser panel
- `aimaxViewer.openArtifactsBrowser` - Open Browser with artifacts dropdown
- `aimaxViewer.openCurrentFile` - Open active HTML file
- `aimaxViewer.openFileInViewer` - Context menu for HTML files
- `aimaxViewer.copyViewerState` - Copy viewer state to clipboard
- `aimaxViewer.openTerminal` - Open new terminal
- `aimaxViewer.openClaudeCode` - New Claude Code conversation

### Settings
- `aimaxViewer.server.port` - HTTP server port (default: 3124)
- `aimaxViewer.startup.mode` - Startup behavior: home/browser/none
- `aimaxViewer.startup.homePage` - Home page path
- `aimaxViewer.panels.multiTab` - Multi-tab mode
- `aimaxViewer.console.openByDefault` - Console visibility
- `aimaxViewer.webview.enableJavaScript` - JavaScript execution

### Technical
- Extension ID: `aimax.aimax-viewer`
- Settings namespace: `aimaxViewer.*`
- Commands namespace: `aimaxViewer.*`

---

## Previous Versions

For history before v0.1.0 (when extension was named `aimax-artifact-viewer`), see git history.
