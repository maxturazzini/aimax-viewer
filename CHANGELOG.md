# Changelog

All notable changes to the AIMax Viewer extension will be documented in this file.

## [0.1.37] - unreleased

### Fixed — the wrong URI handler id is gone from the rest of the repo

- `vscode://aimax.aimax-viewer/…` still appeared 18 times in `README.md`, `Artifacts/guide_en.md`, `Artifacts/index.html`, `Artifacts/aimax-viewer-presentation.html`, both copies of the `aimax-make-presentable` skill and a comment in `extension.ts`. These are the files agents read to build deep links, so the wrong id kept being copied into new artifacts. Only the historical changelog entries keep it, since they record what was true then.

_Version in flight — new entries go here, not under a published heading. This
header exists because they once didn't: the markdown work of 2026-07-29 was
written under `[0.1.34]`, which had already shipped on 2026-07-25 without it, so
the changelog credited a released version with features nobody could install.
Dated on release._

---

## [0.1.36] - 2026-08-11

### Added — Mermaid diagrams render in the `.md` preview

- A ` ```mermaid ` fence is no longer shown as source: it renders as a diagram, with `−` / `+` / `1:1` zoom controls and a fullscreen button on each one. Everything else about code fences is unchanged.
- **Zoom resizes the SVG instead of using `transform: scale()`.** A scaled element keeps its original box, so the container would have nothing to scroll and a magnified process diagram would be magnified but unexplorable. Resizing makes the scrollbars appear on their own.
- **Fullscreen is a CSS overlay, not the Fullscreen API.** The markdown page is served into an iframe, where `requestFullscreen()` needs an `allow` attribute on the frame that the page cannot set — it would have failed silently.
- Diagrams keep their natural width rather than being scaled down to the column (`useMaxWidth: false` for every diagram type). A 2000px process diagram squeezed into 860px has unreadable labels; scrolling sideways is the better trade.
- A diagram that does not parse **falls back to showing its source**. `mermaid.parse()` runs before `mermaid.run()` because `suppressErrors` alone still swaps in mermaid's own "Syntax error" box, and for a hand-written diagram seeing what you typed is more useful.
- `securityLevel: 'strict'` (mermaid's default, set explicitly): labels go through DOMPurify and the `click` directive is disabled, so a diagram cannot call into the page's JS.
- **Edit mode is off inside a rendered diagram**, annotations still work. The labels are real HTML elements and their text exists verbatim in the `.md` inside the fence, so an anchored replace would rewrite the diagram source under a view still showing the old render. The gate is a `data-aimax-noedit` ancestor check in the annotation client.
- The 3.5 MB mermaid bundle is vendored in `assets/`, served from `/__aimax/mermaid.min.js`, and **loaded only for documents that contain a diagram**. No CDN, so it works offline and needs no CSP change. The packaged VSIX grows from 0.3 MB to 1.23 MB.

### Fixed — rendered markdown is sanitized, so a `.md` can no longer run script

- `parseMarkdown` passed author HTML through untouched, so `<img src=x onerror=…>` in a `.md` executed. The output now goes through an allowlist sanitizer (`src/sanitize-html.ts`).
- **Why this was worse than ordinary XSS:** the page is served on the AIMax origin, which also answers `POST /__save-md`, `/__save-notes` and `/__claude` — the last one accepts `allowEdits: true`. Script in a preview could write into the workspace and drive the Claude bridge. Markdown is increasingly written by agents from external material, so "it is a local file" is not a reason to trust it.
- Every tag is **rebuilt from scratch** from an allowlist of names and attributes rather than cleaned in place; nothing of the original tag text survives, and anything that does not parse as a well-formed tag is escaped into text. That is what closes `<scr<script>ipt>` and entity-smuggled `jav&#x61;script:` without enumerating them.
- **Measured before shipping**, because an allowlist that breaks real documents is not a security win: across a 3623-file corpus, 2513 files render byte-identical, 1109 differ in HTML but show the same text or *more* (prose like `<nome utente>` that the browser used to swallow as an unknown tag is now visible), and **1** loses text — an archived file whose HTML was already malformed. Kept: `details`/`summary`, `style`, `class`, tables, images, relative and `vscode:` links. Dropped: script/style/iframe/object/svg with their contents, every `on*` handler, `javascript:`/`vbscript:`/`data:text` URLs, and forged `data-aimax-*` attributes.
- Sanitization runs **before** code fences are restored from their placeholders, so documentation that shows HTML stays intact and escaped.
- `target="_blank"` links now get `rel="noopener noreferrer"`.
- Covered by 36 XSS payloads asserted **in a real browser DOM**, not by string matching — two payloads survive as inert visible text, which a regex cannot tell apart from a live tag.

### Fixed — the URI handler id in the docs was wrong

