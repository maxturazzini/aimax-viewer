# Changelog

All notable changes to the AIMax Viewer extension will be documented in this file.

## [0.1.22] - 2026-02-19

### Added
- **Presenter Mode**: New "Present with AIMax Viewer" feature opens HTML slide decks in the system browser with a two-window presenter view (audience + speaker notes, carousel, timer)
- **Explorer Context Menu**: "Present with AIMax Viewer" option when right-clicking HTML files
- **Browser Hamburger Menu**: "Present in Browser" option to launch presenter mode for the currently viewed page
- **Sidebar Context Menus**: "Present" option in both Artifacts and Recents panels (HTML files only)
- **Extension-Bundled Presenter**: Slide presenter served from `/__presenter` route, always available regardless of workspace content

### Technical
- Added `/__presenter` HTTP route serving `slide-presenter.html` from extension bundle
- New `aimaxViewer.presentFile` command registered in VS Code
- Presenter uses `BroadcastChannel` for sync between audience and presenter windows

---

### Aggiunto (IT)
- **Modalita' Presentazione**: Nuova funzionalita' "Present with AIMax Viewer" apre deck HTML nel browser di sistema con vista relatore a due finestre (audience + note speaker, carousel, timer)
- **Menu Contestuale Explorer**: Opzione "Present with AIMax Viewer" sul click destro dei file HTML
- **Menu Hamburger del Browser**: Opzione "Present in Browser" per lanciare la modalita' presentazione della pagina corrente
- **Menu Contestuali Sidebar**: Opzione "Present" nei pannelli Artifacts e Recents (solo file HTML)
- **Presenter Integrato nell'Estensione**: Slide presenter servito dalla route `/__presenter`, sempre disponibile indipendentemente dal contenuto del workspace

---

## [0.1.21] - 2026-01-31

### Added
- **Artifacts Sidebar with Search**: Replaced native TreeView with custom WebviewView featuring a built-in search bar and codicons for file type icons
- **Context Menu on Artifacts**: Right-click on files/folders in the sidebar for "Open in Viewer", "Open in Editor", "Open in Browser", "Reveal in Explorer", "Reveal in Finder"
- **Collapse All**: New toolbar button to collapse all expanded folders in the Artifacts tree
- **Workspace Identity API**: New `/api/identity` endpoint returns the workspace name, enabling cross-instance identification in Apps Manager
- **Workspace Name in Discovered Apps**: Discovered AIMax Viewer instances now display their workspace name (e.g., "miniMe :3134") instead of generic labels
- **Useful Links Panel**: New sidebar section with links to GitHub README (opens in Viewer), repository, releases, and issue tracker
- **README in Viewer**: README link opens directly inside AIMax Viewer browser panel

### Technical
- Added `@vscode/codicons` dependency for sidebar icons
- Artifacts panel type changed from TreeView to WebviewView
- Legacy `ArtifactsTreeProvider` kept for API compatibility

---

### Aggiunto (IT)
- **Sidebar Artifacts con Ricerca**: Sostituita la TreeView nativa con una WebviewView custom con barra di ricerca integrata e icone codicon per i tipi di file
- **Menu Contestuale sugli Artifacts**: Click destro su file/cartelle nella sidebar per "Apri nel Viewer", "Apri nell'Editor", "Apri nel Browser", "Mostra in Explorer", "Mostra nel Finder"
- **Comprimi Tutto**: Nuovo pulsante nella toolbar per comprimere tutte le cartelle espanse nell'albero Artifacts
- **API Identità Workspace**: Nuovo endpoint `/api/identity` che restituisce il nome del workspace, abilitando l'identificazione cross-istanza nell'Apps Manager
- **Nome Workspace nelle App Scoperte**: Le istanze AIMax Viewer scoperte mostrano ora il nome del workspace (es. "miniMe :3134") invece di etichette generiche
- **Pannello Link Utili**: Nuova sezione nella sidebar con link al README GitHub (si apre nel Viewer), repository, release e issue tracker
- **README nel Viewer**: Il link README si apre direttamente nel pannello browser di AIMax Viewer

---

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
