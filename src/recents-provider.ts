import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

interface RecentEntry {
    fsPath: string;
    timestamp: number;
}

const MAX_RECENTS = 24;
const STORAGE_KEY = 'aimaxViewer.recents';

export class RecentsWebviewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private workspaceFolder: string | undefined;
    private extensionUri: vscode.Uri;
    private workspaceState: vscode.Memento;

    private _onOpenFile = new vscode.EventEmitter<string>();
    readonly onOpenFile = this._onOpenFile.event;
    private _onContextAction = new vscode.EventEmitter<{ action: string; fsPath: string }>();
    readonly onContextAction = this._onContextAction.event;

    constructor(workspaceFolder: string | undefined, extensionUri: vscode.Uri, workspaceState: vscode.Memento) {
        this.workspaceFolder = workspaceFolder;
        this.extensionUri = extensionUri;
        this.workspaceState = workspaceState;
    }

    addRecent(fsPath: string): void {
        // Only track html/md files
        if (!fsPath.endsWith('.html') && !fsPath.endsWith('.md')) { return; }
        // Only track files that still exist
        if (!fs.existsSync(fsPath)) { return; }

        const recents = this.getRecents();
        // Remove existing entry for same file
        const filtered = recents.filter(r => r.fsPath !== fsPath);
        // Add at top
        filtered.unshift({ fsPath, timestamp: Date.now() });
        // Limit
        const trimmed = filtered.slice(0, MAX_RECENTS);
        this.workspaceState.update(STORAGE_KEY, trimmed);
        this.updateView();
    }

    clearRecents(): void {
        this.workspaceState.update(STORAGE_KEY, []);
        this.updateView();
    }

    private getRecents(): RecentEntry[] {
        return this.workspaceState.get<RecentEntry[]>(STORAGE_KEY, []);
    }

    private updateView(): void {
        if (!this._view) { return; }
        const recents = this.getRecents();
        const items = recents
            .filter(r => fs.existsSync(r.fsPath))
            .map(r => ({
                fsPath: r.fsPath,
                name: path.basename(r.fsPath).replace(/\.(html|md)$/, '').replace(/_/g, ' '),
                fileType: r.fsPath.endsWith('.md') ? 'md' : 'html',
                relativePath: this.workspaceFolder
                    ? path.relative(this.workspaceFolder, path.dirname(r.fsPath))
                    : path.dirname(r.fsPath),
                timeAgo: this.timeAgo(r.timestamp)
            }));
        this._view.webview.postMessage({ command: 'updateRecents', items });
    }

    private timeAgo(ts: number): string {
        const diff = Date.now() - ts;
        const mins = Math.floor(diff / 60000);
        if (mins < 1) { return 'just now'; }
        if (mins < 60) { return `${mins}m ago`; }
        const hours = Math.floor(mins / 60);
        if (hours < 24) { return `${hours}h ago`; }
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };
        const codiconUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'assets', 'codicon.css')
        );
        webviewView.webview.html = this.getHtml(codiconUri);

        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg.command === 'ready') {
                this.updateView();
            } else if (msg.command === 'openFile') {
                this._onOpenFile.fire(msg.fsPath);
            } else if (msg.command === 'contextAction') {
                if (msg.action === 'openFile') {
                    this._onOpenFile.fire(msg.fsPath);
                } else if (msg.action === 'removeRecent') {
                    const recents = this.getRecents().filter(r => r.fsPath !== msg.fsPath);
                    this.workspaceState.update(STORAGE_KEY, recents);
                    this.updateView();
                } else {
                    this._onContextAction.fire({ action: msg.action, fsPath: msg.fsPath });
                }
            } else if (msg.command === 'clearAll') {
                this.clearRecents();
            }
        });
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
    .header {
        position: sticky;
        top: 0;
        z-index: 10;
        background: var(--vscode-sideBar-background);
        padding: 4px 8px 4px;
        display: flex;
        align-items: center;
        justify-content: flex-end;
    }
    .header button {
        background: transparent;
        border: none;
        color: var(--vscode-foreground);
        cursor: pointer;
        padding: 0 4px;
        font-size: 12px;
        display: flex;
        align-items: center;
        gap: 4px;
        opacity: 0.7;
        border-radius: 3px;
    }
    .header button:hover {
        background: var(--vscode-toolbar-hoverBackground);
        opacity: 1;
    }
    .tree-row {
        display: flex;
        align-items: center;
        height: 22px;
        padding-left: 8px;
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
        flex: 1;
    }
    .tree-meta {
        font-size: 11px;
        opacity: 0.5;
        margin-left: 8px;
        flex-shrink: 0;
    }
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
        z-index: 1000;
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
    <div class="header">
        <button id="clearAllBtn" title="Clear all recents"><span class="codicon codicon-clear-all"></span></button>
    </div>
    <div id="list"></div>
    <div class="ctx-menu" id="ctxMenu"></div>
    <script>
        const vscode = acquireVsCodeApi();
        const listEl = document.getElementById('list');
        const ctxMenu = document.getElementById('ctxMenu');
        let ctxTarget = null;

        document.getElementById('clearAllBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'clearAll' });
        });

        window.addEventListener('message', e => {
            const msg = e.data;
            if (msg.command === 'updateRecents') {
                renderList(msg.items);
            }
        });

        function renderList(items) {
            listEl.textContent = '';
            if (!items || items.length === 0) {
                const msg = document.createElement('div');
                msg.className = 'empty-msg';
                msg.textContent = 'No recent files';
                listEl.appendChild(msg);
                return;
            }
            items.forEach(item => {
                const row = document.createElement('div');
                row.className = 'tree-row';
                row.title = item.fsPath;

                const icon = document.createElement('span');
                icon.className = 'tree-icon codicon ' + (item.fileType === 'md' ? 'codicon-markdown' : 'codicon-file-code');
                row.appendChild(icon);

                const label = document.createElement('span');
                label.className = 'tree-label';
                label.textContent = item.name;
                row.appendChild(label);

                const meta = document.createElement('span');
                meta.className = 'tree-meta';
                meta.textContent = item.timeAgo;
                row.appendChild(meta);

                row.addEventListener('click', () => {
                    vscode.postMessage({ command: 'openFile', fsPath: item.fsPath });
                });
                row.addEventListener('contextmenu', (e) => showCtx(e, item.fsPath));
                listEl.appendChild(row);
            });
        }

        function showCtx(e, fsPath) {
            e.preventDefault();
            e.stopPropagation();
            ctxTarget = fsPath;
            ctxMenu.textContent = '';

            addCtxItem('codicon-preview', 'Open in Viewer', 'openFile');
            addCtxItem('codicon-edit', 'Open in Editor', 'openInEditor');
            addCtxItem('codicon-globe', 'Open in Browser', 'openInBrowser');
            const sep = document.createElement('div');
            sep.className = 'ctx-sep';
            ctxMenu.appendChild(sep);
            addCtxItem('codicon-files', 'Reveal in Explorer', 'revealInExplorer');
            addCtxItem('codicon-folder-opened', 'Reveal in Finder', 'revealInOS');
            const sep2 = document.createElement('div');
            sep2.className = 'ctx-sep';
            ctxMenu.appendChild(sep2);
            addCtxItem('codicon-close', 'Remove from Recents', 'removeRecent');

            ctxMenu.style.left = e.clientX + 'px';
            ctxMenu.style.top = e.clientY + 'px';
            ctxMenu.classList.add('open');

            const rect = ctxMenu.getBoundingClientRect();
            if (rect.right > window.innerWidth) ctxMenu.style.left = (window.innerWidth - rect.width - 4) + 'px';
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

        vscode.postMessage({ command: 'ready' });
    </script>
</body>
</html>`;
    }
}
