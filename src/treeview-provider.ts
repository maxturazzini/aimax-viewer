import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface FolderConfig {
    label: string;
    path: string;
}

export class ArtifactItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType: 'root-folder' | 'folder' | 'file',
        public readonly fsPath: string,
        public readonly folderLabel?: string,
        public readonly fileType?: 'html' | 'md'
    ) {
        super(label, collapsibleState);

        if (itemType === 'file') {
            this.contextValue = 'artifactFile';
            this.iconPath = fileType === 'md'
                ? new vscode.ThemeIcon('markdown')
                : new vscode.ThemeIcon('file-code');
            this.command = {
                command: 'aimaxViewer.openFromTree',
                title: 'Open in Viewer',
                arguments: [this]
            };
            this.tooltip = fsPath;
        } else if (itemType === 'root-folder') {
            this.contextValue = 'rootFolder';
            this.iconPath = new vscode.ThemeIcon('folder-library');
            this.tooltip = fsPath;
        } else {
            this.contextValue = 'folder';
            this.iconPath = vscode.ThemeIcon.Folder;
            this.tooltip = fsPath;
        }
    }
}

export class ArtifactsTreeProvider implements vscode.TreeDataProvider<ArtifactItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ArtifactItem | undefined | null | void> = new vscode.EventEmitter<ArtifactItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ArtifactItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(
        private workspaceFolder: string | undefined,
        private folders: FolderConfig[]
    ) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    updateFolders(folders: FolderConfig[]): void {
        this.folders = folders;
        this.refresh();
    }

    getTreeItem(element: ArtifactItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ArtifactItem): Promise<ArtifactItem[]> {
        if (!this.workspaceFolder) {
            return [];
        }

        // Root level: show configured folders
        if (!element) {
            const items: ArtifactItem[] = [];
            for (const folder of this.folders) {
                // Support absolute paths (works on Mac, Windows, Linux)
                const folderPath = path.isAbsolute(folder.path)
                    ? folder.path
                    : path.join(this.workspaceFolder, folder.path);
                if (fs.existsSync(folderPath)) {
                    items.push(new ArtifactItem(
                        folder.label,
                        vscode.TreeItemCollapsibleState.Expanded,
                        'root-folder',
                        folderPath,
                        folder.label
                    ));
                }
            }
            return items;
        }

        // Folder level: show subfolders and files
        const dirPath = element.fsPath;
        if (!fs.existsSync(dirPath)) {
            return [];
        }

        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        const items: ArtifactItem[] = [];

        // Sort: folders first, then files, both alphabetically
        const folders = entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
        const files = entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

        // Add subfolders
        for (const folder of folders) {
            // Skip hidden folders
            if (folder.name.startsWith('.')) continue;

            const folderPath = path.join(dirPath, folder.name);
            // Check if folder contains any artifacts
            if (await this.hasArtifacts(folderPath)) {
                items.push(new ArtifactItem(
                    folder.name,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'folder',
                    folderPath,
                    element.folderLabel
                ));
            }
        }

        // Add artifact files (html and md, excluding index.html)
        for (const file of files) {
            const isHtml = file.name.endsWith('.html') && file.name !== 'index.html';
            const isMd = file.name.endsWith('.md');

            if (isHtml || isMd) {
                const filePath = path.join(dirPath, file.name);
                const ext = isHtml ? '.html' : '.md';
                const displayName = file.name.replace(ext, '').replace(/_/g, ' ');

                items.push(new ArtifactItem(
                    displayName,
                    vscode.TreeItemCollapsibleState.None,
                    'file',
                    filePath,
                    element.folderLabel,
                    isHtml ? 'html' : 'md'
                ));
            }
        }

        return items;
    }

    private async hasArtifacts(dirPath: string): Promise<boolean> {
        try {
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    const subPath = path.join(dirPath, entry.name);
                    if (await this.hasArtifacts(subPath)) {
                        return true;
                    }
                } else if (entry.isFile()) {
                    const isHtml = entry.name.endsWith('.html') && entry.name !== 'index.html';
                    const isMd = entry.name.endsWith('.md');
                    if (isHtml || isMd) {
                        return true;
                    }
                }
            }
            return false;
        } catch {
            return false;
        }
    }
}