- `CLAUDE.md` documented `vscode://aimax.aimax-viewer/…`; the published id is `maxturazzini.aimax-viewer`. With the wrong authority VS Code never reaches the handler — it reads the link as a request to install an extension by that id and answers *"cannot be installed because it was not found"*, which sends you looking in the wrong place.

### Added — `openBrowser` accepts a workspace-relative path, so links stop carrying a port

- `vscode://maxturazzini.aimax-viewer/openBrowser?Artifacts/deck.html` now resolves against **this window's** server port. Absolute `http://…` URLs are unchanged, so every existing link keeps working — the new branch only triggers when the query has no scheme.
- Why it was needed: the port is derived from a hash of the workspace path (`3124 + hash % 100`) so that several windows can coexist, and this machine routinely runs four. Any port written by hand into agent instructions is therefore correct in at most one window and silently wrong in the rest — pointing at another workspace's server, or at a foreign app entirely. Live Preview with `portNumber: 3123` puts its **WebSocket** on 3124, which answers `426 Upgrade Required` to anything AIMax sends it.
- What it cannot fix: VS Code chooses which window handles a `vscode://` link. If it picks the wrong workspace the relative path resolves there, so the resolver refuses with a message naming the workspace it searched instead of quietly opening a same-named file from another project.

### Changed — `/api/identity` returns the workspace folder, and no longer sends CORS

- The response gains `folder` (the absolute workspace path) alongside `workspace`. Additive: the only consumer, `fetchWorkspaceName()` in `apps-manager.ts`, reads `workspace` and ignores the rest.
- `Access-Control-Allow-Origin: *` is **removed** from that endpoint, in the same change and for its sake. The consumer is a Node `http.get`, which does not do CORS checks; the header only ever mattered to browsers. With it, any web page open in any browser could scan `127.0.0.1:3124-3223` and read the replies — and `folder` turns that from a list of workspace names into absolute paths, i.e. a username and directory layout. Now readable from this machine, not from a random tab.

---

## [0.1.35] - 2026-07-29

### Changed — `.bak` backups are now opt-in (`aimaxViewer.edit.backupBeforeSave`, default off)

- Until now **every** write to a source file dropped a `<file>.bak` next to it before the session's first edit. That is now behind a setting, **off by default**: no more backup files appearing beside everything you edit — and in a synced folder, no more backup files syncing, indexing and cluttering the tree.
- The switch is uniform: it governs all four write paths (`applyTextEdits`, `applyLayoutEdits`, `removeLayoutBlock`, `writeDeckFile`), with no exception for the destructive ones. One switch, no surprises about which action does or doesn't leave a `.bak`.
- Off is a safe default because the save paths are **anchored replaces**: if the file changed underneath, they refuse with a reason instead of overwriting. **The exception is the Slide Sorter save** (`/__save-deck`), which rewrites the whole deck — with backups off, that one has no undo behind it other than git. Turn the setting on before a reorder you might want to walk back.
- **`Restore file from backup`** (Browser Panel menu) has nothing to restore while the setting is off, and now says so, naming the setting, instead of the old "one is written automatically before the first edit of a session" — which would have been a lie.
- The setting is read at each save rather than at activation: switching it on or off takes effect on the next edit, no window reload.
- Internally the four copy-pasted backup blocks collapse onto a single `ensureBackup()`.

### Added — Edit mode on rendered markdown

