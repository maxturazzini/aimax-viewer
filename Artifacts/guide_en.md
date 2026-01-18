---
title: AIMax Viewer - Complete Guide
author: Max Turazzini
version: 0.1.17
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

- **Sidebar** - Tree view with all HTML/MD files
- **Dropdown** - Quick selector in toolbar (if layout="top")
- **Status Bar** - Home icon to return to main page

### Toolbar

| Icon | Function |
|------|----------|
| Logo | Return to Home |
| `←` `→` | Navigation history |
| `↻` | Reload page |
| `(i)` | File info + YAML metadata |
| `>` | Open new terminal |
| `*` | New Claude conversation |
| `☰` | Menu (Export PDF, etc.) |

### Export PDF

From hamburger menu `☰` → "Export to PDF". The file is automatically downloaded with the same name as the artifact.

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

### PDF doesn't generate

1. Check internet connection (loads CDN)
2. Try with a simpler file
3. Fallback: use "Open in External Browser" + Print

---

## Roadmap

- [ ] Code syntax highlighting support
- [ ] Light/dark themes
- [ ] Batch PDF export
- [ ] MCP server integration

---

*AIMax Viewer - v0.1.17*
*AI, MAX*
