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

2. **`applyTextEdits(absolutePath, edits[])` is the single write primitive.** Each
   edit is `{n, oldText, newText, selector?, occurrenceIndex?, outerHTML?}`. It does an
   **anchored verbatim text replace** in the raw source with three disambiguation
   levels: (1) `oldText` unique → replace; (2) ambiguous but `outerHTML` unique →
   replace inside it; (3) still ambiguous → pick the `occurrenceIndex`-th match
   (DOM order ≈ source order). On 0 matches → "Text not found"; on unresolved
   ambiguity → rejected. Per-edit failures don't block the rest of the batch. It
   calls `ensureBackup()` before the first edit, which writes a
   **one-per-file-per-session `.bak`** (`editBackupOnce: Set`) **only when
   `aimaxViewer.edit.backupBeforeSave` is on — and it is off by default**, see
   "Backups" below. **`oldText` must match the file bytes verbatim** — so
   anchor on raw-source substrings, not DOM-serialized HTML (attribute order,
   entities, whitespace inside tags won't round-trip). Plain text inside an
   element survives verbatim; that's why edits target single text-node leaves.

3. **Three entry points reach `applyTextEdits`:**
   - **Webview → host (postMessage):** the panel scripts post
     `vscode.postMessage({ command: 'saveEdit', url|filePath, edits })`; the panel's
     `onDidReceiveMessage` calls `handleSaveEdit(message, panel)`, which resolves the
     target, applies the edits, and posts back `{ command: 'saveEditResult', applied, failed }`.
     Used by Edit mode (orange ✏ toggle) in Browser Panel and Home Panel.
     **This path also covers rendered markdown** (`mdUrlToWorkspacePath`, `kind: 'md'`),
     with a deliberately narrower policy — see "Editing rendered markdown" below.
   - **HTTP endpoint:** `POST /__save-notes` with body `{ url, oldText, newText }`
     resolves via `urlToWorkspacePath` and calls `applyTextEdits` directly, returning
     `{ ok, error? }`. Used by the **in-panel slide presenter's "Save notes" button**
     (`slide-presenter.html` → `agenticSaveNotes()`), which refetches the deck source,
     locates the slide's `<div class="speaker-notes">…</div>` block, checks it is
     unique, escapes the new inner text, and POSTs the `oldBlock`/`newBlock` pair.
     The HTTP route is the right choice when the editor lives outside the webview
     postMessage channel (e.g. a page served into an iframe or the system browser).
   - **HTTP endpoint, markdown:** `POST /__save-md` with body
     `{ path, edits: [{oldText, newText}] }`, where `path` is **workspace-relative**
     (`projects/todo.md`). Resolves via `mdPathToWorkspacePath` — the sibling of
     `urlToWorkspacePath` for `.md`/`.markdown`, which the `.html` gate there would
     reject — then calls `applyTextEdits` and returns `{ ok, file, applied, failed, error? }`.
     Used by artifacts that render a markdown file and want to write back into it
     (the TODO card in `artifacts/index.html` edits and closes entries this way).
     Two things to know before building on it: the path is taken as a path, not a
     URL, so the gates are containment (`path.resolve` collapses `..` first, then a
     `root + sep` prefix check — a bare `startsWith` would accept a sibling directory
     whose name merely begins with the root's), extension, and existence; and the
     batch is **not atomic** — `applyTextEdits` writes whatever applied, so a caller
     needing all-or-nothing sends one edit per call and orders them so that the
     recoverable failure comes last. Anything reading the file to build `oldText`
     must fetch it with `?aimax-raw=1` (see the rule below).

### Backups (`aimaxViewer.edit.backupBeforeSave`, default **off**)

Every write to a source file goes through **`ensureBackup(absolutePath, source?)`**
— `applyTextEdits`, `applyLayoutEdits`, `removeLayoutBlock` and `writeDeckFile`,
no exceptions. It is a no-op unless the setting is on, and unless this session
hasn't already backed that file up (`editBackupOnce`). Callers that already read
the file pass the bytes in; `writeDeckFile` doesn't have them, so it omits the
argument and lets `ensureBackup` read — behind the flag, so nothing is read when
backups are off. A failed backup **aborts the write** in all four callers.

The setting is read **per save**, not at activation, so flipping it takes effect
on the next edit without a window reload. There is a test for exactly that.

Two consequences worth knowing before changing this:

- **`Restore file from backup` (Browser Panel menu) does nothing while backups
  are off** — it is the only undo the UI offers. `handleRestore` distinguishes
  "no backup yet this session" from "backups are disabled" in its message,
  because sending someone to look for a `.bak` that was never meant to exist is
  the worse failure.
- **`writeDeckFile` is the one write with no undo behind it** when backups are
  off. The other three are anchored replaces: if the source moved underneath
  they refuse and say so. The Slide Sorter save overwrites the whole deck.

Off is the right default because the anchored-replace design already refuses
rather than clobbers, and a `.bak` sibling in a synced folder is a file that
syncs, indexes and shows up in the file tree. Turn it on when you're about to do
something you'd want to walk back.

### Editing rendered markdown

Edit mode works on a rendered `.md` and writes back into the source, which is
possible because of two properties that hold together and would not survive
either one alone:

- the edit client already sends **plain text**, not markup: `oldText` is a text
  leaf's `textContent`, or a bare text node wrapped in a throwaway span;
- `parseMarkdown` is a linear chain of regex replaces with **no typographic
  rewriting** (no smart quotes, no `--` → dash), so a rendered fragment is
  normally a verbatim substring of the source. The text inside `**bold**`
  renders as `bold`, and `bold` is in the file exactly there.

So the anchored replace finds it and swaps it, leaving the markup around it
alone. **Both weaker disambiguators are stripped for `kind: 'md'`:**

- `outerHTML` is rendered markup that exists nowhere in the `.md` — level 2
  could only match by accident;
- `occurrenceIndex` is the dangerous one. The client counts DOM elements whose
  *whole* text equals the fragment; the host counts *substring* hits in the
  source. A `.md` also carries text the renderer never emits (frontmatter, which
  `extractFrontmatter` strips, link URLs, list markers), so the Nth element is
  not the Nth hit and level 3 would write in the wrong place.

What's left is level 1: replace when the anchor is unique, otherwise refuse.
Measured over a real corpus (8 files, 2828 editable spots), that resolves **94%
of edits of 26+ characters and 99% of 61+** — i.e. the sentence someone is
actually fixing — and mostly refuses on short repeated labels (`Cosa`, `[ ]`,
a lone `**Fatture**` appearing in several table rows), where refusing is the
correct answer. Overall across all spots it is 68%; reconstructing markdown
delimiters from tags lifts that to 76%, and anchoring on the containing block
to 80%. Those heuristics were measured and deliberately **not** shipped: each
recovers a few points and none closes the gap. The change that would close it is
a **source map from the parser** (emit source offsets on generated elements, then
replace a byte range instead of searching for text), which means rewriting
`markdown-parser.ts` from a chain of `.replace()` into an offset-aware pass.

Move/Resize is rejected on markdown: geometry is a `<style>` block appended to
`<body>`, and a `.md` has no body to append it to.

**Geometry is the exception — it never goes through `applyTextEdits`.** Moving or
resizing an element would mean patching its opening tag, and an opening tag can't
round-trip verbatim (attribute order, quoting, entities). So Edit ▸ Move/Resize
takes the other route: `applyLayoutEdits(absolutePath, rules[])`, where each rule is
`{n, selector, css}`. It merges the declarations into a single
`<style data-aimax-layout>` block kept at the end of `<body>` — parse the existing
block, upsert by selector, re-serialize, write. Consequences worth knowing:
the block is **idempotent** (re-saving a selector overwrites its declarations),
**machine-managed** (hand edits inside it are rewritten on the next save),
**whitelisted** (only `transform`/`width`/`height`/`box-sizing`/min-max plus the
stacking and visibility trio `z-index`/`position`/`display` survive sanitization —
the last three with their own value whitelists — and selectors may not contain
`{ } < ; @ *`), and it shares the same one-per-session `.bak`. The selector is built
and *verified unique* client-side (`buildLayoutSelector` in
[annotation-client.ts](src/annotation-client.ts)) — the host only sanitizes it.

**z-order is not a geometry problem, it's a stacking-context problem.** Whether a
written `z-index` does anything depends on where the two elements' stacking contexts
meet, so `layZOrder` ranks against the elements the frame *actually overlaps*
(document-wide — after a drag the covered box is usually a cousin, not a sibling),
and refuses-or-warns when an ancestor between the frame and the shared context
establishes a stacking context, because there no value can win. Anything else that
reasons about paint order should reuse `layOverlapping`/`layLca`/`layTrapBetween`
rather than looking at `parentElement.children`. Reach for this pattern whenever the change is presentational:
a CSS override addressed by selector is far cheaper and safer than rewriting markup.

### Reading the source in order to write it back: always `?aimax-raw=1`

Every HTML response the server produces has two scripts injected before
`</body>` — the annotation/edit client and the link handler. **What the URL
returns is therefore not what is on disk.** The server cannot tell the two
intentions apart: a GET for display and a GET for round-tripping look identical.

> **Rule: anything that reads the source in order to rewrite it must read it raw.**
> `fetch(url + '?aimax-raw=1')` returns the file byte-for-byte, injection skipped.

Reading the served copy to *inspect* is fine — counting `<section>` for deck
detection, pulling the `<title>` — because nothing is written back. Reading the
served copy to *rewrite* bakes the client into the source, and the failure is
delayed and silent: the file stays valid and the page still opens. It surfaces
one version later, because the client starts with
`if (window.__aimaxAnnotationLoaded) return;` — the copy frozen in the file wins
the race and the freshly injected one exits on line 2, pinning the artifact to
whatever version it was saved under. This actually happened: the Slide Sorter
round-tripped the served page and accumulated **12 copies, 80 KB → 240 KB**.

Two defences, both intentional: `fetchDeckSource()` in
[slide-presenter.html](slide-presenter.html) is the only way that file reads the
deck, and `writeDeckFile()` strips `<script data-aimax-injected>` before writing
regardless. The backstop covers the single place whole files get written; the
rule covers everywhere else.

**To add a new direct-edit feature:** compute a verbatim `oldText`/`newText` pair from
the raw source (not from the DOM), then either post `saveEdit` (if inside a webview
panel) or add/extend an HTTP endpoint that calls `applyTextEdits`. Reuse
`urlToWorkspacePath`/`resolveEditTarget` for the path — never trust a client-supplied
filesystem path. The `.bak` backup and ambiguity gates come for free.

### Extension Points

- **URI Handler**: `vscode://maxturazzini.aimax-viewer/openBrowser?<url>` for deep
  linking. The authority is the **published extension id** (`publisher.name` from
  `package.json`), not the display name: with any other value VS Code does not
  reach the handler at all, it reads the link as a request to install an
  extension by that id and answers *"cannot be installed because it was not
  found"*. Nothing opens and nothing warns you that the URL was fine.
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

When creating HTML/MD artifacts in `Artifacts/`, display them with a
**workspace-relative path — never a port**:

```bash
open "vscode://maxturazzini.aimax-viewer/openBrowser?Artifacts/<filename>"
```

The port is per-workspace, so writing one is wrong in every window but one.
`server.port` defaults to 3124, and that default means *"derive a unique port
from the workspace path hash"* (`3124 + hash % 100`) precisely so several
windows can coexist — this machine routinely runs four. A URL that hardcodes
`127.0.0.1:3124` therefore points at whichever *other* workspace happens to own
that number, or at a foreign app: 3124 is also where VS Code's Live Preview
lands its WebSocket if its `portNumber` is set to 3123.

Two consequences worth knowing before using the relative form:

- **`3124` is the one port you cannot pin.** The port logic reads "the user
  chose a port" as *"the value differs from the 3124 default"*, so setting
  `aimaxViewer.server.port` to 3124 is indistinguishable from not setting it and
  falls through to the hash. Pin a different number, or don't pin at all.
- **VS Code decides which window receives a `vscode://` link.** With several
  open it may not be the workspace you meant; the relative path then resolves
  *there*. `openWorkspaceRelativeInBrowser` refuses with a message naming the
  workspace it searched rather than opening a same-named file from another
  project — but it cannot route the link for you.

Absolute `http://…` URLs still work unchanged, for external sites and for
targeting a specific server on purpose. To discover a running window's port,
every AIMax server answers `GET /api/identity` with `{workspace, folder}`
(localhost only — that endpoint deliberately sends no CORS header).

Naming convention: `YYYY-MM-DD_descriptive-slug.html` or `.md`

## Release & Deploy Checklist

> **REGOLA BLOCCANTE — versione in corso = "in volo".**
> Quando `package.json` punta a una versione **non ancora pubblicata** (es. 0.1.34
> mentre il Marketplace è a 0.1.33), quella versione è **in lavorazione**.
> **Non si fa bump alla versione successiva e non si inizia un nuovo ciclo di
> release finché la versione corrente non è stata pubblicata** completando TUTTA
> la checklist sotto (build → commit → push → Marketplace → tag → GitHub Release).
> Si può continuare a committare feature/fix *dentro* la versione in volo; ciò che
> è vietato è incrementare il numero di versione prima della pubblicazione.

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

### 5b. Publish to Open VSX (VSCodium, Cursor, Windsurf)
On Open VSX the extension lives under the **`aimax`** namespace
(`aimax.aimax-viewer`), while the VS Code Marketplace is still `maxturazzini`.
The plan is to move the Marketplace to `aimax` later; until then `package.json`
keeps `"publisher": "maxturazzini"` and the Open VSX package is the same `.vsix`
with only the publisher rewritten.

Account: GitHub login `maxturazzini`, Eclipse account maxaiplayground@gmail.com,
Publisher Agreement signed 2026-10-10. No token saved.
```bash
# Rewrite the publisher in a copy of the vsix (manifest + package.json only)
W=/tmp/vsix-aimax; rm -rf $W; mkdir -p $W/x; cd $W/x
unzip -q ~/claude_projects/AIMaxViewer/aimax-viewer-X.Y.Z.vsix
sed -i '' 's/Publisher="maxturazzini"/Publisher="aimax"/' extension.vsixmanifest
sed -i '' 's/"publisher": "maxturazzini"/"publisher": "aimax"/' extension/package.json
zip -q -r -X ../aimax.aimax-viewer-X.Y.Z.vsix '[Content_Types].xml' extension.vsixmanifest extension

# Upload it by hand at https://open-vsx.org/publish (logged in via GitHub).
# "Under review" for ~2 min of automated scans, then live.
# CLI alternative, if a token is ever saved:
#   ovsx publish $W/aimax.aimax-viewer-X.Y.Z.vsix -p $(cat ~/.claude/secrets/ovsx-pat.txt)

# Extension URL: https://open-vsx.org/extension/aimax/aimax-viewer
```
- **Namespace `aimax` verified** on 2026-10-11. Claimed via an issue on
  EclipseFdn/open-vsx.org, Option 3 (namespace matches the domain `aimax.it`,
  registrant MTX SRL), proof by email from @aimax.it:
  https://github.com/EclipseFdn/open-vsx.org/issues/14036 (closed 2026-10-11).
- **`maxturazzini.aimax-viewer` on Open VSX** (0.1.36, 2026-10-10) was the first
  upload, deleted the same day: its downloads were mirrors and scanners. The
  `maxturazzini` namespace is left empty there; do not publish to it.
- Open VSX has no "deprecate" button: the management page only offers deleting
  versions.

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
