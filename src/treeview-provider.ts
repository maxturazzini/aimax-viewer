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

    async hasArtifacts(dirPath: string): Promise<boolean> {
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

interface FileNode {
    name: string;
    fsPath: string;
    fileType: 'html' | 'md';
}

interface FolderNode {
    name: string;
    fsPath: string;
    isRoot: boolean;
    children: (FolderNode | FileNode)[];
}

export class ArtifactsWebviewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private workspaceFolder: string | undefined;
    private folders: FolderConfig[];
    private extensionUri: vscode.Uri;
    private _onOpenFile = new vscode.EventEmitter<string>();
    readonly onOpenFile = this._onOpenFile.event;
    private _onContextAction = new vscode.EventEmitter<{ action: string; fsPath: string }>();
    readonly onContextAction = this._onContextAction.event;

    constructor(workspaceFolder: string | undefined, folders: FolderConfig[], extensionUri: vscode.Uri) {
        this.workspaceFolder = workspaceFolder;
        this.folders = folders;
        this.extensionUri = extensionUri;
    }

    refresh(): void {
        if (this._view) {
            this._view.webview.postMessage({ command: 'refresh' });
            this.updateTree('');
        }
    }

    collapseAll(): void {
        if (this._view) {
            this._view.webview.postMessage({ command: 'collapseAll' });
        }
    }

    updateFolders(folders: FolderConfig[]): void {
        this.folders = folders;
        this.refresh();
    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };
        // Get codicon font URI from bundled assets
        const codiconUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'assets', 'codicon.css')
        );
        webviewView.webview.html = this.getHtml(codiconUri);

        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg.command === 'search') {
                this.updateTree(msg.query);
            } else if (msg.command === 'openFile') {
                this._onOpenFile.fire(msg.fsPath);
            } else if (msg.command === 'contextAction') {
                if (msg.action === 'openFile') {
                    this._onOpenFile.fire(msg.fsPath);
                } else {
                    this._onContextAction.fire({ action: msg.action, fsPath: msg.fsPath });
                }
            } else if (msg.command === 'ready') {
                this.updateTree('');
            }
        });
    }

    private async updateTree(query: string) {
        if (!this._view || !this.workspaceFolder) { return; }
        const tree = await this.buildTree(query);
        this._view.webview.postMessage({ command: 'updateTree', tree });
    }

    private async buildTree(query: string): Promise<FolderNode[]> {
        if (!this.workspaceFolder) { return []; }
        const roots: FolderNode[] = [];
        const q = query.toLowerCase().trim();

        for (const folder of this.folders) {
            const folderPath = path.isAbsolute(folder.path)
                ? folder.path
                : path.join(this.workspaceFolder, folder.path);
            if (!fs.existsSync(folderPath)) { continue; }
            const node = await this.scanDir(folderPath, folder.label, true, q);
            if (node && node.children.length > 0) {
                roots.push(node);
            }
        }
        return roots;
    }

    private async scanDir(dirPath: string, name: string, isRoot: boolean, query: string): Promise<FolderNode | null> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        } catch { return null; }

        const node: FolderNode = { name, fsPath: dirPath, isRoot, children: [] };
        const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
        const files = entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

        for (const d of dirs) {
            const child = await this.scanDir(path.join(dirPath, d.name), d.name, false, query);
            if (child && child.children.length > 0) {
                node.children.push(child);
            }
        }

        for (const f of files) {
            const isHtml = f.name.endsWith('.html') && f.name !== 'index.html';
            const isMd = f.name.endsWith('.md');
            if (!isHtml && !isMd) { continue; }

            const displayName = f.name.replace(/\.(html|md)$/, '').replace(/_/g, ' ');
            if (query && !displayName.toLowerCase().includes(query) && !f.name.toLowerCase().includes(query)) {
                continue;
            }
            node.children.push({
                name: displayName,
                fsPath: path.join(dirPath, f.name),
                fileType: isHtml ? 'html' : 'md'
            });
        }

        // If searching and folder name matches, include all its contents
        if (query && node.children.length === 0 && name.toLowerCase().includes(query)) {
            return await this.scanDir(dirPath, name, isRoot, '');
        }

        return node;
    }

    private getHtml(codiconUri: vscode.Uri): string {
        return `<!DOCTYPE html>
<html>
<head>
<link rel="stylesheet" href="${codiconUri}">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
        font-size: 13px;
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background);
        line-height: 22px;
    }
    .search-bar {
        position: sticky;
        top: 0;
        z-index: 10;
        background: var(--vscode-sideBar-background);
        padding: 4px 8px 6px;
        display: flex;
        gap: 4px;
    }
    .search-bar input {
        flex: 1;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 2px;
        padding: 2px 6px;
        font-size: 12px;
        font-family: var(--vscode-font-family);
        outline: none;
        height: 24px;
    }
    .search-bar input:focus {
        border-color: var(--vscode-focusBorder);
    }
    .search-bar input::placeholder {
        color: var(--vscode-input-placeholderForeground);
    }
    .search-bar button {
        background: transparent;
        border: none;
        color: var(--vscode-foreground);
        cursor: pointer;
        padding: 0 4px;
        font-size: 14px;
        display: flex;
        align-items: center;
        opacity: 0.7;
        border-radius: 3px;
    }
    .search-bar button:hover {
        background: var(--vscode-toolbar-hoverBackground);
        opacity: 1;
    }
    .clear-btn { font-size: 12px !important; }
    .tree-row {
        display: flex;
        align-items: center;
        height: 22px;
        padding-left: 0;
        padding-right: 8px;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .tree-row:hover {
        background: var(--vscode-list-hoverBackground);
    }
    .tree-row.selected {
        background: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
    }
    .indent { display: inline-block; width: 16px; flex-shrink: 0; }
    .twistie {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 22px;
        flex-shrink: 0;
        font-size: 16px;
        color: var(--vscode-foreground);
        opacity: 0.8;
    }
    .twistie-placeholder { width: 16px; flex-shrink: 0; }
    .tree-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 22px;
        margin-right: 4px;
        flex-shrink: 0;
        font-size: 16px;
    }
    .tree-label {
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .folder-children.collapsed { display: none; }
    .empty-msg {
        padding: 12px 16px;
        opacity: 0.5;
        font-size: 12px;
    }
    .ctx-menu {
        position: fixed;
        display: none;
        background: var(--vscode-menu-background, var(--vscode-dropdown-background));
        color: var(--vscode-menu-foreground, var(--vscode-dropdown-foreground));
        border: 1px solid var(--vscode-menu-border, var(--vscode-dropdown-border, #454545));
        border-radius: 4px;
        padding: 4px 0;
        min-width: 180px;
        z-index: 99999;
        box-shadow: 0 2px 8px rgba(0,0,0,0.35);
        font-size: 13px;
    }
    .ctx-menu.open { display: block; }
    .ctx-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 12px;
        cursor: pointer;
        white-space: nowrap;
    }
    .ctx-item:hover {
        background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
        color: var(--vscode-menu-selectionForeground, var(--vscode-foreground));
    }
    .ctx-item .codicon { font-size: 14px; opacity: 0.8; }
    .ctx-sep {
        border-top: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border, #454545));
        margin: 4px 0;
    }
</style>
</head>
<body>
    <div class="search-bar">
        <input id="search" type="text" />
        <button id="clearBtn" class="clear-btn" title="Clear" style="display:none;"><span class="codicon codicon-close"></span></button>
        <button id="searchBtn" title="Search"><span class="codicon codicon-search"></span></button>
    </div>
    <div id="tree"></div>
    <div class="ctx-menu" id="ctxMenu"></div>
    <script>
        const vscode = acquireVsCodeApi();
        const searchInput = document.getElementById('search');
        const clearBtn = document.getElementById('clearBtn');
        const treeEl = document.getElementById('tree');

        function doSearch() {
            vscode.postMessage({ command: 'search', query: searchInput.value });
            clearBtn.style.display = searchInput.value ? 'flex' : 'none';
        }

        searchInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') doSearch();
        });
        document.getElementById('searchBtn').addEventListener('click', doSearch);
        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            clearBtn.style.display = 'none';
            doSearch();
        });

        window.addEventListener('message', e => {
            const msg = e.data;
            if (msg.command === 'updateTree') {
                renderTree(msg.tree);
            } else if (msg.command === 'refresh') {
                searchInput.value = '';
                clearBtn.style.display = 'none';
            } else if (msg.command === 'collapseAll') {
                document.querySelectorAll('.folder-children').forEach(el => {
                    el.classList.add('collapsed');
                });
                document.querySelectorAll('.twistie').forEach(el => {
                    el.className = 'twistie codicon codicon-chevron-right';
                });
            }
        });

        function renderTree(roots) {
            if (!roots || roots.length === 0) {
                treeEl.textContent = '';
                const msg = document.createElement('div');
                msg.className = 'empty-msg';
                msg.textContent = 'No artifacts found';
                treeEl.appendChild(msg);
                return;
            }
            treeEl.textContent = '';
            roots.forEach(root => treeEl.appendChild(buildFolder(root, 0, true)));
        }

        function buildFolder(node, depth, expanded) {
            const frag = document.createDocumentFragment();

            // Folder row
            const row = document.createElement('div');
            row.className = 'tree-row';

            for (let i = 0; i < depth; i++) {
                const indent = document.createElement('span');
                indent.className = 'indent';
                row.appendChild(indent);
            }

            const twistie = document.createElement('span');
            twistie.className = 'twistie codicon ' + (expanded ? 'codicon-chevron-down' : 'codicon-chevron-right');
            row.appendChild(twistie);

            const icon = document.createElement('span');
            icon.className = 'tree-icon codicon ' + (node.isRoot ? 'codicon-library' : 'codicon-folder');
            row.appendChild(icon);

            const label = document.createElement('span');
            label.className = 'tree-label';
            label.textContent = node.name;
            row.appendChild(label);

            frag.appendChild(row);

            // Children container
            const children = document.createElement('div');
            children.className = 'folder-children' + (expanded ? '' : ' collapsed');

            node.children.forEach(child => {
                if (child.fileType) {
                    children.appendChild(buildFile(child, depth + 1));
                } else {
                    children.appendChild(buildFolder(child, depth + 1, searchInput.value.trim() !== '' || child.isRoot));
                }
            });

            frag.appendChild(children);

            row.addEventListener('click', () => {
                const collapsed = children.classList.toggle('collapsed');
                twistie.className = 'twistie codicon ' + (collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down');
            });
            row.addEventListener('contextmenu', (e) => showCtx(e, node.fsPath, true));

            // Wrap in a div so fragment stays together
            const wrapper = document.createElement('div');
            wrapper.appendChild(frag);
            return wrapper;
        }

        function buildFile(node, depth) {
            const row = document.createElement('div');
            row.className = 'tree-row';

            for (let i = 0; i < depth; i++) {
                const indent = document.createElement('span');
                indent.className = 'indent';
                row.appendChild(indent);
            }

            const placeholder = document.createElement('span');
            placeholder.className = 'twistie-placeholder';
            row.appendChild(placeholder);

            const icon = document.createElement('span');
            icon.className = 'tree-icon codicon ' + (node.fileType === 'md' ? 'codicon-markdown' : 'codicon-file-code');
            row.appendChild(icon);

            const label = document.createElement('span');
            label.className = 'tree-label';
            label.textContent = node.name;
            row.appendChild(label);

            row.title = node.fsPath;
            row.addEventListener('click', () => {
                vscode.postMessage({ command: 'openFile', fsPath: node.fsPath });
            });
            row.addEventListener('contextmenu', (e) => showCtx(e, node.fsPath, false));
            return row;
        }

        // Context menu
        const ctxMenu = document.getElementById('ctxMenu');
        let ctxTarget = null;

        function showCtx(e, fsPath, isFolder) {
            e.preventDefault();
            e.stopPropagation();
            ctxTarget = fsPath;
            ctxMenu.textContent = '';

            if (!isFolder) {
                addCtxItem('codicon-preview', 'Open in Viewer', 'openFile');
                addCtxItem('codicon-edit', 'Open in Editor', 'openInEditor');
                addCtxItem('codicon-globe', 'Open in Browser', 'openInBrowser');
                if (fsPath.endsWith('.html')) {
                    addCtxItem('codicon-broadcast', 'Present', 'presentFile');
                }
                const sep = document.createElement('div');
                sep.className = 'ctx-sep';
                ctxMenu.appendChild(sep);
            }
            addCtxItem('codicon-files', 'Reveal in Explorer', 'revealInExplorer');
            addCtxItem('codicon-folder-opened', 'Reveal in Finder', 'revealInOS');

            ctxMenu.style.left = e.clientX + 'px';
            ctxMenu.style.top = e.clientY + 'px';
            ctxMenu.classList.add('open');

            // Keep menu inside viewport
            const rect = ctxMenu.getBoundingClientRect();
            if (rect.right > window.innerWidth) ctxMenu.style.left = (window.innerWidth - rect.width - 4) + 'px';
            if (rect.left < 0) ctxMenu.style.left = '4px';
            if (rect.bottom > window.innerHeight) ctxMenu.style.top = (window.innerHeight - rect.height - 4) + 'px';
        }

        function addCtxItem(iconClass, text, action) {
            const item = document.createElement('div');
            item.className = 'ctx-item';
            const ic = document.createElement('span');
            ic.className = 'codicon ' + iconClass;
            const lb = document.createElement('span');
            lb.textContent = text;
            item.appendChild(ic);
            item.appendChild(lb);
            item.addEventListener('click', () => {
                ctxMenu.classList.remove('open');
                vscode.postMessage({ command: 'contextAction', action: action, fsPath: ctxTarget });
            });
            ctxMenu.appendChild(item);
        }

        document.addEventListener('click', () => ctxMenu.classList.remove('open'));
        document.addEventListener('contextmenu', (e) => {
            if (!e.target.closest('.tree-row')) {
                ctxMenu.classList.remove('open');
            }
        });
        window.addEventListener('blur', () => ctxMenu.classList.remove('open'));

        vscode.postMessage({ command: 'ready' });
    </script>
</body>
</html>`;
    }
}
