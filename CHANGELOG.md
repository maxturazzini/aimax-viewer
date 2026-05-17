# Changelog

All notable changes to the AIMax Viewer extension will be documented in this file.

## [Unreleased] - 0.1.32

_In progress._

---

## [0.1.31] - 2026-05-12

### Added

- **Explorer context menu on folders**: right-click any folder in the VS Code Explorer to get two new actions.
  - **"Add to AIMax Viewer"** — prompts for an alias (defaults to the folder basename), then appends `{label, path}` to `aimaxViewer.browser.folders` in workspace settings (`.vscode/settings.json`). The sidebar Artifacts tree refreshes immediately. Rejects folders outside the workspace and silently skips duplicates (matched by relative path).
  - **"Open this Folder in a New Window"** — opens the folder in a fresh VS Code window via the built-in `vscode.openFolder` command with `forceNewWindow: true`. Useful for quickly switching context to a sibling project without losing the current workspace.

### Changed

- **"Open in AIMax Viewer" now appears on `.md` files**: the command handler already supported markdown but the explorer context-menu `when` clause was scoped to `resourceExtname == .html`, so the entry never showed up for `.md`. Fixed — now visible on both `.html` and `.md`. Folder-only entries are gated by `explorerResourceIsFolder` so file and folder menus stay clean.
- **Default `aimaxViewer.browser.folders` now points to the workspace root** (`{ label: "Workspace", path: "." }`) instead of `Artifacts/`. Cross-platform via Node's `path.join` (works on Windows, Mac, Linux). Only applies to users who never customized the setting — existing custom values are preserved by VS Code's settings system.
- **Welcome card wording softened** in `Artifacts/index.html`: from "AI, MAX Viewer looks for a `Artifacts/` folder..." to "AI, MAX Viewer suggest you to setup an `Artifacts/` folder... to display HTML and md Artifacts." Same actionable info, less alarming tone.

### Fixed

- **External and custom-protocol links were dead inside the iframe browser**: in `aimaxViewer.startup.mode = "browser"`, VS Code silently drops `window.open()`, `target="_blank"`, and navigations to `vscode://` / `obsidian://` / `mailto:` / `tel:` from inside the webview's iframe. Clicks on `<a>` tags in `Artifacts/index.html` (and every other artifact) did nothing. The webview parent already listened for `{command:'openExternal', url}` and routed it to `vscode.env.openExternal()` — but the iframe side that should send the message was missing.

### Added

- **`link-handler-client.ts`**: tiny client script (analogous to `annotation-client.ts`) injected into every HTML/Markdown response served by the internal HTTP server (direct file, proxied app, markdown render). Intercepts `<a>` clicks AND `window.open()` calls so embedded apps that ship absolute-URL links or script-driven popups (e.g. `<a href="quote-detail.html?id=X" target="_blank">`, `window.open('detail.html', '_blank')`) behave like a real browser instead of being silently dropped by VS Code's webview. Routing works on the resolved absolute URL:
  - `vscode:`/`obsidian:`/`mailto:`/`tel:` → `vscode.env.openExternal`.
  - Same-origin `http(s)` (plain click, with or without `target="_blank"`) → in-place iframe navigation. The user UX for an embedded app is "show the next view here", not "spawn a new pane".
  - Same-origin `http(s)` with **Cmd/Ctrl/Shift-click or middle-click** → new AIMax pane via `openInBrowser()`. Standard browser "open in new tab" convention.
  - Cross-origin `http(s)` to `localhost:PORT` where we are inside `/__proxy__/PORT/...` → URL is rewritten to the proxy path and the iframe navigates same-origin. Keeps the app inside its proxy (so annotation/link-handler injection continues to work) even when the app uses absolute URLs like `http://localhost:8766/quote/123`.
  - Other `http(s)` to `localhost`/`127.0.0.1`/`::1` → `openInBrowser()` (a different local app: new AIMax pane). Proxy/direct loading remains controlled by `aimaxViewer.liveInspect.skipHosts`.
  - Other `http(s)` → `vscode.env.openExternal` (system browser).
  - `#anchor`, relative paths, empty href → NOT intercepted.
  - `window.open(url, ...)` calls are shimmed and treated as in-place navigation.
  - No-op when `window.parent === window` (Home Panel has its own link handler in `wrapWithToolbarAndLinkHandler`).
  - Listener runs in bubble phase so annotation mode's capture-phase handler can still suppress link clicks while annotating. Also listens to `auxclick` for middle-button.

