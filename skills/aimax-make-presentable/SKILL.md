---
name: aimax-make-presentable
description: Transform a Markdown or HTML file into an AIMax-presentable slide deck (multiple `<section>` elements + h1/h2 titles + optional speaker notes). Asks the user clarifying questions and writes `<input>-deck.html` next to the input.
user-invocable: true
argument-hint: "[file_path]"
---

# AIMax — Make it presentable

Turn any `.md` or `.html` file into a slide deck compatible with the **AIMax Viewer** presenter (`Cmd+Shift+P` → "Present in Browser" inside the extension).

The presenter contract is minimal:

- HTML file with **at least 2 `<section>` elements** (one per slide)
- `<h1>` (title slide) or `<h2>` (content slides) inside each `<section>`
- Optional `<div class="speaker-notes">…</div>` per section, hidden via `display:none` in CSS
- Optional `class="title-slide"` on the first section, `class="end-slide"` on the last
- Inter font + scroll-snap — see the reference at `Artifacts/aimax-viewer-presentation.html` in the AIMax Viewer repo

## Prerequisites

Requires **AIMax Viewer** to actually open the resulting deck in the presenter. Install from [github.com/maxturazzini/aimax-viewer](https://github.com/maxturazzini/aimax-viewer) (see the aimax-bridge skill for installation steps).

## How to use this skill

`/aimax-make-presentable <file_path>`

The argument can be:
- An absolute path: `/Users/me/notes.md`
- A relative path: `./Artifacts/intro.html`
- A local URL from AIMax: `http://127.0.0.1:3124/Artifacts/intro.html` (the skill derives the workspace path)

If no argument is given, ask the user which file to convert.

## Steps the skill MUST follow

### 1. Resolve and read the input

- Convert any `http://127.0.0.1:<port>/PATH` URL to the workspace path (`<workspace>/PATH`).
- Read the file with `Read`.
- Report what you found: filename, extension, byte size, line count.

### 2. Detect current shape

| Input | Path |
|---|---|
| HTML with `≥ 2 <section>` | **Adapt** path (step 4) |
| HTML with `0–1 <section>` | **Wrap** path (step 5) — use existing `<h1>`/`<h2>` as split points if present |
| Markdown | **Markdown split** path (step 3) |

### 3. Markdown split — ASK the user

Count headings in the markdown:

```
H1 (#):   N occurrences
H2 (##):  M occurrences
H3 (###): K occurrences
```

Then use `AskUserQuestion` with this question:

> **"Found N #, M ##, K ### headings. Split slides on which heading level?"**
>
> Options:
> - **H1 only** — coarsest, fewest slides (one slide per `#`)
> - **H1 + H2** — balanced, recommended for most decks (one slide per `#` or `##`)
> - **H1 + H2 + H3** — finest, most slides
> - **Manual** — let me list the headings and you tell me where to split

If the user picks Manual, list all headings with their level and ask which ones become slide boundaries.

Then split content: each chosen heading starts a new `<section>`. The heading text becomes `<h1>` if it was H1, `<h2>` otherwise. Following content (paragraphs, lists, code blocks, images, blockquotes) becomes the slide body.

Convert markdown to HTML inline with the standard rules:
- `**bold**` → `<strong>`, `*italic*` → `<em>`
- ` ``` ` fenced code blocks → `<pre><code>`, inline `` ` `` → `<code>`
- `- item` / `1. item` → `<ul>` / `<ol>`
- `[text](url)` → `<a href="url">text</a>`
- `![alt](src)` → `<img alt="alt" src="src">`
- `> quote` → `<blockquote>`

If `pandoc` is available (`Bash: command -v pandoc`), feel free to use it for the conversion — but only the body, not the surrounding structure (you assemble the `<section>`s yourself).

### 4. Adapt path (HTML already has sections)

- Add `<h1>` or `<h2>` to any `<section>` missing one (use the first prominent text or ask the user).
- Add `class="title-slide"` to the first `<section>`, `class="end-slide"` to the last (only if not already classed).
- Ensure CSS contains `.speaker-notes { display: none; }` so notes don't leak into slides.
- Preserve all existing styling and content — minimal touch.

### 5. Wrap path (HTML without sections)

- If the document has `<h1>`/`<h2>`, split on those (treat each heading as a slide boundary).
- Otherwise, ask the user how many slides they want and split content evenly, prompting for slide titles.

### 6. ASK the user — final 3 questions (use `AskUserQuestion`)

- **Audience / tone?** Options: technical demo, sales pitch, internal training, conference talk, other.
- **Deck length target?** Options: ~5 slides (lightning), ~10 slides (standard), ~20 slides (deep dive), no preference.
- **Speaker notes?** Options: yes (draft 1–2 sentences per slide), no, only on key slides.

Use the answers to guide grouping/splitting (e.g. for 5 slides, merge similar adjacent headings; for 20, split long sections by `##`).

### 7. Generate the HTML deck

Visual reference: read `Artifacts/aimax-viewer-presentation.html` in the AIMax Viewer repo (or fetch via WebFetch from `https://raw.githubusercontent.com/maxturazzini/aimax-viewer/main/Artifacts/aimax-viewer-presentation.html`). Use that file's `<head>` and `<style>` block as a template — Inter font, blue/sky/yellow palette, scroll-snap-align.

Each slide is one `<section>`:

```html
<section class="title-slide">
  <div class="slide">
    <h1>Deck Title</h1>
    <p class="tagline">Subtitle / one-line abstract</p>
  </div>
  <div class="speaker-notes">Welcome the audience, set expectations.</div>
</section>

<section>
  <div class="slide">
    <h2>Slide title</h2>
    <p>Body copy…</p>
    <ul><li>Bullet</li></ul>
  </div>
  <div class="speaker-notes">Talking points for this slide.</div>
</section>

<section class="end-slide">
  <div class="slide">
    <h2>Thanks</h2>
    <p>Questions? <a href="…">contact</a></p>
  </div>
</section>
```

Mandatory CSS (include in the `<style>` block):

```css
.speaker-notes { display: none; }
section { scroll-snap-align: start; min-height: 100vh; }
```

### 8. Save

Write to `<input_dir>/<input_basename>-deck.html`.

- `notes.md` → `notes-deck.html` in the same folder
- `Artifacts/intro.html` → `Artifacts/intro-deck.html`

If the target file already exists, ask the user to confirm overwrite (use `AskUserQuestion`: Overwrite / Choose different name / Cancel).

### 9. Confirm

Tell the user:

> ✅ Generated `<output_path>` with N slides.
>
> Open it in AIMax Viewer (the "Present in Browser" menu item in the hamburger menu will now be enabled).

If the user is in VS Code with AIMax Viewer installed, also offer to open it directly:
```
vscode://aimax.aimax-viewer/openBrowser?http://127.0.0.1:3124/<relative/path>
```

## Edge cases

- **Mixed input**: an `.md` with embedded HTML — process the markdown headings normally, preserve the HTML blocks as-is in the slide body.
- **Empty file**: refuse politely and ask for content.
- **Single huge section**: ask the user if they want to split it (you may suggest split points based on paragraph density).
- **No headings at all**: ask the user to provide titles or how many slides they want.
- **Permission denied on write**: report the error and propose an alternate path (e.g. `Artifacts/<basename>-deck.html`).

## Anti-goals

- Do NOT modify the original input file.
- Do NOT pull external CSS frameworks (Tailwind, Bootstrap) — keep the deck self-contained.
- Do NOT generate JavaScript — slides are static HTML.
- Do NOT invent content beyond what's in the input + 1–2 sentence speaker notes when asked.