- The orange ✏ Edit toggle now **saves back into the `.md`** when the page is a rendered markdown file. Until now the client was injected on those pages and let you type, but the save resolved through `urlToWorkspacePath`, which only accepts `.html`, so nothing ever reached disk.
- It works because the client already sends plain text (a leaf's `textContent`, or a bare text node) rather than markup, and because `parseMarkdown` does no typographic rewriting: a rendered fragment is normally a verbatim substring of the source, so the anchored replace swaps it and leaves the surrounding `**`, `` ` `` or `#` untouched.
- **The two weaker disambiguators are stripped on markdown.** `outerHTML` is rendered markup that exists nowhere in the source. `occurrenceIndex` is worse: the client counts DOM elements whose whole text equals the fragment while the host counts substring hits in the source, and a `.md` also carries text the renderer never emits (frontmatter, link URLs, list markers), so the Nth element is not the Nth hit. Only unique anchors are accepted; everything else is refused with a reason. The failure mode is therefore "did not save and said so", never "saved in the wrong place".
- Measured over a real corpus of 8 documents and 2828 editable spots: 94% of edits of 26+ characters succeed, 99% of 61+ characters, i.e. the sentence someone is actually correcting. Short repeated labels are where it refuses. Two heuristics that would raise the overall rate (reconstructing markdown delimiters from tags, 76%; anchoring on the containing block, 80%) were measured and left out on purpose: each buys a few points and none closes the gap. The change that closes it is a source map from the parser, tracked separately.
- Move/Resize is refused on markdown with an explicit message: geometry is a `<style>` block appended to `<body>`, and a `.md` has none.

### Added — writing back to a markdown source (`POST /__save-md`)

- An artifact that renders a `.md` can now **write back into it**, which until now only `.html` could do. Both existing save endpoints resolve their target through `urlToWorkspacePath`, and that function rejects anything not ending in `.html` — so every markdown source the viewer serves was read-only from the page's side, and the only way to change a line was to go through `/__claude` and spend a full agent run on it.
- Body is `{ path, edits: [{oldText, newText}] }` with `path` **workspace-relative** (`projects/todo.md`). The write primitive is the same `applyTextEdits` as the HTML savers, same backup policy included (see the `.bak` entry above): an **anchored verbatim replace**, not a full-file overwrite. On a file that lives in a synced folder this is the point — if it changed underneath (OneDrive, another editor, an agent), the save fails with "text not found" instead of silently clobbering the other version.
- The new resolver `mdPathToWorkspacePath` takes a path rather than a URL, and gates on containment, extension and existence. Containment is `path.resolve` (which collapses `..` first) plus a `root + separator` prefix check — a bare `startsWith(root)` would have accepted a sibling directory whose name merely begins with the root's.
- Not atomic across a batch: `applyTextEdits` writes whatever applied. Callers wanting all-or-nothing send one edit per call and order them so the recoverable failure lands last — the TODO card in miniMe's `artifacts/index.html`, first consumer of the endpoint, appends to `done.md` before removing from `todo.md`, so a half-failure leaves a visible duplicate instead of a lost task.

---

## [0.1.34] - 2026-07-25

### Added

- **Edit ▸ Move/Resize (direct manipulation of frames)**: Edit mode gains a new ✥ toggle next to 📝 Notes. Turn it on and the cursor stops being a text caret and becomes `move`: drag a block to move it, drag the 8 orange handles of the selection frame to resize it, ↑↓←→ to nudge by 1px (⇧ = 10px), `Esc` to deselect. The Notes and Move/Resize sub-modes are mutually exclusive.
  - **The markup is never touched.** Every gesture becomes a CSS rule in a single `<style data-aimax-layout>` block at the end of `<body>`, keyed on a selector the client verified resolves to exactly one element (`#id` when there is one, otherwise a `>` chain with `:nth-of-type`, truncated at the first ancestor carrying a unique id). The block is idempotent: re-saving the same element overwrites its declarations instead of appending new ones, and it can be deleted by hand in one go. Only geometry properties are writable (`transform`, `width`, `height`, `box-sizing`, min/max) — selectors and values are sanitized, so no arbitrary text reaches the file.
  - **Respects the page's own transforms**: on a deck that scales its stage (`transform: scale(...)`), 1 mouse px ≠ 1 CSS px. Moves convert with the *parent's* scale, resizes with the element's *total* scale, so the frame tracks the pointer and the saved geometry reproduces to the pixel what you saw while dragging. Dragging an N/W handle keeps the opposite edge still. Any rotate/scale the element already carried is preserved (only the translation component of the matrix is rewritten).
  - One ✥ badge per frame: it adds to the **Save** button's counter alongside text edits (a single save writes both), and clicking it undoes the gesture, putting the element back as it was. Available in both the Browser Panel and the Home Panel; the one-per-session `.bak` applies here too.
  - In this mode clicks on the page are swallowed: dragging a card that is also a link, or a deck's click-to-advance surface, no longer navigates away mid-gesture.
  - **Stacking order (z-order)** on the artifact's own elements, with the four classic commands: **⤓ To back**, **↓ Backward**, **↑ Forward**, **⤒ To front**. Steps are computed from the current `z-index` values of the elements the frame **actually overlaps**, wherever they sit in the tree: "to front" goes to max+1, "to back" to min−1, single steps hop over the contender immediately above/below and say so when you are already at the end. On a `position: static` element `z-index` would be inert, so `position: relative` is written alongside it (which leaves it exactly where normal flow put it). Both properties are whitelisted with dedicated validation: `position` accepts only the five CSS keywords, `z-index` only an integer or `auto`.
    - **The comparison is no longer between siblings.** Looking for overlaps among `parentElement.children` feels natural but is the wrong set: the point of dragging a frame is to put it where it wasn't, so what it ends up covering is almost always a *cousin* — the card in the next column, a box in another wrapper. With the sibling search the command answered *"Nothing overlaps this frame"* on the very overlap the user was looking at, and when it did fire it picked numbers taken from siblings, too low to beat the real cousin.
    - **Stacking contexts.** A `z-index` does not cross an ancestor that establishes a stacking context (`transform`, `filter`, `opacity < 1`, `isolation`, `mix-blend-mode`, `will-change`, `contain`, `position: fixed/sticky`, or a `z-index` on a positioned box): inside that ancestor the element is sealed, and no value — not even `999` — lifts it above anything outside. This is the typical case of decks that scale their stage. The command now recognises it: it ranks against everything it can genuinely reach and, if something stays out of reach, it says so, naming both the box that stays on top and the ancestor responsible and why ("`<div.seg-zone.seg-interno>` creates a stacking context (transform)… restack that block instead"), instead of declaring success while leaving the frame buried.
  - A pure restack no longer writes an identity `transform` into the file: `transform` appears only if the element was really moved or resized.
  - **Undo/redo of gestures**, with a button row that appears in the panel body only inside Move/Resize (and disappears when you go back to text editing): **↶ Undo** (`⌘Z`), **↷ Redo** (`⇧⌘Z`), **⟲ Reset frame**, which puts the selected frame back to how it was before the first gesture. The buttons disable when there is nothing to undo/redo, or no selection. Consecutive arrow presses coalesce into a single history entry, so holding a key down doesn't bury the history under one entry per pixel. When an undo brings an element back to its starting geometry, its pending entry and badge disappear instead of writing a rule identical to the original.
  - **Ordered z-index band**: the injected client's overlays (frame, label, popup, badges) now sit below `2147483647`, reserved for AIMax's own chrome. It was needed in the Home Panel, where chrome and client live in the same document: both being at the maximum, the client won on DOM order and the inspector's white label ended up above the panel.

### Added (Move/Resize, second pass)

- **Rotation**: a round handle on a stem above the frame; drag it and the frame turns about its centre; **⇧ snaps to 15°**. The rotation composes with the transform the element already had (`L = R · M0`), so any scale or skew belonging to the artifact survives and only our rotation is layered on top. The resize handles stay on the **element's** axes: on a tilted frame the mouse delta is mapped into local space, otherwise dragging the right edge of a skewed box widened it diagonally.
- **⇧ while resizing keeps the aspect ratio** (on corners), driven by the axis you pulled furthest.
- **Delete a frame**, from the 🗑 button or the `Del`/`Backspace` key. It is `display: none`, not a cut: **the markup stays in the file**, so ⌘Z brings it back and "Back to original" removes the rule entirely. `display` joins the whitelist with its own list of accepted values.
- **Show Dev Console** in the hamburger: opens the **panel's** Developer Tools (`workbench.action.webview.openDeveloperTools`), which is where the viewer's own errors land.
- **Alignment snapping** while dragging a frame: edges and centre are compared against those of the siblings **and of the parent**; within 6px the snap is exact and a guide appears showing the alignment found. The guide is visible *only* while a snap is active, so seeing it is confirmation of being aligned rather than a hope. **⌥ suspends snapping** on the fly. Targets are measured once at drag start: they cannot move with the pointer down, and re-measuring them on every move would thrash layout.
- **Two restore commands in the hamburger**, both with a modal confirmation before writing, described to the user by what **survives** rather than by how they work:
  - **Restore original layout** — puts every element back where the page puts it (undoes moves, resizes, rotations, ordering and hidden frames); **text edits stay**. It is not a convenience: it is the only way out of a state the interface can enter and not leave, because a frame hidden with Delete no longer has a box to click, and after a reload there is nothing to select in order to undo it.
  - **Restore file from backup** — takes the whole file back to how it was before the session's first edit, text included. The `.bak` already existed on disk at every save, but was unreachable from the interface.

### Design notes — why geometry never touches the markup (and what that costs)

> For whoever reads this code later. The mechanism is deliberate, but it carries a
> measured price, not a theoretical one: anyone extending it needs to know both.

- **Why a CSS block and not the element's tag.** The whole save path rests on a
  **verbatim** replace: `applyTextEdits` finds the old string byte for byte in the
  source and swaps it. Text edits suit that — the text inside an element survives
  untouched. An **opening tag** does not: run it through the DOM and re-serialize
  it and the attribute order, the quote style, the entity encoding and the
  whitespace inside the tag all change. The anchor would no longer be found, or
  would be found wrong. So moving and resizing — which would mean rewriting that
  tag — take the other route: a selector-addressed rule in
  `<style data-aimax-layout>`. **Text edits stay in the markup**: only geometry
  ends up in the CSS block.
- **What it buys.** The block is idempotent (one rule per element, not per
  gesture: twenty drags on the same box stay one line), it lives in one place
  instead of being scattered across N tags, and it is **fully reversible**: remove
  the last rule and the file goes back *byte-identical* to the original — that is
  a test, not a hope. Plus the one-per-session `.bak`.
- **What it costs, measured.** The selector is **positional** (`:nth-of-type`) and
  **nothing verifies that it still points where it pointed**. `laySavedRuleIndex`
  compares only the selector *text*, not the element. Two ways to break, both
  reproduced on a real artifact:
  1. **The rule evaporates.** Saved a box's move; inserted a card earlier in the
     file; the selector resolves to `0` elements. The box returns to its original
     position and the saved layout is gone — **with no error anywhere**.
  2. **Worse: it moves the wrong box.** Rule saved on one block; an element added
     before it in the same container; the same rule now moves the *next* block,
     and the original one goes back to `transform: none`. Silently. Whoever opens
     the file sees an element out of place and hunts for the bug in the artifact's
     own CSS, where it isn't.
- **The trigger lives inside this same product.** The **Slide Sorter reorders
  sections by rewriting the whole file**: every reorder invalidates the rules
  whose path crosses that level. The same goes for a hand edit of the HTML, or an
  agent adding a card. And because the rules are `!important`, a misalignment also
  beats CSS the author writes afterwards by hand.
- **It is not "the file gets messy"**: the block stays small and deletable. It is
  that the file becomes **silently misaligned**.
- **The two ways out, for whoever comes back to this.** (a) *Validate on load*:
  the client already reads the saved block, so it can check that each selector
  still resolves to exactly one element and flag the ones at 0 or >1 — cheap, and
  it turns a silent failure into a warning, but it does not cover the "resolves to
  exactly one, the wrong one" case. (b) *Anchor to an `id`*: `buildLayoutSelector`
  already prefers `#id` when there is one, and that is immune to reordering;
  making it robust would mean **writing** an id into the element on save, i.e.
  touching the opening tag — but as the insertion of a single attribute into a tag
  already identified, not as a re-serialization of the DOM, which is the thing
  this design avoids.

### Added (Annotate)

- **Freehand drawing (pen) as an annotation gesture**: Annotate mode now has a third way, next to 👆 Point — it did not exist before. Drawing over the page leaves a visible SVG stroke until you write the comment attached to it (a tap without dragging, fewer than 2 points, is discarded). The stroke is reduced to ~40 points at most and saved in normalized coordinates (0–1) relative to the viewport, together with its bounding box and the element resolved under the stroke's centroid: it flows into the same `annot:add` payload as point comments, with `kind: 'draw'`, hence into the same feed that reaches Claude.

### Added (Bridge)

- **`/__claude` accepts a new `readOnly` mode**, alongside `allowEdits`: it confines the agent to non-mutating tools (`Read,Grep,Glob,WebFetch,WebSearch`, no Bash/Edit/Write), with a 180s budget and a system prompt tailored to answering inside a live demo in a deck ("never create or modify files, or run shell commands"). `allowEdits` wins if both flags are set, so `readOnly` can never widen an edit session. Not wired to a UI control yet: for now it must be passed explicitly in the POST body.

### Changed

- **The selector turns white.** The colour was hand-written in 6 places in the client: the palette now lives in CSS variables (`--aimax-sel`, `--aimax-edit`, `--aimax-accent`, `--aimax-draw`) defined once. The selection frame and its handles are white with a thin dark contrast line — they are editor chrome, and every tool the user already knows draws them neutral, leaving colour to the artifact. Bright tints stay for **state** (comment cyan, edit orange, draw pink).
- The Notes icon is no longer the only emoji in the bar: an SVG silhouette like the others.

- **Panel reorganised: modes on top, actions below.** The header carried sub-modes, Save and six action buttons all at once, and with Move/Resize arriving it had become unreadable. The header now answers a single question — *where am I* — and everything you **do** with what you have collected sits in an action row below.
  - **Freehand drawing becomes an annotation sub-mode**, not a toolbar button: both pointing and drawing produce comments, so they are two ways of doing the same job. The top toolbar now has only two mode buttons (💬 Annotate, ✏ Edit) and the pen lives in the panel header next to 👆 Point.
  - **Edit's sub-modes are three explicit toggle buttons**: **T Text** (default), **✥ Move/Resize**, **📝 Notes**. Before, "text" was the implicit state you got by switching the other two off, and there was no way to see which one you were in. Entering Edit always lands on Text.
  - Copy · `>_` · `</>` · ✱ · ⟳ · 🗑 moved into the action row, together with (never at the same time as) the Move/Resize tools.

### Fixed

- **Copying from the viewer never worked**: in the Browser Panel the `Cmd/Ctrl+C` handler was attached to `frame.contentDocument`, which is always cross-origin (`vscode-webview://` against `http://127.0.0.1`) — the `try` threw, the `catch` swallowed it, and the handler was never installed; the fallback on the panel's own document read the panel's selection, always empty, because the selected text lives in the iframe. In the Home Panel there was no handler at all. It now lives in the injected client, the only place that actually sees the selection, and hands it to the host via `copyToClipboard`: it works in both panels, with annotation mode on or off, and it also covers the context menu ▸ Copy (the `copy` event, not just the shortcut).

- **`deploy.sh` no longer bumps the version unless asked to** (`--bump`). Bumping on every run silently violated the in-flight version rule and left the changelog documenting a number that no longer existed. The script also deleted the freshly built package with `rm -f aimax-viewer-*.vsix` — precisely the artifact needed to reinstall or roll back: it now removes only the ones belonging to other versions.

- **The VSIX contained a backup of another VSIX** (280 KB out of 547): `.vscodeignore` did not exclude `.bak` files. Package back down to ~275 KB.

- **The Home Panel's relative links went nowhere**: `navigateLocal` looked for the file under a `projects/` folder hard-coded in the source — a leftover from an old layout — so a link to a file sitting next to the index opened nothing, with no error anywhere. The search now starts from the **workspace root**, with the path constrained to stay inside it, and if the file is not there it says so.

- **Selection survives a sub-mode switch**: you were resizing a frame, you switch to Text, and the caret now lands inside that element instead of making you find it by eye again; from Text to Move/Resize, the frame containing the spot you were typing in becomes the selected one; switching to Annotate opens the popup already on that element. A reference to the element could not survive — switching sub-mode rewrites the DOM, because text mode wraps text fragments in temporary spans — so the **verified-unique selector** is remembered and re-attached on the other side: the same mechanism we use to write to file, reused for continuity of work.

- **The Slide Sorter's save walled the injected client into the source (serious — it corrupted the artifact)**: the sorter read the deck with `fetch(deckBaseUrl)`, i.e. the **served** URL, which by construction contains the `<script data-aimax-injected>` before `</body>`. Splitting the text into head + sections + tail, that script ended up in the tail and was written back to the file. On the next save the sorter re-read a file that already contained one, the server injected another on top, and the count climbed: on the sample artifact **12 copies, from 80 KB to 240 KB** — 160 KB of duplicated client, introduced by the very commit that added the sorter.
  - The damage was not only weight. The client starts with `if (window.__aimaxAnnotationLoaded) return;`: the oldest copy walled into the file ran first and raised the flag, and **the fresh client injected by the server bailed out on its second line**. Result: the page ran forever with the client version frozen into the file, while toolbar and panel were the new ones — hence the orange pen instead of the white selector, and the edit popup from two versions back.
  - Every read of the source destined to be written back now goes through `fetchDeckSource()`, which asks for `?aimax-raw=1` (the file exactly as it is on disk). This covers both the sorter and the notes save.
  - **Safety net at the point of writing**: `writeDeckFile()` strips every `<script data-aimax-injected>` before writing anyway, and logs that it did. It is the only place whole files get rewritten, so no future client can repeat the damage even by reading wrong.
  - **The sample artifact was exactly this case**: `Artifacts/aimax-viewer-presentation.html` carried the 12 walled-in copies of the client inside the "Add Bridge to this page" slide (235 KB → 75 KB after cleanup). Cleaned in the same pass; if you see ~4000 lines removed from that file in this release's diff, this is why — not lost content.

- **Notes on artifacts that have none**: turning the Notes sub-mode on for a file with no `.speaker-notes` blocks revealed nothing and made nothing editable, without saying why. The page now reports how many it found and the panel spells it out: "this artifact has no speaker notes", pointing you back to Text.

- **Restacking with nothing underneath**: z-order commands on a frame that overlaps nothing wrote a rule that changed nothing visible — stacking decides who paints on top only where two elements share pixels, and in normal flow that does not happen. The command now stops and explains, instead of looking broken.

- **Discarding a text edit did not put the text back**: clicking the ✏ badge took the edit out of the save queue, but the new version stayed on screen — you saw one thing and the file contained another. Discarding now restores the original words too. If the edit has already been written to disk, discarding no longer touches the text (the file contains the new version: putting it back on screen only would recreate exactly the divergence this fixed); in that case the badge is already grey and labelled "Saved".

- **"Reset frame" lied after a save**: it removed the pending edit and restored the inline style, but the rule already written into the `<style data-aimax-layout>` block is `!important` and stayed — the frame went back to where it was *at save time*, not where it was originally, without saying so. The client now reads the block from the served page, so it knows which frames already have an override on file: the restore deletes the rule from the live stylesheet too (the preview matches what will be written) and queues the rule's **removal**, which drops it from the file on Save. Removing the declarations is the only correct neutral: overwriting them with `auto`/`none` would leave an `!important` rule still beating the artifact's own CSS. When the last override falls, the whole block is removed and the file returns exactly to its starting markup.
  - The button is now called **⤺ Back to original** (it was "Reset frame", which said neither what it restored nor how far back) and enables only if the selected frame really has an override, pending or already on file.
  - Selecting a frame updates the buttons immediately: state used to travel only once a gesture completed, so the button stayed grey at precisely the moment it was needed.

- **The old injected client came back from the webview cache**: the `no-store` introduced in this same version prevents *new* cache entries from being created, but does not evict the ones left by earlier builds (which sent `etag`/`last-modified` and no `cache-control`): the iframe served them back with the annotation client from the version they were saved under, so the toolbar was new and the page behaved like the old one — in Edit the text popup appeared instead of the current behaviour. The iframe now always loads with a throwaway `__aimaxcb` parameter (first load, navigation and ⟳), so the cache key no longer matches the legacy entries. The URL the panel tracks stays clean: address bar, history, presenter and resolving the file to edit all read that one, and the server strips the query before resolving the file. `/__proxy__/`, `/__presenter` and `/api/` are excluded.

- **Presenter on long decks — `lesson-mode=fullpage` and iframe multiplication (MTX-19)**: the presenter opened one iframe per slide, each a full load of the deck. On a 157-slide deck that meant 159 iframes instantiated together (157 carousel + current + next) and the page froze for seconds.
  - **Lazy thumbnails, mounted through a queue**: carousel and sorter tiles start as text-only placeholders (the slide title) and mount their iframe only when they come on screen, going through a queue that starts at most 4 at a time — the ones closest to the centre of the screen first — and starts a new one as soon as one finishes. What froze the page was not the number of live iframes but having instantiated them all in the same frame. Off-screen tiles are evicted down to `THUMB_BUDGET` (24); the ones the user is looking at stay, up to a hard ceiling of `THUMB_CEILING` (64). On a 157-slide deck: **159 → 26 iframes** in steady state, stable when jumping to the end of the deck and when scrolling the carousel; the worst case (sorter open and zoomed all the way out, 97 tiles on screen) stops at 64 previews and a single ~116 ms long task, against seconds of freeze before. Past the ceiling, tiles stay placeholders with the title.
  - Opening the sorter unmounts the carousel thumbnails, which the overlay covers entirely: they were invisible iframes occupying slots the sorter tiles needed. Closing it brings them back.
  - **`<meta name="lesson-mode" content="fullpage">` is now honoured**: a deck that declares it does not want to be split owns its own navigation, so it is driven through the `postMessage` bridge (`aimax-lesson-goto`, 1-based slide) instead of merely scrolling its DOM. Before, the meta was simply ignored.
  - The jump is still also performed as an instant scroll: the reference bridge scrolls `smooth`, which on a deck with scroll-snap animates through every intermediate slide and can settle one section further on. As a side effect, a deck that declares the meta but does not implement the bridge keeps navigating instead of sitting mute on slide 1.
  - **Indices aligned with the bridge**: in fullpage mode sections are counted with the contract's reference selector (`main section` when it exists, `section` otherwise), so the presenter's slide N is the deck's slide N. Each slide now also carries its own `sourceIndex` (its position among **all** the `section`s in the file): the notes save goes through that, otherwise on a deck with sections both inside and outside `<main>` it would have written — with no error and a "Saved" result — onto another slide's notes.
  - In the sorter too, fullpage deck previews are driven with the bridge as well as with scrolling: the sorter indexes the **raw source**, and since it only opens when that order matches the presented one (see below), the raw index is also the bridge's slide number. So a fullpage deck with its own navigation shows the right slide in every tile instead of slide 1 everywhere.
  - Closing the sorter unmounts its thumbnails instead of leaving them alive behind the presenter.
  - The sorter now refuses to open, explaining why, when the source contains more `<section>`s than the deck presents (fullpage with sections outside `<main>`): reordering would have renumbered and moved sections the presenter does not show, and saving would have lost the markup between sections (the `<main>` wrapper, for one).

### Fixed (surfaced during MTX-19 testing, pre-existing)

- **Hidden slides never revealed themselves**: clicking a `data-hidden` slide from the carousel updated the counter and the title, but the preview stayed on the previous slide. The injected hiding rule is `display:none !important` and the reveal used an inline style without `!important`, so it always lost. The reveal is now `!important` in all three places (current preview, fullpage branch, audience window).
- **The sorter's zoom reloaded every preview**: `layoutSorter()` re-`appendChild`ed every tile on every call, and moving an iframe within the DOM reloads it — so every notch of the zoom slider and every click on the eye threw away all the mounted previews. Only tiles genuinely out of position are moved now: a zoom reloads nothing, a reorder reloads only the tiles that moved.
- **`TypeError` on decks with no sections**: a `slideChanged` message from the audience window sent `updatePresenterView()` to read a slide that did not exist.

- **Remote HTTP services in the browser panel (MTX-18)**: opening a service served over plain HTTP (e.g. `http://minimacs.local:8788`, a Tailscale IP) showed a silent blank page in the browser panel iframe. The webview CSP had no explicit `frame-src` and allowed only `localhost`/`127.0.0.1` over HTTP plus the CDNs (always HTTPS), so it blocked the host.
  - New setting `aimaxViewer.csp.allowedHttpHosts` (array, default `[]`): each listed host is allowed as `http://<host>:*` in `default-src`/`frame-src` and in the resource directives.
  - Added an explicit `frame-src` to the CSP (localhost + configured HTTP hosts) so the iframe no longer inherits `default-src` alone.

---

## [0.1.33] - 2026-06-15

### Added

- **Slide Sorter (presenter mode)**: full-screen overlay to reorder and hide/show slides with live thumbnails.
  - Open with the **⊞ Sorter** button above the carousel or the **`S`** shortcut; **`Esc`** to close.
  - Thumbnails are functioning mini-iframes in a zoomable, multi-row grid (zoom slider in the header); iframes build once and reorder via DOM moves (no reload).
  - **Drag & drop** to reorder freely; a blue edge indicator shows the drop position.
  - **Eye toggle** per slide hides/shows it. Hidden slides stay in the carousel (dimmed, with a badge) and can be opened on demand, but are skipped by next/prev navigation and the audience window (kept in the source as `<section data-hidden>`).
  - **Save order** rewrites the deck file in the new order, renumbers the visible `slide-num` badges (`N / TOT`, with TOT = visible count), and reloads the deck + audience window in place. A one-per-session `.bak` is written before the first save.

- **Annotation mode — Edit in place (beta, personal)**: new orange "Edit" toggle next to the existing Annotation toggle in both Browser Panel and Home Panel toolbars.
  - Click a plain-text element (`<p>`, `<h1>`–`<h6>`, `<li>`, `<td>`, etc.) to open a textarea pre-populated with its current text. Press Enter to apply the change to the DOM immediately and queue it for save.
  - A green ✏ badge marks each pending edit. The toolbar shows a `SAVE (N)` button that flushes the batch to disk on click.
  - **Sub-toggle 📝 Notes** (visible only inside Edit mode): reveals hidden `<div class="speaker-notes">` blocks of slide decks with a yellow highlight and restricts editing to them. Multi-line textarea, Enter for newline, ⌘↵ (Cmd+Enter / Ctrl+Enter) to save.
  - **Safety gates**: Edit toggle is disabled unless the URL is a workspace `.html` served by the AIMax server (no `.md`, no `/__proxy__/`, no external sites). Reuses the existing `urlToWorkspacePath()` gate.
  - **Save strategy — anchored text replace**: each edit must match its original text exactly once in the source file. On 0 matches → "Text not found" (file changed externally). On ≥2 matches → "Ambiguous: edit manually". Failed edits don't block other edits in the batch.
  - **Automatic backup**: the first save per file per session writes a sidecar `<file>.bak` snapshot of the on-disk content right before any edit. Subsequent saves of the same file in the same session don't overwrite the `.bak`.
  - **Element filter**: refuses elements with element children (e.g. `<p>Hello <strong>world</strong></p>`) with a toast — single text-node leaves only.

### Technical

- `slide-presenter.html`: Slide Sorter overlay; the slide model now keeps **all** sections (with a `hidden` flag, array index = DOM index) so navigation skips hidden slides while explicit clicks still show them.
- `src/extension.ts`: new `/__save-deck` HTTP endpoint (`writeDeckFile`) for full-file deck saves, reusing the same workspace gate and one-per-session `.bak` policy as `/__save-notes`.
- `src/annotation-client.ts`: extended `annot:toggle` payload with `mode: 'comment' | 'edit'` and `notes: boolean`; new `edit:save`, `edit:remove`, `edit:result`, `edit:toast` message types; in-iframe toast + Notes reveal stylesheet.
- `src/extension.ts`: new `applyTextEdits()` helper, `filePathToWorkspacePath()` gate, `resolveEditTarget()`, `handleSaveEdit()`, session-scoped `editBackupOnce: Set<string>`. Wired `saveEdit` into all three panel `onDidReceiveMessage` handlers (Browser Panel single-tab, Browser Panel multi-tab, Home Panel).

---

## [0.1.32] - 2026-05-20

### Added

- **Commit with Claude**: right-click on any folder (VS Code Explorer or Artifacts sidebar) to start a scoped commit session via Claude Code.
  - Runs `git status --porcelain` limited to that folder and only opens a terminal if there's something to commit.
  - Shows an info banner (`Nothing to commit in <folder>`) when the folder is clean and a warning (`<folder> is not inside a git repository`) when outside a repo — zero wasted terminals or tokens.
  - The terminal is opened at the **repo root** (not the selected folder) so all `git` commands work correctly, while the prompt scopes the work to the selected folder via its relative path.
  - The prompt instructs Claude to: list scoped changes, group them by logical theme when more than three files, propose commit messages per group, and wait for explicit OK before committing.
  - The prompt is localized to the user's VS Code UI language (`vscode.env.language`, IETF BCP 47) — Claude replies in Italian on an Italian VS Code, English on English, etc., while the prompt template itself stays in English.
  - Cross-platform: uses `execFileSync` with array args (no shell quoting issues with spaces / accents in paths) on macOS and Windows.

### Technical

- New command: `aimaxViewer.commitFolderWithClaude` (accepts a `vscode.Uri` folder argument).
- `package.json`: registered the command, added an entry under `menus.explorer/context` with `when: explorerResourceIsFolder` in the `navigation` group.
- `src/treeview-provider.ts`: extended the Artifacts webview context menu to expose "Commit with Claude" when the right-clicked node is a folder; action routed through the existing `contextAction` postMessage channel.

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
