import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { listArtifactFiles } from './utils';
import { parseMarkdown, wrapMarkdownHtml } from './markdown-parser';

let httpServer: http.Server | undefined;
let currentServerPort: number;

export function getServerPort(): number {
    return currentServerPort;
}

export function startHttpServer(workspaceFolder: string, serverPort: number): void {
    if (httpServer) {
        return;
    }

    currentServerPort = serverPort;

    const mimeTypes: { [key: string]: string } = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.md': 'text/html',  // Served as HTML after conversion
        '.markdown': 'text/html'
    };

    httpServer = http.createServer((req, res) => {
        const url = req.url || '/';

        // API endpoint: list artifact files
        if (url === '/api/artifacts') {
            const artifactsPath = path.join(workspaceFolder, 'Artifacts');
            listArtifactFiles(artifactsPath, workspaceFolder, currentServerPort).then(files => {
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify(files));
            }).catch(() => {
                res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'Failed to list artifacts' }));
            });
            return;
        }

        const filePath = path.join(workspaceFolder, decodeURIComponent(url));

        // Security: only serve files within workspace
        if (!filePath.startsWith(workspaceFolder)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        // Check if file exists
        if (!fs.existsSync(filePath)) {
            res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
            res.end('Not found');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();

        // Handle Markdown files: convert to HTML
        if (ext === '.md' || ext === '.markdown') {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const title = path.basename(filePath, ext).replace(/_/g, ' ');
                const html = wrapMarkdownHtml(parseMarkdown(content), title);
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(html);
            } catch (err) {
                res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
                res.end('Error processing markdown');
            }
            return;
        }

        // Serve other files normally
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
                res.end('Not found');
                return;
            }

            const contentType = mimeTypes[ext] || 'application/octet-stream';
            res.writeHead(200, {
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            });
            res.end(data);
        });
    });

    httpServer.listen(currentServerPort, '127.0.0.1', () => {
        console.log(`[AIMax] HTTP server running on http://127.0.0.1:${currentServerPort}`);
    });

    httpServer.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE') {
            currentServerPort++;
            httpServer = undefined;
            startHttpServer(workspaceFolder, currentServerPort);
        }
    });
}

export function stopHttpServer(): void {
    if (httpServer) {
        httpServer.close();
        httpServer = undefined;
    }
}
