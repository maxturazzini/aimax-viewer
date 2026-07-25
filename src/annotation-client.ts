// Self-contained client script injected into every served HTML/MD response.
// Stays inert until it receives { type: 'annot:toggle', on: true } from window
// (parent or self). Supports two modes:
//   - 'comment' (default): hover-highlight, click-to-comment, reports each
//     annotation back via postMessage for the parent toolbar to collect.
//   - 'edit': click-to-replace-text on plain-text leaves, applies DOM update
//     immediately and posts {type:'edit:save'} for the parent to persist.
//     Sub-mode 'notes' reveals hidden .speaker-notes (slide decks) and
//     restricts editing to them with a multi-line textarea.
//     Sub-mode 'layout' swaps text editing for direct manipulation: drag a
//     block to move it, drag one of 8 handles to resize it, arrows to nudge.
//     Each committed gesture posts {type:'edit:layout'} carrying a unique CSS
//     selector + the declarations to persist (the host merges them into a
//     <style data-aimax-layout> block in the source file).

export const ANNOTATION_CLIENT_JS = `
(function() {
    if (window.__aimaxAnnotationLoaded) return;
    window.__aimaxAnnotationLoaded = true;

    var active = false;
    var mode = 'comment'; // 'comment' | 'edit' | 'draw'
    var notesActive = false;
    var hoverTarget = null;
    var pinnedTarget = null;
    var counter = 0;
    var badges = []; // [{ n, el, node, variant, stroke }]

    // ---- Draw mode (freehand pencil) state ----
    // A full-viewport SVG captures pointer strokes. On pointerup we resolve the
    // DOM element under the stroke centroid (hybrid mapping: coords + element).
    var drawing = false;          // pen is currently down
    var drawPts = [];             // [{x,y}] viewport-px points of the live stroke
    var livePath = null;          // <path> being drawn
    var pendingStroke = null;     // { el, pts[], bbox } awaiting a comment
    var notesStyleEl = null;
    // In edit mode the user types directly into text leaves (contenteditable).
    // We snapshot each leaf's original state when it gains focus so we can diff
    // on blur — by SAVE time the DOM has been mutated, so oldText/occIndex/
    // outerHTML must come from the pre-edit snapshot, not the live DOM.
    var editOriginals = new WeakMap(); // el -> { oldText, occIndex, outerHTML }
    var editableLeaves = []; // currently-contenteditable elements (for cleanup)
    // badge number -> { el, oldText, fragment, saved } for text edits, so
    // discarding a ✏ badge puts the words back on screen instead of only
    // dropping the pending write (which used to leave the view and the file
    // disagreeing). Edits already written to disk are marked saved and are no
    // longer revertable this way.
    var editByN = {};

    // ---- Layout sub-mode (move / resize frames) state ----
    // Gestures never rewrite markup: they accumulate a translate (+ optional
    // width/height) applied inline for live feedback, then persist host-side
    // as a CSS rule keyed on a verified-unique selector.
    var layoutActive = false;
    var laySel = null;      // currently selected element
    var layBase = null;     // { mat:[a,b,c,d], dx, dy, w, h, resized }
    var layDrag = null;     // { handle, x0, y0, start, sc, moved }
    var layPendingBySel = {}; // selector -> badge number (repeat drags coalesce)
    var layByN = {};          // badge number -> { el, selector }
    var layOriginalStyle = new WeakMap(); // el -> style attribute before first gesture
    var layStates = new WeakMap();        // el -> geometry state currently applied
    // Undo/redo: a flat list of {el, before, after} in gesture order, plus a
    // pointer to how many of them are currently applied. Undo walks the pointer
    // back and re-applies the 'before' of the entry it stepped over; redo walks
    // forward. A new gesture truncates whatever redo tail was left.
    var layHistory = [];
    var layHistoryIdx = 0;
    var layNudgeRun = null; // el of the in-progress arrow-key run (entries coalesce)

    // ---- Carrying the working element across sub-modes ----
    // Switching sub-mode rewrites the DOM (text mode wraps bare text nodes in
    // temporary spans), so an element REFERENCE can't survive the trip. A
    // verified-unique selector can: we remember the string on the way out and
    // resolve it again on the way in. Same trick we use to write to disk,
    // reused for continuity of work.
    var carrySelector = null;
    var lastEditedEl = null; // most recent leaf that held the caret in text mode

    var SENTINEL = 'data-aimax-overlay';

    // Stacking band. The client's overlays sit just BELOW 2147483647, which is
    // reserved for AIMax's own chrome (toolbar + annotation panel). It matters
    // only in the Home Panel, where chrome and client share one document: with
    // both at max the client won on DOM order and its hover label painted over
    // the panel. In the Browser Panel the client is alone in the iframe, so the
    // band is still effectively "above everything the artifact can do".
    var styleEl = document.createElement('style');
    styleEl.setAttribute(SENTINEL, '1');
    styleEl.textContent = [
        // One place for the palette. --aimax-sel is deliberately white: the
        // selection frame is editor chrome, and every tool the user already
        // knows draws it neutral, letting the artwork keep the colour. The
        // accent hues stay for *state* (comment cyan, edit orange, draw pink).
        ':root { --aimax-accent: #00d4ff; --aimax-edit: #ff9500; --aimax-draw: #ff2d92;' +
        ' --aimax-sel: #ffffff; --aimax-sel-ink: #14161a; --aimax-sel-edge: rgba(0,0,0,0.55); }',
        '.__aimax-outline { position: fixed; pointer-events: none; z-index: 2147483642; border: 2px solid var(--aimax-accent); background: rgba(0,212,255,0.08); border-radius: 2px; transition: all 60ms linear; display: none; }',
        '.__aimax-outline.edit { border-color: var(--aimax-edit); background: rgba(255,149,0,0.10); }',
        '.__aimax-label { position: fixed; pointer-events: none; z-index: 2147483645; background: #ffffff; color: #111; font: 11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",monospace; padding: 6px 10px; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.25); white-space: pre; display: none; max-width: 320px; }',
        '.__aimax-input { position: fixed; z-index: 2147483646; background: #ffffff; border-radius: 14px; padding: 8px 14px; box-shadow: 0 6px 20px rgba(0,0,0,0.35); display: none; min-width: 280px; max-width: 420px; }',
        '.__aimax-input.notes { min-width: 420px; max-width: 640px; padding: 10px 14px; }',
        '.__aimax-input textarea { width: 100%; border: none; outline: none; background: transparent; font: 13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color: #111; resize: none; overflow: hidden; line-height: 1.4; min-height: 18px; max-height: 200px; padding: 0; margin: 0; display: block; }',
        '.__aimax-input.notes textarea { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 12px; max-height: 400px; }',
        '.__aimax-input-hint { font: 10px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color: #999; margin-top: 4px; display: none; }',
        '.__aimax-input.notes .__aimax-input-hint { display: block; }',
        '.__aimax-badge { position: fixed; z-index: 2147483643; background: #00d4ff; color: #001018; font: bold 11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 6px rgba(0,0,0,0.4); cursor: pointer; user-select: none; }',
        '.__aimax-badge:hover { background: #ff5757; color: #fff; transform: scale(1.15); }',
        '.__aimax-badge.edit { background: #34c759; color: #003311; font-size: 12px; }',
        // Neutral like the selection frame it belongs to — the layout badge is
        // editor chrome, not a status hue.
        '.__aimax-badge.layout { background: var(--aimax-sel); color: var(--aimax-sel-ink); border: 1px solid var(--aimax-sel-edge); font-size: 12px; }',
        '.__aimax-badge.saved { background: #888; color: #fff; opacity: 0.6; }',
        '.__aimax-badge.failed { background: #ff5757; color: #fff; }',
        '.__aimax-toast { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 2147483647; background: #222; color: #fff; font: 12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; padding: 8px 14px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); opacity: 0; transition: opacity 200ms ease-out; pointer-events: none; max-width: 480px; }',
        '.__aimax-toast.show { opacity: 1; }',
        '.__aimax-toast.error { background: #cc2222; }',
        '.__aimax-toast.success { background: #2a8f3a; }',
        'body.__aimax-active, body.__aimax-active * { cursor: crosshair !important; }',
        'body.__aimax-active.edit, body.__aimax-active.edit * { cursor: text !important; }',
        // In draw mode AIMax\\'s own chrome stays interactive — never force the
        // crosshair on overlay elements (panel, toolbar, popups).
        'body.__aimax-active.draw [' + 'data-aimax-overlay' + '], body.__aimax-active.draw [' + 'data-aimax-overlay' + '] * { cursor: auto !important; }',
        '.__aimax-editable { outline: 2px dashed rgba(255,149,0,0.55) !important; outline-offset: 3px; border-radius: 3px; }',
        '.__aimax-editable:focus { outline: 2px solid var(--aimax-edit) !important; background: rgba(255,149,0,0.08); }',
        // Layout sub-mode: the whole page becomes a drag surface (grab cursor),
        // the selection frame draws 8 handles with their own resize cursors.
        // These win over the .edit text-cursor rule because they come later.
        'body.__aimax-active.edit.layout, body.__aimax-active.edit.layout * { cursor: move !important; }',
        'body.__aimax-active.edit.layout [' + 'data-aimax-overlay' + '], body.__aimax-active.edit.layout [' + 'data-aimax-overlay' + '] * { cursor: auto !important; }',
        // White frame + white handles, each with a dark hairline so they stay
        // readable on a white artifact as well as a dark one.
        '.__aimax-lay { position: fixed; z-index: 2147483644; border: 1.5px solid var(--aimax-sel); box-shadow: 0 0 0 1px var(--aimax-sel-edge), inset 0 0 0 1px rgba(0,0,0,0.35); pointer-events: none; display: none; transform-origin: 50% 50%; }',
        '.__aimax-lay-h { position: absolute; width: 11px; height: 11px; background: var(--aimax-sel); border: 1px solid var(--aimax-sel-edge); border-radius: 2px; box-shadow: 0 1px 2px rgba(0,0,0,0.35); pointer-events: auto; }',
        // Rotation handle: a round grip on a short stem above the top edge —
        // the gesture every editor uses, so it needs no explaining.
        '.__aimax-lay-rot { position: absolute; left: 50%; top: -30px; margin-left: -7px; width: 14px; height: 14px; border-radius: 50%; background: var(--aimax-sel); border: 1px solid var(--aimax-sel-edge); box-shadow: 0 1px 3px rgba(0,0,0,0.4); pointer-events: auto; cursor: grab !important; }',
        '.__aimax-lay-stem { position: absolute; left: 50%; top: -16px; margin-left: -0.75px; width: 1.5px; height: 16px; background: var(--aimax-sel); box-shadow: 0 0 0 1px var(--aimax-sel-edge); pointer-events: none; }',
        '.__aimax-lay-nw { left: -7px; top: -7px; cursor: nwse-resize !important; }',
        '.__aimax-lay-n  { left: 50%; top: -7px; margin-left: -6px; cursor: ns-resize !important; }',
        '.__aimax-lay-ne { right: -7px; top: -7px; cursor: nesw-resize !important; }',
        '.__aimax-lay-e  { right: -7px; top: 50%; margin-top: -6px; cursor: ew-resize !important; }',
        '.__aimax-lay-se { right: -7px; bottom: -7px; cursor: nwse-resize !important; }',
        '.__aimax-lay-s  { left: 50%; bottom: -7px; margin-left: -6px; cursor: ns-resize !important; }',
        '.__aimax-lay-sw { left: -7px; bottom: -7px; cursor: nesw-resize !important; }',
        '.__aimax-lay-w  { left: -7px; top: 50%; margin-top: -6px; cursor: ew-resize !important; }',
        // Alignment guides: shown only while a snap is engaged, so seeing one
        // IS the confirmation that the frame is aligned — not a hope.
        '.__aimax-guide { position: fixed; z-index: 2147483641; background: var(--aimax-draw); pointer-events: none; display: none; }',
        '.__aimax-guide.v { top: 0; width: 1px; height: 100vh; }',
        '.__aimax-guide.h { left: 0; height: 1px; width: 100vw; }',
        '.__aimax-lay-size { position: absolute; left: 0; bottom: -22px; background: var(--aimax-sel); color: var(--aimax-sel-ink); font: bold 10px -apple-system,BlinkMacSystemFont,"Segoe UI",monospace; padding: 2px 6px; border-radius: 4px; white-space: nowrap; box-shadow: 0 1px 3px rgba(0,0,0,0.35); }',
        // z-index sits BELOW AIMax's own host chrome (toolbar ~100000, annotation
        // panel ~100002) so its pointer-capturing surface never covers those —
        // otherwise the panel buttons become unclickable. It's still far above
        // ordinary page content, so strokes render on top of the artifact.
        '.__aimax-draw { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; z-index: 99990; pointer-events: none; display: none; }',
        'body.__aimax-active.draw .__aimax-draw { display: block; pointer-events: auto; }',
        'body.__aimax-active.draw .__aimax-draw { cursor: crosshair; }',
        '.__aimax-draw path { fill: none; stroke: #ff2d92; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }'
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

    // Selection frame for layout sub-mode: a fixed-position box tracking the
    // selected element's viewport rect, with 8 resize handles + a size readout.
    var LAY_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    var layBox = document.createElement('div');
    layBox.className = '__aimax-lay';
    layBox.setAttribute(SENTINEL, '1');
    for (var lh = 0; lh < LAY_HANDLES.length; lh++) {
        var hEl = document.createElement('div');
        hEl.className = '__aimax-lay-h __aimax-lay-' + LAY_HANDLES[lh];
        hEl.setAttribute(SENTINEL, '1');
        hEl.setAttribute('data-aimax-h', LAY_HANDLES[lh]);
        layBox.appendChild(hEl);
    }
    var layStem = document.createElement('div');
    layStem.className = '__aimax-lay-stem';
    layStem.setAttribute(SENTINEL, '1');
    layBox.appendChild(layStem);
    var layRotHandle = document.createElement('div');
    layRotHandle.className = '__aimax-lay-rot';
    layRotHandle.setAttribute(SENTINEL, '1');
    layRotHandle.setAttribute('data-aimax-h', 'rot');
    layRotHandle.title = 'Drag to rotate — hold ⇧ to snap to 15°';
    layBox.appendChild(layRotHandle);
    var laySizeLbl = document.createElement('div');
    laySizeLbl.className = '__aimax-lay-size';
    laySizeLbl.setAttribute(SENTINEL, '1');
    layBox.appendChild(laySizeLbl);

    var layGuideV = document.createElement('div');
    layGuideV.className = '__aimax-guide v';
    layGuideV.setAttribute(SENTINEL, '1');
    var layGuideH = document.createElement('div');
    layGuideH.className = '__aimax-guide h';
    layGuideH.setAttribute(SENTINEL, '1');

    var SVGNS = 'http://www.w3.org/2000/svg';
    var drawSvg = document.createElementNS(SVGNS, 'svg');
    drawSvg.setAttribute('class', '__aimax-draw');
    drawSvg.setAttribute(SENTINEL, '1');

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
        if (!drawSvg.parentNode) document.body.appendChild(drawSvg);
        if (!layBox.parentNode) document.body.appendChild(layBox);
        if (!layGuideV.parentNode) document.body.appendChild(layGuideV);
        if (!layGuideH.parentNode) document.body.appendChild(layGuideH);
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
        // Remember what the words were, so discarding this badge can put them
        // back. The FIRST edit of a leaf is the one that matters: a second edit
        // reuses this record's oldText, so discarding always lands on the text
        // that is actually in the file.
        editByN[counter] = {
            el: el,
            oldText: snap.oldText,
            fragment: !!snap.fragment,
            saved: false
        };
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
            // A draw-stroke is anchored to its element: translate it by the delta
            // between the element's current rect and the rect at draw time.
            if (b.stroke && b.anchorRect) {
                var dx = r.left - b.anchorRect.left;
                var dy = r.top - b.anchorRect.top;
                b.stroke.setAttribute('transform', 'translate(' + dx + ',' + dy + ')');
            }
        }
    }

    function placeBadge(el, n, variant, stroke, anchorRect) {
        var badge = document.createElement('div');
        var cls = '__aimax-badge' +
            (variant === 'edit' ? ' edit' : (variant === 'layout' ? ' edit layout' : ''));
        badge.className = cls;
        badge.setAttribute(SENTINEL, '1');
        badge.setAttribute('data-aimax-n', String(n));
        badge.title = (variant === 'edit')
            ? 'Edit ' + n + ' — click to discard'
            : (variant === 'layout'
                ? 'Move/resize ' + n + ' — click to revert'
                : 'Click to remove annotation ' + n);
        badge.textContent = (variant === 'edit') ? '✏' : (variant === 'layout' ? '✥' : String(n));
        var rect = el.getBoundingClientRect();
        badge.style.left = (rect.left - 10) + 'px';
        badge.style.top = (rect.top - 10) + 'px';
        // Layout badges ride the same host-side discard channel as text edits.
        var topic = (variant === 'edit' || variant === 'layout') ? 'edit:remove' : 'annot:remove';
        badge.addEventListener('click', function(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            removeBadge(n, variant);
            try { window.parent.postMessage({ type: topic, n: n }, '*'); } catch (err) {}
        }, true);
        document.body.appendChild(badge);
        badges.push({ n: n, el: el, node: badge, variant: variant || 'comment', stroke: stroke || null, anchorRect: anchorRect || null });
    }

    function findBadge(n, variant) {
        for (var i = 0; i < badges.length; i++) {
            if (badges[i].n === n && (badges[i].variant || 'comment') === (variant || 'comment')) {
                return i;
            }
        }
        return -1;
    }

    // The host addresses text edits and layout gestures through one channel
    // ('edit:remove' / 'edit:result'), so resolve either variant by number.
    function findEditBadge(n) {
        var i = findBadge(n, 'edit');
        return i >= 0 ? i : findBadge(n, 'layout');
    }

    // Put a discarded text edit's original words back in the DOM. Refuses once
    // the edit has reached disk — at that point the file holds the new text and
    // silently restoring the old one on screen would recreate the very
    // divergence this is here to prevent.
    function editRevert(n) {
        var rec = editByN[n];
        if (!rec) return;
        delete editByN[n];
        if (rec.saved) return;
        rec.el.textContent = rec.oldText;
        if (rec.fragment) {
            rec.el.setAttribute('data-aimax-frag', rec.oldText);
            snapshotFragment(rec.el);
        } else if (editOriginals.has(rec.el)) {
            snapshotLeaf(rec.el);
        }
    }

    function removeBadge(n, variant) {
        var i = findBadge(n, variant);
        if (i < 0) return;
        if (variant === 'layout') layRevert(n);
        if (variant === 'edit') editRevert(n);
        if (badges[i].node.parentNode) {
            badges[i].node.parentNode.removeChild(badges[i].node);
        }
        if (badges[i].stroke && badges[i].stroke.parentNode) {
            badges[i].stroke.parentNode.removeChild(badges[i].stroke);
        }
        badges.splice(i, 1);
    }

    function markBadge(n, variant, state) {
        var i = (variant === 'edit') ? findEditBadge(n) : findBadge(n, variant);
        if (i < 0) return;
        var b = badges[i];
        if (state === 'saved') {
            if (editByN[n]) editByN[n].saved = true;
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
            if (badges[i].stroke && badges[i].stroke.parentNode) {
                badges[i].stroke.parentNode.removeChild(badges[i].stroke);
            }
        }
        badges = [];
        counter = 0;
        editByN = {};
        layPendingBySel = {};
        layByN = {};
        layHistory = [];
        layHistoryIdx = 0;
        layNudgeRun = null;
        layPostState();
        // Drop any live stroke / pending stroke awaiting a comment.
        if (livePath && livePath.parentNode) livePath.parentNode.removeChild(livePath);
        livePath = null;
        drawing = false;
        drawPts = [];
        pendingStroke = null;
    }

    function onMouseMove(e) {
        if (!active || pinnedTarget) return;
        // Layout sub-mode DOES hover-highlight — it shows which frame a click
        // would grab. Plain edit mode types into leaves; draw owns its SVG.
        if (mode === 'edit' && layoutActive) {
            if (layDrag) return;
            var lt = layTarget(document.elementFromPoint(e.clientX, e.clientY));
            if (!lt || lt === laySel) { if (!lt) hideOverlay(); hoverTarget = null; return; }
            if (lt === hoverTarget) return;
            hoverTarget = lt;
            showOverlay(lt);
            return;
        }
        if (mode === 'edit' || mode === 'draw') return; // edit: contenteditable; draw: SVG handles pointers
        var t = document.elementFromPoint(e.clientX, e.clientY);
        if (!t || isOverlay(t)) return;
        if (t === hoverTarget) return;
        hoverTarget = t;
        showOverlay(t);
    }

    function onClick(e) {
        if (!active) return;
        // Layout sub-mode: swallow the click entirely so dragging a frame that
        // happens to be a link (or a deck's click-to-advance surface) doesn't
        // navigate away mid-gesture.
        if (mode === 'edit' && layoutActive) {
            if (isOverlay(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        // Edit mode uses direct contenteditable typing — let clicks place the
        // caret in the leaf instead of pinning a popup. Draw mode is handled by
        // the SVG pointer handlers.
        if (mode === 'edit' || mode === 'draw') return;
        if (isOverlay(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        var t = e.target;
        if (!t || isOverlay(t)) return;

        pinnedTarget = t;
        showOverlay(t);
        showInput(t);
    }

    // ---- Draw mode (freehand pencil) ----
    function ptsToPathD(pts) {
        if (!pts.length) return '';
        var d = 'M ' + pts[0].x + ' ' + pts[0].y;
        for (var i = 1; i < pts.length; i++) d += ' L ' + pts[i].x + ' ' + pts[i].y;
        return d;
    }

    function strokeBBox(pts) {
        var minX = pts[0].x, minY = pts[0].y, maxX = pts[0].x, maxY = pts[0].y;
        for (var i = 1; i < pts.length; i++) {
            if (pts[i].x < minX) minX = pts[i].x;
            if (pts[i].y < minY) minY = pts[i].y;
            if (pts[i].x > maxX) maxX = pts[i].x;
            if (pts[i].y > maxY) maxY = pts[i].y;
        }
        return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
    }

    function strokeCentroid(pts) {
        var sx = 0, sy = 0;
        for (var i = 0; i < pts.length; i++) { sx += pts[i].x; sy += pts[i].y; }
        return { x: sx / pts.length, y: sy / pts.length };
    }

    // Downsample to at most ~40 points so the serialized path stays compact.
    function downsample(pts, max) {
        if (pts.length <= max) return pts.slice();
        var step = (pts.length - 1) / (max - 1);
        var out = [];
        for (var i = 0; i < max; i++) out.push(pts[Math.round(i * step)]);
        return out;
    }

    function onDrawDown(e) {
        if (!active || mode !== 'draw') return;
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        drawing = true;
        drawPts = [{ x: e.clientX, y: e.clientY }];
        livePath = document.createElementNS(SVGNS, 'path');
        livePath.setAttribute(SENTINEL, '1');
        livePath.setAttribute('d', ptsToPathD(drawPts));
        drawSvg.appendChild(livePath);
        try { drawSvg.setPointerCapture(e.pointerId); } catch (err) {}
    }

    function onDrawMove(e) {
        if (!drawing || mode !== 'draw') return;
        var last = drawPts[drawPts.length - 1];
        // Skip near-duplicate points to keep the stroke light.
        if (last && Math.abs(last.x - e.clientX) < 2 && Math.abs(last.y - e.clientY) < 2) return;
        drawPts.push({ x: e.clientX, y: e.clientY });
        if (livePath) livePath.setAttribute('d', ptsToPathD(drawPts));
    }

    function onDrawUp(e) {
        if (!drawing || mode !== 'draw') return;
        drawing = false;
        try { drawSvg.releasePointerCapture(e.pointerId); } catch (err) {}
        // Ignore a stray tap (no real stroke).
        if (drawPts.length < 2) {
            if (livePath && livePath.parentNode) livePath.parentNode.removeChild(livePath);
            livePath = null;
            drawPts = [];
            return;
        }
        var bbox = strokeBBox(drawPts);
        var c = strokeCentroid(drawPts);
        // Resolve the element under the stroke centroid — the SVG must not
        // intercept the hit-test, so disable its pointer events momentarily.
        var prevPE = drawSvg.style.pointerEvents;
        drawSvg.style.pointerEvents = 'none';
        var el = document.elementFromPoint(c.x, c.y);
        drawSvg.style.pointerEvents = prevPE;
        if (!el || isOverlay(el)) el = document.body;
        pendingStroke = { el: el, pts: drawPts.slice(), bbox: bbox };
        // Keep the live path on screen while the comment popup is open.
        showInput(el);
    }

    function submitComment() {
        var comment = inputField.value.trim();
        // Draw mode: a pending freehand stroke awaiting its note.
        if (pendingStroke) {
            var stroke = pendingStroke;
            pendingStroke = null;
            if (comment) {
                counter += 1;
                var el = stroke.el;
                var anchorRect = el.getBoundingClientRect();
                // The live path becomes the persistent stroke for this badge.
                if (livePath) livePath.setAttribute(SENTINEL, '1');
                placeBadge(el, counter, 'comment', livePath, anchorRect);
                livePath = null;
                var vw = window.innerWidth, vh = window.innerHeight;
                var norm = downsample(stroke.pts, 40).map(function(p) {
                    return { x: +(p.x / vw).toFixed(4), y: +(p.y / vh).toFixed(4) };
                });
                var bb = stroke.bbox;
                var payload = {
                    type: 'annot:add',
                    n: counter,
                    selector: buildSelector(el),
                    info: getInfo(el),
                    comment: comment,
                    href: location.href,
                    kind: 'draw',
                    gesture: 'freehand',
                    path: norm,
                    bbox: {
                        x: +(bb.left / vw).toFixed(4),
                        y: +(bb.top / vh).toFixed(4),
                        w: +(bb.width / vw).toFixed(4),
                        h: +(bb.height / vh).toFixed(4)
                    },
                    viewport: { w: vw, h: vh }
                };
                try { window.parent.postMessage(payload, '*'); } catch (err) {}
            } else {
                // Discarded: drop the live stroke.
                if (livePath && livePath.parentNode) livePath.parentNode.removeChild(livePath);
                livePath = null;
            }
            hideInput();
            hideOverlay();
            hoverTarget = null;
            return;
        }
        var elc = pinnedTarget;
        if (comment && elc) {
            counter += 1;
            placeBadge(elc, counter, 'comment');
            var payloadc = {
                type: 'annot:add',
                n: counter,
                selector: buildSelector(elc),
                info: getInfo(elc),
                comment: comment,
                href: location.href
            };
            try { window.parent.postMessage(payloadc, '*'); } catch (err) {}
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

    // Draw-mode pointer handlers live on the SVG overlay (only it receives
    // pointers while draw mode is active).
    drawSvg.addEventListener('pointerdown', onDrawDown);
    drawSvg.addEventListener('pointermove', onDrawMove);
    drawSvg.addEventListener('pointerup', onDrawUp);
    drawSvg.addEventListener('pointercancel', onDrawUp);

    // ---- Layout sub-mode: move / resize frames ----

    // Only simple idents are safe to interpolate into a selector we write into
    // the source file — anything else falls back to the structural path.
    function isSimpleIdent(s) {
        return typeof s === 'string' && /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(s);
    }

    function isUniqueId(id) {
        try { return document.querySelectorAll('#' + id).length === 1; } catch (err) { return false; }
    }

    // Build a selector that addresses exactly this element in the SAVED file.
    // Prefers a unique #id (at the element or at any ancestor, which truncates
    // the path), otherwise a strict child chain with :nth-of-type. Returns null
    // if the result doesn't resolve back to this single element — better to
    // refuse the save than to move the wrong box.
    // Safe against our own overlay nodes: they are appended at the END of body,
    // so nth-of-type indices of pre-existing elements never shift.
    function buildLayoutSelector(el) {
        if (el.id && isSimpleIdent(el.id) && isUniqueId(el.id)) return '#' + el.id;
        var parts = [];
        var cur = el;
        var guard = 0;
        var hitBody = false;
        while (cur && cur.nodeType === 1 && guard < 40) {
            if (cur === document.body) { hitBody = true; break; }
            var parent = cur.parentElement;
            var part = cur.tagName.toLowerCase();
            if (parent) {
                var same = 0, idx = 0;
                for (var i = 0; i < parent.children.length; i++) {
                    var c = parent.children[i];
                    if (c.tagName !== cur.tagName) continue;
                    same++;
                    if (c === cur) idx = same;
                }
                if (same > 1) part += ':nth-of-type(' + idx + ')';
            }
            if (cur !== el && cur.id && isSimpleIdent(cur.id) && isUniqueId(cur.id)) {
                parts.unshift('#' + cur.id);
                cur = null;
                break;
            }
            parts.unshift(part);
            cur = parent;
            guard++;
        }
        if (!parts.length) return null;
        if (!hitBody && cur !== null) return null; // ran out of guard, path incomplete
        var sel = (hitBody ? 'body > ' : '') + parts.join(' > ');
        var found;
        try { found = document.querySelectorAll(sel); } catch (err) { return null; }
        if (!found || found.length !== 1 || found[0] !== el) return null;
        return sel;
    }

    // Is this node a shape INSIDE an <svg>? (ownerSVGElement is null on the
    // outermost <svg>, which behaves like a normal replaced HTML box.)
    function layIsSvgChild(el) {
        return !!(el && el.ownerSVGElement);
    }

    // Scale of a matrix along each axis, rotation-safe.
    function layCtmScale(m) {
        if (!m) return null;
        var x = Math.sqrt(m.a * m.a + m.b * m.b);
        var y = Math.sqrt(m.c * m.c + m.d * m.d);
        return { x: x || 1, y: y || 1 };
    }

    // Effective scale factors. Ancestor CSS transforms (slide decks scale their
    // stage) mean 1 mouse px != 1 CSS px:
    //   own    — screen px per local px INCLUDING this element's own transform
    //            → converts mouse deltas into width/height deltas
    //   parent — screen px per px of this element's own translate component
    //            → converts mouse deltas into transform translate deltas
    function layScales(el) {
        // Inside an <svg> the numbers are user units, not CSS px, and a viewBox
        // maps them to the screen at whatever ratio the box happens to have.
        // offsetWidth doesn't exist on SVG elements at all, so the HTML path
        // below would silently compute a scale of 1 and every drag would run at
        // the wrong speed. getScreenCTM is the authoritative conversion.
        if (layIsSvgChild(el) && el.getScreenCTM) {
            var own = { x: 1, y: 1 }, par = { x: 1, y: 1 };
            try {
                var so = layCtmScale(el.getScreenCTM());
                if (so) own = so;
                var pn = el.parentNode;
                var sp = (pn && pn.getScreenCTM) ? layCtmScale(pn.getScreenCTM()) : null;
                par = sp || { x: own.x, y: own.y };
            } catch (err) {}
            return { own: own, parent: par };
        }
        var r = el.getBoundingClientRect();
        var ow = el.offsetWidth || r.width || 1;
        var oh = el.offsetHeight || r.height || 1;
        var own2 = { x: (r.width / ow) || 1, y: (r.height / oh) || 1 };
        var par2 = { x: own2.x, y: own2.y };
        var p = el.parentElement;
        if (p) {
            var pr = p.getBoundingClientRect();
            var pw = p.offsetWidth, ph = p.offsetHeight;
            if (pw > 0 && pr.width > 0) par2.x = pr.width / pw;
            if (ph > 0 && pr.height > 0) par2.y = pr.height / ph;
        }
        return { own: own2, parent: par2 };
    }

    // The element's size in its OWN units, before its own transform: offsetWidth
    // for HTML, getBBox for SVG (which has no offset* properties). Multiplying
    // this by the parent scale is what turns it back into screen pixels.
    function layLocalSize(el) {
        if (layIsSvgChild(el) && el.getBBox) {
            try {
                var b = el.getBBox();
                if (b && (b.width || b.height)) return { w: b.width, h: b.height };
            } catch (err) {}
        }
        var r = el.getBoundingClientRect();
        var sc = layScales(el);
        return {
            w: el.offsetWidth || (r.width / (sc.own.x || 1)),
            h: el.offsetHeight || (r.height / (sc.own.y || 1))
        };
    }

    // Current transform as [a,b,c,d,tx,ty]; keeps any rotate/scale the artifact
    // already applies so we only ever rewrite the translate components.
    function layMatrix(el) {
        var t = '';
        try { t = window.getComputedStyle(el).transform || ''; } catch (err) {}
        if (!t || t === 'none') return [1, 0, 0, 1, 0, 0];
        var m = t.match(/matrix\\(([^)]+)\\)/);
        if (m) {
            var v = m[1].split(',').map(function(x) { return parseFloat(x) || 0; });
            if (v.length === 6) return v;
        }
        var m3 = t.match(/matrix3d\\(([^)]+)\\)/);
        if (m3) {
            var v3 = m3[1].split(',').map(function(x) { return parseFloat(x) || 0; });
            if (v3.length === 16) return [v3[0], v3[1], v3[4], v3[5], v3[12], v3[13]];
        }
        return [1, 0, 0, 1, 0, 0];
    }

    // Painted SVG content. Gradients, filters and the like are excluded because
    // they have no box; <defs>/<marker>/<clipPath> content is excluded because
    // it is a template — selecting the arrowhead inside a <marker> would move
    // every arrow at once, and its frame would sit at the origin.
    var LAY_SVG_PAINTED = {
        rect: 1, circle: 1, ellipse: 1, line: 1, polyline: 1, polygon: 1,
        path: 1, text: 1, tspan: 1, image: 1, use: 1, g: 1, foreignobject: 1, svg: 1
    };
    var LAY_SVG_TEMPLATE = {
        defs: 1, marker: 1, clippath: 1, mask: 1, pattern: 1, symbol: 1
    };
    // CSS width/height are geometry properties only on these — on a <path> or a
    // <g> they parse fine and do nothing at all.
    var LAY_SVG_SIZABLE = { rect: 1, image: 1, foreignobject: 1, svg: 1, use: 1 };

    function layTagOf(el) {
        return String(el.tagName || '').toLowerCase();
    }

    function laySvgSelectable(el) {
        if (!LAY_SVG_PAINTED[layTagOf(el)]) return false;
        var n = el.parentElement, guard = 0;
        while (n && guard < 40) {
            if (LAY_SVG_TEMPLATE[layTagOf(n)]) return false;
            if (!layIsSvgChild(n)) break;
            n = n.parentElement;
            guard++;
        }
        var r = el.getBoundingClientRect();
        return r.width > 0 || r.height > 0;
    }

    // Can a resize handle do anything to this element?
    function laySizable(el) {
        if (!layIsSvgChild(el)) return true;
        return !!LAY_SVG_SIZABLE[layTagOf(el)];
    }

    // Resolve the "frame" under the cursor: the nearest ancestor that actually
    // has a box a transform can act on (inline elements ignore transform).
    function layTarget(el) {
        var guard = 0;
        while (el && el.nodeType === 1 && guard < 40) {
            if (isOverlay(el)) return null;
            if (el === document.body || el === document.documentElement) return null;
            // SVG shapes compute to display:inline, but transform DOES apply to
            // them — the inline rule below exists for HTML inlines (<span>),
            // where it genuinely doesn't. Without this branch every click inside
            // a diagram walks straight past the shape it hit and selects the
            // whole <svg>, so no part of a diagram can ever be picked.
            if (layIsSvgChild(el)) {
                if (laySvgSelectable(el)) return el;
            } else {
                var disp = 'block';
                try { disp = window.getComputedStyle(el).display; } catch (err) {}
                if (disp !== 'inline' && disp !== 'contents') return el;
            }
            el = el.parentElement;
            guard++;
        }
        return null;
    }

    function layRound(v) { return Math.round(v * 100) / 100; }

    // z and pos are tri-state: null means "never touched, leave the artifact's
    // own styling alone". We never removeProperty() them — an artifact may carry
    // its own inline position, and stripping it during an unrelated drag would
    // silently break the layout. Undo restores the explicit neutral value
    // instead ('auto' / 'static'), which is also what gets persisted, so the
    // saved rule can't keep asserting a z-order the user has undone.
    function layCloneState(st) {
        return {
            mat: [st.mat[0], st.mat[1], st.mat[2], st.mat[3]],
            dx: st.dx, dy: st.dy, w: st.w, h: st.h,
            rot: st.rot || 0,
            disp: (st.disp === undefined ? null : st.disp),
            // moved/resized gate which declarations get written at all: a frame
            // that was only restacked must not also acquire an identity
            // transform in the saved file.
            moved: !!st.moved, resized: !!st.resized,
            z: (st.z === undefined ? null : st.z),
            pos: (st.pos === undefined ? null : st.pos)
        };
    }

    // Compose the element's own linear transform with the user's rotation:
    // L = R(rot) · M0, so whatever scale/skew/rotate the artifact already had
    // survives and only OUR rotation is layered on top. Returns [a,b,c,d].
    function layComposeLinear(m0, rotDeg) {
        if (!rotDeg) return [m0[0], m0[1], m0[2], m0[3]];
        var r = rotDeg * Math.PI / 180;
        var cs = Math.cos(r), sn = Math.sin(r);
        // CSS matrix(a,b,c,d) is the column-major [[a,c],[b,d]].
        return [
            cs * m0[0] - sn * m0[1],
            sn * m0[0] + cs * m0[1],
            cs * m0[2] - sn * m0[3],
            sn * m0[2] + cs * m0[3]
        ];
    }

    function layApply(el, st) {
        var m = layComposeLinear(st.mat || layBase.mat, st.rot || 0);
        var mat = 'matrix(' + layRound(m[0]) + ',' + layRound(m[1]) + ',' +
            layRound(m[2]) + ',' + layRound(m[3]) + ',' + layRound(st.dx) + ',' + layRound(st.dy) + ')';
        // !important is required, not cosmetic: once a gesture has been saved,
        // the persisted rule in <style data-aimax-layout> is itself !important
        // and would beat a plain inline style — dragging again would then
        // commit correct numbers while the frame visibly refused to move.
        if (st.moved || st.resized || st.rot) el.style.setProperty('transform', mat, 'important');
        // Inside an <svg> both halves of the rotation reference differ from HTML:
        // transform-box defaults to view-box (so the origin resolves against the
        // whole SVG viewport) AND transform-origin defaults to 0 0 instead of
        // 50% 50%. Left alone, a 45° turn threw this deck's MCP pill 457px across
        // the diagram; fill-box alone still left 26px of drift. Both together put
        // the origin at the shape's own centre, which is what layPlaceBox and the
        // rotation handle already assume. Translation is unaffected either way.
        if (layIsSvgChild(el) && (st.moved || st.resized || st.rot)) {
            el.style.setProperty('transform-box', 'fill-box', 'important');
            el.style.setProperty('transform-origin', '50% 50%', 'important');
        }
        if (st.disp !== null && st.disp !== undefined) {
            el.style.setProperty('display', String(st.disp), 'important');
        }
        // width/height are written only once the user has actually resized —
        // a pure move must not freeze an auto-sized box.
        if (st.resized) {
            el.style.setProperty('box-sizing', 'border-box', 'important');
            el.style.setProperty('width', Math.round(st.w) + 'px', 'important');
            el.style.setProperty('height', Math.round(st.h) + 'px', 'important');
        }
        // z-index only bites on a positioned element, so a static one gets
        // position:relative alongside it (relative keeps it exactly where the
        // normal flow put it — nothing moves, it just becomes stackable).
        if (st.pos !== null && st.pos !== undefined) {
            el.style.setProperty('position', String(st.pos), 'important');
        }
        if (st.z !== null && st.z !== undefined) {
            el.style.setProperty('z-index', String(st.z), 'important');
        }
        layStates.set(el, layCloneState(st));
    }

    // The frame tracks the element's own box, not its axis-aligned bounding box:
    // once rotated those differ, and handles on the bounding box would drag
    // along the wrong axes. Rotation is about the centre (the default
    // transform-origin), and rotation doesn't move the centre — so the centre of
    // the bounding rect is still the centre of the element.
    function layPlaceBox() {
        if (!laySel || !layBase) { layBox.style.display = 'none'; return; }
        var r = laySel.getBoundingClientRect();
        var sc = layScales(laySel);
        var ls = layLocalSize(laySel);
        var w = ls.w * (sc.parent.x || 1);
        var h = ls.h * (sc.parent.y || 1);
        var cx = r.left + r.width / 2;
        var cy = r.top + r.height / 2;
        layBox.style.display = 'block';
        layBox.style.left = (cx - w / 2) + 'px';
        layBox.style.top = (cy - h / 2) + 'px';
        layBox.style.width = w + 'px';
        layBox.style.height = h + 'px';
        layBox.style.transform = layBase.rot ? ('rotate(' + layRound(layBase.rot) + 'deg)') : '';
        laySizeLbl.textContent = laySel.tagName.toLowerCase() + '  ' +
            Math.round(layBase.w) + '×' + Math.round(layBase.h) +
            (layBase.rot ? ('  ' + Math.round(layBase.rot) + '°') : '') +
            '  Δ' + Math.round(layBase.dx) + ',' + Math.round(layBase.dy);
    }

    function laySelect(el) {
        laySel = el || null;
        if (!laySel) {
            layBase = null;
            layBox.style.display = 'none';
            return;
        }
        if (!layOriginalStyle.has(laySel)) {
            layOriginalStyle.set(laySel, laySel.getAttribute('style'));
        }
        // Re-selecting an element already touched in this session must resume
        // from the state we applied, not from a fresh read of the DOM — the two
        // agree numerically, but only the stored one carries the resized flag.
        var known = layStates.get(laySel);
        if (known) {
            layBase = layCloneState(known);
        } else {
            var m = layMatrix(laySel);
            var ls0 = layLocalSize(laySel);
            layBase = {
                mat: [m[0], m[1], m[2], m[3]],
                dx: m[4],
                dy: m[5],
                w: ls0.w,
                h: ls0.h,
                resized: !!(laySel.style.width && laySel.style.height)
            };
        }
        hideOverlay();
        layPlaceBox();
    }

    // Push an element's current geometry to the host. Repeated gestures on the
    // same element reuse one badge / one pending entry (last state wins).
    function layPublish(el) {
        var sel = buildLayoutSelector(el);
        if (!sel) {
            showToast('Cannot address this element uniquely — move not saved', 'error');
            return null;
        }
        var st = layStates.get(el);
        var css = {};
        if (st && (st.moved || st.resized || st.rot)) css['transform'] = el.style.transform;
        // Must travel with the transform: without them the saved file would
        // rotate the shape about the SVG viewport's top-left, i.e. somewhere
        // else entirely.
        if (st && layIsSvgChild(el) && (st.moved || st.resized || st.rot)) {
            css['transform-box'] = 'fill-box';
            css['transform-origin'] = '50% 50%';
        }
        if (st && st.disp !== null && st.disp !== undefined) css['display'] = String(st.disp);
        if (st && st.resized) {
            css['box-sizing'] = 'border-box';
            css['width'] = el.style.width;
            css['height'] = el.style.height;
        }
        if (st && st.z !== null && st.z !== undefined) css['z-index'] = String(st.z);
        if (st && st.pos !== null && st.pos !== undefined) css['position'] = String(st.pos);
        var n = layPendingBySel[sel];
        if (!n) {
            counter += 1;
            n = counter;
            layPendingBySel[sel] = n;
            layByN[n] = { el: el, selector: sel };
            placeBadge(el, n, 'layout');
        } else {
            // Re-dragging an already-saved element: badge goes live again.
            var bi = findBadge(n, 'layout');
            if (bi >= 0) {
                badges[bi].node.className = '__aimax-badge edit layout';
                badges[bi].node.setAttribute(SENTINEL, '1');
            }
        }
        try {
            window.parent.postMessage({
                type: 'edit:layout',
                n: n,
                selector: sel,
                css: css,
                href: location.href
            }, '*');
        } catch (err) {}
        return n;
    }

    // Drop an element's pending layout entry entirely (used when undo walks it
    // back to the geometry it had before the first gesture): tell the host to
    // forget it, and let removeBadge restore the pre-gesture inline style.
    function layDropPending(el) {
        var sel = buildLayoutSelector(el);
        var n = sel ? layPendingBySel[sel] : 0;
        if (!n) return;
        try { window.parent.postMessage({ type: 'edit:remove', n: n }, '*'); } catch (err) {}
        removeBadge(n, 'layout');
    }

    // Record one gesture. kind='nudge' coalesces consecutive arrow-key steps
    // on the same element into a single entry, so a held key doesn't bury the
    // history under one entry per pixel.
    function layRecord(el, before, after, kind) {
        var last = layHistory[layHistoryIdx - 1];
        if (kind === 'nudge' && layNudgeRun === el && last && last.el === el) {
            last.after = layCloneState(after);
        } else {
            if (layHistory.length > layHistoryIdx) layHistory.length = layHistoryIdx;
            layHistory.push({ el: el, before: layCloneState(before), after: layCloneState(after) });
            layHistoryIdx = layHistory.length;
        }
        layNudgeRun = (kind === 'nudge') ? el : null;
    }

    // After moving the history pointer, an element either still has an applied
    // gesture (republish its geometry) or is back to square one (drop it).
    function layAfterHistoryMove(el) {
        var stillApplied = false;
        for (var i = 0; i < layHistoryIdx; i++) {
            if (layHistory[i].el === el) { stillApplied = true; break; }
        }
        if (stillApplied) { layPublish(el); } else { layDropPending(el); }
        if (el === laySel) layPlaceBox();
        repositionBadges();
        layPostState();
    }

    function layUndo() {
        if (layHistoryIdx <= 0) return;
        layNudgeRun = null;
        var e = layHistory[--layHistoryIdx];
        layApply(e.el, e.before);
        if (e.el === laySel) { layBase = layCloneState(e.before); } else { laySelect(e.el); }
        layAfterHistoryMove(e.el);
    }

    function layRedo() {
        if (layHistoryIdx >= layHistory.length) return;
        layNudgeRun = null;
        var e = layHistory[layHistoryIdx++];
        layApply(e.el, e.after);
        if (e.el === laySel) { layBase = layCloneState(e.after); } else { laySelect(e.el); }
        layAfterHistoryMove(e.el);
    }

    // ---- z-order (send to back / bring to front, on the artifact's elements) ----

    // Effective stacking number of an element, 'auto' counting as 0 — which is
    // what it behaves like against other positioned siblings.
    function layZOf(el) {
        var v = 'auto';
        try { v = window.getComputedStyle(el).zIndex; } catch (err) {}
        var n = parseInt(v, 10);
        return isNaN(n) ? 0 : n;
    }

    // Nearest common ancestor — the element whose stacking context is the one
    // where these two actually compete for paint order.
    function layLca(a, b) {
        var n = a;
        var guard = 0;
        while (n && guard < 80) {
            if (n.contains(b)) return n;
            n = n.parentElement;
            guard++;
        }
        return document.body;
    }

    // Why an element establishes a stacking context, or null if it doesn't.
    // This is the whole reason a z-index can "not work": inside such an ancestor
    // a descendant's z-index is only ever compared with its context siblings —
    // it can never out-rank anything painted outside it, at any value.
    function layStackingReason(n) {
        var s;
        try { s = window.getComputedStyle(n); } catch (err) { return null; }
        if (s.transform && s.transform !== 'none') return 'transform';
        if (s.filter && s.filter !== 'none') return 'filter';
        if (s.perspective && s.perspective !== 'none') return 'perspective';
        if (parseFloat(s.opacity) < 1) return 'opacity ' + s.opacity;
        if (s.isolation === 'isolate') return 'isolation';
        if (s.mixBlendMode && s.mixBlendMode !== 'normal') return 'mix-blend-mode';
        if (s.willChange && /transform|opacity|filter|perspective/.test(s.willChange)) return 'will-change';
        if (s.contain && /paint|layout|strict|content/.test(s.contain)) return 'contain';
        if (s.position === 'fixed' || s.position === 'sticky') return 'position: ' + s.position;
        if (s.position !== 'static' && s.zIndex !== 'auto') return 'z-index on a positioned box';
        return null;
    }

    // First trapping ancestor strictly between el and the shared context, if any.
    function layTrapBetween(el, lca) {
        var n = el.parentElement;
        var guard = 0;
        while (n && n !== lca && guard < 80) {
            var why = layStackingReason(n);
            if (why) return { el: n, why: why };
            n = n.parentElement;
            guard++;
        }
        return null;
    }

    // Stacking numbers along a contender's chain up to the shared context. The
    // contender itself may be a deeply nested child, but what the shared context
    // ranks is its whole branch — so every z on the way up is a number we may
    // have to beat.
    function layChainZ(node, lca) {
        var max = 0, min = 0;
        var n = node;
        var guard = 0;
        while (n && n !== lca && guard < 80) {
            var v = layZOf(n);
            if (v > max) max = v;
            if (v < min) min = v;
            n = n.parentElement;
            guard++;
        }
        return { max: max, min: min };
    }

    // No regex here on purpose: this whole client ships as a template literal, so
    // a \\s in the source reaches the browser as a plain 's' and the split would
    // silently cut class names on the letter s.
    // All class tokens, not just the first: the blocked box and the ancestor
    // blocking it are frequently two cards sharing a layout class, and naming
    // both '<div.card>' makes the message unreadable.
    function layDescribe(n) {
        var cls = '';
        try {
            var c = n.className;
            if (c && typeof c === 'string' && c.length) {
                var parts = c.split(' ');
                for (var i = 0; i < parts.length && cls.length < 40; i++) {
                    if (parts[i]) cls += '.' + parts[i];
                }
            }
        } catch (err) {}
        return '<' + n.tagName.toLowerCase() + cls + '>';
    }

    // dir: 'front' | 'forward' | 'backward' | 'back'. Steps are computed against
    // the elements this frame ACTUALLY overlaps, wherever they sit in the tree —
    // once a frame has been dragged, the box it covers is almost never a sibling
    // (a card in the next column is a cousin), and ranking against siblings
    // alone both refuses valid restacks and picks numbers too low to win.
    function layZOrder(dir) {
        if (!laySel || !layBase) { showToast('Select a frame first', 'error'); return; }
        var el = laySel;
        // Stacking only decides who paints on top where two elements share
        // pixels. In a normal flow nothing overlaps, so the rule would be
        // written and change nothing visible — say so instead of looking broken.
        var over = layOverlapping(el);
        if (!over.length) {
            showToast('Nothing overlaps this frame, so stacking order has no visible effect — drag it over another one first', 'error');
            return;
        }
        // Contenders split in two: those this frame can actually out-rank, and
        // those sealed off behind a stacking context on the way up — for which
        // NO z-index value works, not even 999. Both groups matter: ranking is
        // computed from the reachable ones, and the unreachable ones are what
        // the user has to be told about, or the frame stays visibly buried while
        // the button reports success.
        var sibs = [];
        var trap = null;
        var blocked = null;
        for (var i = 0; i < over.length; i++) {
            var lca = layLca(el, over[i]);
            var t = layTrapBetween(el, lca);
            if (t) { if (!trap) { trap = t; blocked = over[i]; } continue; }
            var ch = layChainZ(over[i], lca);
            sibs.push(ch.max);
            if (ch.min !== ch.max) sibs.push(ch.min);
        }
        if (!sibs.length) {
            // Every contender is outside a stacking context this frame is sealed
            // into. No z-index on the frame can cross that boundary — say which
            // ancestor is responsible instead of writing a rule that does nothing.
            showToast(trap
                ? 'Can\\'t restack over ' + layDescribe(blocked) + ': ' + layDescribe(trap.el) + ' creates a stacking context (' + trap.why + '), so this frame can never paint outside it — restack ' + layDescribe(trap.el) + ' instead'
                : 'Nothing to stack against here', 'error');
            return;
        }
        var mine = layZOf(el);
        var target;
        if (dir === 'front') {
            target = Math.max.apply(null, sibs) + 1;
        } else if (dir === 'back') {
            target = Math.min.apply(null, sibs) - 1;
        } else if (dir === 'forward') {
            var above = [];
            for (var a = 0; a < sibs.length; a++) if (sibs[a] > mine) above.push(sibs[a]);
            if (!above.length) { showToast('Already at the front', 'success'); return; }
            target = Math.min.apply(null, above) + 1;
        } else {
            var below = [];
            for (var b = 0; b < sibs.length; b++) if (sibs[b] < mine) below.push(sibs[b]);
            if (!below.length) { showToast('Already at the back', 'success'); return; }
            target = Math.max.apply(null, below) - 1;
        }
        if (target === mine) return;

        var before = layCloneState(layBase);
        if (before.z === null) before.z = 'auto';
        var isStatic = false;
        try { isStatic = window.getComputedStyle(el).position === 'static'; } catch (err) {}
        if (isStatic) {
            if (before.pos === null) before.pos = 'static';
            layBase.pos = 'relative';
        }
        layBase.z = target;
        layApply(el, layBase);
        layPlaceBox();
        repositionBadges();
        layRecord(el, before, layBase, 'z');
        layPublish(el);
        layPostState();
        // Partial win: the restack succeeded against everything it could reach,
        // but at least one overlapped box lives outside a stacking context this
        // frame is sealed into. Without this the button would look broken —
        // "brought to front", frame still buried.
        if (trap) {
            showToast('Restacked (z-index ' + target + '), but still behind ' + layDescribe(blocked) +
                ' — ' + layDescribe(trap.el) + ' creates a stacking context (' + trap.why +
                '), which no z-index on this frame can cross. Restack ' + layDescribe(trap.el) + ' instead.', 'error');
        }
    }

    // ---- Awareness of what is ALREADY in the file ----
    // The served page carries the <style data-aimax-layout> block verbatim, so
    // the client can read it to know which frames already have a saved override
    // — without it, "revert" could only drop the pending write and the frame
    // would snap back to its SAVED position while claiming to be original.
    function laySavedBlock() {
        try {
            var els = document.querySelectorAll('style[data-aimax-layout]');
            return els.length ? els[els.length - 1] : null;
        } catch (err) { return null; }
    }

    function laySavedRuleIndex(sel) {
        var st = laySavedBlock();
        if (!st || !st.sheet) return -1;
        var rules;
        try { rules = st.sheet.cssRules || []; } catch (err) { return -1; }
        for (var i = 0; i < rules.length; i++) {
            if (rules[i].selectorText === sel) return i;
        }
        return -1;
    }

    // Drop the live rule too, so what the user sees after a revert is exactly
    // what the file will contain once saved.
    function laySavedDelete(sel) {
        var st = laySavedBlock();
        var idx = laySavedRuleIndex(sel);
        if (!st || !st.sheet || idx < 0) return false;
        try { st.sheet.deleteRule(idx); return true; } catch (err) { return false; }
    }

    // Which elements does this frame actually share pixels with? Two boxes need
    // a few px of overlap in BOTH axes to be contesting the same area.
    //
    // Scoped to the whole document, not to el.parentElement.children: the point
    // of dragging a frame is to put it somewhere it wasn't, which almost always
    // means it now covers a cousin — a card in the next column, a box in another
    // wrapper. Ancestors and descendants are excluded (they contain or are
    // contained, they never contest), as are our own overlay nodes.
    function layOverlapping(el) {
        var a = el.getBoundingClientRect();
        if (a.width < 2 || a.height < 2) return [];
        var out = [];
        var all;
        try { all = document.body.getElementsByTagName('*'); } catch (err) { return []; }
        // Rect reads only — one layout pass. getComputedStyle is deferred to the
        // few boxes that actually overlap, so a 3000-element deck stays cheap.
        var cap = Math.min(all.length, 6000);
        for (var i = 0; i < cap; i++) {
            var c = all[i];
            if (c === el || isOverlay(c)) continue;
            if (c.contains(el) || el.contains(c)) continue;
            var r = c.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            var ox = Math.min(a.right, r.right) - Math.max(a.left, r.left);
            var oy = Math.min(a.bottom, r.bottom) - Math.max(a.top, r.top);
            if (ox > 4 && oy > 4) out.push(c);
        }
        // An invisible box paints nothing, so out-ranking it means nothing.
        var vis = [];
        for (var j = 0; j < out.length; j++) {
            var s = null;
            try { s = window.getComputedStyle(out[j]); } catch (err) {}
            if (s && (s.visibility === 'hidden' || s.visibility === 'collapse' || parseFloat(s.opacity) === 0)) continue;
            vis.push(out[j]);
        }
        return vis;
    }

    function layHasChanges(el) {
        if (!el) return false;
        if (layStates.has(el)) return true;
        var sel = buildLayoutSelector(el);
        if (!sel) return false;
        if (layPendingBySel[sel]) return true;
        return laySavedRuleIndex(sel) >= 0;
    }

    // Delete is non-destructive by construction: the markup stays, the frame is
    // hidden with display:none. Undo brings it back, and "Back to original"
    // removes the rule entirely — nothing is ever cut out of the file.
    function layDeleteSelection() {
        if (!laySel || !layBase) { showToast('Select a frame first', 'error'); return; }
        var el = laySel;
        if (layBase.disp === 'none') { showToast('Already hidden', 'error'); return; }
        var before = layCloneState(layBase);
        if (before.disp === null) {
            var shown = 'block';
            try { shown = window.getComputedStyle(el).display || 'block'; } catch (err) {}
            before.disp = shown;
        }
        layBase.disp = 'none';
        layApply(el, layBase);
        layRecord(el, before, layBase, 'delete');
        layPublish(el);
        // A hidden element has no box to draw a frame around.
        laySelect(null);
        layPostState();
        showToast('Frame hidden — ⌘Z to bring it back', 'success');
    }

    // Revert the selected frame to how the artifact itself lays it out: forget
    // this session's gestures AND queue the removal of any override already
    // written to the file.
    function layResetSelection() {
        if (!laySel) { showToast('Select a frame first', 'error'); return; }
        var el = laySel;
        var sel = buildLayoutSelector(el);
        var wasSaved = sel ? (laySavedRuleIndex(sel) >= 0) : false;
        var kept = [];
        for (var i = 0; i < layHistory.length; i++) {
            if (layHistory[i].el !== el) kept.push(layHistory[i]);
        }
        var removedBefore = 0;
        for (var j = 0; j < layHistoryIdx; j++) {
            if (layHistory[j].el === el) removedBefore++;
        }
        layHistory = kept;
        layHistoryIdx = Math.max(0, layHistoryIdx - removedBefore);
        layNudgeRun = null;
        layStates.delete(el);
        layDropPending(el);          // restores the pre-gesture inline style
        if (wasSaved) {
            laySavedDelete(sel);
            // A removal is still a pending write: it needs its own badge and its
            // own slot in the Save counter, or the file would keep the override.
            counter += 1;
            var n = counter;
            layPendingBySel[sel] = n;
            layByN[n] = { el: el, selector: sel };
            placeBadge(el, n, 'layout');
            try {
                window.parent.postMessage({
                    type: 'edit:layout',
                    n: n,
                    selector: sel,
                    css: {},
                    remove: true,
                    href: location.href
                }, '*');
            } catch (err) {}
            showToast('Saved override queued for removal — press Save', 'success');
        }
        laySelect(el);
        layPostState();
    }

    // Snapshot whatever the user is working on, whichever mode we're leaving.
    function carryCapture() {
        var el = null;
        if (mode === 'edit' && layoutActive) {
            el = laySel;
        } else if (mode === 'edit') {
            // In text mode the caret sits in a leaf (possibly a temporary
            // fragment span) — carry the frame that CONTAINS it, since that's
            // what Move/Resize can act on.
            el = layTarget(lastEditedEl);
        } else {
            el = pinnedTarget || null;
        }
        if (!el) return;
        var sel = buildLayoutSelector(el);
        if (sel) carrySelector = sel;
    }

    function carryResolve() {
        if (!carrySelector) return null;
        try { return document.querySelector(carrySelector); } catch (err) { return null; }
    }

    // Put the caret back where the user was, so Move → Text lands on the same
    // element instead of making them hunt for it again.
    function carryFocusText(el) {
        if (!el) return;
        var t = null;
        if (el.classList && el.classList.contains('__aimax-editable')) {
            t = el;
        } else if (el.querySelector) {
            t = el.querySelector('.__aimax-editable');
        }
        if (t && t.focus) { try { t.focus(); } catch (err) {} }
    }

    function layPostState() {
        try {
            window.parent.postMessage({
                type: 'edit:layout-state',
                canUndo: layHistoryIdx > 0,
                canRedo: layHistoryIdx < layHistory.length,
                hasSelection: !!laySel,
                hasChanges: layHasChanges(laySel)
            }, '*');
        } catch (err) {}
    }

    // Discarding a layout badge restores the element to how it looked when it
    // was first grabbed, and drops the pending entry host-side.
    function layRevert(n) {
        var rec = layByN[n];
        if (!rec) return;
        delete layByN[n];
        delete layPendingBySel[rec.selector];
        var snap = layOriginalStyle.get(rec.el);
        if (snap === null || snap === undefined) {
            rec.el.removeAttribute('style');
        } else {
            rec.el.setAttribute('style', snap);
        }
        // Keep the pre-gesture snapshot: a later drag on the same element must
        // still be able to revert to the artifact's original styling.
        if (rec.el === laySel) laySelect(rec.el);
    }

    // ---- Alignment snapping ----
    // Targets are collected ONCE per drag: they can't move while the pointer is
    // down, and re-measuring every pointermove would thrash layout.
    var LAY_SNAP_PX = 6;

    function laySnapEdges(r) {
        return {
            v: [r.left, (r.left + r.right) / 2, r.right],
            h: [r.top, (r.top + r.bottom) / 2, r.bottom]
        };
    }

    function laySnapCollect(el) {
        var out = [];
        var p = el.parentElement;
        if (!p) return out;
        out.push(laySnapEdges(p.getBoundingClientRect()));
        for (var i = 0; i < p.children.length; i++) {
            var c = p.children[i];
            if (c === el || isOverlay(c)) continue;
            var r = c.getBoundingClientRect();
            if (r.width < 1 && r.height < 1) continue;
            out.push(laySnapEdges(r));
        }
        return out;
    }

    function layHideGuides() {
        layGuideV.style.display = 'none';
        layGuideH.style.display = 'none';
    }

    // Nudge the raw screen delta so an edge or centre lands exactly on a
    // neighbour's. ⌥ suspends it for when the eyeballed position is the point.
    function laySnapDelta(dxm, dym, disabled) {
        if (disabled || !layDrag || !layDrag.snap) { layHideGuides(); return { dx: dxm, dy: dym }; }
        var r0 = layDrag.rect0;
        var mv = [r0.left + dxm, (r0.left + r0.right) / 2 + dxm, r0.right + dxm];
        var mh = [r0.top + dym, (r0.top + r0.bottom) / 2 + dym, r0.bottom + dym];
        var bestV = null, bestH = null;
        for (var t = 0; t < layDrag.snap.length; t++) {
            var tgt = layDrag.snap[t];
            for (var a = 0; a < 3; a++) {
                for (var b = 0; b < 3; b++) {
                    var dv = tgt.v[b] - mv[a];
                    if (Math.abs(dv) <= LAY_SNAP_PX && (!bestV || Math.abs(dv) < Math.abs(bestV.d))) {
                        bestV = { d: dv, at: tgt.v[b] };
                    }
                    var dh = tgt.h[b] - mh[a];
                    if (Math.abs(dh) <= LAY_SNAP_PX && (!bestH || Math.abs(dh) < Math.abs(bestH.d))) {
                        bestH = { d: dh, at: tgt.h[b] };
                    }
                }
            }
        }
        if (bestV) {
            dxm += bestV.d;
            layGuideV.style.display = 'block';
            layGuideV.style.left = bestV.at + 'px';
        } else {
            layGuideV.style.display = 'none';
        }
        if (bestH) {
            dym += bestH.d;
            layGuideH.style.display = 'block';
            layGuideH.style.top = bestH.at + 'px';
        } else {
            layGuideH.style.display = 'none';
        }
        return { dx: dxm, dy: dym };
    }

    function layStartDrag(handle, e) {
        var r = laySel.getBoundingClientRect();
        var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        layDrag = {
            handle: handle,
            x0: e.clientX,
            y0: e.clientY,
            cx: cx,
            cy: cy,
            // Angle of the grab point around the centre: rotation tracks the
            // DELTA from it, so the handle never jumps to the cursor.
            a0: Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI,
            rect0: r,
            snap: (handle === 'move') ? laySnapCollect(laySel) : null,
            start: layCloneState(layBase),
            sc: layScales(laySel),
            moved: false
        };
    }

    function onLayDown(e) {
        if (!active || mode !== 'edit' || !layoutActive) return;
        if (e.button !== undefined && e.button !== 0) return;
        var t = e.target;
        var handle = (t && t.getAttribute) ? t.getAttribute('data-aimax-h') : null;
        // Clicks on AIMax's own chrome (panel, toolbar) stay interactive.
        if (!handle && isOverlay(t)) return;
        e.preventDefault();
        e.stopPropagation();
        if (handle) {
            if (!laySel) return;
            // On a <path>/<g>/<text> the width/height we'd write parse fine and
            // do nothing — CSS geometry properties only exist on <rect>, <image>,
            // <use>, <svg> and <foreignObject>. Refusing beats a handle that
            // drags and leaves the shape exactly where it was.
            if (handle !== 'rot' && !laySizable(laySel)) {
                showToast('<' + layTagOf(laySel) + '> has no CSS width/height — move and rotate work on it, resize does not', 'error');
                return;
            }
            layStartDrag(handle, e);
            return;
        }
        var el = layTarget(t);
        // Selection alone changes what the panel's buttons may act on, so the
        // state goes out on plain clicks too — not just when a gesture lands.
        if (!el) { laySelect(null); layPostState(); return; }
        if (el !== laySel) { laySelect(el); layPostState(); }
        layStartDrag('move', e);
    }

    function onLayMove(e) {
        if (!layDrag || !laySel || !layBase) return;
        var dxm = e.clientX - layDrag.x0;
        var dym = e.clientY - layDrag.y0;
        if (!layDrag.moved && (Math.abs(dxm) + Math.abs(dym)) < 3) return;
        layDrag.moved = true;
        var s = layDrag.start, sc = layDrag.sc;
        // Any drag (move or handle) means the transform is now the user's.
        s.moved = true;
        var st = layCloneState(s);
        var h = layDrag.handle;

        if (h === 'rot') {
            // Rotation: follow the cursor around the centre, ⇧ snaps to 15°.
            var ang = Math.atan2(e.clientY - layDrag.cy, e.clientX - layDrag.cx) * 180 / Math.PI;
            var rot = (s.rot || 0) + (ang - layDrag.a0);
            if (e.shiftKey) rot = Math.round(rot / 15) * 15;
            // Keep it readable in the size chip.
            rot = ((rot % 360) + 360) % 360;
            if (rot > 180) rot -= 360;
            st.rot = rot;
            layBase.rot = rot;
            layApply(laySel, st);
            layPlaceBox();
            repositionBadges();
            return;
        }

        if (h === 'move') {
            var snapped = laySnapDelta(dxm, dym, e.altKey);
            st.dx = s.dx + snapped.dx / (sc.parent.x || 1);
            st.dy = s.dy + snapped.dy / (sc.parent.y || 1);
        } else {
            st.resized = true;
            // Handles live on the element's own axes, so a rotated frame needs
            // the mouse delta rotated back into local space — otherwise dragging
            // the right edge of a tilted box widens it diagonally.
            var rr = (s.rot || 0) * Math.PI / 180;
            var cs = Math.cos(rr), sn = Math.sin(rr);
            var lx = (dxm * cs + dym * sn) / (sc.own.x || 1);
            var ly = (-dxm * sn + dym * cs) / (sc.own.y || 1);
            if (h.indexOf('e') >= 0) st.w = Math.max(16, s.w + lx);
            if (h.indexOf('s') >= 0) st.h = Math.max(16, s.h + ly);
            if (h.indexOf('w') >= 0) st.w = Math.max(16, s.w - lx);
            if (h.indexOf('n') >= 0) st.h = Math.max(16, s.h - ly);
            // ⇧ on a corner keeps the original proportions, driven by whichever
            // axis the user pulled further.
            var corner = h.length === 2;
            if (e.shiftKey && corner && s.w > 0 && s.h > 0) {
                var ratio = s.h / s.w;
                if (Math.abs(st.w - s.w) * ratio >= Math.abs(st.h - s.h)) {
                    st.h = Math.max(16, st.w * ratio);
                } else {
                    st.w = Math.max(16, st.h / ratio);
                }
            }
            // The opposite edge must stay put: shrinking from N/W moves the box
            // by the same visual amount, along the element's rotated axes.
            var ddx = 0, ddy = 0;
            if (h.indexOf('w') >= 0) ddx = (s.w - st.w) * (sc.own.x || 1);
            if (h.indexOf('n') >= 0) ddy = (s.h - st.h) * (sc.own.y || 1);
            if (ddx || ddy) {
                st.dx = s.dx + (ddx * cs - ddy * sn) / (sc.parent.x || 1);
                st.dy = s.dy + (ddx * sn + ddy * cs) / (sc.parent.y || 1);
            }
        }
        layBase.dx = st.dx; layBase.dy = st.dy;
        layBase.w = st.w; layBase.h = st.h;
        layBase.moved = st.moved; layBase.resized = st.resized;
        layBase.rot = st.rot;
        layApply(laySel, st);
        layPlaceBox();
        repositionBadges();
    }

    function onLayUp() {
        if (!layDrag) return;
        var moved = layDrag.moved;
        var before = layDrag.start;
        layDrag = null;
        if (!moved || !laySel) return;
        layRecord(laySel, before, layBase, 'drag');
        layPublish(laySel);
        layPostState();
    }

    // Arrow keys nudge the selection (Shift = 10px); Escape drops it;
    // Cmd/Ctrl+Z undoes, Cmd/Ctrl+Shift+Z (or Ctrl+Y) redoes.
    function onLayKeydown(e) {
        if (!active || mode !== 'edit' || !layoutActive) return false;
        var accel = e.metaKey || e.ctrlKey;
        if (accel && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
            e.preventDefault();
            e.stopPropagation();
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
            if (e.key === 'y' || e.key === 'Y' || e.shiftKey) { layRedo(); } else { layUndo(); }
            return true;
        }
        if (!laySel || !layBase) return false;
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            e.stopPropagation();
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
            layDeleteSelection();
            return true;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            laySelect(null);
            layPostState();
            return true;
        }
        var step = e.shiftKey ? 10 : 1;
        var d = null;
        if (e.key === 'ArrowLeft') d = [-step, 0];
        else if (e.key === 'ArrowRight') d = [step, 0];
        else if (e.key === 'ArrowUp') d = [0, -step];
        else if (e.key === 'ArrowDown') d = [0, step];
        if (!d) return false;
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        var before = layCloneState(layBase);
        // Both sides carry moved: undoing a nudge has to be able to write the
        // earlier transform back, not just stop writing one.
        before.moved = true;
        layBase.moved = true;
        layBase.dx += d[0];
        layBase.dy += d[1];
        layApply(laySel, layBase);
        layPlaceBox();
        repositionBadges();
        layRecord(laySel, before, layBase, 'nudge');
        layPublish(laySel);
        layPostState();
        return true;
    }

    document.addEventListener('pointerdown', onLayDown, true);
    window.addEventListener('pointermove', onLayMove, true);
    window.addEventListener('pointerup', onLayUp, true);
    window.addEventListener('pointercancel', onLayUp, true);

    // ---- Direct in-place editing (edit mode) ----
    // Snapshot a leaf when it gains focus so blur can diff against the original.
    function onEditFocusIn(e) {
        if (!active || mode !== 'edit') return;
        var el = e.target;
        if (!el || !el.classList || !el.classList.contains('__aimax-editable')) return;
        lastEditedEl = el;
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
        // Layout sub-mode has no editable leaves — arrows nudge the selection.
        if (layoutActive) { onLayKeydown(e); return; }
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

    // ---- Copying text out of the viewer ----
    // The selection lives in THIS document, and only this document can read it:
    // the Browser Panel holds the page in a cross-origin iframe, so the panel's
    // own copy handler could never see it (it was attached to
    // frame.contentDocument, which always throws) and its fallback read the
    // panel's empty selection instead. VS Code's webview also swallows the
    // native Cmd/Ctrl+C, so the text is handed to the host explicitly.
    // Runs whether or not annotation mode is on — copying is not a mode.
    function forwardSelection() {
        var sel = '';
        try { sel = (document.getSelection && document.getSelection().toString()) || ''; } catch (err) {}
        if (!sel) return;
        try { window.parent.postMessage({ command: 'copyToClipboard', text: sel }, '*'); } catch (err) {}
    }

    document.addEventListener('keydown', function(e) {
        if (!(e.metaKey || e.ctrlKey)) return;
        if (e.key !== 'c' && e.key !== 'C') return;
        forwardSelection();
    }, true);
    // Covers right-click ▸ Copy and any programmatic copy as well.
    document.addEventListener('copy', function() { forwardSelection(); }, true);

    // Abort and clear any in-progress / pending freehand stroke.
    function cancelPendingDraw() {
        drawing = false;
        drawPts = [];
        pendingStroke = null;
        if (livePath && livePath.parentNode) livePath.parentNode.removeChild(livePath);
        livePath = null;
    }

    function setActive(on, nextMode, nextNotes, nextLayout) {
        // Capture BEFORE anything changes: disableInlineEditing() below unwraps
        // the temporary spans, and the element we want to carry may be one.
        if (active) carryCapture();
        active = !!on;
        var requestedMode = (nextMode === 'edit') ? 'edit' : (nextMode === 'draw' ? 'draw' : 'comment');
        mode = active ? requestedMode : 'comment';
        layoutActive = !!nextLayout && mode === 'edit';
        if (!layoutActive) {
            layDrag = null;
            laySelect(null);
        }
        var requestedNotes = !!nextNotes && mode === 'edit' && !layoutActive;
        if (requestedNotes !== notesActive) {
            notesActive = requestedNotes;
            applyNotesReveal(notesActive);
        } else if (!active && notesActive) {
            notesActive = false;
            applyNotesReveal(false);
        }
        // Notes mode on a deck with no .speaker-notes blocks reveals nothing and
        // makes nothing editable — report the count so the panel can say so
        // instead of showing an empty page and an instruction that can't apply.
        if (notesActive) {
            var noteCount = 0;
            try { noteCount = document.querySelectorAll('.speaker-notes').length; } catch (err) {}
            try { window.parent.postMessage({ type: 'edit:notes-state', count: noteCount }, '*'); } catch (err) {}
            if (!noteCount) {
                showToast('This artifact has no speaker notes (.speaker-notes blocks)', 'error');
            }
        }
        // Leaving draw mode (or deactivating): drop any unsaved stroke.
        if (mode !== 'draw') cancelPendingDraw();
        if (active) {
            document.body.classList.add('__aimax-active');
            document.body.classList.toggle('draw', mode === 'draw');
            if (mode === 'edit') {
                document.body.classList.add('edit');
                document.body.classList.toggle('layout', layoutActive);
                // Re-scan leaves each time: a notes toggle changes which leaves
                // are eligible (.speaker-notes only vs all text leaves).
                hideOverlay();
                hideInput();
                pinnedTarget = null;
                // Layout and text editing are mutually exclusive: contenteditable
                // would swallow the drag gestures (and the wrapper spans would
                // break the selectors we address frames with).
                disableInlineEditing();
                if (!layoutActive) enableInlineEditing();
                // Re-acquire whatever the user was working on before the switch.
                var carried = carryResolve();
                if (layoutActive) {
                    if (carried) laySelect(carried);
                    // Entering the sub-mode: hand the panel the current
                    // undo/redo state so its buttons start out correct.
                    layPostState();
                } else if (!notesActive) {
                    carryFocusText(carried);
                }
            } else {
                document.body.classList.remove('edit');
                document.body.classList.remove('layout');
                disableInlineEditing();
                if (mode === 'draw') {
                    hideOverlay();
                    hideInput();
                    pinnedTarget = null;
                    hoverTarget = null;
                } else {
                    // Comment mode: land on the element the user was working on,
                    // popup open, ready to type. Esc dismisses it as usual.
                    var carriedC = carryResolve();
                    if (carriedC) {
                        pinnedTarget = carriedC;
                        showOverlay(carriedC);
                        showInput(carriedC);
                    }
                }
            }
        } else {
            document.body.classList.remove('__aimax-active');
            document.body.classList.remove('edit');
            document.body.classList.remove('draw');
            document.body.classList.remove('layout');
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
            setActive(d.on, d.mode, d.notes, d.layout);
        } else if (d.type === 'annot:reset') {
            clearBadges();
        } else if (d.type === 'annot:remove' && typeof d.n === 'number') {
            removeBadge(d.n, 'comment');
        } else if (d.type === 'edit:remove' && typeof d.n === 'number') {
            removeBadge(d.n, 'edit');
            removeBadge(d.n, 'layout');
        } else if (d.type === 'edit:layout-undo') {
            layUndo();
        } else if (d.type === 'edit:layout-redo') {
            layRedo();
        } else if (d.type === 'edit:layout-reset') {
            layResetSelection();
        } else if (d.type === 'edit:layout-z' && typeof d.dir === 'string') {
            layZOrder(d.dir);
        } else if (d.type === 'edit:layout-delete') {
            layDeleteSelection();
        } else if (d.type === 'edit:layout-state?') {
            layPostState();
        } else if (d.type === 'edit:result' && typeof d.n === 'number') {
            markBadge(d.n, 'edit', d.ok ? 'saved' : 'failed');
            if (d.toast) showToast(d.toast, d.ok ? 'success' : 'error');
        } else if (d.type === 'edit:toast') {
            showToast(d.text || '', d.level || 'info');
        }
    });

    function onScrollOrResize() {
        repositionBadges();
        if (laySel) layPlaceBox();
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
