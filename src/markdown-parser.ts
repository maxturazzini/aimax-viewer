// Simple Markdown to HTML parser

// Frontmatter extraction result interface
export interface FrontmatterResult {
    content: string;      // Markdown without frontmatter
    metadata: Record<string, unknown> | null;
}

// Extract YAML frontmatter from markdown
export function extractFrontmatter(md: string): FrontmatterResult {
    // Remove BOM if present
    let content = md.replace(/^\uFEFF/, '');

    // Normalize line endings to \n
    content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // More flexible regex: matches frontmatter at start of file
    // Allows for optional trailing newline after closing ---
    const frontmatterRegex = /^---\n([\s\S]*?)\n---(?:\n|$)/;
    const match = content.match(frontmatterRegex);

    if (!match) {
        return { content: content, metadata: null };
    }

    // Parse YAML (key: value pairs, including multi-line values)
    const yamlBlock = match[1];
    const metadata: Record<string, unknown> = {};
    const lines = yamlBlock.split('\n');

    let currentKey: string | null = null;
    let currentValue: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check if this is a new key: value pair (starts with non-space, has colon)
        const keyMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)/);

        if (keyMatch) {
            // Save previous key if exists
            if (currentKey) {
                metadata[currentKey] = parseYamlValue(currentValue.join('\n'));
            }

            currentKey = keyMatch[1];
            currentValue = keyMatch[2] ? [keyMatch[2]] : [];
        } else if (currentKey && (line.startsWith('  ') || line.startsWith('\t') || line.trim() === '')) {
            // Continuation of multi-line value
            currentValue.push(line.trim());
        }
    }

    // Don't forget the last key
    if (currentKey) {
        metadata[currentKey] = parseYamlValue(currentValue.join('\n'));
    }

    return {
        content: content.slice(match[0].length),
        metadata: Object.keys(metadata).length > 0 ? metadata : null
    };
}

// Parse YAML value (handles strings, arrays, numbers, booleans)
function parseYamlValue(value: string): unknown {
    const trimmed = value.trim();

    // Empty value
    if (!trimmed) return '';

    // Array [a, b, c]
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        return trimmed.slice(1, -1).split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
    }

    // Quoted string
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }

    // Boolean
    if (trimmed.toLowerCase() === 'true') return true;
    if (trimmed.toLowerCase() === 'false') return false;

    // Number
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        return parseFloat(trimmed);
    }

    // Plain string (possibly multi-line)
    return trimmed;
}

