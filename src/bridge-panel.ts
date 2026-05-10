// Claude Bridge floating panel for injection into proxied HTML pages.
// Mirrors the skill template (skills/aimax-bridge/SKILL.md) but uses a
// distinct id prefix (aimax-bridge-px-) so it cannot collide with bridge
// snippets the user may have inlined in their own artifacts via the skill.
//
// Used by the reverse proxy in src/extension.ts when liveInspect.injectBridge
// is enabled. Injected before </body> alongside the annotation client.

export const BRIDGE_PANEL_HTML_PROXY = `
<!-- AIMax Claude Bridge Panel (proxy-injected) -->
<div id="aimax-bridge-px" style="position:fixed;bottom:20px;right:20px;z-index:2147483647;font-family:system-ui,-apple-system,sans-serif;">
  <div id="aimax-bridge-px-panel" style="display:none;width:340px;background:#1e1e2e;border:1px solid #444;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);padding:16px;margin-bottom:8px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <span style="color:#cdd6f4;font-weight:600;font-size:14px;">Claude Bridge</span>
      <button onclick="document.getElementById('aimax-bridge-px-panel').style.display='none'" style="background:none;border:none;color:#888;cursor:pointer;font-size:18px;padding:0;line-height:1;">&times;</button>
    </div>
    <textarea id="aimax-bridge-px-prompt" placeholder="Ask Claude about this page..." style="width:100%;height:80px;background:#181825;color:#cdd6f4;border:1px solid #555;border-radius:8px;padding:8px;font-size:13px;resize:vertical;box-sizing:border-box;font-family:inherit;"></textarea>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px;">
      <button onclick="aimaxBridgePxCopy()" style="background:#cba6f7;color:#1e1e2e;border:none;border-radius:6px;padding:8px;cursor:pointer;font-size:12px;font-weight:600;">Copy</button>
      <button onclick="aimaxBridgePxSend('terminal',true)" style="background:#89b4fa;color:#1e1e2e;border:none;border-radius:6px;padding:8px;cursor:pointer;font-size:12px;font-weight:600;">Copy &amp; Terminal</button>
      <button onclick="aimaxBridgePxSend('vscode',true)" style="background:#a6e3a1;color:#1e1e2e;border:none;border-radius:6px;padding:8px;cursor:pointer;font-size:12px;font-weight:600;">Copy &amp; VS Code</button>
      <button onclick="aimaxBridgePxSend('print',false)" style="background:#f9e2af;color:#1e1e2e;border:none;border-radius:6px;padding:8px;cursor:pointer;font-size:12px;font-weight:600;">Ask Inline</button>
    </div>
    <div id="aimax-bridge-px-response" style="display:none;margin-top:10px;padding:10px;background:#181825;border-radius:8px;color:#cdd6f4;font-size:13px;max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;"></div>
    <div id="aimax-bridge-px-status" style="margin-top:6px;font-size:11px;color:#888;text-align:center;"></div>
  </div>
  <button onclick="document.getElementById('aimax-bridge-px-panel').style.display=document.getElementById('aimax-bridge-px-panel').style.display==='none'?'block':'none'" title="Claude Bridge" style="width:48px;height:48px;border-radius:50%;background:#3b82f6;color:#fff;border:none;cursor:pointer;font-size:22px;box-shadow:0 4px 16px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;margin-left:auto;">&#10042;</button>
</div>
<script data-aimax-bridge-injected="1">
(function(){
  if (window.__aimaxBridgePxLoaded) return;
  window.__aimaxBridgePxLoaded = true;
  function $(id){ return document.getElementById(id); }
  function safeCopy(text){
    return new Promise(function(resolve, reject){
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(resolve).catch(function(){
          fallbackCopy(text) ? resolve() : reject();
        });
      } else {
        fallbackCopy(text) ? resolve() : reject();
      }
    });
  }
  function fallbackCopy(text){
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  window.aimaxBridgePxCopy = async function(){
    var p = $('aimax-bridge-px-prompt').value.trim();
    if (!p) return;
    var s = $('aimax-bridge-px-status');
    try {
      await safeCopy(p);
      s.textContent = 'Copied!';
      setTimeout(function(){ s.textContent = ''; }, 1500);
    } catch (e) {
      s.textContent = 'Copy failed';
    }
  };
  window.aimaxBridgePxSend = async function(mode, alsoCopy){
    var p = $('aimax-bridge-px-prompt').value.trim();
    if (!p) return;
    var s = $('aimax-bridge-px-status');
    var rb = $('aimax-bridge-px-response');
    if (alsoCopy) { try { await safeCopy(p); } catch(e){} }
    s.textContent = mode === 'print' ? 'Waiting for Claude...' : 'Sent!';
    rb.style.display = 'none';
    var fullPrompt = 'Context: viewing ' + window.location.pathname + '\\n\\n' + p;
    try {
      // Bridge is served by AIMax proxy: /__claude is rooted at the AIMax server,
      // but with <base href="/__proxy__/PORT/"> the relative '/__claude' resolves
      // to the AIMax root since it starts with '/'. Use absolute path for safety.
      var res = await fetch('/__claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: fullPrompt, mode: mode })
      });
      var data = await res.json();
      if (mode === 'print' && data.response) {
        rb.textContent = data.response;
        rb.style.display = 'block';
        s.textContent = '';
      } else if (data.ok) {
        s.textContent = 'Sent to Claude!';
        setTimeout(function(){ s.textContent = ''; }, 2000);
      } else {
        s.textContent = 'Error: ' + (data.error || 'Unknown');
      }
    } catch (e) {
      s.textContent = 'Connection error - is AIMax Viewer running?';
    }
  };
})();
</script>
<!-- End AIMax Claude Bridge -->
`;

export function injectBridgePanel(html: string): string {
    if (html.includes('data-aimax-bridge-injected')) return html;
    if (/<\/body>/i.test(html)) {
        return html.replace(/<\/body>/i, BRIDGE_PANEL_HTML_PROXY + '</body>');
    }
    return html + BRIDGE_PANEL_HTML_PROXY;
}