### Technical

- Injection added at three points in `src/extension.ts`: proxy response (`/__proxy__/PORT/...`), markdown-to-HTML render path, and direct HTML file path. Same three points where `injectAnnotationClient` already runs.
- Parent webview message router gains an `openInBrowser` forward alongside the existing `openExternal`; both browser-panel `onDidReceiveMessage` handlers (multi-tab and single-tab) gain a matching command that calls `openInBrowser(url)`.
- No changes required in individual artifacts. No regressions in Home Panel.

---

## [0.1.30] - 2026-05-10

Patch release. No functional changes.

### Fixed

- **`.playwright-mcp/` debug artifacts leaked into the v0.1.29 VSIX**: 16 files (~365 KB of Playwright console logs, accessibility-tree YAML snapshots, and verification screenshots) ended up bundled into the published extension because the folder was gitignored but not listed in `.vscodeignore`. Added `.playwright-mcp/**` plus standard junk patterns (`*.log`, `.DS_Store`, `.env`, `.env.*`) to `.vscodeignore`. v0.1.30 ships clean.
- **`aimax-make-presentable` skill missing from the Claude Code marketplace**: only `aimax-bridge` was registered in `.claude-plugin/marketplace.json`, so `/plugin install aimax-make-presentable@aimax-viewer` would have failed. Now both skills are properly registered.

---

## [0.1.29] - 2026-05-10

A big release that consolidates several months of work and reshapes
how AIMax Viewer feels day-to-day. The throughline is **agency**:
the extension stops being just a viewer and becomes the place where
you actually drive Claude — to inspect pages, edit artifacts, manage
local apps, build decks, and ship presentations.

### What's in it (the short version)

- **Apps Manager v2** — the sidebar now manages local *and* remote
  dev apps end-to-end: HTTP healthchecks, burst-then-slow refresh,
  per-app context menu (Run / Stop / Open / Copy URL / Edit),
  remote-host detection with cloud icons, optional `remote: boolean`.

- **Live Annotation across any localhost port** — a single toggle
  (`Enable Live Annotation`, on by default) routes Vite / Streamlit /
  FastAPI / your-stack-here through the AIMax proxy and injects the
  annotation client. Annotate any local web app the same way you
  annotate static artifacts.

- **Claude Bridge, unified** — one ✻ button in the Browser toolbar
  opens a dropdown with Copy / Terminal / VS Code / Inline actions
  and an explicit **Allow file edits** toggle (60s chat vs 5min
  agent). A new menu item "Add Claude Bridge to this page (persistent)"
  asks Claude Code to inject the bridge snippet straight into your
  artifact's source HTML. The Annotation panel mirrors all of this
  with `>Term` / `>VSC` / `>Run` / `Refresh`, so a click on an element
  becomes an actionable change without copy-paste.

- **Make it presentable** — a new skill (`aimax-make-presentable`)
  and matching menu item that turns any `.md` or `.html` into an
  AIMax-ready slide deck, asking the right questions about heading
  splits, audience, and speaker notes. Works even if you haven't
  installed the skill locally — falls back to fetching it from the
  GitHub repo on the fly.

- **Presenter ergonomics** — drag-to-resize the thumbnail carousel
  (16:9 preserved), and an Agentic Save Notes button that writes
  the speaker note you just edited back into the source HTML
  surgically. "Present in Browser" is now always visible, disabled
  with a reason when the file isn't a deck.

