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
    // In edit mode the user types directly into text leaves (contenteditable).
    // We snapshot each leaf's original state when it gains focus so we can diff
    // on blur — by SAVE time the DOM has been mutated, so oldText/occIndex/
    // outerHTML must come from the pre-edit snapshot, not the live DOM.
    var editOriginals = new WeakMap(); // el -> { oldText, occIndex, outerHTML }
    var editableLeaves = []; // currently-contenteditable elements (for cleanup)

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
        'body.__aimax-active.edit, body.__aimax-active.edit * { cursor: text !important; }',
        '.__aimax-editable { outline: 2px dashed rgba(255,149,0,0.55) !important; outline-offset: 3px; border-radius: 3px; }',
        '.__aimax-editable:focus { outline: 2px solid #ff9500 !important; background: rgba(255,149,0,0.08); }'
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
        var cap = 200; // comment popup only
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

    // A text leaf is eligible for direct editing if it has text, no element
    // children, isn't part of our own overlay UI, and — in notes sub-mode —
    // lives inside a .speaker-notes block. Mirrors the click-handler gates.
    function isEditableLeaf(el) {
        if (!el || el.nodeType !== 1) return false;
        if (isOverlay(el)) return false;
        if (hasElementChildren(el)) return false;
        if (!(el.textContent || '').trim()) return false;
        if (notesActive && !isInsideSpeakerNotes(el)) return false;
        return true;
    }

    function snapshotLeaf(el) {
        var oldText = el.textContent || '';
        editOriginals.set(el, {
            oldText: oldText,
            occIndex: occurrenceIndexInDom(el, oldText),
            outerHTML: el.outerHTML
        });
    }

    // Snapshot a wrapper span standing in for a bare text node inside a mixed
    // element (e.g. "Context switching kills " in <h2>...<span>x</span></h2>).
    // The diff anchors on the PLAIN text fragment — which exists verbatim in the
    // source — not on the temporary span (which never reaches disk). We carry
    // the source fragment in __aimaxFragment so the surrounding whitespace the
    // user might trim still maps back to the original bytes.
    function snapshotFragment(span) {
        var oldText = span.getAttribute('data-aimax-frag') || (span.textContent || '');
        editOriginals.set(span, {
            oldText: oldText,
            occIndex: -1,        // text fragments aren't whole-element leaves; rely on uniqueness/outerHTML
            outerHTML: null,
            fragment: true
        });
    }

    // True for inline elements that are themselves pure-text leaves living
    // inside a parent that has other element children — these already pass
    // isEditableLeaf, so enableInlineEditing handles them directly.

    // Wrap each bare (non-whitespace) text node child of a mixed element in an
    // editable span. Returns the created spans. Used only inside edit mode and
    // unwrapped on disable so the served DOM is restored.
    function wrapBareTextNodes(parent) {
        var made = [];
        var nodes = [];
        for (var i = 0; i < parent.childNodes.length; i++) nodes.push(parent.childNodes[i]);
        for (var j = 0; j < nodes.length; j++) {
            var node = nodes[j];
            if (node.nodeType !== 3) continue;            // text nodes only
            if (!(node.nodeValue || '').trim()) continue; // skip pure whitespace
            var span = document.createElement('span');
            span.className = '__aimax-editable __aimax-frag';
            span.setAttribute(SENTINEL, '1');
            span.setAttribute('data-aimax-frag', node.nodeValue);
            span.setAttribute('contenteditable', 'true');
            span.textContent = node.nodeValue;
            parent.replaceChild(span, node);
            made.push(span);
        }
        return made;
    }

    function unwrapFragmentSpan(span) {
        if (!span.parentNode) return;
        // Replace the span with a plain text node carrying its current text, so
        // an unsaved edit stays visible but the temporary span markup is gone.
        var tn = document.createTextNode(span.textContent || '');
        span.parentNode.replaceChild(tn, span);
    }

    function enableInlineEditing() {
        editableLeaves = [];
        var all = document.body ? document.body.getElementsByTagName('*') : [];
        var candidates = [];
        for (var i = 0; i < all.length; i++) candidates.push(all[i]);
        for (var j = 0; j < candidates.length; j++) {
            var el = candidates[j];
            if (isOverlay(el)) continue;
            if (notesActive && !isInsideSpeakerNotes(el)) continue;
            if (isEditableLeaf(el)) {
                // Pure-text leaf: edit the element directly.
                el.setAttribute('contenteditable', 'true');
                el.classList.add('__aimax-editable');
                editableLeaves.push(el);
            } else if (hasElementChildren(el) && hasBareTextChild(el)) {
                // Mixed element: wrap its bare text fragments so each becomes an
                // independently-editable sub-node (keeps inline tags intact).
                var spans = wrapBareTextNodes(el);
                for (var k = 0; k < spans.length; k++) editableLeaves.push(spans[k]);
            }
        }
    }

    function hasBareTextChild(el) {
        if (!el || !el.childNodes) return false;
        for (var i = 0; i < el.childNodes.length; i++) {
            var n = el.childNodes[i];
            if (n.nodeType === 3 && (n.nodeValue || '').trim()) return true;
        }
        return false;
    }

    function disableInlineEditing() {
        for (var i = 0; i < editableLeaves.length; i++) {
            var el = editableLeaves[i];
            if (el.classList && el.classList.contains('__aimax-frag')) {
                unwrapFragmentSpan(el);
            } else {
                el.removeAttribute('contenteditable');
                el.classList.remove('__aimax-editable');
            }
        }
        editableLeaves = [];
        editOriginals = new WeakMap();
    }

    // Diff a leaf against its focus-in snapshot and, if changed, post an
    // edit:save payload (same shape the old popup flow produced) and drop a ✏
    // badge. Re-baselines the snapshot so a second edit diffs cleanly.
    function captureLeafEdit(el) {
        var snap = editOriginals.get(el);
        if (!snap) return;
        var newText = el.textContent || '';
        if (snap.fragment) {
            // The source fragment may carry leading/trailing whitespace between
            // tags (e.g. "Context switching kills "). The user edits only the
            // visible words, so re-attach the original edge whitespace so the
            // verbatim source replace still matches and round-trips.
            var orig = snap.oldText;
            var lead = (orig.match(/^\\s*/) || [''])[0];
            var trail = (orig.match(/\\s*$/) || [''])[0];
            newText = lead + newText.replace(/^\\s+|\\s+$/g, '') + trail;
        }
        if (newText === snap.oldText) return;
        if (!newText.trim()) {
            el.textContent = snap.oldText;
            showToast('Empty text — reverted', 'error');
            return;
        }
        counter += 1;
        placeBadge(el, counter, 'edit');
        var payload = {
            type: 'edit:save',
            n: counter,
            selector: buildSelector(el),
            oldText: snap.oldText,
            newText: newText,
            occurrenceIndex: snap.occIndex,
            outerHTML: snap.outerHTML,
            href: location.href,
            notes: notesActive
        };
        try { window.parent.postMessage(payload, '*'); } catch (err) {}
        // Re-baseline against what we just sent so a second edit diffs cleanly.
        if (snap.fragment) {
            el.setAttribute('data-aimax-frag', newText);
            snapshotFragment(el);
        } else {
            snapshotLeaf(el);
        }
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

    // Popup is comment-mode only now; edit mode types directly into the leaf.
    function showInput(el) {
        var rect = el.getBoundingClientRect();
        inputBox.style.display = 'block';
        inputBox.className = '__aimax-input';
        inputBox.setAttribute(SENTINEL, '1');
        inputField.value = '';
        inputField.rows = 1;
        inputField.placeholder = 'Add a comment...';
        inputField.style.height = 'auto';
        inputField.style.overflowY = 'hidden';
        autoGrow();

        var vw = window.innerWidth, vh = window.innerHeight;
        var ix = rect.left;
        var iy = rect.top - 50;
        if (iy < 8) iy = rect.bottom + 8;
        if (ix < 10 || ix > vw - 280 || iy < 10 || iy > vh - 50) { ix = 10; iy = 10; }
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
        if (mode === 'edit') return; // contenteditable outline replaces hover overlay
        var t = document.elementFromPoint(e.clientX, e.clientY);
        if (!t || isOverlay(t)) return;
        if (t === hoverTarget) return;
        hoverTarget = t;
        showOverlay(t);
    }

    function onClick(e) {
        if (!active) return;
        // Edit mode uses direct contenteditable typing — let clicks place the
        // caret in the leaf instead of pinning a popup.
        if (mode === 'edit') return;
        if (isOverlay(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        var t = e.target;
        if (!t || isOverlay(t)) return;

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

    // The popup is comment-only now (edit mode types directly into leaves).
    inputField.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submitComment();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            hideInput();
        }
    });

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);

    // ---- Direct in-place editing (edit mode) ----
    // Snapshot a leaf when it gains focus so blur can diff against the original.
    function onEditFocusIn(e) {
        if (!active || mode !== 'edit') return;
        var el = e.target;
        if (!el || !el.classList || !el.classList.contains('__aimax-editable')) return;
        if (editOriginals.has(el)) return;
        if (el.classList.contains('__aimax-frag')) {
            snapshotFragment(el);
        } else {
            snapshotLeaf(el);
        }
    }

    function onEditFocusOut(e) {
        if (mode !== 'edit') return;
        var el = e.target;
        if (!el || !el.classList || !el.classList.contains('__aimax-editable')) return;
        captureLeafEdit(el);
    }

    // Force plain-text paste so leaves never gain child elements (which would
    // break the text-leaf invariant applyHtmlEdits relies on).
    function onEditPaste(e) {
        if (!active || mode !== 'edit') return;
        var el = e.target;
        if (!el || !el.classList || !el.classList.contains('__aimax-editable')) return;
        e.preventDefault();
        var text = '';
        if (e.clipboardData && e.clipboardData.getData) {
            text = e.clipboardData.getData('text/plain') || '';
        }
        if (!notesActive) text = text.replace(/[\\r\\n]+/g, ' ');
        try {
            document.execCommand('insertText', false, text);
        } catch (err) {
            // Fallback: append at caret is hard without execCommand; just append.
            el.textContent = (el.textContent || '') + text;
        }
    }

    function isEditingTarget(el) {
        return el && el.classList && el.classList.contains('__aimax-editable');
    }

    // While typing in a leaf, the host page's own key handlers (slide decks
    // navigate on Space / arrows / PageUp-Down, etc.) must NOT fire — otherwise
    // the deck scrolls away mid-edit. Swallow every keystroke at capture phase
    // so it never reaches the page's listeners, while still letting the browser
    // perform the default text-input behavior inside the editable element.
    function onEditKeyGuard(e) {
        if (!active || mode !== 'edit') return;
        if (!isEditingTarget(e.target)) return;
        // Stop the page (and our own non-edit listeners) from seeing this key.
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    }

    // In non-notes leaves, Enter would insert <br>/<div> and split the leaf.
    // Suppress it; newlines are allowed only inside .speaker-notes (notes mode).
    function onEditKeydown(e) {
        if (!active || mode !== 'edit') return;
        var el = e.target;
        if (!isEditingTarget(el)) return;
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        if (e.key === 'Enter' && !notesActive) {
            e.preventDefault();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            el.blur();
        }
        // Space, arrows, PageUp/Down, Home/End keep their default text-caret
        // behavior here but no longer bubble to the deck's navigation handlers.
    }

    document.addEventListener('focusin', onEditFocusIn, true);
    document.addEventListener('focusout', onEditFocusOut, true);
    document.addEventListener('paste', onEditPaste, true);
    document.addEventListener('keydown', onEditKeydown, true);
    // Some decks bind on keyup/keypress instead of keydown — guard those too.
    document.addEventListener('keyup', onEditKeyGuard, true);
    document.addEventListener('keypress', onEditKeyGuard, true);

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
                // Re-scan leaves each time: a notes toggle changes which leaves
                // are eligible (.speaker-notes only vs all text leaves).
                hideOverlay();
                hideInput();
                pinnedTarget = null;
                disableInlineEditing();
                enableInlineEditing();
            } else {
                document.body.classList.remove('edit');
                disableInlineEditing();
            }
        } else {
            document.body.classList.remove('__aimax-active');
            document.body.classList.remove('edit');
            disableInlineEditing();
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
