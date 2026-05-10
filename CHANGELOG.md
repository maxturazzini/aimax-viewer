# Changelog

All notable changes to the AIMax Viewer extension will be documented in this file.

## [0.1.32] - 2026-05-10

### Added
- **`Make it presentable` menu item + `aimax-make-presentable` skill**: when the file in the Browser panel isn't a slide deck (i.e. `Present in Browser` is disabled), a new menu item appears under it. Clicking it opens Claude Code with the new `aimax-make-presentable` skill, which turns the current `.md` or `.html` into an AIMax-presentable deck (`<filename>-deck.html` next to the input). For markdown, the skill asks the user which heading level to split on (H1 / H1+H2 / H1+H2+H3 / Manual). For HTML without sections, it wraps content using existing `<h1>`/`<h2>` as boundaries. Asks audience/length/notes preferences. The skill ships in two folders (`skills/aimax-make-presentable/`, `plugins/aimax-make-presentable/`) — install once into Claude Code, OR run as-is: the menu prompt embeds a fallback that fetches the skill from GitHub raw on the fly when the slash command isn't recognized locally.
- **Carousel resize handle (Presenter)**: drag-to-resize bar between the main area and the carousel. Dragging upward grows the carousel and scales every thumbnail proportionally (16:9 preserved by recomputing `width = height × 1280/720` and rescaling the inner iframe transform). Min height = current 72px baseline, max = 60% of viewport.
- **`>Run` button in Annotation panel**: new action that sends the annotation prompt to Claude in agent mode (`--dangerously-skip-permissions`, 5 min budget) and renders the response in a new box below the annotation list. Annotations always run with edits enabled because their purpose is applying changes.
- **`Refresh` button in Annotation panel**: reloads the page from inside the annotation flow without leaving the panel.
- **`Allow file edits` checkbox in Claude Bridge dropdown**: explicit toggle controls inline behavior. Off (default) = quick chat answer with `--tools ""` + concise system prompt + 60s budget; On = full agent with `--dangerously-skip-permissions` + 5 min budget. Tooltip explains both modes.
- **Same annotation actions on Home panel**: `>Term`, `>VSC`, `>Run`, `Refresh` now mirror the Browser panel header. The Home panel host listener now also handles `claudeBridge` postMessages, reusing the shared `handleClaudeBridge` helper.

### Changed
- **`Present in Browser` is now always visible, disabled when not applicable**: previously the menu item disappeared (`display:none`) when the iframe content lacked `<section>` elements, hurting feature discoverability. It now stays visible and gets `disabled` + a context-specific `title` ("Not a slide deck (found N <section>, need ≥2)" / "Cross-origin content — cannot inspect for slides" / "Open this deck in the slide presenter"). New `.menu-item:disabled` CSS gives the greyed-out appearance.
- **Annotation + Bridge button coherence**: both surfaces now share a single `.aimax-icon-btn` class (transparent background, grey border, azure `#00d4ff` icon) — they perform the same actions (Copy, send-to-Terminal, send-to-VS-Code, ask-inline), so they look identical. Replaced the colored Bridge buttons (lavender/blue/green/yellow with long labels) with icon-only ones; the Bridge actions row switched from 2-col grid to flex.
- **Sparkle SVG replaces text `*`**: the "New Claude Code conversation" toolbar button (Browser + Home) and the Bridge "Ask Inline" button now use an 8-point Claude-style sparkle SVG centered via `viewBox`, instead of the previous superscript `*` glyph that rendered visually off-center. Icon library predisposed to host other provider marks (e.g. Codex) in a future iteration.
- **Inline buttons disable while pending**: `Ask Inline` (Bridge) and `>Run` (Annotation) now grey out and ignore extra clicks until the result returns or the timeout fires. Prevents the user from queueing duplicate Claude invocations.
- **Status text in Bridge while running**: shows `Running agent (up to 5 min)…` when edits are enabled, `Waiting for Claude…` otherwise, instead of the previous fixed wait message.

