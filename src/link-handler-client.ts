// Self-contained client script injected into every served HTML/MD response.
// Handles <a> clicks AND window.open() calls inside the iframe served by the
// AIMax HTTP server. VS Code's webview silently drops new-window navigations
// (window.open, target="_blank") and custom-protocol links (vscode://,
// obsidian://, mailto:, tel:), so without this script those links are dead.
//
// Routing (works on the resolved absolute URL, not the raw attribute):
//   - vscode:/obsidian:/mailto:/tel:                       -> 'openExternal'
//   - http(s) same-origin, plain click                     -> NOT intercepted
//     (iframe navigates in place — also covers target="_blank" by default,
//      because the user UX is "show the next view here, not in a new pane")
//   - http(s) same-origin with Cmd/Ctrl/Shift/middle-click -> 'openInBrowser'
//     (standard browser "open in new tab" convention spawns a new AIMax pane)
//   - http(s) cross-origin to localhost:PORT where we are
//     in /__proxy__/PORT/                                  -> rewrite to proxy
//     path, iframe navigates same-origin (keeps you inside the proxied app)
//   - http(s) to any other localhost/127.0.0.1/::1         -> 'openInBrowser'
//   - other http(s)                                        -> 'openExternal'
//   - href "#..." or empty                                 -> NOT intercepted
//
// window.open(url, ...) is shimmed and treated as in-place navigation, so
// script-driven popups (e.g. quotes.html's window.open('detail.html')) land
// in the current iframe instead of getting silently dropped by VS Code.
//
// Bubble-phase listener so annotation mode (capture phase) can suppress link
// clicks. No-op when window.parent === window (Home Panel has its own handler).

export const LINK_HANDLER_CLIENT_JS = `
(function() {
    if (window.__aimaxLinkHandlerLoaded) return;
    window.__aimaxLinkHandlerLoaded = true;
    var LOG = '[aimax-link]';
    try { console.log(LOG, 'loaded at', location.href); } catch (e) {}
    if (window.parent === window) {
        try { console.log(LOG, 'top-level frame, exit (Home Panel)'); } catch (e) {}
        return;
    }

    function isLocalHost(h) {
        if (!h) return false;
        h = h.toLowerCase();
        return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
    }

    function portOf(u) {
        if (u.port) return u.port;
        return u.protocol === 'https:' ? '443' : '80';
    }

    function post(cmd, url) {
        try { window.parent.postMessage({ command: cmd, url: url }, '*'); } catch (err) {}
    }

    // wantsNewPane = true when the user explicitly asked for a new tab
    // (Cmd/Ctrl-click, middle-click, target="_blank" on script-driven open).
    // For same-origin links, default click navigates in place; modifier
    // upgrades to a new AIMax pane — the standard browser convention.
    function route(absoluteUrl, wantsNewPane) {
        var u = null;
        try { u = new URL(absoluteUrl, location.href); } catch (err) { return false; }
        if (!u) return false;
        try { console.log(LOG, 'route', { url: u.href, wantsNewPane: wantsNewPane, sameOrigin: u.origin === location.origin, pageOrigin: location.origin }); } catch (err) {}

        var proto = u.protocol;

        if (proto === 'vscode:' || proto === 'obsidian:' || proto === 'mailto:' || proto === 'tel:') {
            post('openExternal', u.href);
            return true;
        }

        if (proto !== 'http:' && proto !== 'https:') return false;

        var sameOrigin = (u.origin === location.origin);

        if (sameOrigin && !wantsNewPane) return false; // iframe navigates naturally

        if (sameOrigin && wantsNewPane) {
            // Cmd/Ctrl-click or middle-click on a same-origin link → new pane.
            post('openInBrowser', u.href);
            return true;
        }

        if (isLocalHost(u.hostname)) {
            var proxyMatch = location.pathname.match(/^\\/__proxy__\\/(\\d+)\\//);
            var proxiedPort = proxyMatch ? proxyMatch[1] : null;
            var linkPort = portOf(u);

            if (proxiedPort && linkPort === proxiedPort && !wantsNewPane) {
                // Same proxied app, link uses absolute URL with the upstream
                // host. Rewrite to proxy path so iframe stays same-origin and
                // the AIMax proxy continues to inject the client scripts.
                location.href = '/__proxy__/' + proxiedPort + u.pathname + u.search + u.hash;
                return true;
            }
            post('openInBrowser', u.href);
            return true;
        }

        post('openExternal', u.href);
        return true;
    }

    function onLinkClick(e) {
        if (e.defaultPrevented) {
            try { console.log(LOG, 'click ignored: defaultPrevented'); } catch (err) {}
            return;
        }
        if (e.button !== 0 && e.button !== 1) return;
        var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!a) return;
        var rawHref = a.getAttribute('href');
        try { console.log(LOG, 'click on <a>', { rawHref: rawHref, resolved: a.href, target: a.getAttribute('target') }); } catch (err) {}
        if (!rawHref) return;
        if (rawHref.charAt(0) === '#') return;
        var abs = a.href;
        if (!abs) return;
        // target="_blank" alone is treated as in-place (per user UX). Only
        // explicit modifier keys / middle-click upgrade to a new AIMax pane,
        // matching the standard browser "open in new tab" convention.
        var wantsNewPane = e.button === 1 || e.metaKey || e.ctrlKey || e.shiftKey;
        if (route(abs, wantsNewPane)) {
            e.preventDefault();
        }
    }
    document.addEventListener('click', onLinkClick, false);
    // Middle-click fires 'auxclick', not 'click', in modern browsers.
    document.addEventListener('auxclick', onLinkClick, false);

    // Shim window.open: VS Code webview silently drops new-window navigations,
    // including those triggered by target="_blank" on form submits or by
    // script. Forward to the same router so they reach the user.
    try {
        var origOpen = window.open;
        window.open = function(url, name, features) {
            if (typeof url === 'string' && url) {
                // Treat script-driven window.open as in-place navigation: VS
                // Code would otherwise drop the popup silently, and the user
                // intent for embedded apps is "show the next view here".
                if (route(url, false)) return null;
            }
            return origOpen ? origOpen.call(window, url, name, features) : null;
        };
    } catch (err) {}
})();
`;

export function injectLinkHandler(html: string): string {
    const tag = `<script data-aimax-injected="link-handler">${LINK_HANDLER_CLIENT_JS}</script>`;
    if (/<\/body>/i.test(html)) {
        return html.replace(/<\/body>/i, tag + '</body>');
    }
    return html + tag;
}
