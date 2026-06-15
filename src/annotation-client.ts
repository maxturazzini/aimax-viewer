// Self-contained client script injected into every served HTML/MD response.
// Stays inert until it receives { type: 'annot:toggle', on: true } from window
// (parent or self). Supports two modes:
//   - 'comment' (default): hover-highlight, click-to-comment, reports each
//     annotation back via postMessage for the parent toolbar to collect.
//   - 'edit': click-to-replace-text on plain-text leaves, applies DOM update
//     immediately and posts {type:'edit:save'} for the parent to persist.
//     Sub-mode 'notes' reveals hidden .speaker-notes (slide decks) and
//     restricts editing to them with a multi-line textarea.

export const ANNOTATION_CLIENT_JS = `
(function() {
    if (window.__aimaxAnnotationLoaded) return;
    window.__aimaxAnnotationLoaded = true;

    var active = false;
    var mode = 'comment'; // 'comment' | 'edit'
    var notesActive = false;
    var hoverTarget = null;
    var pinnedTarget = null;
    var counter = 0;
    var badges = []; // [{ n, el, node, variant }]
    var notesStyleEl = null;

    var SENTINEL = 'data-aimax-overlay';

    var styleEl = document.createElement('style');
    styleEl.setAttribute(SENTINEL, '1');
    styleEl.textContent = [
        '.__aimax-outline { position: fixed; pointer-events: none; z-index: 2147483646; border: 2px solid #00d4ff; background: rgba(0,212,255,0.08); border-radius: 2px; transition: all 60ms linear; display: none; }',
        '.__aimax-outline.edit { border-color: #ff9500; background: rgba(255,149,0,0.10); }',
        '.__aimax-label { position: fixed; pointer-events: none; z-index: 2147483647; background: #ffffff; color: #111; font: 11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",monospace; padding: 6px 10px; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.25); white-space: pre; display: none; max-width: 320px; }',
        '.__aimax-input { position: fixed; z-index: 2147483647; background: #ffffff; border-radius: 14px; padding: 8px 14px; box-shadow: 0 6px 20px rgba(0,0,0,0.35); display: none; min-width: 280px; max-width: 420px; }',
        '.__aimax-input.notes { min-width: 420px; max-width: 640px; padding: 10px 14px; }',
        '.__aimax-input textarea { width: 100%; border: none; outline: none; background: transparent; font: 13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color: #111; resize: none; overflow: hidden; line-height: 1.4; min-height: 18px; max-height: 200px; padding: 0; margin: 0; display: block; }',
        '.__aimax-input.notes textarea { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 12px; max-height: 400px; }',
        '.__aimax-input-hint { font: 10px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color: #999; margin-top: 4px; display: none; }',
        '.__aimax-input.notes .__aimax-input-hint { display: block; }',
        '.__aimax-badge { position: fixed; z-index: 2147483645; background: #00d4ff; color: #001018; font: bold 11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 6px rgba(0,0,0,0.4); cursor: pointer; user-select: none; }',
        '.__aimax-badge:hover { background: #ff5757; color: #fff; transform: scale(1.15); }',
        '.__aimax-badge.edit { background: #34c759; color: #003311; font-size: 12px; }',
        '.__aimax-badge.saved { background: #888; color: #fff; opacity: 0.6; }',
        '.__aimax-badge.failed { background: #ff5757; color: #fff; }',
        '.__aimax-toast { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 2147483647; background: #222; color: #fff; font: 12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; padding: 8px 14px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); opacity: 0; transition: opacity 200ms ease-out; pointer-events: none; max-width: 480px; }',
        '.__aimax-toast.show { opacity: 1; }',
        '.__aimax-toast.error { background: #cc2222; }',
        '.__aimax-toast.success { background: #2a8f3a; }',
        'body.__aimax-active, body.__aimax-active * { cursor: crosshair !important; }',
        'body.__aimax-active.edit, body.__aimax-active.edit * { cursor: text !important; }'
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
    var inputHint = document.createElement('div');
    inputHint.className = '__aimax-input-hint';
    inputHint.setAttribute(SENTINEL, '1');
    inputHint.textContent = 'Enter for newline · ⌘↵ to save';
    inputBox.appendChild(inputHint);

    var toastEl = document.createElement('div');
    toastEl.className = '__aimax-toast';
    toastEl.setAttribute(SENTINEL, '1');
    var toastTimer = null;

    function autoGrow() {
        inputField.style.height = 'auto';
        var cap = (mode === 'edit' && notesActive) ? 400 : 200;
        inputField.style.height = Math.min(inputField.scrollHeight, cap) + 'px';
        if (inputField.scrollHeight > cap) {
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
        if (!toastEl.parentNode) document.body.appendChild(toastEl);
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

    function hasElementChildren(el) {
        if (!el || !el.childNodes) return false;
        for (var i = 0; i < el.childNodes.length; i++) {
            if (el.childNodes[i].nodeType === 1) return true;
        }
        return false;
    }

    function isInsideSpeakerNotes(el) {
        while (el && el !== document.body) {
            if (el.classList && el.classList.contains('speaker-notes')) return true;
            el = el.parentNode;
        }
        return false;
    }

    function closestSpeakerNotes(el) {
        while (el && el !== document.body) {
            if (el.classList && el.classList.contains('speaker-notes')) return el;
            el = el.parentNode;
        }
        return null;
    }

    // Compute the 0-based index of el among all DOM elements whose
    // textContent matches and which have no element children.
    // The extension host uses this as a tie-breaker when the same text
    // appears multiple times in the source HTML (DOM order == source
    // order for static LLM-generated artifacts).
    function occurrenceIndexInDom(el, text) {
        var all = document.body ? document.body.getElementsByTagName('*') : [];
        var idx = 0;
        for (var i = 0; i < all.length; i++) {
            var node = all[i];
            if (isOverlay(node)) continue;
            if (hasElementChildren(node)) continue;
            if ((node.textContent || '') !== text) continue;
            if (node === el) return idx;
            idx++;
        }
        return -1;
    }

    function showToast(text, level) {
        toastEl.textContent = text;
        toastEl.className = '__aimax-toast show' + (level ? ' ' + level : '');
        toastEl.setAttribute(SENTINEL, '1');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function() {
            toastEl.className = '__aimax-toast' + (level ? ' ' + level : '');
        }, 2400);
    }

    function applyNotesReveal(on) {
        if (on) {
            if (!notesStyleEl) {
                notesStyleEl = document.createElement('style');
                notesStyleEl.setAttribute(SENTINEL, '1');
                notesStyleEl.textContent = [
                    '.speaker-notes { display: block !important; background: #fff8c5 !important; color: #333 !important; outline: 1px dashed #b58900 !important; padding: 8px !important; margin: 8px 0 !important; font-family: ui-monospace,SFMono-Regular,Menlo,monospace !important; font-size: 12px !important; white-space: pre-wrap !important; }',
                    '.speaker-notes::before { content: "\u{1F4DD} SPEAKER NOTE"; display: block; font-size: 10px; font-weight: bold; color: #b58900; margin-bottom: 4px; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif !important; }'
                ].join('\\n');
                document.documentElement.appendChild(notesStyleEl);
            }
        } else {
            if (notesStyleEl && notesStyleEl.parentNode) {
                notesStyleEl.parentNode.removeChild(notesStyleEl);
                notesStyleEl = null;
            }
        }
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
        outline.className = '__aimax-outline' + (mode === 'edit' ? ' edit' : '');
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
        var isNotes = (mode === 'edit' && notesActive);
        inputBox.className = '__aimax-input' + (isNotes ? ' notes' : '');
        inputBox.setAttribute(SENTINEL, '1');

        if (mode === 'edit') {
            inputField.value = (el.textContent || '').replace(/\\u00A0/g, ' ');
            inputField.rows = isNotes ? 5 : 1;
            inputField.placeholder = isNotes ? 'Edit note — ⌘↵ to save' : 'Edit text — ↵ to save';
        } else {
            inputField.value = '';
            inputField.rows = 1;
            inputField.placeholder = 'Add a comment...';
        }
        inputField.style.height = 'auto';
        inputField.style.overflowY = 'hidden';
        autoGrow();

        var vw = window.innerWidth, vh = window.innerHeight;
        var boxW = isNotes ? 480 : 280;
        var ix = rect.left;
        var iy = rect.top - (isNotes ? 80 : 50);
        if (iy < 8) iy = rect.bottom + 8;
        if (ix < 10 || ix > vw - boxW || iy < 10 || iy > vh - 50) { ix = 10; iy = 10; }
        inputBox.style.left = ix + 'px';
        inputBox.style.top = iy + 'px';
        setTimeout(function() { inputField.focus(); inputField.select && inputField.select(); }, 0);
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

    function placeBadge(el, n, variant) {
        var badge = document.createElement('div');
        var cls = '__aimax-badge' + (variant === 'edit' ? ' edit' : '');
        badge.className = cls;
        badge.setAttribute(SENTINEL, '1');
        badge.setAttribute('data-aimax-n', String(n));
        badge.title = (variant === 'edit')
            ? 'Edit ' + n + ' — click to discard'
            : 'Click to remove annotation ' + n;
        badge.textContent = (variant === 'edit') ? '✏' : String(n);
        var rect = el.getBoundingClientRect();
        badge.style.left = (rect.left - 10) + 'px';
        badge.style.top = (rect.top - 10) + 'px';
        var topic = (variant === 'edit') ? 'edit:remove' : 'annot:remove';
        badge.addEventListener('click', function(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            removeBadge(n, variant);
            try { window.parent.postMessage({ type: topic, n: n }, '*'); } catch (err) {}
        }, true);
        document.body.appendChild(badge);
        badges.push({ n: n, el: el, node: badge, variant: variant || 'comment' });
    }

    function findBadge(n, variant) {
        for (var i = 0; i < badges.length; i++) {
            if (badges[i].n === n && (badges[i].variant || 'comment') === (variant || 'comment')) {
                return i;
            }
        }
        return -1;
    }

    function removeBadge(n, variant) {
        var i = findBadge(n, variant);
        if (i < 0) return;
        if (badges[i].node.parentNode) {
            badges[i].node.parentNode.removeChild(badges[i].node);
        }
        badges.splice(i, 1);
    }

    function markBadge(n, variant, state) {
        var i = findBadge(n, variant);
        if (i < 0) return;
        var b = badges[i];
        if (state === 'saved') {
            b.node.className = '__aimax-badge edit saved';
            b.node.title = 'Saved';
        } else if (state === 'failed') {
            b.node.className = '__aimax-badge edit failed';
            b.node.title = 'Save failed';
        }
        b.node.setAttribute(SENTINEL, '1');
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

        if (mode === 'edit') {
            if (notesActive) {
                var noteEl = closestSpeakerNotes(t);
                if (!noteEl) {
                    showToast('Not a speaker note', 'error');
                    return;
                }
                t = noteEl;
            }
            if (hasElementChildren(t)) {
                showToast('Plain text elements only', 'error');
                return;
            }
            var txt = (t.textContent || '').trim();
            if (!txt) {
                showToast('Element has no text', 'error');
                return;
            }
        }

        pinnedTarget = t;
        showOverlay(t);
        showInput(t);
    }

    function submitComment() {
        var comment = inputField.value.trim();
        var el = pinnedTarget;
        if (comment && el) {
            counter += 1;
            placeBadge(el, counter, 'comment');
            var payload = {
                type: 'annot:add',
                n: counter,
                selector: buildSelector(el),
                info: getInfo(el),
                comment: comment,
                href: location.href
            };
            try { window.parent.postMessage(payload, '*'); } catch (err) {}
        }
        hideInput();
        hideOverlay();
        hoverTarget = null;
    }

    function submitEdit() {
        var el = pinnedTarget;
        if (!el) { hideInput(); hideOverlay(); return; }
        var newText = inputField.value;
        var oldText = el.textContent || '';
        if (newText === oldText) {
            showToast('No change', 'info');
            hideInput();
            hideOverlay();
            hoverTarget = null;
            return;
        }
        // Capture occurrenceIndex and outerHTML BEFORE mutating the DOM —
        // after we overwrite textContent, the element no longer matches
        // oldText and the search would miss it.
        var occIndex = occurrenceIndexInDom(el, oldText);
        var oldOuterHTML = el.outerHTML;
        // Apply DOM immediately for visual feedback. Persistence happens on SAVE.
        el.textContent = newText;
        counter += 1;
        placeBadge(el, counter, 'edit');
        var payload = {
            type: 'edit:save',
            n: counter,
            selector: buildSelector(el),
            oldText: oldText,
            newText: newText,
            occurrenceIndex: occIndex,
            outerHTML: oldOuterHTML,
            href: location.href,
            notes: notesActive
        };
        try { window.parent.postMessage(payload, '*'); } catch (err) {}
        hideInput();
        hideOverlay();
        hoverTarget = null;
    }

    inputField.addEventListener('keydown', function(e) {
        var isNotes = (mode === 'edit' && notesActive);
        var submitGesture = isNotes
            ? ((e.key === 'Enter') && (e.metaKey || e.ctrlKey))
            : ((e.key === 'Enter') && !e.shiftKey);

        if (submitGesture) {
            e.preventDefault();
            if (mode === 'edit') {
                submitEdit();
            } else {
                submitComment();
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            hideInput();
        }
        // In notes mode plain Enter inserts a newline (default behavior).
    });

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);

    function setActive(on, nextMode, nextNotes) {
        active = !!on;
        var requestedMode = (nextMode === 'edit') ? 'edit' : 'comment';
        mode = active ? requestedMode : 'comment';
        var requestedNotes = !!nextNotes && mode === 'edit';
        if (requestedNotes !== notesActive) {
            notesActive = requestedNotes;
            applyNotesReveal(notesActive);
        } else if (!active && notesActive) {
            notesActive = false;
            applyNotesReveal(false);
        }
        if (active) {
            document.body.classList.add('__aimax-active');
            if (mode === 'edit') {
                document.body.classList.add('edit');
            } else {
                document.body.classList.remove('edit');
            }
        } else {
            document.body.classList.remove('__aimax-active');
            document.body.classList.remove('edit');
            hideOverlay();
            hideInput();
            hoverTarget = null;
        }
    }

    window.addEventListener('message', function(ev) {
        var d = ev.data;
        if (!d || typeof d !== 'object') return;
        if (d.type === 'annot:toggle') {
            setActive(d.on, d.mode, d.notes);
        } else if (d.type === 'annot:reset') {
            clearBadges();
        } else if (d.type === 'annot:remove' && typeof d.n === 'number') {
            removeBadge(d.n, 'comment');
        } else if (d.type === 'edit:remove' && typeof d.n === 'number') {
            removeBadge(d.n, 'edit');
        } else if (d.type === 'edit:result' && typeof d.n === 'number') {
            markBadge(d.n, 'edit', d.ok ? 'saved' : 'failed');
            if (d.toast) showToast(d.toast, d.ok ? 'success' : 'error');
        } else if (d.type === 'edit:toast') {
            showToast(d.text || '', d.level || 'info');
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