### Fixed
- **Carousel toggle button inverted (Presenter)**: `▤ Carousel` now lights up when the carousel is **visible** (default) and goes off when hidden, matching the convention of `Dots` and `Swap Layout`. Previously the button was active only when the carousel was hidden, and the default-on state showed an unlit button.
- **`Exit code 143` after long inline runs**: race condition between the 120s timeout and the `close` event meant the timeout killed the child but the subsequent `close(143)` overwrote the timeout result with a misleading `Exit code 143`. The callback is now guarded by an internal `done` flag so only the first outcome wins.
- **Inline runs hung as full agent on a chat prompt**: `claude -p` was invoked with no tool restriction and no system prompt, so a quick question like "fix the title" triggered file scans, edits, and permission prompts that hung past the 120s timeout. Chat mode now runs `claude -p --tools "" --system-prompt "concise…" --no-session-persistence -` and returns in seconds.

### Technical
- New helpers in [src/extension.ts](src/extension.ts): `httpUrlToWorkspacePath(url)` (inverse of `getHttpUrl`, returns `null` for non-local URLs) and `openMakePresentableInClaude(url)` (builds the prompt with `/aimax-make-presentable <path>` plus a fallback block instructing Claude to fetch the skill from `https://raw.githubusercontent.com/maxturazzini/aimax-viewer/main/skills/aimax-make-presentable/SKILL.md` if the slash command isn't installed). Wired into both browser webview message listeners (multi-tab + single-tab) under `command === 'makePresentable'`.
- Browser webview detection logic refactored to a tri-state (`isDeck` / `notDeck` / `crossOrigin`). `isDeck` enables Present and hides Make-Presentable; `notDeck` disables Present (with count tooltip) and shows Make-Presentable; `crossOrigin` disables Present (with cross-origin tooltip) and hides Make-Presentable (we can't read or write a remote file).
- `slide-presenter.html`: grid grew a row (`1fr auto auto auto`) for the new `.carousel-resize-handle` (grid-row 2). Carousel moved to row 3, bottom-bar to row 4. New `initCarouselResize()` mirrors `initResize()`/`initColResize()` with mousedown→mousemove drag (delta = `startY − e.clientY`, so up grows). New `applyCarouselItemSize()` and module-level `carouselItemWidth/Height` so `buildCarousel()` honors the user-chosen size on rebuild. `toggleCarousel` also toggles the handle's `.hidden` class so it disappears with the carousel.
- `src/extension.ts:84` — `handleClaudeBridge` signature gained `opts?: { allowEdits?: boolean }`. The `print` branch now builds `args` dynamically: chat mode adds `--tools ""` + `--system-prompt`, edit mode adds `--dangerously-skip-permissions`. Timeout is `60_000` (chat) or `300_000` (edit). Internal `done` flag in `finish()` prevents double-callback when timeout and `close` race.
- All four call sites updated to forward `allowEdits`: multi-tab webview, single-tab webview, home panel, `/__claude` HTTP endpoint (which now also accepts `allowEdits` in the JSON body and returns `504` for any `Timeout (Ns)` string, not only the previously-hardcoded `Timeout (120s)`).
- Shared `.aimax-icon-btn` CSS added in two places (browser webview ~line 1322, home wrapper ~line 2792) — same rules to keep coherence visible. New `.bridge-allow-edits` CSS for the toggle row. Removed obsolete `.bridge-btn-copy/term/vsc/inline` classes.
- New JS state: `bridgeInlinePending` (browser), `annotRunPending` (browser), `aimaxAnnotRunPending` (home). The browser `aimaxBridgeOnResult` routes `print` results into `#annotResponse` when `>Run` was pending, otherwise into `#bridgeResponse`; in both cases re-enables both buttons.
- `bridge-panel.ts` standalone (proxy-injected Bridge): intentionally untouched in this release. Will get the same coherence + `allowEdits` toggle in a follow-up if desired.

---

## [0.1.31] - 2026-05-09

### Fixed
- **Apps Manager status detection**: configured apps now report Running/Stopped based on an HTTP healthcheck against `healthUrl`, not on local `lsof`. Apps running on a different host (e.g. `http://minimacs.local:5001/`) are now correctly detected. Locally-running apps are still picked up via lsof for PID/uptime metadata.
- **Apps Manager unsafe stop on remote apps**: previously, hitting Stop on an app whose `healthUrl` pointed to a remote host fell back to `killByPort` on the local machine, killing whichever local process happened to listen on the same port. Stop is now refused for remote apps unless an explicit `stopCmd` is configured, with a clear error message.
- **Apps Manager click on stopped item did nothing**: items now always have a click action that opens the URL in the AIMax Viewer browser panel. If the app is unreachable, the iframe surfaces the connection error instead of failing silently.
- **Apps Manager `getPortsInUse` race**: parallel callers no longer return an empty cache while a query is in flight; they now await the same in-flight Promise.

### Added
- **Burst-then-slow refresh**: Apps Manager status checks run every `burstIntervalMs` (default 3000) for the first `burstDurationMs` (default 30000) after activation or a manual refresh, then settle to the user-configured `refreshInterval`. Two new settings expose this:
  - `aimaxViewer.appsManager.burstDurationMs` (default 30000, 0 disables burst)
  - `aimaxViewer.appsManager.burstIntervalMs` (default 3000)
- **Right-click context menu on apps tree**: each configured app now exposes Open in AIMax Viewer / Open in External Browser / Start App or Stop App / Copy URL / Edit in settings.json. Inline ▶/⏹ icons remain on the row.
- **Cloud icon for remote apps**: configured apps whose `healthUrl` is non-local render with `cloud` (running) / `cloud-outline` (stopped) instead of the filled circle, making the host distinction visible at a glance. Tooltip now includes a `Host:` line.
- **Optional `remote: boolean` field** in `aimaxViewer.appsManager.apps[]` schema. If omitted, it is auto-derived from the host of `healthUrl`. When true, AIMax never runs `lsof` or kills local processes for that app.

### Changed
- **Discovery cadence is slow-only**: lsof-based discovery of running services no longer participates in the burst window. It runs only at `refreshInterval`, avoiding "too many open files" pressure on long sessions.
- **Tooltip cleaned up**: removed status emojis (🟢/🔴) for consistency; replaced with plain Running/Stopped text plus the new Host line.

### Technical
- `src/apps-manager.ts`: new `isRemoteApp()` helper, `getStatus()` rewritten to use parallel `checkHealth()` calls (timeout reduced 2000→1500 ms with proper socket drain), `_portsQueryRunning: boolean` replaced by `_portsQueryInflight: Promise<...> | null`, `stopApp()` guarded against remote.
- `src/apps-tree-provider.ts`: split single `refreshTimer` into independent `statusTimer` (HTTP) and `discoveryTimer` (lsof); `startBurst()` swaps the status timer cadence and is also called by `refresh()`. Context values extended with `app-running-remote` / `app-stopped-remote`.
- `src/extension.ts`: 4 new commands `aimaxViewer.openAppInViewer`, `aimaxViewer.openAppInBrowser`, `aimaxViewer.copyAppUrl`, `aimaxViewer.editAppInSettings`. `AppsTreeProvider` constructor now takes burst settings.
- `package.json`: new commands, settings, schema, and `view/item/context` regex-matched entries grouped as `1_open` / `2_lifecycle` / `3_meta`.

---

## [0.1.30] - 2026-05-09

### Added
- **Live Inspect toggle**: New `aimaxViewer.liveInspect.enabled` setting (default `true`) controls whether external localhost URLs are routed through the AIMax reverse proxy. When on, Annotation Mode and Claude Bridge can be injected into dev-server pages (Vite, Streamlit, FastAPI…). When off, apps load directly with no injection. Toggle is also available in the hamburger menu of the Browser panel.
- **Auto Claude Bridge injection in proxied pages**: When Live Inspect is enabled and `aimaxViewer.liveInspect.injectBridge` is `true` (default), the Claude Bridge floating panel is automatically injected into every proxied HTML response, alongside the annotation client. Any local web app gains a "Send to Claude" button without source-code changes.
- **Bridge button in Browser toolbar**: New round blue button in the Browser panel toolbar (controlled by `aimaxViewer.bridge.toolbarButton`, default `true`) opens a Claude Bridge dropdown with textarea + Copy / Terminal / VS Code / Inline actions. Lives in the webview chrome — works for any URL, file or app, independently of the proxy.
- **Annotation send-to-Claude actions**: Annotation panel header now has `>Term` and `>VSC` buttons next to `Copy` and `Clear`, sending the annotation prompt directly to a terminal or to Claude Code without copy-paste.
- **Hamburger menu reorganized**: Now contains 4 grouped sections — page actions (Reload, Annotation Mode), URL actions (Copy URL, Present), `Open *` group (Terminal, Claude Code, External Browser, Current Editor File, Home), and Live Inspect toggles. Toolbar buttons are duplicated in the menu for accessibility (except `←` `→` navigation).

### Changed
- **CSP stripped on proxied HTML responses**: The reverse proxy now strips `content-security-policy` and `content-security-policy-report-only` headers from upstream HTML responses. Required for inline annotation/bridge scripts to run on apps with strict CSP (e.g. Streamlit). Only affects HTML through `/__proxy__/PORT/`.

### Technical
- New `src/bridge-panel.ts` exporting `injectBridgePanel(html)` and `BRIDGE_PANEL_HTML_PROXY` (mirrors `annotation-client.ts` pattern). Uses distinct id prefix `aimax-bridge-px-` to avoid collisions with skill-injected bridges.
- `src/extension.ts:45-` — extracted `/__claude` core logic into reusable `handleClaudeBridge(mode, prompt, callback)` helper, called by both the HTTP endpoint and the toolbar bridge dropdown.
- Toolbar Bridge dropdown communicates with the extension host via `vscode.postMessage({ command: 'claudeBridge', mode, prompt })`; the result is delivered back via `panel.webview.postMessage({ command: 'bridgeResult', ... })`.
- Toggle items in the hamburger menu persist their state in workspace `settings.json` via `vscode.workspace.getConfiguration().update(..., ConfigurationTarget.Workspace)`.

---

## [0.1.29] - 2026-05-09

### Fixed
- **Claude Bridge `vscode` mode now pre-fills the prompt**: previously `mode: 'vscode'` only copied the prompt to the clipboard and opened a new Claude Code conversation, leaving the user to paste manually. The endpoint now uses the official Claude Code URI handler `vscode://anthropic.claude-code/open?prompt=…` (documented at code.claude.com/docs/en/vs-code) which pre-fills the prompt box automatically. Clipboard write is kept as a fallback for older Claude Code extension versions.

### Changed
- **Bridge snippets now include page reference**: all bridge HTML snippets (floating panel, inline assistant, demo) automatically prepend `Context: viewing <pathname>\n\n` to the prompt before sending. Gives Claude immediate awareness of which artifact the user is on, with no extra UI.
- **Distinct placeholders for bridge panels**: each panel type (demo main / floating / inline) now has a unique placeholder text, helping users tell them apart when more than one is visible on the same page.

### Technical
- `src/extension.ts:1728-1750` — `mode === 'vscode'` branch rewritten to use `vscode.env.openExternal` with the Claude Code URI handler.
- Snippet edits applied to both `skills/aimax-bridge/` and `plugins/aimax-bridge/` (verified identical with `diff -r`).

---

## [0.1.28] - 2026-04-28

### Added
- **URL Fallback for Browser Title**: When the loaded page has no `<title>` (or is cross-origin), the Browser Panel tab title now falls back to the current URL — the same one shown in the (i) tooltip — instead of remaining empty.
- **Clipboard Copy in Browser Panel**: Selecting text inside the iframe and pressing `Cmd/Ctrl+C` now copies to the system clipboard. A `keydown` + `copy` listener is injected into the iframe document on load; a parent-level fallback handles cases where VS Code intercepts the shortcut before it reaches the frame. Selection is forwarded to the host via `postMessage` and written via `vscode.env.clipboard.writeText`.

### Fixed
- **Home/Browser Rendering Mismatch**: Home Panel now applies the same Content-Security-Policy as the Browser Panel via injected `<meta http-equiv="Content-Security-Policy">`. Previously, missing CSP in the Home wrapper caused Google Fonts (e.g. Inter) to fail loading, falling back to Helvetica with different metrics — making the same artifact look noticeably different between the two views. Both panels now render identically.
- **Broken AI, MAX Brand Icon**: Toolbar icon was rendering as a broken image whenever the wrapped HTML was loaded outside its originating webview (e.g. via the new annotation proxy). Replaced `webview.asWebviewUri()` references with an inlined base64 `data:image/png` URI, cached on first read. Works uniformly across webview, iframe, and proxy contexts.

### Changed
- **Presenter Defaults**: Slide presenter now starts with the **Dots** filter inactive (decks ship without dots overlay by default) and **Swap Layout** active (speaker notes above, next-slide preview below). Button-active visuals were inverted accordingly so the lit state always reflects "user opted in to non-default behavior".

---

## [0.1.27] - 2026-04-27

### Added
- **Sort Toggle in Artifacts View**: New button in the search bar that toggles between alphabetical (A→Z, default) and last-modified (newest first) ordering. The selected mode is persisted per-workspace and survives reloads. Folders remain alphabetical in both modes; only files reorder.

### Technical
- `ArtifactsWebviewProvider` now receives `vscode.Memento` (`workspaceState`) and reads/writes the key `aimaxViewer.sortMode`.
- `mtime-desc` mode performs `fs.promises.stat()` per file in parallel via `Promise.all` (zero stat calls in default `name-asc` mode — no regression).
- Stat failures fall back to `mtime: 0` per-file without aborting the scan.

---

## [0.1.26] - 2026-04-26

### Added
- **Annotation Mode**: Toolbar toggle (chat-bubble icon) in Browser Panel and Home Panel that turns the preview into a feedback-capture surface. Hover any element to see a devtools-style label (tag, dimensions, color, font); click to attach a multi-line comment via auto-growing textarea (Enter submits, Shift+Enter newline, Esc cancels).
- **Floating Annotation List**: Compact single-row list with click-through removal (×), hover tooltip showing full details, and Copy/Clear actions. Numbered badges follow the annotated elements through scroll/resize.
- **Auto-Generated Edit Prompt**: Copy builds a structured prompt wrapped in `<annotation n="…">` blocks with selector, element snapshot, and `<request>` tags — ready to paste into any AI for iterative edits. Prompt references the actual file path (HTTP URL for served artifacts, absolute filesystem path for the Home Panel).
- **HTTP Server Raw Endpoint**: `?aimax-raw=1` query param skips annotation-client injection and returns markdown sources untouched (groundwork for future tooling).

### Technical
- New `src/annotation-client.ts` containing the self-contained, idempotent overlay client injected into every served HTML/MD response and into Home Panel content.
- Cross-origin iframe + same-document Home Panel use one shared client and a uniform `postMessage` protocol (`annot:toggle` / `annot:add` / `annot:remove` / `annot:reset`).
- Sentinel attribute (`data-aimax-overlay`) prevents the client from highlighting its own UI or the Home Panel toolbar/floating window.
- Hover label and comment input fall back to viewport coordinates `(10, 10)` when the target element would push them off-screen (e.g. clicking `body`).

---

## [0.1.25] - 2026-03-20

### Added
- **Speaker Notes Font Resize**: A-/A+ buttons in the yellow bar to increase or decrease notes font size (also via +/- keyboard shortcuts)
- **Speaker Notes Editing**: Click on notes text to edit in-place (contenteditable); changes persist across slide navigation within the session; Escape to exit editing
- **Swap Layout Toggle**: New button in options bar to swap notes and next-slide vertical positions in the presenter right panel

### Changed
- **Presenter GUI in English**: All labels, buttons, and help text translated from Italian to English
- **Apps Manager Performance**: Cached `lsof` results with 4s TTL to prevent spawn storms; added refresh guard to avoid concurrent tree rebuilds
- **Apps Manager Refresh Interval**: Default refresh interval increased from 5s to 30s for lower resource usage

---

## [0.1.23] - 2026-03-10

### Fixed
- **Copy to clipboard**: risolto in home panel (markdown) e browser panel. `navigator.clipboard` non disponibile nel webview VS Code — ora delegato a `vscode.env.clipboard` tramite postMessage bridge
- **Copy URL**: fix stesso problema nella toolbar del browser panel — il pulsante "Copy URL" nel menu ora funziona correttamente

---

## [0.1.22] - 2026-02-22

### Added
- **Presenter Mode**: New "Present with AIMax Viewer" feature opens HTML slide decks in the system browser with a two-window presenter view (audience + speaker notes, carousel, timer)
- **Explorer Context Menu**: "Present with AIMax Viewer" option when right-clicking HTML files
- **Browser Hamburger Menu**: "Present in Browser" option to launch presenter mode for the currently viewed page
- **Sidebar Context Menus**: "Present" option in both Artifacts and Recents panels (HTML files only)
- **Extension-Bundled Presenter**: Slide presenter served from `/__presenter` route, always available regardless of workspace content
- **Recents Panel**: New sidebar panel between Artifacts and Apps Manager tracking the last 24 opened HTML/MD files per workspace
- **Multi-Tab Dedup**: Reuses existing tab when the same file is opened again in multi-tab mode, avoiding duplicate panels

### Changed
- **iframe sandbox**: Added `allow-top-navigation-by-user-activation` so links and buttons inside artifacts work on user click
- **Documentation**: Updated guides (EN/IT) to v0.1.22 with Presenter Mode, Recents panel, sidebar search, context menus
- **Presentation Deck**: Added `aimax-viewer-presentation.html` — an 8-slide feature overview of AIMax Viewer
- **Index page**: Added Presenter Mode card with link to the presentation deck

### Technical
- Added `/__presenter` HTTP route serving `slide-presenter.html` from extension bundle
- New `aimaxViewer.presentFile` command registered in VS Code
- Presenter uses `BroadcastChannel` for sync between audience and presenter windows
- New `RecentsProvider` WebviewView with workspace-scoped state persistence

---

### Aggiunto (IT)
- **Modalita' Presentazione**: Nuova funzionalita' "Present with AIMax Viewer" apre deck HTML nel browser di sistema con vista relatore a due finestre (audience + note speaker, carousel, timer)
- **Menu Contestuale Explorer**: Opzione "Present with AIMax Viewer" sul click destro dei file HTML
- **Menu Hamburger del Browser**: Opzione "Present in Browser" per lanciare la modalita' presentazione della pagina corrente
- **Menu Contestuali Sidebar**: Opzione "Present" nei pannelli Artifacts e Recents (solo file HTML)
- **Presenter Integrato nell'Estensione**: Slide presenter servito dalla route `/__presenter`, sempre disponibile indipendentemente dal contenuto del workspace
- **Pannello Recenti**: Nuovo pannello nella sidebar tra Artifacts e Apps Manager che traccia gli ultimi 24 file HTML/MD aperti per workspace
- **Dedup Multi-Tab**: Riutilizza il tab esistente quando lo stesso file viene riaperto in modalita' multi-tab, evitando pannelli duplicati

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
