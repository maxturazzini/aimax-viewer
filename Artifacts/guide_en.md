---
title: AIMax Viewer - Complete Guide
author: Max Turazzini
version: 0.1.29
tags: [vscode, artifacts, ai, workflow]
---

# AIMax Viewer - Complete Guide

## Why does AIMax Viewer exist?

**The problem:** When working with AI agents like Claude Code in VS Code, generated artifacts (HTML reports, analyses, dashboards) end up in a folder. To view them you must open them in an external browser, losing your work context.

**The solution:** AIMax Viewer brings everything inside VS Code. An integrated viewer that displays artifacts without leaving the editor.

---

## The Outcome Oriented Approach

AIMax Viewer was built to support a specific workflow: the **Outcome Oriented Approach** (OOA).

### What is OOA?

Instead of telling the AI "write code to do X", you define the desired **outcome**:

> "I want an HTML report showing sales by category with interactive charts"

The AI generates the complete artifact. You view it, evaluate, iterate.

### The OOA cycle with AIMax Viewer

1. **Define the outcome** - Describe what you want to achieve
2. **AI generates the artifact** - HTML/MD file in `Artifacts/`
3. **View immediately** - AIMax Viewer shows it in VS Code
4. **Evaluate and iterate** - Feedback to AI for refinement
5. **Export if needed** - PDF, sharing, archiving

### Advantages over external browser

| External Browser | AIMax Viewer |
|------------------|--------------|
| Context switch | Stay in VS Code |
| Lose your flow | Continuous workflow |
| Copy-paste URL | Click from tree |
| No AI integration | Claude Code button |

---

## Project Philosophy

### 1. Zero Friction

No mandatory configuration. Create an `Artifacts/` folder, put an `index.html` in it, done. The extension starts automatically.

### 2. AI-First

Designed for those who work with AI agents. Every feature answers the question: "How can I make the human-AI cycle smoother?"

### 3. Markdown Native

`.md` files are first-class citizens. They are automatically rendered to HTML with a clean, professional style.

### 4. Extensible

URI handler (`vscode://`) for automation. The AI can open artifacts programmatically.

---

## How to Use AIMax Viewer

### Initial Setup

1. Install the extension
2. Create the `Artifacts/` folder in your workspace
3. Create an `index.html` (or copy the example one)
4. Reload VS Code

### Navigation

- **Sidebar** - Tree view with all HTML/MD files, with built-in search bar
- **Dropdown** - Quick selector in toolbar (if layout="top")
- **Status Bar** - Home icon to return to main page
- **Recents Panel** - Tracks the last 24 opened HTML/MD files per workspace
- **Context Menu** - Right-click files/folders in the sidebar for "Open in Viewer", "Open in Editor", "Open in Browser", "Reveal in Finder"

### Toolbar

| Icon | Function |
|------|----------|
| Logo | Return to Home |
| `←` `→` | Navigation history |
| `↻` | Reload page |
| `(i)` | File info + YAML metadata |
| `>` | Open new terminal |
| `*` (sparkle) | New Claude conversation |
| `✻` | Claude Bridge dropdown (Copy / Terminal / VS Code / Inline) |
| `☰` | Menu (advanced actions) |

---

## Advanced Configuration

### Server Port

```json
{
  "aimaxViewer.server.port": 8080
}
```

- **Default (empty or 3124)**: Port automatically calculated per workspace (avoids conflicts between VS Code windows)
- **Custom (any value other than 3124)**: Fixed port, useful for firewall or bookmarks

### Multi-Folder

```json
{
  "aimaxViewer.browser.folders": [
    { "label": "Artifacts", "path": "Artifacts" },
    { "label": "Reports", "path": "reports" }
  ]
}
```

### Layout

```json
{
  "aimaxViewer.browser.layout": "sidebar"
}
```

- **sidebar** - Use lateral tree view (recommended)
- **top** - Dropdown in toolbar

### Startup

```json
{
  "aimaxViewer.startup.mode": "browser",
  "aimaxViewer.startup.homePage": "Artifacts/index.html"
}
```

- **home** - Opens home page directly
- **browser** - Opens in browser panel with toolbar
- **none** - Opens nothing at startup

---

## YAML Frontmatter

Markdown files can have YAML metadata at the top between `---` markers:

```yaml
---
title: Q1 Sales Report
author: Max Turazzini
date: 2026-01-18
tags: [sales, analysis, Q1]
---
```

Metadata appears in the `(i)` popup in the toolbar.

---

## Integration with Claude Code

### CLAUDE.md Configuration

Add this to your project's **CLAUDE.md** file:

```markdown
## Artifact Viewer

When creating HTML or MD files in Artifacts/, display them with:

open "vscode://aimax.aimax-viewer/openBrowser?http://127.0.0.1:3124/Artifacts/FILENAME"

Naming convention: YYYY-MM-DD_descriptive-slug.html or .md

IMPORTANT: Never use external browser - always use vscode:// protocol.
```