// Apply inline formatting to text (for use in table cells)
function formatInline(text: string): string {
    return text
        .replace(/~~(.+?)~~/g, '<del>$1</del>')
        .replace(/==(.+?)==/g, '<mark>$1</mark>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/__(.+?)__/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

function parseTable(md: string): string {
    const tableRegex = /\|(.+)\|\n\|[-:\s|]+\|\n((?:\|.+\|\n?)+)/g;
    return md.replace(tableRegex, (_match, headerRow, bodyRows) => {
        const headers = headerRow.split('|').filter((h: string) => h.trim());
        const rows = bodyRows.trim().split('\n').map((row: string) =>
            row.split('|').filter((c: string) => c.trim())
        );

        let table = '<div class="table-wrapper"><table><thead><tr>';
        headers.forEach((h: string) => {
            table += `<th>${formatInline(h.trim())}</th>`;
        });
        table += '</tr></thead><tbody>';

        rows.forEach((row: string[]) => {
            table += '<tr>';
            row.forEach((cell: string) => {
                table += `<td>${formatInline(cell.trim())}</td>`;
            });
            table += '</tr>';
        });

        table += '</tbody></table></div>';
        return table;
    });
}

export function parseMarkdown(md: string): string {
    // Normalize line endings first
    md = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    md = md.replace(/\n{3,}/g, '\n\n<!--SPACER-->\n\n');

    // Fenced code blocks (```lang ... ```) - must be processed FIRST
    // Use a placeholder to protect code blocks from further processing
    const codeBlocks: string[] = [];
    md = md.replace(/```(\w*)\n([\s\S]*?)\n```/g, (_match, lang, code) => {
        const escaped = code
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        const langClass = lang ? ` class="language-${lang}"` : '';
        const copyIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
        const html = `<div class="code-block-wrapper"><button class="copy-btn" onclick="copyCode(this)" title="Copy code">${copyIcon}</button><pre><code${langClass}>${escaped}</code></pre></div>`;
        codeBlocks.push(html);
        return `<!--CODEBLOCK${codeBlocks.length - 1}-->`;
    });

    let html = parseTable(md);

    html = html
        // Headings
        .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        // Images and links
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width: 100%; height: auto; border-radius: 12px; margin: 20px 0;">')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
        // Inline formatting (order matters!)
        .replace(/~~(.+?)~~/g, '<del>$1</del>')                    // Strikethrough ~~text~~
        .replace(/==(.+?)==/g, '<mark>$1</mark>')                  // Highlight ==text== (Obsidian)
        .replace(/`([^`]+)`/g, '<code>$1</code>')                  // Inline code `text`
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')          // Bold **text**
        .replace(/__(.+?)__/g, '<strong>$1</strong>')              // Bold __text__
        .replace(/\*(.+?)\*/g, '<em>$1</em>')                      // Italic *text*
        .replace(/_([^_]+)_/g, '<em>$1</em>')                      // Italic _text_
        // Blockquotes
        .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
        // Horizontal rule
        .replace(/^---$/gm, '<div class="section-divider"></div>')
        // Numbered lists
        .replace(/^\d+\. (.+)$/gm, '<li class="ol-item">$1</li>')
        // Bullet lists
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        // Wrap consecutive list items
        .replace(/(<li class="ol-item">.*<\/li>\n?)+/g, '<ol>$&</ol>')
        .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
        // Clean up ol-item class
        .replace(/ class="ol-item"/g, '')
        // Paragraphs
        .replace(/^(?!<(?:h[1-6]|ul|ol|li|table|div|p|img|blockquote|!))(.+)$/gm, '<p>$1</p>')
        .replace(/<p>\s*<\/p>/g, '')
        // Merge consecutive blockquotes
        .replace(/<\/blockquote>\n<blockquote>/g, '<br>')
        // Spacers
        .replace(/<!--SPACER-->/g, '<div style="height: 1.5em;"></div>')
        .replace(/<p><!--SPACER--><\/p>/g, '<div style="height: 1.5em;"></div>');

    // Restore code blocks from placeholders
    codeBlocks.forEach((block, i) => {
        html = html.replace(`<!--CODEBLOCK${i}-->`, block);
        html = html.replace(`<p><!--CODEBLOCK${i}--></p>`, block);
    });

    return html;
}

export function wrapMarkdownHtml(content: string, title: string, metadata?: Record<string, unknown> | null): string {
    const metadataScript = metadata
        ? `<script id="frontmatter" type="application/json">${JSON.stringify(metadata)}</script>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    ${metadataScript}
    <style>
        :root {
            --blue: #0052FF;
            --light-gray: #f3f4f6;
            --gray: #6b7280;
            --dim-gray: #4b5563;
            --dark: #1f2937;
            --black: #111827;
            --white: #ffffff;
            --deep-sky-blue: #00d4ff;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: var(--white);
            color: var(--dark);
            line-height: 1.6;
        }

        .content-section {
            max-width: 900px;
            margin: 0 auto;
            padding: 40px 20px;
        }

        .content-section h1 {
            font-size: clamp(24px, 4vw, 32px);
            font-weight: 800;
            margin-bottom: 24px;
            color: var(--black);
        }

        .content-section h2 {
            font-size: 18px;
            font-weight: 700;
            margin: 32px 0 16px;
            color: var(--blue);
            border-bottom: 2px solid var(--light-gray);
            padding-bottom: 8px;
        }

        .content-section h3 {
            font-size: 15px;
            font-weight: 700;
            margin: 20px 0 10px;
            color: var(--dark);
        }

        .content-section p {
            font-size: 14px;
            line-height: 1.7;
            margin-bottom: 14px;
            color: var(--dim-gray);
        }

        .content-section ul, .content-section ol {
            margin: 14px 0;
            padding-left: 24px;
        }

        .content-section li {
            font-size: 14px;
            line-height: 1.6;
            margin-bottom: 8px;
            color: var(--dim-gray);
        }

        .table-wrapper {
            width: 100%;
            max-width: 100%;
            margin: 20px 0;
            overflow-x: auto;
        }

        .content-section table {
            width: 100%;
            border-collapse: collapse;
            background: var(--white);
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 2px 12px rgba(0,0,0,0.06);
        }

        .content-section th {
            background: var(--light-gray);
            font-weight: 700;
            text-align: left;
            padding: 12px 16px;
            font-size: 12px;
            color: var(--dark);
        }

        .content-section td {
            padding: 12px 16px;
            border-bottom: 1px solid var(--light-gray);
            font-size: 13px;
            color: var(--dim-gray);
        }

        .content-section tr:last-child td {
            border-bottom: none;
        }

        .content-section strong {
            font-weight: 700;
            color: var(--black);
        }

        .content-section a {
            color: var(--blue);
            text-decoration: none;
            font-weight: 600;
        }

        .content-section a:hover {
            text-decoration: underline;
        }

        .content-section del {
            text-decoration: line-through;
            color: var(--gray);
        }

        .content-section mark {
            background: linear-gradient(120deg, #fff3cd 0%, #ffeaa7 100%);
            padding: 2px 4px;
            border-radius: 3px;
        }

        .content-section code {
            background: var(--light-gray);
            padding: 2px 6px;
            border-radius: 4px;
            font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
            font-size: 13px;
            color: var(--dark);
        }

        .content-section .code-block-wrapper {
            position: relative;
            margin: 16px 0;
        }

        .content-section .code-block-wrapper .copy-btn {
            position: absolute;
            top: 8px;
            right: 8px;
            background: rgba(0,0,0,0.1);
            border: 1px solid rgba(0,0,0,0.15);
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 11px;
            color: var(--dim-gray);
            cursor: pointer;
            opacity: 0;
            transition: opacity 0.2s;
        }

        .content-section .code-block-wrapper:hover .copy-btn {
            opacity: 1;
        }

        .content-section .code-block-wrapper .copy-btn:hover {
            background: rgba(0,0,0,0.15);
        }

        .content-section pre {
            background: var(--light-gray);
            border-radius: 8px;
            padding: 16px 20px;
            margin: 0;
            overflow-x: auto;
            border: 1px solid rgba(0,0,0,0.08);
        }

        .content-section pre code {
            background: transparent;
            padding: 0;
            color: var(--dark);
            font-size: 13px;
            line-height: 1.5;
            white-space: pre;
        }

        .content-section blockquote {
            border-left: 4px solid var(--blue);
            padding: 12px 20px;
            margin: 16px 0;
            background: var(--light-gray);
            border-radius: 0 8px 8px 0;
            font-style: italic;
            color: var(--dim-gray);
        }

        .content-section ol {
            margin: 14px 0;
            padding-left: 24px;
            list-style-type: decimal;
        }

        .content-section h4 {
            font-size: 14px;
            font-weight: 600;
            margin: 16px 0 8px;
            color: var(--dim-gray);
        }

        .section-divider {
            height: 1px;
            background: linear-gradient(90deg, var(--blue), var(--deep-sky-blue));
            margin: 32px 0;
            opacity: 0.3;
        }

        .content-section img {
            max-width: 100%;
            height: auto;
            border-radius: 12px;
            margin: 20px 0;
        }

        @media (max-width: 768px) {
            .content-section {
                padding: 20px 16px;
            }
        }

        @media print {
            body {
                background: white;
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
            }
            .content-section {
                max-width: 100%;
                padding: 20px;
            }
        }
    </style>
</head>
<body>
    <div class="content-section">
        ${content}
    </div>
    <script>
        const copyIconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
        const checkIconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>';
        function copyCode(btn) {
            const code = btn.parentElement.querySelector('code').textContent;

            const showSuccess = () => {
                btn.innerHTML = checkIconSvg;
                btn.title = 'Copied!';
                setTimeout(() => { btn.innerHTML = copyIconSvg; btn.title = 'Copy code'; }, 2000);
            };

            const fallbackCopy = () => {
                const textarea = document.createElement('textarea');
                textarea.value = code;
                textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                const success = document.execCommand('copy');
                document.body.removeChild(textarea);
                return success;
            };

            // Try clipboard API, fall back to execCommand
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(code)
                    .then(showSuccess)
                    .catch(() => {
                        // Clipboard API failed, try fallback
                        if (fallbackCopy()) showSuccess();
                    });
            } else {
                // No clipboard API, use fallback directly
                if (fallbackCopy()) showSuccess();
            }
        }

        // Post metadata to parent window (for AIMax Viewer toolbar)
        if (window.parent !== window) {
            window.parent.postMessage({
                type: 'aimaxMetadata',
                metadata: ${JSON.stringify(metadata || {})}
            }, '*');
        }
    </script>
</body>
</html>`;
}
