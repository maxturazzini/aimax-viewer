// Allowlist HTML sanitizer for rendered markdown.
//
// Why this exists: parseMarkdown passes author HTML through untouched, and the
// page it produces is served on the AIMax origin — the same origin that exposes
// POST /__save-md, /__save-notes and /__claude. A <script> in a .md is therefore
// not "just" an alert box: it can write into the workspace and drive the bridge.
// Markdown files are increasingly written by agents from external material, so
// the file is not automatically trusted just because it is local.
//
// Design: every tag is REBUILT from scratch from an allowlist of names and
// attributes. Nothing from the original tag text is copied through, so malformed
// or entity-smuggled attributes cannot survive. Anything that does not parse as
// a well-formed tag is escaped into text rather than passed along.
//
// Measured against a 3623-file .md corpus, the tags used outside code fences are
// details/summary/b/td/p/br/h2/th/strong/tr/div/img/col and the attributes are
// style/name/title/src/alt — all allowed below. No on* handler and no <script>
// appeared outside a fence, so this allowlist is not a behaviour change in
// practice; it is a floor under one.

// Dropped together with their contents: rendering their text would be noise, and
// for script/style it would also be a bypass (the text is code, not prose).
const DROP_WITH_CONTENT = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'noscript',
    'template', 'svg', 'math', 'frame', 'frameset', 'applet'
]);

// Unknown/disallowed tags outside that set lose the tag but keep their text —
// this is what makes prose pseudo-tags (<example>, <commentary>) harmless.
const ALLOWED_TAGS = new Set([
    'a', 'abbr', 'article', 'aside', 'b', 'blockquote', 'br', 'caption', 'code',
    'col', 'colgroup', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption',
    'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i',
    'img', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 's',
    'samp', 'section', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table',
    'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr'
]);

const VOID_TAGS = new Set(['br', 'col', 'hr', 'img', 'wbr']);

// Attributes accepted on any allowed tag.
const GLOBAL_ATTRS = new Set(['class', 'id', 'style', 'title', 'dir', 'lang', 'role']);

// Attributes accepted only on specific tags.
const TAG_ATTRS: Record<string, Set<string>> = {
    a: new Set(['href', 'target', 'rel', 'name']),
    img: new Set(['src', 'alt', 'width', 'height', 'loading']),
    td: new Set(['colspan', 'rowspan', 'align', 'valign']),
    th: new Set(['colspan', 'rowspan', 'align', 'valign', 'scope']),
    col: new Set(['span', 'width']),
    colgroup: new Set(['span']),
    ol: new Set(['start', 'reversed', 'type']),
    details: new Set(['open']),
    time: new Set(['datetime']),
    del: new Set(['datetime']),
    ins: new Set(['datetime'])
};

// vscode: is allowed on purpose — deep links into the viewer are a documented
// feature of this project. mailto/tel are inert. data: is allowed only for
// raster images: a data:image/svg+xml can carry script, and even though <img>
// does not execute it, keeping svg out costs nothing here.
const SAFE_SCHEMES = /^(?:https?|mailto|tel|vscode|vscode-insiders):/;
const SAFE_DATA_URL = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i;

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', tab: '\t', newline: '\n'
};

// Decode entities before inspecting a URL, so jav&#x61;script: is judged as
// javascript: and not as an unknown-scheme-free relative path.
function decodeEntities(value: string): string {
    return value.replace(/&(#x?[0-9a-f]+|[a-z]+);?/gi, (match, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X'
                ? parseInt(body.slice(2), 16)
                : parseInt(body.slice(1), 10);
            if (!isFinite(code) || code < 0 || code > 0x10ffff) return match;
            try { return String.fromCodePoint(code); } catch { return match; }
        }
        const named = NAMED_ENTITIES[body.toLowerCase()];
        return named !== undefined ? named : match;
    });
}

function isSafeUrl(rawValue: string): boolean {
    // Control characters and whitespace are stripped by browsers when resolving
    // a URL, so strip them before deciding. "java\nscript:x" is javascript:x.
    const value = decodeEntities(rawValue).replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
    if (!value) return false;
    if (SAFE_DATA_URL.test(value)) return true;
    // A scheme is everything before the first ':' that precedes any / ? #.
    const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):/);
    if (!schemeMatch) return !value.startsWith('//') || /^\/\/[a-z0-9]/.test(value);
    return SAFE_SCHEMES.test(value);
}