### Available URIs

| Action | URI |
|--------|-----|
| Open URL | `vscode://aimax.aimax-viewer/openBrowser?<url>` |
| Open Home | `vscode://aimax.aimax-viewer/openHome` |
| Open current file | `vscode://aimax.aimax-viewer/openCurrentFile` |
| Open terminal | `vscode://aimax.aimax-viewer/openTerminal` |

---

## Best Practices

### Naming Convention

```
YYYY-MM-DD_short-description.html
YYYY-MM-DD_short-description.md
```

Example: **2026-01-18_q1-sales-analysis.html**

### Artifacts Structure

```
Artifacts/
├── index.html          # Dashboard/home page
├── 2026-01-18_report.html
├── 2026-01-17_analysis.md
└── templates/          # Reusable templates
```

### index.html as Dashboard

The home page should be a navigation hub:

- Links to recent artifacts
- Quick access to resources
- Project overview

---

## Troubleshooting

### Viewer doesn't open

1. Verify that `Artifacts/index.html` exists
2. Check Output → "AIMax Viewer" for errors
3. Reload VS Code window

### Port already in use

If you have multiple VS Code windows, each workspace uses a different port (calculated from hash). If you want a fixed port, set it explicitly.

---

## Claude Bridge API

AIMax Viewer includes a built-in HTTP endpoint that allows HTML artifacts to communicate directly with Claude Code. This enables powerful workflows where your artifacts can send prompts to Claude and even receive responses — all without leaving VS Code.

### Endpoint

```
POST http://127.0.0.1:<port>/__claude
Content-Type: application/json
```

### Modes

| Mode | Description | Use case |
|------|-------------|----------|
| `vscode` | Opens the Claude Code extension panel | Start a new conversation in the GUI |
| `terminal` | Opens an interactive Claude session in the terminal | Send a prompt to Claude interactively |
| `print` | Sends the prompt and returns Claude's response as JSON | Get AI responses directly inside your artifact |
| `copy` | Returns the prompt text (client handles clipboard) | Copy prompt for manual use |

### Usage from HTML

```html
<button onclick="askClaude()">Send to Claude</button>

<script>
async function askClaude() {
  const response = await fetch('/__claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Explain this code',
      mode: 'terminal'  // or: vscode, print, copy
    })
  });
  const result = await response.json();
  console.log(result);
}

// "print" mode returns Claude's response inline:
async function getAnswer() {
  const res = await fetch('/__claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'What is 2+2?',
      mode: 'print'
    })
  });
  const data = await res.json();
  // data.response contains Claude's answer
  document.getElementById('answer').textContent = data.response;
}
</script>
```

### Plain text fallback

For simplicity, you can also send a plain text body (no JSON). The prompt will default to `terminal` mode:

```bash
curl -X POST http://127.0.0.1:3124/__claude -d "hello world"
```

---

## Presenter Mode

AIMax Viewer includes a built-in **Presenter Mode** that turns any HTML slide deck into a full presentation experience.

### Creating a Slide Deck

Structure your HTML file with `<section>` elements — one per slide. Add optional speaker notes:

```html
<html>
<head>
    <style>
        html { scroll-snap-type: y mandatory; scroll-behavior: smooth; }
        section { scroll-snap-align: start; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .speaker-notes { display: none; }
    </style>
</head>
<body>
    <section>
        <h1>Slide Title</h1>
        <p>Slide content here</p>
        <div class="speaker-notes">These notes are visible only in Presenter Mode.</div>
    </section>
    <section>
        <h2>Second Slide</h2>
        <div class="speaker-notes">Notes for this slide.</div>
    </section>
</body>
</html>
```

### Launching Presenter Mode

There are several ways to start a presentation:

| Method | How |
|--------|-----|
| Context Menu (Explorer) | Right-click an HTML file → "Present with AIMax Viewer" |
| Browser Hamburger Menu | Click `☰` → "Present in Browser" |
| Sidebar Context Menu | Right-click an artifact → "Present" |

### Presenter View Features

The presenter window gives you:

- **Current + next slide** preview side by side
- **Speaker notes** panel with light/dark theme toggle
- **Slide carousel** at the bottom for quick navigation
- **Timer & clock** for pacing your talk
- **Keyboard shortcuts**: `←` `→` navigate, `Home`/`End` first/last, `F` fullscreen audience, `T` toggle timer
- **Resizable panels** — drag the handles between current slide, next slide, and notes

### How It Works

Presenter Mode opens two windows:
1. **Audience window** — shows the slide deck (project on screen)
2. **Presenter window** — shows current/next slide, notes, carousel, timer

The two windows stay in sync via `BroadcastChannel`. Navigate from the presenter and the audience window follows.

---

## Roadmap

- [ ] Light/dark themes
- [ ] Batch PDF export
- [ ] MCP server integration

---

*AIMax Viewer - v0.1.29*
*AI, MAX*
