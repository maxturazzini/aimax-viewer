import * as fs from 'fs';
import * as path from 'path';

// Find workspace root by looking for Artifacts directory
export function findWorkspaceRoot(startPath: string): string | undefined {
    let currentPath = startPath;
    const maxLevels = 10;

    for (let i = 0; i < maxLevels; i++) {
        const artifactsPath = path.join(currentPath, 'Artifacts');
        if (fs.existsSync(artifactsPath)) {
            console.log('[AIMax] Found workspace root at:', currentPath);
            return currentPath;
        }
        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) {
            break;
        }
        currentPath = parentPath;
    }
    console.log('[AIMax] Could not find workspace root from:', startPath);
    return undefined;
}

// Convert file path to HTTP URL via our server
export function getHttpUrl(filePath: string, workspaceFolder: string, serverPort: number): string {
    const relativePath = filePath.replace(workspaceFolder, '').replace(/^\//, '');
    return `http://127.0.0.1:${serverPort}/${relativePath}`;
}

export interface ArtifactFile {
    name: string;
    path: string;
    url: string;
    modified: number;
    type: 'html' | 'md';
    folderLabel: string;
}

// Recursively list artifact files (HTML and MD) in a directory
export async function listArtifactFiles(
    dir: string,
    workspaceFolder: string,
    serverPort: number,
    folderLabel: string = 'Artifacts'
): Promise<ArtifactFile[]> {
    const results: ArtifactFile[] = [];

    async function scan(currentDir: string) {
        const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                await scan(fullPath);
            } else {
                const isHtml = entry.name.endsWith('.html') && entry.name !== 'index.html';
                const isMd = entry.name.endsWith('.md');

                if (isHtml || isMd) {
                    const stats = await fs.promises.stat(fullPath);
                    const relativePath = fullPath.replace(workspaceFolder + '/', '');
                    const ext = isHtml ? '.html' : '.md';
                    results.push({
                        name: entry.name.replace(ext, '').replace(/_/g, ' '),
                        path: relativePath,
                        url: `http://127.0.0.1:${serverPort}/${relativePath}`,
                        modified: stats.mtimeMs,
                        type: isHtml ? 'html' : 'md',
                        folderLabel: folderLabel
                    });
                }
            }
        }
    }

    await scan(dir);
    return results.sort((a, b) => b.modified - a.modified);
}

// Check if file is a valid artifact type
export function isArtifactFile(filePath: string): boolean {
    return filePath.endsWith('.html') || filePath.endsWith('.md');
}
