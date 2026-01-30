---
name: aimax-bridge
description: Adds Claude Bridge API integration to HTML artifacts served by AIMax Viewer. Use when creating HTML artifacts that should communicate with Claude Code — adds floating action buttons for sending prompts to Claude directly from the browser.
user-invocable: true
argument-hint: "[buttons|inline]"
---

# AIMax Bridge

Adds a Claude Bridge panel to HTML artifacts, enabling direct communication with Claude Code from the browser via the AIMax Viewer HTTP server.

## Prerequisites

This skill requires **AIMax Viewer**, a VS Code extension that serves HTML artifacts and provides the `/__claude` HTTP endpoint used by the bridge.

**Install AIMax Viewer:**

1. Download the latest `.vsix` from [GitHub Releases](https://github.com/maxturazzini/aimax-viewer/releases)
2. In VS Code: `Cmd+Shift+P` → "Extensions: Install from VSIX..." → select the downloaded file
3. Reload the window

Or via CLI:
```bash
code --install-extension aimax-viewer-<version>.vsix --force
```

Repository: [github.com/maxturazzini/aimax-viewer](https://github.com/maxturazzini/aimax-viewer)

## When to use this skill

- When creating an HTML artifact that will be served by AIMax Viewer
- When the user wants to add "Send to Claude" functionality to an artifact
- When building interactive tools, dashboards, or reports that need AI assistance inline

## How to use this skill

1. **Choose the template** based on the user's request:
   - `templates/bridge-buttons.md` — Floating action panel with 4 buttons (default)
   - `templates/bridge-inline.md` — Inline widget with prompt input and response area

2. **Load the matching template** and follow its instructions

3. **Insert the snippet** into the HTML artifact, just before `</body>`

4. If the user says `/aimax-bridge` with no argument, use the **bridge-buttons** template (floating panel).

## Claude Bridge API Reference

The AIMax Viewer extension runs an HTTP server on `127.0.0.1:<port>`. The `/__claude` endpoint accepts POST requests:

```
POST /__claude
Content-Type: application/json

{ "prompt": "your prompt here", "mode": "terminal" }
```

### Modes

| Mode | Behavior |
|------|----------|
| `terminal` | Opens interactive Claude session in VS Code terminal (default) |
| `vscode` | Opens Claude Code extension panel for a new conversation |
| `print` | Sends prompt to Claude CLI, returns response as `{ok, response}` |
| `copy` | Echoes prompt back (client handles clipboard) |

### Important notes

- The artifact is served by the same HTTP server, so `/__claude` is a **relative URL** — no need for `http://127.0.0.1:port`, just use `fetch('/__claude', ...)`.
- The `print` mode may take up to 120 seconds to respond. Always show a loading state.
- All responses are JSON with `Access-Control-Allow-Origin: *`.

## Embedded HTML snippet — Floating Action Panel

Insert this snippet before `</body>` in any HTML artifact to add the Claude Bridge panel:

```html
<!-- AIMax Claude Bridge Panel -->
<div id="aimax-bridge" style="position:fixed;bottom:20px;right:20px;z-index:99999;font-family:system-ui,-apple-system,sans-serif;">
  <div id="aimax-bridge-panel" style="display:none;width:340px;background:#1e1e2e;border:1px solid #444;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);padding:16px;margin-bottom:8px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <span style="color:#cdd6f4;font-weight:600;font-size:14px;">Claude Bridge</span>
      <button onclick="document.getElementById('aimax-bridge-panel').style.display='none'" style="background:none;border:none;color:#888;cursor:pointer;font-size:18px;padding:0;line-height:1;">&times;</button>
    </div>
    <textarea id="aimax-bridge-prompt" placeholder="Enter your prompt..." style="width:100%;height:80px;background:#181825;color:#cdd6f4;border:1px solid #555;border-radius:8px;padding:8px;font-size:13px;resize:vertical;box-sizing:border-box;font-family:inherit;"></textarea>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px;">
      <button onclick="aimaxCopy()" style="background:#cba6f7;color:#1e1e2e;border:none;border-radius:6px;padding:8px;cursor:pointer;font-size:12px;font-weight:600;">Copy</button>
      <button onclick="aimaxCopyAndBridge('terminal')" style="background:#89b4fa;color:#1e1e2e;border:none;border-radius:6px;padding:8px;cursor:pointer;font-size:12px;font-weight:600;">Copy &amp; Terminal</button>
      <button onclick="aimaxCopyAndBridge('vscode')" style="background:#a6e3a1;color:#1e1e2e;border:none;border-radius:6px;padding:8px;cursor:pointer;font-size:12px;font-weight:600;">Copy &amp; VS Code</button>
      <button onclick="aimaxBridge('print')" style="background:#f9e2af;color:#1e1e2e;border:none;border-radius:6px;padding:8px;cursor:pointer;font-size:12px;font-weight:600;">Ask Inline</button>
    </div>
    <div id="aimax-bridge-response" style="display:none;margin-top:10px;padding:10px;background:#181825;border-radius:8px;color:#cdd6f4;font-size:13px;max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;"></div>
    <div id="aimax-bridge-status" style="margin-top:6px;font-size:11px;color:#888;text-align:center;"></div>
  </div>
  <button onclick="document.getElementById('aimax-bridge-panel').style.display=document.getElementById('aimax-bridge-panel').style.display==='none'?'block':'none'" style="width:48px;height:48px;border-radius:50%;background:#cba6f7;color:#1e1e2e;border:none;cursor:pointer;font-size:22px;box-shadow:0 4px 16px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;margin-left:auto;">&#10042;</button>
</div>
<script>
async function aimaxBridge(mode) {
  const prompt = document.getElementById('aimax-bridge-prompt').value.trim();
  if (!prompt) return;
  const status = document.getElementById('aimax-bridge-status');
  const respBox = document.getElementById('aimax-bridge-response');
  status.textContent = mode === 'print' ? 'Waiting for Claude...' : 'Sent!';
  respBox.style.display = 'none';
  try {
    const res = await fetch('/__claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, mode })
    });
    const data = await res.json();
    if (mode === 'print' && data.response) {
      respBox.textContent = data.response;
      respBox.style.display = 'block';
      status.textContent = '';
    } else if (data.ok) {
      status.textContent = 'Sent to Claude!';
      setTimeout(() => status.textContent = '', 2000);
    } else {
      status.textContent = 'Error: ' + (data.error || 'Unknown');
    }
  } catch (e) {
    status.textContent = 'Connection error — is AIMax Viewer running?';
  }
}
function aimaxSafeCopy(text) {
  return new Promise(function(resolve, reject) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(resolve).catch(function() {
        aimaxFallbackCopy(text) ? resolve() : reject();
      });
    } else {
      aimaxFallbackCopy(text) ? resolve() : reject();
    }
  });
}
function aimaxFallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}
async function aimaxCopy() {
  var prompt = document.getElementById('aimax-bridge-prompt').value.trim();
  if (!prompt) return;
  var s = document.getElementById('aimax-bridge-status');
  try {
    await aimaxSafeCopy(prompt);
    s.textContent = 'Copied!';
    setTimeout(function() { s.textContent = ''; }, 1500);
  } catch (e) {
    s.textContent = 'Copy failed';
  }
}
async function aimaxCopyAndBridge(mode) {
  var prompt = document.getElementById('aimax-bridge-prompt').value.trim();
  if (!prompt) return;
  try { await aimaxSafeCopy(prompt); } catch (e) { /* continue anyway */ }
  aimaxBridge(mode);
}
</script>
<!-- End AIMax Claude Bridge -->
```

## Common mistakes to avoid

- Using absolute URLs (`http://127.0.0.1:3125/__claude`) instead of relative (`/__claude`) — the port may vary per workspace
- Not showing a loading state for `print` mode — it can take time
- Forgetting that the artifact must be served by AIMax Viewer's HTTP server for the bridge to work (opening the HTML file directly in a browser won't work)
- Making the bridge panel too intrusive — keep it floating and collapsible
