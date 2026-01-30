# Bridge Inline Template

Inline widget for asking Claude and showing the response directly in the artifact.

## When to use

Use when the artifact needs an embedded AI assistant — the user types a question, clicks "Ask Claude", and sees the response inline without leaving the page. Best for:
- Interactive reports where the user wants to drill down
- Learning tools where the user asks follow-up questions
- Data dashboards where the user wants AI interpretation

## Instructions

Insert this widget wherever you want the inline Claude assistant to appear in the artifact:

```html
<!-- AIMax Claude Bridge — Inline Assistant -->
<div style="background:#1e1e2e;border:1px solid #444;border-radius:12px;padding:16px;margin:16px 0;font-family:system-ui,-apple-system,sans-serif;">
  <div style="display:flex;gap:8px;margin-bottom:10px;">
    <input id="aimax-inline-prompt" type="text" placeholder="Ask Claude..."
      style="flex:1;background:#181825;color:#cdd6f4;border:1px solid #555;border-radius:8px;padding:10px;font-size:14px;"
      onkeydown="if(event.key==='Enter')aimaxInline()">
    <button onclick="aimaxInline()" id="aimax-inline-btn"
      style="background:#89b4fa;color:#1e1e2e;border:none;border-radius:8px;padding:10px 20px;cursor:pointer;font-weight:600;font-size:14px;white-space:nowrap;">
      Ask Claude
    </button>
  </div>
  <div id="aimax-inline-response" style="display:none;padding:12px;background:#181825;border-radius:8px;color:#cdd6f4;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:400px;overflow-y:auto;"></div>
</div>
<script>
async function aimaxInline() {
  const input = document.getElementById('aimax-inline-prompt');
  const btn = document.getElementById('aimax-inline-btn');
  const respBox = document.getElementById('aimax-inline-response');
  const prompt = input.value.trim();
  if (!prompt) return;
  btn.textContent = 'Thinking...';
  btn.disabled = true;
  respBox.style.display = 'block';
  respBox.textContent = 'Waiting for Claude...';
  try {
    const res = await fetch('/__claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, mode: 'print' })
    });
    const data = await res.json();
    if (data.ok && data.response) {
      respBox.textContent = data.response;
    } else {
      respBox.textContent = 'Error: ' + (data.error || 'No response');
    }
  } catch (e) {
    respBox.textContent = 'Connection error — is AIMax Viewer running?';
  }
  btn.textContent = 'Ask Claude';
  btn.disabled = false;
}
</script>
<!-- End AIMax Claude Bridge Inline -->
```

## Customization

- **Pre-fill prompt with context**: Set `input.value` based on the artifact's data
- **Multiple instances**: If adding more than one, use unique IDs (e.g., `aimax-inline-prompt-2`)
- **Wider layout**: Remove max-width or adjust as needed for the artifact's design
- **Custom system prompt**: Prepend context to the user's prompt in the `aimaxInline()` function:
  ```js
  const fullPrompt = `Context: this is a sales dashboard showing Q4 data.\n\nUser question: ${prompt}`;
  ```

## Style guidelines

- **Theme**: Dark (Catppuccin Mocha — `#1e1e2e` bg, `#181825` input bg, `#cdd6f4` text)
- **Button**: Blue (`#89b4fa`), changes to "Thinking..." while loading
- **Response area**: Same dark bg, scrollable, max-height 400px
- **Layout**: Full-width block, integrates into page flow (not floating)
