# AIMax Viewer

VS Code extension that provides automatic artifact viewing at startup and an internal browser for localhost development.

![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-1.80+-blue)
![Version](https://img.shields.io/badge/version-0.1.16-green)
![License](https://img.shields.io/badge/license-MIT-brightgreen)

## Features

### 1. Auto-Open at Startup

Automatically displays your home page when VS Code opens. Configurable via `aimaxViewer.startup.mode`.

### 2. Two Panel Types: Home vs Browser

The extension provides two distinct ways to view content, each with different capabilities:

| Feature | Home Panel | Browser Panel |
|---------|------------|---------------|
| **External links** | Opens in system browser | Blocked by iframe sandbox |
| **Localhost links** | Opens in Browser Panel | Navigates within iframe |
| **vscode:// links** | Fully supported | Fully supported |
| **Toolbar** | Fixed (title only) | Artifacts dropdown selector |
| **Content loading** | Direct file read | Via HTTP server (iframe) |
| **Use case** | Dashboard with external links | Browsing multiple artifacts |

**Technical explanation:**
- **Home Panel** reads the HTML file directly and injects it into a VS Code webview. External links (`https://...`) are intercepted and opened in your system browser.
- **Browser Panel** loads content via an iframe with `sandbox` restrictions. The iframe cannot navigate to external origins for security reasons.

### 3. Artifacts Browser

Browse all HTML and Markdown files in your configured folders with a dropdown selector or sidebar TreeView. Files are sorted by modification date (newest first).

- 📄 HTML files - displayed as-is
- 📝 Markdown files - automatically converted to styled HTML

### 4. Sidebar TreeView (New in v0.1.16)

A dedicated sidebar panel shows all your artifacts organized by folder. Quick access buttons in the panel header for Terminal and Claude Code.

### 5. Multi-Folder Support (New in v0.1.16)

Configure multiple artifact folders via `aimaxViewer.browser.folders`. Each folder appears as a separate group in the dropdown and TreeView.

```json
{
  "aimaxViewer.browser.folders": [
    { "label": "Artifacts", "path": "projects/Artifacts" },
    { "label": "Reports", "path": "reports" }
  ]
}
```

### 6. Markdown Rendering

**New in v0.1.9** - Full markdown support with server-side rendering.

Markdown files (`.md`) are automatically converted to HTML when served. Supported features:
- Headings (H1-H3)
- Bold, italic, strikethrough
- Tables with alignment
- Bullet and numbered lists
- Links and images
- Horizontal rules
- Code blocks (inline)

Just create a `.md` file in `projects/Artifacts/` and it will appear in the dropdown with the 📝 icon.

### 7. Status Bar Quick Access

A `$(home)` icon in the status bar provides one-click access to your Home page.

### 8. Multi-Tab Support

Each artifact opens in a new tab by default. Configure with `aimaxViewer.panels.multiTab`.

### 9. Content Security Policy (CSP) for CDN Resources

**New in v0.1.3** - Support for external CDN resources (Google Fonts, Chart.js, etc.)

By default, the viewer uses **permissive mode** allowing common CDN domains:
- `fonts.googleapis.com` / `fonts.gstatic.com` - Google Fonts
- `cdn.jsdelivr.net` - Chart.js, Vue, React
- `cdnjs.cloudflare.com` - Cloudflare CDN
- `unpkg.com` - npm packages

**CSP Modes:**

| Mode | Use Case | Allowed Resources |
|------|----------|-------------------|
| `strict` | Maximum security | Localhost only |
| `permissive` | Default - balanced | Localhost + common CDNs |
| `custom` | Specific needs | Localhost + your custom domains |

**Example: Using Google Fonts in artifacts**

```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
```

This now works out-of-the-box in permissive mode!

**How to configure CSP settings:**

1. **Via VS Code Settings UI** (recommended):
   - `Cmd+,` (macOS) or `Ctrl+,` (Windows/Linux)
   - Search for "aimax csp"
   - Set **CSP Mode** to `strict`, `permissive`, or `custom`
   - If using `custom`, edit **CSP Allowed Domains** list

2. **Via settings.json**:
   ```json
   {
     "aimaxViewer.csp.mode": "custom",
     "aimaxViewer.csp.allowedDomains": [
       "fonts.googleapis.com",
       "fonts.gstatic.com",
       "your-cdn.example.com"
     ]
   }
   ```

**Note**: Settings are in VS Code's user/workspace settings, not in the extension files.

### 10. vscode:// URI Handler

Deep links for use in HTML artifacts or external tools:

```
vscode://aimax.aimax-viewer/openBrowser?http://localhost:8080
vscode://aimax.aimax-viewer/openHome
```

## Installation

### From VSIX

1. Build and package:
   ```bash
   npm run compile
   npx vsce package --allow-missing-repository
   ```

2. Install in VS Code:
   - `Cmd+Shift+P` → "Extensions: Install from VSIX..."
   - Select the `.vsix` file

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `aimaxViewer.startup.mode` | `"home"` | What to open at startup: `home`, `browser`, or `none` |
| `aimaxViewer.startup.homePage` | `"projects/Artifacts/index.html"` | Path to home page file |
| `aimaxViewer.server.port` | `3124` | HTTP server port |
| `aimaxViewer.panels.multiTab` | `true` | Open each artifact in new tab |
| `aimaxViewer.csp.mode` | `"permissive"` | CSP mode: `strict`, `permissive`, `custom` |
| `aimaxViewer.csp.allowedDomains` | `["fonts.googleapis.com", ...]` | CDN domains for custom mode |

## Commands

| Command | Title |
|---------|-------|
| `aimaxViewer.openHome` | AIMax Viewer: Open Home Page |
| `aimaxViewer.openBrowser` | AIMax Viewer: Open URL in Browser |
| `aimaxViewer.openArtifactsBrowser` | AIMax Viewer: Open Artifacts Browser |
| `aimaxViewer.openCurrentFile` | AIMax Viewer: Open Current HTML File |
| `aimaxViewer.openTerminal` | AIMax Viewer: Open New Terminal |
| `aimaxViewer.openClaudeCode` | AIMax Viewer: Open Claude Code |

## Usage with AI Agents (Claude Code, Copilot, etc.)

AIMax Viewer exposes commands via `vscode://` URI protocol, enabling any AI agent running in VS Code to display content directly in the editor.

### Available URI Commands

| Command | URI Pattern | Description |
|---------|-------------|-------------|
| **Open URL** | `/openBrowser?<url>` | Open any URL in Browser panel |
| **Open Home** | `/openHome` | Open the configured home page |
| **Open Current File** | `/openCurrentFile` | Open active editor file (HTML/MD) |
| **Open Terminal** | `/openTerminal` | Open new VS Code terminal |

### Practical Examples

**1. Show an HTML artifact:**
```bash
open "vscode://aimax.aimax-viewer/openBrowser?http://127.0.0.1:3124/projects/Artifacts/2026-01-10_report.html"
```

**2. Show a Markdown file (auto-converted to HTML):**
```bash
open "vscode://aimax.aimax-viewer/openBrowser?http://127.0.0.1:3124/projects/Artifacts/analysis.md"
```

**3. Show a local dev server:**
```bash
open "vscode://aimax.aimax-viewer/openBrowser?http://localhost:5173"
```

### Configuration for Claude Code

Add to your project's `CLAUDE.md`:

```markdown
## Artifact Viewer

When creating HTML or MD files in `projects/Artifacts/`, display them with:

\`\`\`bash
open "vscode://aimax.aimax-viewer/openBrowser?http://127.0.0.1:3124/<file-path>"
\`\`\`

**Naming convention**: `YYYY-MM-DD_descriptive-slug.html` or `.md`

**NEVER use** external browser (`open file.html`) - always use vscode:// protocol.
```

### Why use AIMax Viewer instead of external browser?

- Opens inside VS Code (keeps focus on development)
- Includes toolbar with reload, back/forward navigation
- Artifacts dropdown to quickly switch between files
- Markdown files rendered as HTML automatically
- Quick access buttons for terminal and Claude Code

## Example index.html

A generic example is provided in `example/index.html`. Copy it to your `projects/Artifacts/` folder to get started.

## Toolbar Buttons

| Button | Function |
|--------|----------|
| 🔵 (favicon) | Go to Home |
| `←` `→` | Navigate back/forward in history |
| `(i)` | Show current URL |
| Dropdown | Select artifact |
| `>_` | Open terminal |
| `*` | New Claude Code conversation |
| `☰` | Menu (reload, copy URL, open external) |

## Requirements

- VS Code 1.80.0+
- Workspace with `projects/Artifacts/` folder

## License

MIT License - Copyright (c) 2024-2025 Max Turazzini

---

*AI, MAX*
