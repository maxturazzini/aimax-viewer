# Bridge Buttons Template

Floating action panel with 4 buttons for Claude Bridge integration.

## When to use

Default template. Use when the artifact needs a general-purpose "send to Claude" capability. The panel floats in the bottom-right corner and is collapsible.

## Instructions

1. Copy the **Embedded HTML snippet** from the parent `SKILL.md` and insert it just before `</body>` in the artifact
2. If the artifact already has a specific prompt context (e.g., a report, analysis, or code), pre-fill the textarea by adding this script after the bridge snippet:

```html
<script>
// Pre-fill with context-aware prompt
document.getElementById('aimax-bridge-prompt').value =
  'Based on the data shown in this report, suggest improvements for...';
</script>
```

3. Optionally customize button labels to match the artifact's domain (e.g., "Analyze Data" instead of "Ask Inline")

## Style guidelines

- **Position**: Fixed, bottom-right, z-index 99999
- **Theme**: Dark (Catppuccin Mocha palette — `#1e1e2e` background, `#cdd6f4` text)
- **Toggle button**: Circular, 48px, purple (`#cba6f7`) with sparkle icon
- **Panel width**: 340px, rounded corners (12px)
- **Buttons**: 2x2 grid, color-coded by function:
  - Copy: Purple (`#cba6f7`)
  - Copy & Terminal: Blue (`#89b4fa`)
  - Copy & VS Code: Green (`#a6e3a1`)
  - Ask Inline: Yellow (`#f9e2af`)
