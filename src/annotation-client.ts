// Self-contained client script injected into every served HTML/MD response.
// Stays inert until it receives { type: 'annot:toggle', on: true } from window
// (parent or self). Handles hover-highlight, click-to-comment, and reports each
// annotation back via postMessage for the parent toolbar to collect into a prompt.

export const ANNOTATION_CLIENT_JS = `
(function() {
    if (window.__aimaxAnnotationLoaded) return;
    window.__aimaxAnnotationLoaded = true;

    var active = false;
    var hoverTarget = null;
    var pinnedTarget = null;
    var counter = 0;
    var badges = []; // [{ n, el, node }]

    var SENTINEL = 'data-aimax-overlay';

    var styleEl = document.createElement('style');
    styleEl.setAttribute(SENTINEL, '1');
    styleEl.textContent = [
        '.__aimax-outline { position: fixed; pointer-events: none; z-index: 2147483646; border: 2px solid #00d4ff; background: rgba(0,212,255,0.08); border-radius: 2px; transition: all 60ms linear; display: none; }',
        '.__aimax-label { position: fixed; pointer-events: none; z-index: 2147483647; background: #ffffff; color: #111; font: 11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",monospace; padding: 6px 10px; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.25); white-space: pre; display: none; max-width: 320px; }',
        '.__aimax-input { position: fixed; z-index: 2147483647; background: #ffffff; border-radius: 14px; padding: 8px 14px; box-shadow: 0 6px 20px rgba(0,0,0,0.35); display: none; min-width: 280px; max-width: 420px; }',
        '.__aimax-input textarea { width: 100%; border: none; outline: none; background: transparent; font: 13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color: #111; resize: none; overflow: hidden; line-height: 1.4; min-height: 18px; max-height: 200px; padding: 0; margin: 0; display: block; }',
        '.__aimax-badge { position: fixed; z-index: 2147483645; background: #00d4ff; color: #001018; font: bold 11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 6px rgba(0,0,0,0.4); cursor: pointer; user-select: none; }',
        '.__aimax-badge:hover { background: #ff5757; color: #fff; transform: scale(1.15); }',
        'body.__aimax-active, body.__aimax-active * { cursor: crosshair !important; }'
    ].join('\\n');
    document.documentElement.appendChild(styleEl);

    var outline = document.createElement('div');
    outline.className = '__aimax-outline';
    outline.setAttribute(SENTINEL, '1');

    var label = document.createElement('div');
    label.className = '__aimax-label';
    label.setAttribute(SENTINEL, '1');

    var inputBox = document.createElement('div');
    inputBox.className = '__aimax-input';
    inputBox.setAttribute(SENTINEL, '1');
    var inputField = document.createElement('textarea');
    inputField.rows = 1;
    inputField.placeholder = 'Add a comment...';
    inputField.setAttribute(SENTINEL, '1');
    inputBox.appendChild(inputField);

    function autoGrow() {
        inputField.style.height = 'auto';
        inputField.style.height = Math.min(inputField.scrollHeight, 200) + 'px';
        if (inputField.scrollHeight > 200) {
            inputField.style.overflowY = 'auto';
        } else {
            inputField.style.overflowY = 'hidden';
        }
    }
    inputField.addEventListener('input', autoGrow);

    function attach() {
        if (!document.body) return false;
        if (!outline.parentNode) document.body.appendChild(outline);
        if (!label.parentNode) document.body.appendChild(label);
        if (!inputBox.parentNode) document.body.appendChild(inputBox);
        return true;
    }
    if (!attach()) {
        document.addEventListener('DOMContentLoaded', attach, { once: true });
    }

    function isOverlay(el) {
        while (el && el !== document.body) {
            if (el.hasAttribute && el.hasAttribute(SENTINEL)) return true;
            el = el.parentNode;
        }
        return false;
    }

    function rgbToHex(rgb) {
        if (!rgb) return rgb;
        var m = rgb.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
        if (!m) return rgb;
        var r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
        return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
    }

    function getInfo(el) {
        var rect = el.getBoundingClientRect();
        var cs = window.getComputedStyle(el);
        return {
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            cls: (el.className && typeof el.className === 'string') ? el.className.trim() : null,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            color: rgbToHex(cs.color),
            background: rgbToHex(cs.backgroundColor),
            font: cs.font || (cs.fontSize + ' ' + cs.fontFamily),
            text: (el.innerText || el.textContent || '').trim().slice(0, 80)
        };
    }

    function buildSelector(el) {
        if (!el || el === document.body) return 'body';
        if (el.id) return '#' + el.id;
        var parts = [];
        var cur = el;
        var depth = 0;
        while (cur && cur.nodeType === 1 && cur !== document.body && depth < 4) {
            var part = cur.tagName.toLowerCase();
            var parent = cur.parentNode;
            if (parent) {
                var siblings = Array.prototype.filter.call(parent.children, function(c) { return c.tagName === cur.tagName; });
                if (siblings.length > 1) {
                    var idx = siblings.indexOf(cur) + 1;
                    part += ':nth-of-type(' + idx + ')';
                }
            }
            parts.unshift(part);
            cur = parent;
            depth++;
        }
        return 'body > ' + parts.join(' > ');
    }

    function showOverlay(el) {
        var rect = el.getBoundingClientRect();
        outline.style.display = 'block';
        outline.style.left = rect.left + 'px';
        outline.style.top = rect.top + 'px';
        outline.style.width = rect.width + 'px';
        outline.style.height = rect.height + 'px';

        var info = getInfo(el);
        var dim = info.width + 'x' + info.height;
        var lines = [
            info.tag.padEnd(10) + dim.padStart(20),
            'Colore'.padEnd(10) + (info.color || '-').padStart(20),
            'Carattere ' + (info.font || '-').slice(0, 30)
        ];
        label.textContent = lines.join('\\n');
        label.style.display = 'block';

        var vw = window.innerWidth, vh = window.innerHeight;
        var lx = rect.left;
        var ly = rect.top - 60;
        if (ly < 8) ly = rect.bottom + 8;
        if (lx < 10 || lx > vw - 100 || ly < 10 || ly > vh - 60) { lx = 10; ly = 10; }
        label.style.left = lx + 'px';
        label.style.top = ly + 'px';
    }

    function hideOverlay() {
        outline.style.display = 'none';
        label.style.display = 'none';
    }

    function showInput(el) {
        var rect = el.getBoundingClientRect();
        inputBox.style.display = 'block';
        var vw = window.innerWidth, vh = window.innerHeight;
        var ix = rect.left;
        var iy = rect.top - 50;
        if (iy < 8) iy = rect.bottom + 8;
        if (ix < 10 || ix > vw - 280 || iy < 10 || iy > vh - 50) { ix = 10; iy = 10; }
        inputBox.style.left = ix + 'px';
        inputBox.style.top = iy + 'px';
        inputField.value = '';
        inputField.style.height = 'auto';
        inputField.style.overflowY = 'hidden';
        setTimeout(function() { inputField.focus(); }, 0);
    }

    function hideInput() {
        inputBox.style.display = 'none';
        pinnedTarget = null;
    }

    function repositionBadges() {
        for (var i = 0; i < badges.length; i++) {
            var b = badges[i];
            var r = b.el.getBoundingClientRect();
            b.node.style.left = (r.left - 10) + 'px';
            b.node.style.top = (r.top - 10) + 'px';
        }
    }

    function placeBadge(el, n) {
        var badge = document.createElement('div');
        badge.className = '__aimax-badge';
        badge.setAttribute(SENTINEL, '1');
        badge.setAttribute('data-aimax-n', String(n));
        badge.title = 'Click to remove annotation ' + n;
        badge.textContent = String(n);
        var rect = el.getBoundingClientRect();
        badge.style.left = (rect.left - 10) + 'px';
        badge.style.top = (rect.top - 10) + 'px';
        badge.addEventListener('click', function(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            removeBadge(n);
            try { window.parent.postMessage({ type: 'annot:remove', n: n }, '*'); } catch (err) {}
        }, true);
        document.body.appendChild(badge);
        badges.push({ n: n, el: el, node: badge });
    }

    function removeBadge(n) {
        for (var i = 0; i < badges.length; i++) {
            if (badges[i].n === n) {
                if (badges[i].node.parentNode) {
                    badges[i].node.parentNode.removeChild(badges[i].node);
                }
                badges.splice(i, 1);
                return;
            }
        }
    }

    function clearBadges() {
        for (var i = 0; i < badges.length; i++) {
            if (badges[i].node.parentNode) {
                badges[i].node.parentNode.removeChild(badges[i].node);
            }
        }
        badges = [];
        counter = 0;
    }

    function onMouseMove(e) {
        if (!active || pinnedTarget) return;
        var t = document.elementFromPoint(e.clientX, e.clientY);
        if (!t || isOverlay(t)) return;
        if (t === hoverTarget) return;
        hoverTarget = t;
        showOverlay(t);
    }

    function onClick(e) {
        if (!active) return;
        if (isOverlay(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        var t = e.target;
        if (!t || isOverlay(t)) return;
        pinnedTarget = t;
        showOverlay(t);
        showInput(t);
    }

    inputField.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            var comment = inputField.value.trim();
            var el = pinnedTarget;
            if (comment && el) {
                counter += 1;
                placeBadge(el, counter);
                var payload = {
                    type: 'annot:add',
                    n: counter,
                    selector: buildSelector(el),
                    info: getInfo(el),
                    comment: comment,
                    href: location.href
                };
                // postMessage to window.parent works in both contexts:
                // - iframe: posts cross-origin to parent webview
                // - same-document (Home Panel): window.parent === window, triggers own listeners
                try { window.parent.postMessage(payload, '*'); } catch (err) {}
            }
            hideInput();
            hideOverlay();
            hoverTarget = null;
        } else if (e.key === 'Escape') {
            e.preventDefault();
            hideInput();
        }
    });

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);

    function setActive(on) {
        active = !!on;
        if (active) {
            document.body.classList.add('__aimax-active');
        } else {
            document.body.classList.remove('__aimax-active');
            hideOverlay();
            hideInput();
            hoverTarget = null;
        }
    }

    window.addEventListener('message', function(ev) {
        var d = ev.data;
        if (!d || typeof d !== 'object') return;
        if (d.type === 'annot:toggle') {
            setActive(d.on);
        } else if (d.type === 'annot:reset') {
            clearBadges();
        } else if (d.type === 'annot:remove' && typeof d.n === 'number') {
            removeBadge(d.n);
        }
    });

    function onScrollOrResize() {
        repositionBadges();
        if (pinnedTarget) {
            showOverlay(pinnedTarget);
            showInput(pinnedTarget);
        } else if (hoverTarget) {
            showOverlay(hoverTarget);
        }
    }
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
})();
`;

export function injectAnnotationClient(html: string): string {
    const tag = `<script data-aimax-injected="1">${ANNOTATION_CLIENT_JS}</script>`;
    if (/<\/body>/i.test(html)) {
        return html.replace(/<\/body>/i, tag + '</body>');
    }
    return html + tag;
}