- **A top-to-bottom UI pass** — shared icon-button style across
  Annotations and Bridge, sparkle SVG everywhere instead of the
  off-center `*` glyph, pending-state on inline buttons, dynamic
  status text, and a fetch-based deck detector that finally works
  past webview cross-origin.

### Heads up — the extension is now doing *a lot*

What started as "a clean way to view HTML/Markdown artifacts inside
VS Code" now spans Apps Manager, Live Annotation, Claude Bridge,
Presenter Mode, two installable skills, an HTTP API, a reverse proxy,
inline AI agents, and several sidebar surfaces. The CHANGELOG and
the README do their best, but the surface area has grown past what
those alone can document well.

**Looking for wiki volunteers.** If you've been using AIMax Viewer
and want to help, I'd love contributors for a proper wiki —
how-to guides, end-to-end recipes, troubleshooting pages, screenshots,
short videos. Open an issue at
[github.com/maxturazzini/aimax-viewer/issues](https://github.com/maxturazzini/aimax-viewer/issues)
or ping `@maxturazzini` if you want to take any chunk of it.

### Looking ahead

Heads up: I'm considering **deprecating the Home panel** in a future
release. Right now Home and Browser are largely a duplicate: Browser
is more capable (annotations, Bridge, deck detection, presenter,
agentic actions), while Home only exists because of webview technical
limits I'm running into when trying to reconcile the two surfaces.
The likely outcome is keeping only the Browser panel — which already
serves the home page just fine — and retiring the dedicated Home
view. Nothing changes in this release, this is just a heads up so
you can mentally plan around it. Feedback welcome on the issue
tracker if you rely on Home for something Browser can't do today.

### Full details

The sections below cover everything in the depth release notes can
carry — Added / Changed / Fixed / Technical. Skim the headlines
above; dive in here when something breaks or when you want to
understand the *why*.

### Added

- **Apps Manager v2**: HTTP healthcheck on `healthUrl` for remote
  apps; configurable burst-then-slow refresh
  (`appsManager.burstDurationMs` 30000, `appsManager.burstIntervalMs`
  3000); right-click context menu (Open in Viewer / Open External /
  Start / Stop / Copy URL / Edit settings); cloud icon for non-local
  hosts; optional `remote: boolean` field in the apps schema; click
  on a stopped item now opens the URL.
- **Toolbar Bridge button (✻)** in the Browser panel: opens a Bridge
  dropdown with Copy / Copy & Terminal / Copy & VS Code / Ask Inline,
  and an `Allow file edits` checkbox. Off = quick chat (`--tools ""`
  + concise system prompt + 60s budget); On = full agent
  (`--dangerously-skip-permissions` + 5 min budget).
- **Hamburger menu — `Add Claude Bridge to this page (persistent)…`**:
  on local AIMax-served HTML files, opens Claude Code to inject the
  bridge snippet into the source via the `aimax-bridge` skill; falls
  back to fetching the canonical template from GitHub raw if the
  slash command isn't installed locally; clipboard fallback if Claude
  Code isn't available. Disabled with explanatory tooltip on proxied,
  external, or non-HTML URLs.
- **Hamburger menu — `Make it presentable`**: appears under "Present
  in Browser" when the file isn't a deck. Opens Claude Code with the
  new `aimax-make-presentable` skill; for markdown asks the heading-
  split level (H1 / H1+H2 / H1+H2+H3 / Manual); writes
  `<filename>-deck.html` next to the input.
- **Annotations panel — `>Term`, `>VSC`, `>Run`, `Refresh` buttons**:
  send the constructed annotation prompt to a terminal, to Claude Code,
  or run it inline as an agent (5 min budget) and render the response
  in a new box below the list. `Refresh` reloads the page from inside
  the panel.
- **Home panel parity**: same `>Term` / `>VSC` / `>Run` / `Refresh`
  actions on the Home panel annotation header. The Home panel host
  listener now handles `claudeBridge` postMessages too.
- **Presenter — carousel resize handle**: drag-to-resize bar above
  the carousel (min 72px, max 60vh). Thumbnails scale proportionally,
  16:9 preserved.
- **Presenter — Agentic Save Notes**: floppy+sparkle icon in the
  Speaker Notes header writes the currently-edited note straight back
  into the source HTML's `<div class="speaker-notes">` for the current
  `<section>`. Async with floating banners; per-slide `savePending`
  state so you can queue saves on different slides concurrently.
  Surgical Edit-by-content contract avoids touching anything else.
- **`aimax-make-presentable` skill**: new skill in
  `skills/aimax-make-presentable/` and `plugins/aimax-make-presentable/`.

### Changed

- **`Present in Browser` is always visible**: previously hidden when
  the iframe lacked `<section>` elements (hurting discoverability).
  Now stays visible and gets `disabled` + a context-specific tooltip
  ("Not a slide deck (found N <section>, need ≥2)" / "Cross-origin
  content — cannot inspect for slides" / "Open this deck in the slide
  presenter"). Detection moved from `frame.contentDocument` (always
  cross-origin in webview) to a fetch-based section count via the
  local server CORS.
- **Annotation + Bridge button coherence**: shared `.aimax-icon-btn`
  class — transparent background, grey border, azure `#00d4ff` icon.
  Bridge buttons switched from coloured/labelled to icon-only.
- **Sparkle SVG replaces text `*`**: the "New Claude Code conversation"
  toolbar button (Browser + Home) and the Bridge "Ask Inline" button
  use an 8-point Claude-style sparkle SVG centered via `viewBox`,
  instead of the previous superscript `*` glyph that rendered visually
  off-center.
- **Bridge inline buttons disable while pending**: `Ask Inline`
  (Bridge) and `>Run` (Annotation) grey out and ignore extra clicks
  until the result returns or the timeout fires.
- **Bridge `vscode` mode pre-fills the prompt**: uses the official
  Claude Code URI handler `vscode://anthropic.claude-code/open?prompt=…`
  (no more manual paste). Clipboard write kept as fallback for older
  Claude Code extension versions.
- **Bridge snippets prepend page reference**: bridge HTML snippets
  (floating panel, inline assistant) automatically prepend
  `Context: viewing <pathname>\n\n` to the prompt so Claude knows
  which artifact the user is on.
- **Distinct placeholders for bridge panels**: each panel type
  (demo / floating / inline) has a unique placeholder text.
- **CSP stripped on proxied HTML responses**: the reverse proxy strips
  `content-security-policy` and `content-security-policy-report-only`
  headers from upstream HTML responses, so inline annotation/bridge
  scripts can run on apps with strict CSP (e.g. Streamlit). Only
  affects HTML through `/__proxy__/PORT/`.
- **Apps Manager — discovery cadence is slow-only**: `lsof`-based
  discovery no longer participates in the burst window, avoiding
  "too many open files" pressure on long sessions.
- **Apps Manager — tooltip cleaned up**: removed status emojis;
  plain Running/Stopped text plus a Host line.

### Fixed

- **Apps Manager — status detection on remote apps**: now reports
  Running/Stopped from an HTTP healthcheck against `healthUrl`, not
  `lsof`. Apps on `http://minimacs.local:5001/` are correctly
  detected.
- **Apps Manager — unsafe stop on remote apps**: previously fell back
  to `killByPort` on the local machine, killing whichever local
  process happened to listen on the same port. Stop is now refused
  for remote apps unless an explicit `stopCmd` is configured.
- **Apps Manager — `getPortsInUse` race**: parallel callers no longer
  return an empty cache while a query is in flight; they await the
  same in-flight Promise.
- **Bridge `Exit code 143` after long inline runs**: race condition
  between the inline timeout and the `close` event made the timeout
  result get overwritten by the subsequent `close(143)`. Now guarded
  by an internal `done` flag so only the first outcome wins.
- **Bridge inline runs hung as full agent on a chat prompt**: `claude
  -p` was invoked with no tool restriction, so a quick question
  triggered file scans, edits, and permission prompts that hung past
  the timeout. Chat mode now runs `claude -p --tools "" --system-
  prompt "concise…" --no-session-persistence -` and returns in seconds.
- **Carousel toggle button polarity (Presenter)**: `▤ Carousel` lights
  up when the carousel is **visible** (default) and goes off when
  hidden, matching `Dots` and `Swap Layout`.

### Technical (high-signal)

- `src/extension.ts` — `handleClaudeBridge(mode, prompt, callback,
  opts?)` reusable helper called from HTTP `/__claude`, the toolbar
  Bridge dropdown, the Annotation `>Run` button, and the Presenter
  Save-Notes flow. The `print` branch builds `args` dynamically: chat
  mode adds `--tools ""` + `--system-prompt`, edit mode adds
  `--dangerously-skip-permissions`. Timeout 60s (chat) / 300s (edit).
  Internal `done` flag prevents double-callback on timeout/close race.
- New helpers: `httpUrlToWorkspacePath(url)` (inverse of `getHttpUrl`,
  null for non-local URLs), `urlToWorkspacePath(url)` (filters
  `__proxy__` / `__presenter` / `api/`, requires `.html`),
  `openMakePresentableInClaude(url)`, `buildBridgeInjectionPrompt(rel)`,
  `dispatchAddBridgeToPage(url)`. All wired into both browser-panel
  message listeners.
- Browser webview detection refactored to a tri-state (`isDeck` /
  `notDeck` / `crossOrigin`) via fetch-based section count. CORS-
  permissive local server + webview CSP `connect-src 127.0.0.1:*`
  make the fetch work without same-origin iframe access.
- New menu items wired with disabled-state CSS (`.menu-item:disabled`).
  Visibility checks for Make-Presentable + Add-Bridge are URL-based —
  no fetch, no iframe DOM access — so cross-origin pages never break
  the menu.
- `slide-presenter.html`: grid grew a row for the carousel resize
  handle; per-slide `savePending` state; surgical Edit-by-content
  contract for Save Notes (refetch deck `cache:'no-store'`, regex-
  extract exact `.speaker-notes` block on raw HTML, verify single
  occurrence, send Claude a literal old→new Edit with prompt-level
  prohibition of Read/Grep/Glob/Bash/Write).
- `src/apps-manager.ts`: new `isRemoteApp()` helper, `getStatus()`
  rewritten with parallel `checkHealth()` calls (timeout 1500 ms),
  `_portsQueryInflight: Promise<...> | null` replaces the racy
  boolean, `stopApp()` guarded against remote.
- `src/apps-tree-provider.ts`: split `refreshTimer` into independent
  `statusTimer` (HTTP) and `discoveryTimer` (lsof); `startBurst()`
  swaps the status timer cadence; context values extended with
  `app-running-remote` / `app-stopped-remote`.
- `package.json`: 4 new commands (`openAppInViewer`,
  `openAppInBrowser`, `copyAppUrl`, `editAppInSettings`); new
  settings (`appsManager.burstDurationMs`,
  `appsManager.burstIntervalMs`); apps schema + `view/item/context`
  regex entries grouped as `1_open` / `2_lifecycle` / `3_meta`.
- `aimax-bridge` skill in `skills/` and `plugins/` (canonical source
  for the bridge snippet, used by the persistent injection menu item).
- `aimax-make-presentable` skill in `skills/` and `plugins/`.
- `Artifacts/` is tracked again (was un-tracked in 8c1f0ca) — now
  serves as a living showcase: presentation deck, Claude Bridge demo,
  English guide, and 13 deck screenshots.

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
