// Simple Markdown to HTML parser

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
    md = md.replace(/\n{3,}/g, '\n\n<!--SPACER-->\n\n');
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

    return html;
}

export function wrapMarkdownHtml(content: string, title: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
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
    </style>
</head>
<body>
    <div class="content-section">
        ${content}
    </div>
</body>
</html>`;
}