// CSS cannot execute script in any browser this extension runs on, but url()
// with a script scheme and the legacy expression() are cheap to refuse.
function sanitizeStyle(rawValue: string): string | null {
    const value = decodeEntities(rawValue);
    if (/expression\s*\(|javascript:|vbscript:|behavior\s*:|@import|<|>/i.test(value)) return null;
    return value.replace(/["<>]/g, '');
}

function escapeAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function isAttrAllowed(tag: string, attr: string): boolean {
    if (attr.startsWith('on')) return false;
    // data-aimax-* is the extension's own namespace (overlay sentinel, no-edit
    // gate). A document must not be able to forge it.
    if (attr.startsWith('data-aimax')) return false;
    if (attr.startsWith('data-') || attr.startsWith('aria-')) return true;
    if (GLOBAL_ATTRS.has(attr)) return true;
    const perTag = TAG_ATTRS[tag];
    return !!perTag && perTag.has(attr);
}

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]*)))?/g;

// Void tags are re-emitted without a trailing slash: HTML5 ignores it, and the
// browser closes them anyway. VOID_TAGS is what keeps the list honest for
// anyone extending ALLOWED_TAGS later.
function rebuildTag(tag: string, attrText: string): string {
    const parts: string[] = [tag];
    const seen = new Set<string>();
    ATTR_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ATTR_RE.exec(attrText)) !== null) {
        if (match[0] === '') { ATTR_RE.lastIndex++; continue; }
        const name = match[1].toLowerCase();
        if (seen.has(name) || !isAttrAllowed(tag, name)) continue;
        seen.add(name);
        let value = match[2] ?? match[3] ?? match[4] ?? '';
        if (name === 'href' || name === 'src') {
            if (!isSafeUrl(value)) continue;
        } else if (name === 'style') {
            const safe = sanitizeStyle(value);
            if (safe === null) continue;
            value = safe;
        }
        parts.push(`${name}="${escapeAttr(value)}"`);
    }
    // target="_blank" without noopener leaves the opener reachable; the markdown
    // link rule in parseMarkdown emits target="_blank" on every link.
    if (tag === 'a' && /target="_blank"/.test(parts.join(' ')) && !seen.has('rel')) {
        parts.push('rel="noopener noreferrer"');
    }
    return `<${parts.join(' ')}>`;
}

// Matches a comment or a well-formed tag. The attribute part is quote-aware so
// a '>' inside an attribute value does not terminate the tag early.
const TOKEN_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

// Placeholders parseMarkdown leaves behind for already-escaped code blocks. They
// must survive; every other comment is dropped.
const KEEP_COMMENT = /^<!--(?:CODEBLOCK\d+|SPACER)-->$/;

export function sanitizeHtml(html: string): string {
    let out = '';
    let cursor = 0;
    TOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = TOKEN_RE.exec(html)) !== null) {
        // Text before this token: a stray '<' that never formed a tag becomes
        // literal text instead of being handed to the browser's parser.
        out += html.slice(cursor, match.index).replace(/</g, '&lt;');
        cursor = match.index + match[0].length;

        if (match[0].startsWith('<!--')) {
            if (KEEP_COMMENT.test(match[0])) out += match[0];
            continue;
        }

        const isClosing = match[1] === '/';
        const tag = match[2].toLowerCase();
        const attrText = match[3] || '';

        if (DROP_WITH_CONTENT.has(tag)) {
            if (!isClosing && !attrText.trimEnd().endsWith('/')) {
                // Skip to the matching close tag; if there is none, to the end.
                const closeRe = new RegExp('</\\s*' + tag + '\\s*>', 'i');
                const rest = html.slice(cursor);
                const closeAt = rest.search(closeRe);
                cursor = closeAt === -1 ? html.length : cursor + closeAt + rest.match(closeRe)![0].length;
                TOKEN_RE.lastIndex = cursor;
            }
            continue;
        }

        if (!ALLOWED_TAGS.has(tag)) continue;              // drop tag, keep content
        if (isClosing) {
            if (!VOID_TAGS.has(tag)) out += `</${tag}>`;   // </br> is not a thing
            continue;
        }
        out += rebuildTag(tag, attrText);
    }

    out += html.slice(cursor).replace(/</g, '&lt;');
    return out;
}
