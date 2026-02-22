import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { execFile, spawn } from 'child_process';
import { parseMarkdown, wrapMarkdownHtml, extractFrontmatter } from './markdown-parser';
import { ArtifactsTreeProvider, ArtifactsWebviewProvider, ArtifactItem, FolderConfig } from './treeview-provider';
import { RecentsWebviewProvider } from './recents-provider';
import { AppsManager } from './apps-manager';
import { AppsTreeProvider, AppTreeItem, DiscoveredAppTreeItem } from './apps-tree-provider';

let browserPanel: vscode.WebviewPanel | undefined;
const openBrowserPanels = new Map<string, vscode.WebviewPanel>();
let homePanel: vscode.WebviewPanel | undefined;
let httpServer: http.Server | undefined;
let serverPort = 3124;
let extensionContext: vscode.ExtensionContext;
let treeProvider: ArtifactsTreeProvider | undefined;
let webviewProvider: ArtifactsWebviewProvider | undefined;
let appsManager: AppsManager | undefined;
let appsTreeProvider: AppsTreeProvider | undefined;
let recentsProvider: RecentsWebviewProvider | undefined;


// Settings
function getConfig() {
    const config = vscode.workspace.getConfiguration('aimaxViewer');
    return {
        serverPort: config.get<number>('server.port', 3124),
        startupMode: config.get<string>('startup.mode', 'home'),
        homePage: config.get<string>('startup.homePage', 'Artifacts/index.html'),
        consoleOpenByDefault: config.get<boolean>('console.openByDefault', false),
        enableJavaScript: config.get<boolean>('webview.enableJavaScript', true),
        multiTab: config.get<boolean>('panels.multiTab', true),
        cspMode: config.get<string>('csp.mode', 'permissive'),
        cspAllowedDomains: config.get<string[]>('csp.allowedDomains', [
            'fonts.googleapis.com',
            'fonts.gstatic.com',
            'cdn.jsdelivr.net',
            'cdnjs.cloudflare.com',
            'unpkg.com'
        ]),
        browserLayout: config.get<string>('browser.layout', 'sidebar'),
        browserFolders: config.get<FolderConfig[]>('browser.folders', [
            { label: 'Artifacts', path: 'Artifacts' }
        ]),
        appsManagerEnabled: config.get<boolean>('appsManager.enabled', true),
        appsManagerRefreshInterval: config.get<number>('appsManager.refreshInterval', 5000),
        // ZeroUI layout options
        startupOpenClaudeCode: config.get<boolean>('startup.openClaudeCode', false),
        startupFocusSidebar: config.get<boolean>('startup.focusSidebar', true)
    };
}

// Generate CSP meta tag based on settings
function generateCSP(): string {
    const config = getConfig();

    if (config.cspMode === 'strict') {
        // Strict mode: only localhost
        return `default-src 'self' http://127.0.0.1:* http://localhost:*; script-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:*; style-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:*; img-src 'self' data: http://127.0.0.1:* http://localhost:*; font-src 'self' data: http://127.0.0.1:* http://localhost:*;`;
    }

    // Permissive or custom mode
    const domains = config.cspAllowedDomains;
    const httpsScheme = domains.map(d => `https://${d}`).join(' ');

    return `default-src 'self' http://127.0.0.1:* http://localhost:*; script-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:* ${httpsScheme}; style-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:* ${httpsScheme}; img-src 'self' data: http://127.0.0.1:* http://localhost:* ${httpsScheme}; font-src 'self' data: http://127.0.0.1:* http://localhost:* ${httpsScheme}; connect-src 'self' http://127.0.0.1:* http://localhost:* ${httpsScheme};`;
}

// Find workspace root by looking for Artifacts directory

export function activate(context: vscode.ExtensionContext) {
    extensionContext = context;
    console.log('[AIMax] Extension activating...');

    const vsCodeWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    console.log('[AIMax] VS Code workspace:', vsCodeWorkspace);

    const workspaceFolder = vsCodeWorkspace;
    console.log('[AIMax] Resolved workspace folder:', workspaceFolder);

    const config = getConfig();
    console.log('[AIMax] Config:', JSON.stringify(config));

    // Port logic:
    // - If user set custom port (different from default 3124) → use fixed port
    // - If default (3124) → calculate unique port based on workspace hash to avoid conflicts
    const DEFAULT_PORT = 3124;
    if (config.serverPort !== DEFAULT_PORT) {
        // User explicitly set a custom port - use it as-is
        serverPort = config.serverPort;
        console.log('[AIMax] Using custom fixed port:', serverPort);
    } else if (workspaceFolder) {
        // Default port + workspace: calculate unique port to avoid conflicts between windows
        const hash = workspaceFolder.split('').reduce((a, b) => ((a << 5) - a) + b.charCodeAt(0), 0);
        serverPort = DEFAULT_PORT + (Math.abs(hash) % 100); // Range: 3124-3223
        console.log('[AIMax] Calculated port for workspace:', serverPort);
    } else {
        serverPort = DEFAULT_PORT;
    }

    // Start our HTTP server for serving local files (only if workspace found)
    if (workspaceFolder) {
        console.log('[AIMax] Starting HTTP server on port', serverPort);
        startHttpServer(workspaceFolder);
    }

    // Create Status Bar item for quick Home access
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(home)';
    statusBarItem.tooltip = 'AIMax Viewer: Open Home';
    statusBarItem.command = 'aimaxViewer.openHome';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Register WebviewView for sidebar layout (with search bar)
    webviewProvider = new ArtifactsWebviewProvider(workspaceFolder, config.browserFolders, context.extensionUri);
    const webviewRegistration = vscode.window.registerWebviewViewProvider('aimaxViewer.artifactsTree', webviewProvider);
    context.subscriptions.push(webviewRegistration);

    // Register Recents webview panel
    recentsProvider = new RecentsWebviewProvider(workspaceFolder, context.extensionUri, context.workspaceState);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('aimaxViewer.recentsView', recentsProvider)
    );

    // Handle file open from recents
    recentsProvider.onOpenFile(fsPath => {
        if (workspaceFolder) {
            const httpUrl = getHttpUrl(fsPath, workspaceFolder);
            openInBrowser(httpUrl);
        }
    });

    // Handle context menu actions from recents
    recentsProvider.onContextAction(({ action, fsPath }) => {
        const uri = vscode.Uri.file(fsPath);
        switch (action) {
            case 'openInEditor':
                vscode.window.showTextDocument(uri);
                break;
            case 'openInBrowser':
                if (workspaceFolder) {
                    const httpUrl = getHttpUrl(fsPath, workspaceFolder);
                    vscode.env.openExternal(vscode.Uri.parse(httpUrl));
                }
                break;
            case 'presentFile':
                if (workspaceFolder) {
                    const httpUrl = getHttpUrl(fsPath, workspaceFolder);
                    const presenterUrl = `http://127.0.0.1:${serverPort}/__presenter#${httpUrl}`;
                    vscode.env.openExternal(vscode.Uri.parse(presenterUrl));
                }
                break;
            case 'revealInExplorer':
                vscode.commands.executeCommand('revealInExplorer', uri);
                break;
            case 'revealInOS':
                vscode.commands.executeCommand('revealFileInOS', uri);
                break;
        }
    });

    // Register clear recents command
    context.subscriptions.push(
        vscode.commands.registerCommand('aimaxViewer.clearRecents', () => {
            recentsProvider?.clearRecents();
        })
    );

    // Handle file open from webview tree
    webviewProvider.onOpenFile(fsPath => {
        if (workspaceFolder) {
            const httpUrl = getHttpUrl(fsPath, workspaceFolder);
            openInBrowser(httpUrl);
        }
    });

    // Handle context menu actions from webview tree
    webviewProvider.onContextAction(({ action, fsPath }) => {
        const uri = vscode.Uri.file(fsPath);
        switch (action) {
            case 'openInEditor':
                vscode.window.showTextDocument(uri);
                break;
            case 'openInBrowser':
                if (workspaceFolder) {
                    const httpUrl = getHttpUrl(fsPath, workspaceFolder);
                    vscode.env.openExternal(vscode.Uri.parse(httpUrl));
                }
                break;
            case 'presentFile':
                if (workspaceFolder) {
                    const httpUrl = getHttpUrl(fsPath, workspaceFolder);
                    const presenterUrl = `http://127.0.0.1:${serverPort}/__presenter#${httpUrl}`;
                    vscode.env.openExternal(vscode.Uri.parse(presenterUrl));
                }
                break;
            case 'revealInExplorer':
                vscode.commands.executeCommand('revealInExplorer', uri);
                break;
            case 'revealInOS':
                vscode.commands.executeCommand('revealFileInOS', uri);
                break;
        }
    });

    // Keep legacy tree provider for API compatibility
    treeProvider = new ArtifactsTreeProvider(workspaceFolder, config.browserFolders);

    // Register command to open artifact from tree
    const openFromTreeCommand = vscode.commands.registerCommand('aimaxViewer.openFromTree', (item: ArtifactItem) => {
        if (item && item.fsPath && workspaceFolder) {
            const httpUrl = getHttpUrl(item.fsPath, workspaceFolder);
            openInBrowser(httpUrl);
        }
    });
    context.subscriptions.push(openFromTreeCommand);

    // Register command to refresh tree
    const refreshTreeCommand = vscode.commands.registerCommand('aimaxViewer.refreshTree', () => {
        if (webviewProvider) {
            webviewProvider.refresh();
        }
        if (treeProvider) {
            treeProvider.refresh();
        }
    });
    context.subscriptions.push(refreshTreeCommand);

    // Register command to collapse all tree items
    const collapseAllCommand = vscode.commands.registerCommand('aimaxViewer.collapseAll', () => {
        if (webviewProvider) {
            webviewProvider.collapseAll();
        }
    });
    context.subscriptions.push(collapseAllCommand);

    // Apps Manager
    if (config.appsManagerEnabled && workspaceFolder) {
        appsManager = new AppsManager(workspaceFolder);

        appsTreeProvider = new AppsTreeProvider(
            appsManager,
            config.appsManagerRefreshInterval
        );

        const appsTreeView = vscode.window.createTreeView('aimaxViewer.appsTree', {
            treeDataProvider: appsTreeProvider,
            showCollapseAll: false
        });

        // Start App command
        const startAppCmd = vscode.commands.registerCommand(
            'aimaxViewer.startApp',
            async (item: AppTreeItem) => {
                if (item && item.status && appsManager) {
                    await appsManager.startApp(item.status.id);
                    appsTreeProvider?.refresh();
                }
            }
        );

        // Stop App command
        const stopAppCmd = vscode.commands.registerCommand(
            'aimaxViewer.stopApp',
            async (item: AppTreeItem) => {
                if (item && item.status && appsManager) {
                    await appsManager.stopApp(item.status.id);
                    appsTreeProvider?.refresh();
                }
            }
        );

        // Refresh Apps command
        const refreshAppsCmd = vscode.commands.registerCommand(
            'aimaxViewer.refreshApps',
            () => appsTreeProvider?.refresh()
        );

        // Add discovered app to config
        const addAppCmd = vscode.commands.registerCommand(
            'aimaxViewer.addAppToConfig',
            async (item: DiscoveredAppTreeItem) => {
                if (item && item.discovered && appsManager) {
                    const name = await vscode.window.showInputBox({
                        prompt: 'Enter a name for this app',
                        value: `${item.discovered.process} (${item.discovered.port})`
                    });
                    if (name) {
                        await appsManager.addAppToSettings(item.discovered, name);
                        appsTreeProvider?.refresh();
                    }
                }
            }
        );

        context.subscriptions.push(
            appsTreeView,
            startAppCmd,
            stopAppCmd,
            refreshAppsCmd,
            addAppCmd
        );

        console.log('[AIMax] Apps Manager initialized');
    }

    // Auto-open on startup based on mode setting
    if (config.startupMode !== 'none') {
        console.log('[AIMax] Startup mode:', config.startupMode);
        if (workspaceFolder) {
            // Normal mode: workspace has Artifacts
            if (config.startupMode === 'home') {
                openArtifactsHome(workspaceFolder, config.homePage);
            } else if (config.startupMode === 'browser') {
                const artifactsUrl = `http://127.0.0.1:${serverPort}/${config.homePage}`;
                openInBrowser(artifactsUrl, 'Artifacts Browser');
            }
        } else {
            // Fallback mode: show setup instructions from extension's example/index.html
            console.log('[AIMax] No Artifacts found - showing setup instructions');
            openSetupInstructions();
        }
    } else {
        console.log('[AIMax] Startup mode: none');
    }

    // ZeroUI: Open Claude Code in secondary sidebar at startup
    if (config.startupOpenClaudeCode) {
        console.log('[AIMax] Opening Claude Code at startup');
        setTimeout(() => {
            vscode.commands.executeCommand('claude-vscode.newConversation');
        }, 500); // Small delay to let the UI settle
    }

    // ZeroUI: Focus AIMax Viewer sidebar
    if (config.startupFocusSidebar) {
        console.log('[AIMax] Focusing AIMax Viewer sidebar');
        setTimeout(() => {
            vscode.commands.executeCommand('workbench.view.extension.aimax-viewer');
        }, 100);
    }

    // Register browser command
    const openBrowserCommand = vscode.commands.registerCommand('aimaxViewer.openBrowser', async (urlArg?: string, titleArg?: string) => {
        let url = urlArg;

        if (!url) {
            url = await vscode.window.showInputBox({
                prompt: 'Enter URL to open',
                placeHolder: 'http://localhost:2204',
                value: 'http://localhost:2204'
            });
        }

        if (!url) return;

        // Ensure URL has protocol
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'http://' + url;
        }

        openInBrowser(url, titleArg);
    });

    // Open Home Page command
    const openHomeCommand = vscode.commands.registerCommand('aimaxViewer.openHome', () => {
        if (workspaceFolder) {
            const cfg = getConfig();
            openArtifactsHome(workspaceFolder, cfg.homePage);
        }
    });

    // Open current HTML or MD file in viewer
    const openCurrentFileCommand = vscode.commands.registerCommand('aimaxViewer.openCurrentFile', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No file open');
            return;
        }
        const filePath = editor.document.uri.fsPath;
        if (!filePath.endsWith('.html') && !filePath.endsWith('.md')) {
            vscode.window.showWarningMessage('Current file is not an HTML or Markdown file');
            return;
        }
        if (workspaceFolder) {
            const httpUrl = getHttpUrl(filePath, workspaceFolder);
            openInBrowser(httpUrl);
        }
    });

    // Open file from explorer context menu (right-click)
    const openFileInViewerCommand = vscode.commands.registerCommand('aimaxViewer.openFileInViewer', (uri: vscode.Uri) => {
        if (!uri || !uri.fsPath) {
            vscode.window.showWarningMessage('No file selected');
            return;
        }
        const filePath = uri.fsPath;
        if (!filePath.endsWith('.html') && !filePath.endsWith('.md')) {
            vscode.window.showWarningMessage('Selected file is not an HTML or Markdown file');
            return;
        }
        if (workspaceFolder) {
            const httpUrl = getHttpUrl(filePath, workspaceFolder);
            openInBrowser(httpUrl);
        }
    });

    // Present HTML file in system browser (presenter mode)
    const presentFileCommand = vscode.commands.registerCommand('aimaxViewer.presentFile', (uri: vscode.Uri) => {
        let filePath: string | undefined;
        if (uri && uri.fsPath) {
            filePath = uri.fsPath;
        } else {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                filePath = editor.document.uri.fsPath;
            }
        }
        if (!filePath) {
            vscode.window.showWarningMessage('No file selected');
            return;
        }
        if (!filePath.endsWith('.html')) {
            vscode.window.showWarningMessage('Presenter mode only works with HTML files');
            return;
        }
        if (workspaceFolder) {
            const httpUrl = getHttpUrl(filePath, workspaceFolder);
            const presenterUrl = `http://127.0.0.1:${serverPort}/__presenter#${httpUrl}`;
            vscode.env.openExternal(vscode.Uri.parse(presenterUrl));
        }
    });

    // Command: Open new terminal
    const openTerminalCommand = vscode.commands.registerCommand('aimaxViewer.openTerminal', () => {
        vscode.commands.executeCommand('workbench.action.terminal.new');
    });

    // Command: Open Claude Code (new conversation)
    const openClaudeCodeCommand = vscode.commands.registerCommand('aimaxViewer.openClaudeCode', () => {
        // Just open new conversation - it handles focus automatically
        vscode.commands.executeCommand('claude-vscode.newConversation');
    });

    // Command: Open Artifacts Browser (opens browser panel with artifacts dropdown)
    const openArtifactsBrowserCommand = vscode.commands.registerCommand('aimaxViewer.openArtifactsBrowser', () => {
        if (workspaceFolder) {
            const cfg = getConfig();
            // Open the artifacts index via HTTP server
            const artifactsUrl = `http://127.0.0.1:${cfg.serverPort}/Artifacts/index.html`;
            openInBrowser(artifactsUrl, 'Artifacts Browser');
        }
    });

    // URI handler for vscode:// links
    const uriHandler = vscode.window.registerUriHandler({
        handleUri(uri: vscode.Uri) {
            if (uri.path === '/openBrowser') {
                const url = uri.query; // e.g., vscode://aimax.aimax-viewer/openBrowser?http://localhost:8080
                if (url) {
                    openInBrowser(url);
                }
            } else if (uri.path === '/openHome') {
                if (workspaceFolder) {
                    const cfg = getConfig();
                    openArtifactsHome(workspaceFolder, cfg.homePage);
                }
            } else if (uri.path === '/openCurrentFile') {
                vscode.commands.executeCommand('aimaxViewer.openCurrentFile');
            } else if (uri.path === '/openTerminal') {
                vscode.commands.executeCommand('aimaxViewer.openTerminal');
            } else if (uri.path === '/openClaudeCode') {
                vscode.commands.executeCommand('aimaxViewer.openClaudeCode');
            }
        }
    });

    // Register Useful Links webview
    const linksProvider: vscode.WebviewViewProvider = {
        resolveWebviewView(view: vscode.WebviewView) {
            view.webview.options = { enableScripts: true };
            view.webview.html = `<!DOCTYPE html>
<html><head><style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); padding: 8px 12px; }
    a { color: var(--vscode-textLink-foreground); text-decoration: none; display: flex; align-items: center; gap: 6px; padding: 4px 0; font-size: 12px; }
    a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    .sep { border-top: 1px solid var(--vscode-panel-border, transparent); margin: 6px 0; }
</style></head><body>
    <a href="https://github.com/maxturazzini/aimax-viewer#readme" title="Open README in Viewer" data-viewer="true">&#x1F4D6; README</a>
    <a href="https://github.com/maxturazzini/aimax-viewer" title="GitHub Repository">&#x2B50; AIMax Viewer on GitHub</a>
    <a href="https://github.com/maxturazzini/aimax-viewer/releases" title="Download latest version">&#x1F4E6; Releases / Updates</a>
    <a href="changelog" title="View Changelog" data-changelog="true">&#x1F4CB; Changelog</a>
    <div class="sep"></div>
    <a href="https://github.com/maxturazzini/aimax-viewer/issues" title="Report issues or request features">&#x1F41B; Report Issue / Feature Request</a>
<script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('a').forEach(a => {
        a.addEventListener('click', e => {
            e.preventDefault();
            const cmd = a.dataset.changelog ? 'openChangelog' : a.dataset.viewer ? 'openInViewer' : 'openUrl';
            vscode.postMessage({ command: cmd, url: a.href });
        });
    });
</script>
</body></html>`;
            view.webview.onDidReceiveMessage(msg => {
                if (msg.command === 'openInViewer') {
                    openInBrowser(msg.url, 'README');
                } else if (msg.command === 'openChangelog') {
                    // Open local CHANGELOG.md in viewer
                    const changelogPath = path.join(extensionContext.extensionPath, 'changelog.md');
                    if (fs.existsSync(changelogPath)) {
                        const content = fs.readFileSync(changelogPath, 'utf-8');
                        const { content: md, metadata } = extractFrontmatter(content);
                        const html = wrapMarkdownHtml(parseMarkdown(md), 'Changelog', metadata);
                        const panel = vscode.window.createWebviewPanel('aimaxChangelog', 'Changelog', vscode.ViewColumn.Two, { enableScripts: false });
                        panel.webview.html = html;
                    }
                } else if (msg.command === 'openUrl') {
                    vscode.env.openExternal(vscode.Uri.parse(msg.url));
                }
            });
        }
    };
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('aimaxViewer.linksView', linksProvider)
    );

    context.subscriptions.push(
        openBrowserCommand,
        openHomeCommand,
        openCurrentFileCommand,
        openFileInViewerCommand,
        presentFileCommand,
        openTerminalCommand,
        openClaudeCodeCommand,
        openArtifactsBrowserCommand,
        uriHandler
    );
}

function openInBrowser(url: string, customTitle?: string) {
    // Track in recents if it's a local file
    if (recentsProvider) {
        try {
            const urlObj = new URL(url);
            if (urlObj.hostname === '127.0.0.1' && urlObj.port === String(serverPort)) {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders) {
                    const fsPath = path.join(workspaceFolders[0].uri.fsPath, decodeURIComponent(urlObj.pathname));
                    recentsProvider.addRecent(fsPath);
                }
            }
        } catch { /* ignore non-URL strings */ }
    }

    const config = getConfig();

    // Extract title from URL path for local files
    let pageTitle = customTitle;
    if (!pageTitle) {
        try {
            const urlObj = new URL(url);
            const pathParts = urlObj.pathname.split('/').filter(p => p);
            const fileName = pathParts[pathParts.length - 1] || '';
            if (fileName.endsWith('.html') || fileName.endsWith('.md')) {
                // Use filename without extension as title
                pageTitle = fileName.replace('.html', '').replace('.md', '').replace(/_/g, ' ');
                // Capitalize first letter of each word
                pageTitle = pageTitle.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            } else {
                pageTitle = urlObj.hostname;
            }
        } catch {
            pageTitle = 'AIMax Browser';
        }
    }

    // Multi-tab mode: reuse panel if same URL is already open, otherwise create new
    // Single-tab mode: reuse existing panel
    if (config.multiTab) {
        // Check if this URL already has an open panel
        const existingPanel = openBrowserPanels.get(url);
        if (existingPanel) {
            existingPanel.reveal(vscode.ViewColumn.Two);
            return;
        }

        // Create a new panel for this URL
        const newPanel = vscode.window.createWebviewPanel(
            'aimaxBrowser',
            pageTitle,
            vscode.ViewColumn.Two,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionContext.extensionUri]
            }
        );

        // Track the panel
        openBrowserPanels.set(url, newPanel);
        newPanel.onDidDispose(() => {
            openBrowserPanels.delete(url);
        });

        // Get favicon URI
        const faviconPath = vscode.Uri.joinPath(extensionContext.extensionUri, 'icon.png');
        const faviconUri = newPanel.webview.asWebviewUri(faviconPath).toString();

        // Handle messages from webview
        newPanel.webview.onDidReceiveMessage(message => {
            if (message.command === 'openExternal' && message.url) {
                vscode.env.openExternal(vscode.Uri.parse(message.url));
            } else if (message.command === 'updateTitle' && message.title) {
                newPanel.title = message.title;
            } else if (message.command === 'openCurrentFile') {
                vscode.commands.executeCommand('aimaxViewer.openCurrentFile');
            } else if (message.command === 'openTerminal') {
                vscode.commands.executeCommand('aimaxViewer.openTerminal');
            } else if (message.command === 'openClaudeCode') {
                vscode.commands.executeCommand('aimaxViewer.openClaudeCode');
            } else if (message.command === 'presentFile' && message.url) {
                const presenterUrl = `http://127.0.0.1:${serverPort}/__presenter#${message.url}`;
                vscode.env.openExternal(vscode.Uri.parse(presenterUrl));
            }
        });

        const showDropdown = config.browserLayout === 'top';
        newPanel.webview.html = getBrowserHtml(url, pageTitle, faviconUri, showDropdown);
                return;
    }

    // Single-tab mode: reuse browserPanel
    if (browserPanel) {
        browserPanel.reveal(vscode.ViewColumn.Two);
    } else {
        browserPanel = vscode.window.createWebviewPanel(
            'aimaxBrowser',
            pageTitle,
            vscode.ViewColumn.Two,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionContext.extensionUri]
            }
        );

        browserPanel.onDidDispose(() => {
            browserPanel = undefined;
        });

        // Handle messages from webview
        browserPanel.webview.onDidReceiveMessage(message => {
            if (message.command === 'openExternal' && message.url) {
                vscode.env.openExternal(vscode.Uri.parse(message.url));
            } else if (message.command === 'updateTitle' && message.title) {
                if (browserPanel) {
                    browserPanel.title = message.title;
                }
            } else if (message.command === 'openCurrentFile') {
                vscode.commands.executeCommand('aimaxViewer.openCurrentFile');
            } else if (message.command === 'openTerminal') {
                vscode.commands.executeCommand('aimaxViewer.openTerminal');
            } else if (message.command === 'openClaudeCode') {
                vscode.commands.executeCommand('aimaxViewer.openClaudeCode');
            } else if (message.command === 'presentFile' && message.url) {
                const presenterUrl = `http://127.0.0.1:${serverPort}/__presenter#${message.url}`;
                vscode.env.openExternal(vscode.Uri.parse(presenterUrl));
            }
        });
    }

    // Get favicon URI
    const faviconPath = vscode.Uri.joinPath(extensionContext.extensionUri, 'icon.png');
    const faviconUri = browserPanel.webview.asWebviewUri(faviconPath).toString();

    browserPanel.title = pageTitle;
    const showDropdown = config.browserLayout === 'top';
    browserPanel.webview.html = getBrowserHtml(url, pageTitle, faviconUri, showDropdown);
    }

function getBrowserHtml(url: string, title: string, faviconUri: string, showDropdown: boolean = true): string {
    const csp = generateCSP();
    const homePage = getConfig().homePage;
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #1e1e1e;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .toolbar {
            background: linear-gradient(90deg, #1a1a2e 0%, #16213e 100%);
            padding: 8px 12px;
            display: flex;
            align-items: center;
            gap: 8px;
            border-bottom: 2px solid #00d4ff;
        }
        .brand-icon {
            height: 22px;
            width: auto;
            cursor: pointer;
            border-radius: 4px;
            transition: opacity 0.2s;
            margin-right: 4px;
        }
        .brand-icon:hover { opacity: 0.7; }
        .nav-btn {
            background: transparent;
            border: 1px solid rgba(255,255,255,0.15);
            color: #666;
            padding: 2px 6px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-family: system-ui;
            line-height: 1;
        }
        .nav-btn:hover:not(:disabled) { color: #00d4ff; border-color: #00d4ff; }
        .nav-btn:disabled { opacity: 0.3; cursor: default; }
        .select-wrapper {
            flex: 1;
            display: flex;
            align-items: center;
            background: #3c3c3c;
            border-radius: 4px;
            position: relative;
        }
        .select-wrapper:hover { background: #4c4c4c; }
        .url-display {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: flex-end;
            background: #3c3c3c;
            border-radius: 4px;
            padding: 0 4px;
        }
        .artifact-select {
            flex: 1;
            background: transparent;
            border: none;
            color: #cccccc;
            padding: 6px 12px;
            padding-right: 28px;
            font-size: 12px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            cursor: pointer;
            appearance: none;
            -webkit-appearance: none;
        }
        .artifact-select option {
            background: #252526;
            color: #cccccc;
        }
        .select-info-btn {
            background: transparent;
            border: none;
            color: #888;
            font-size: 12px;
            cursor: pointer;
            padding: 4px 8px;
            position: relative;
        }
        .select-info-btn:hover { color: #00d4ff; }
        .info-tooltip {
            display: none;
            position: absolute;
            top: 100%;
            right: 0;
            background: #1e1e1e;
            border: 1px solid #3c3c3c;
            border-radius: 6px;
            padding: 10px 14px;
            font-size: 12px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            color: #cccccc;
            white-space: normal;
            min-width: 250px;
            max-width: 400px;
            z-index: 100001;
            margin-top: 4px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.4);
            line-height: 1.4;
        }
        .select-info-btn:hover .info-tooltip { display: block; }
        .title-badge {
            background: #0e639c;
            color: white;
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 11px;
        }
        .toolbar-btn {
            background: transparent;
            border: 1px solid #3c3c3c;
            color: #cccccc;
            font-size: 11px;
            cursor: pointer;
            padding: 4px 8px;
            border-radius: 4px;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .toolbar-btn:hover {
            color: #00d4ff;
            border-color: #00d4ff;
        }
        .menu-btn {
            background: transparent;
            border: none;
            color: #cccccc;
            font-size: 18px;
            cursor: pointer;
            padding: 4px 8px;
        }
        .menu-btn:hover { color: #00d4ff; }
        .menu {
            display: none;
            position: fixed;
            top: 44px;
            right: 12px;
            background: #252526;
            border: 1px solid #3c3c3c;
            border-radius: 8px;
            padding: 8px 0;
            z-index: 100000;
            min-width: 200px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }
        .menu.open { display: block; }
        .menu-item {
            display: block;
            padding: 8px 16px;
            color: #cccccc;
            text-decoration: none;
            font-size: 13px;
            cursor: pointer;
            border: none;
            background: none;
            width: 100%;
            text-align: left;
        }
        .menu-item:hover { background: #3c3c3c; color: #00d4ff; }
        .menu-divider { border-top: 1px solid #3c3c3c; margin: 4px 0; }
        iframe {
            flex: 1;
            border: none;
            background: white;
        }
        .error {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            color: #cccccc;
            text-align: center;
            padding: 40px;
        }
        .error h2 { margin-bottom: 16px; color: #e06c75; }
        .error p { margin-bottom: 24px; opacity: 0.8; }

        @media print {
            .toolbar, .menu { display: none !important; }
            iframe {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: auto;
                border: none;
            }
            body { height: auto; background: white; }
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <button class="nav-btn" id="backBtn" onclick="goBack()" title="Back" disabled>←</button>
        <button class="nav-btn" id="fwdBtn" onclick="goForward()" title="Forward" disabled>→</button>
        <button class="nav-btn" onclick="reload()" title="Reload">↻</button>
        ${showDropdown ? `
        <div class="select-wrapper">
            <select class="artifact-select" id="artifactSelect" onchange="loadArtifact(this.value)">
                <option value="">Loading artifacts...</option>
            </select>
            <button class="select-info-btn" id="infoBtn">
                ⓘ
                <span class="info-tooltip" id="infoTooltip">${url}</span>
            </button>
        </div>
        ` : `
        <div class="url-display">
            <button class="select-info-btn" id="infoBtn">
                ⓘ
                <span class="info-tooltip" id="infoTooltip">${url}</span>
            </button>
        </div>
        `}
        <button class="toolbar-btn" onclick="openTerminal()" title="Open new terminal">
            <span style="color: #00d4ff; font-size: 14px;">&gt;</span>
        </button>
        <button class="toolbar-btn" onclick="openClaudeCode()" title="New Claude Code conversation">
            <span style="color: #ff9500; font-size: 20px; line-height: 1;">*</span>
        </button>
        <button class="menu-btn" onclick="toggleMenu()">☰</button>
    </div>
    <div class="menu" id="menu">
        <button class="menu-item" onclick="reload()">Reload</button>
        <button class="menu-item" onclick="copyUrl()">Copy URL</button>
        <!-- WIP: Export PDF disabled - needs VS Code file system API -->
        <button class="menu-item" onclick="openExternal()">Open in External Browser</button>
        <button class="menu-item" onclick="presentInBrowser()">Present in Browser</button>
        <div class="menu-divider"></div>
        <button class="menu-item" onclick="goHome()">Go to Home</button>
        <button class="menu-item" onclick="openCurrentFile()">Open Current Editor File</button>
    </div>
    <iframe id="frame" src="${url}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"></iframe>

    <script>
        const vscode = acquireVsCodeApi();
        const frame = document.getElementById('frame');
        const artifactSelect = document.getElementById('artifactSelect');
        const infoTooltip = document.getElementById('infoTooltip');
        let currentUrl = '${url}';

        // History management
        let navHistory = ['${url}'];
        let historyIndex = 0;

        function updateNavButtons() {
            document.getElementById('backBtn').disabled = historyIndex <= 0;
            document.getElementById('fwdBtn').disabled = historyIndex >= navHistory.length - 1;
        }

        function goBack() {
            if (historyIndex > 0) {
                historyIndex--;
                navigateToUrl(navHistory[historyIndex], false);
            }
        }

        function goForward() {
            if (historyIndex < navHistory.length - 1) {
                historyIndex++;
                navigateToUrl(navHistory[historyIndex], false);
            }
        }

        function navigateToUrl(url, addToHistory = true) {
            console.log('[AIMax Nav] navigateToUrl:', url, 'addToHistory:', addToHistory);
            console.log('[AIMax Nav] current history:', navHistory, 'index:', historyIndex);
            if (addToHistory && url !== navHistory[historyIndex]) {
                // Truncate forward history and add new entry
                navHistory = navHistory.slice(0, historyIndex + 1);
                navHistory.push(url);
                historyIndex = navHistory.length - 1;
                console.log('[AIMax Nav] Added to history. New history:', navHistory, 'index:', historyIndex);
            }
            frame.src = url;
            currentUrl = url;
            updateUrlDisplay(url);
            updateNavButtons();
            console.log('[AIMax Nav] Back disabled:', document.getElementById('backBtn').disabled);

            // Extract title from URL
            const fileName = url.split('/').pop().replace('.html', '').replace('.md', '').replace(/_/g, ' ');
            const title = fileName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            vscode.postMessage({ command: 'updateTitle', title: title });
        }

        // Update info tooltip with URL and optional metadata
        function updateInfoTooltip(url, metadata) {
            let html = '<div style="font-size: 11px; color: #888; word-break: break-all;">' + url + '</div>';

            if (metadata && Object.keys(metadata).length > 0) {
                html += '<div style="margin-top: 8px; border-top: 1px solid #444; padding-top: 8px;">';
                for (const [key, value] of Object.entries(metadata)) {
                    const displayValue = Array.isArray(value) ? value.join(', ') : value;
                    html += '<div style="margin-bottom: 4px;"><strong style="color: #00d4ff;">' + key + ':</strong> ' + displayValue + '</div>';
                }
                html += '</div>';
            }

            infoTooltip.innerHTML = html;
        }

        // Legacy function for backward compatibility
        function updateUrlDisplay(url) {
            updateInfoTooltip(url, null);
        }

        // Load artifacts list grouped by folder
        async function loadArtifactsList() {
            try {
                const response = await fetch('http://127.0.0.1:${serverPort}/api/artifacts');
                const artifacts = await response.json();

                artifactSelect.innerHTML = '<option value="">📁 Select an Artifact...</option>';
                artifactSelect.innerHTML += '<option value="http://127.0.0.1:${serverPort}/Artifacts/index.html">🏠 Home (index.html)</option>';

                // Group artifacts by folderLabel
                const grouped = {};
                artifacts.forEach(artifact => {
                    const label = artifact.folderLabel || 'Artifacts';
                    if (!grouped[label]) grouped[label] = [];
                    grouped[label].push(artifact);
                });

                // Create optgroups for each folder
                const folderLabels = Object.keys(grouped);
                if (folderLabels.length > 1) {
                    // Multiple folders: use optgroups
                    folderLabels.forEach(label => {
                        const optgroup = document.createElement('optgroup');
                        optgroup.label = '📁 ' + label;
                        grouped[label].forEach(artifact => {
                            const option = document.createElement('option');
                            option.value = artifact.url;
                            const icon = artifact.type === 'md' ? '📝' : '📄';
                            option.textContent = icon + ' ' + artifact.name;
                            if (artifact.url === currentUrl) {
                                option.selected = true;
                            }
                            optgroup.appendChild(option);
                        });
                        artifactSelect.appendChild(optgroup);
                    });
                } else {
                    // Single folder: flat list
                    artifacts.forEach(artifact => {
                        const option = document.createElement('option');
                        option.value = artifact.url;
                        const icon = artifact.type === 'md' ? '📝' : '📄';
                        option.textContent = icon + ' ' + artifact.name;
                        if (artifact.url === currentUrl) {
                            option.selected = true;
                        }
                        artifactSelect.appendChild(option);
                    });
                }
            } catch (e) {
                artifactSelect.innerHTML = '<option value="">Failed to load artifacts</option>';
            }
        }

        function loadArtifact(url) {
            if (!url) return;
            navigateToUrl(url, true);
        }

        function toggleMenu() {
            document.getElementById('menu').classList.toggle('open');
        }

        function reload() {
            frame.src = frame.src;
            toggleMenu();
        }

        function copyUrl() {
            navigator.clipboard.writeText(currentUrl);
            toggleMenu();
        }

        // Load html2pdf.js dynamically
        let html2pdfLoaded = false;
        function loadHtml2Pdf() {
            return new Promise((resolve, reject) => {
                if (html2pdfLoaded && window.html2pdf) {
                    resolve(window.html2pdf);
                    return;
                }
                const script = document.createElement('script');
                script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
                script.onload = () => {
                    html2pdfLoaded = true;
                    resolve(window.html2pdf);
                };
                script.onerror = reject;
                document.head.appendChild(script);
            });
        }

        async function exportPdf() {
            toggleMenu();
            try {
                // Show loading indicator
                const loadingDiv = document.createElement('div');
                loadingDiv.id = 'pdfLoading';
                loadingDiv.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:999999;color:white;font-size:16px;';
                loadingDiv.innerHTML = '<div style="text-align:center;"><div style="font-size:24px;margin-bottom:10px;">⏳</div>Generating PDF...</div>';
                document.body.appendChild(loadingDiv);

                // Load html2pdf.js if not already loaded
                await loadHtml2Pdf();

                // Get iframe content
                const iframeDoc = frame.contentDocument || frame.contentWindow.document;
                const content = iframeDoc.body.cloneNode(true);

                // Get filename from URL
                const fileName = currentUrl.split('/').pop()?.replace('.html', '').replace('.md', '') || 'artifact';

                // Generate PDF with html2pdf.js
                const opt = {
                    margin: [10, 10, 10, 10],
                    filename: fileName + '.pdf',
                    image: { type: 'jpeg', quality: 0.98 },
                    html2canvas: { scale: 2, useCORS: true, logging: false },
                    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
                };

                await window.html2pdf().set(opt).from(content).save();

                // Remove loading indicator
                document.body.removeChild(loadingDiv);
            } catch (e) {
                // Remove loading if exists
                const loading = document.getElementById('pdfLoading');
                if (loading) loading.remove();

                console.log('[AIMax] PDF export failed, falling back to print dialog:', e);
                // Fallback to print dialog
                try {
                    frame.contentWindow.print();
                } catch (printErr) {
                    vscode.postMessage({ command: 'openExternal', url: currentUrl });
                }
            }
        }

        function openExternal() {
            vscode.postMessage({ command: 'openExternal', url: currentUrl });
            toggleMenu();
        }

        function presentInBrowser() {
            vscode.postMessage({ command: 'presentFile', url: currentUrl });
            toggleMenu();
        }

        function goHome() {
            const homeUrl = 'http://127.0.0.1:${serverPort}/${homePage}';
            navigateToUrl(homeUrl, true);
            if (artifactSelect) artifactSelect.value = homeUrl;
            toggleMenu();
        }

        function openCurrentFile() {
            vscode.postMessage({ command: 'openCurrentFile' });
            toggleMenu();
        }

        function openTerminal() {
            vscode.postMessage({ command: 'openTerminal' });
        }

        function openClaudeCode() {
            vscode.postMessage({ command: 'openClaudeCode' });
        }

        // Close menu on outside click
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.menu-btn') && !e.target.closest('.menu')) {
                document.getElementById('menu').classList.remove('open');
            }
        });

        // Track iframe navigation (when user clicks links inside iframe)
        frame.onload = function() {
            console.log('[AIMax Nav] === IFRAME ONLOAD FIRED ===');
            try {
                const newUrl = frame.contentWindow?.location.href;
                console.log('[AIMax Nav] newUrl from iframe:', newUrl);
                console.log('[AIMax Nav] currentUrl tracked:', currentUrl);
                console.log('[AIMax Nav] Are they equal?', newUrl === currentUrl);

                // If URL changed and it's not from our navigation, add to history
                if (newUrl && newUrl !== currentUrl && newUrl !== 'about:blank') {
                    console.log('[AIMax Nav] URL CHANGED! Detected internal navigation to:', newUrl);
                    // Add to history without changing frame.src (it already loaded)
                    if (newUrl !== navHistory[historyIndex]) {
                        navHistory = navHistory.slice(0, historyIndex + 1);
                        navHistory.push(newUrl);
                        historyIndex = navHistory.length - 1;
                        console.log('[AIMax Nav] Added to history. New index:', historyIndex, 'history length:', navHistory.length);
                    }
                    currentUrl = newUrl;
                    updateUrlDisplay(newUrl);
                    updateNavButtons();
                    console.log('[AIMax Nav] Back button disabled?', document.getElementById('backBtn').disabled);
                } else {
                    console.log('[AIMax Nav] URL unchanged or about:blank, skipping history update');
                }

                // Try to get page title
                const iframeTitle = frame.contentDocument?.title;
                if (iframeTitle) {
                    vscode.postMessage({ command: 'updateTitle', title: iframeTitle });
                }

                // Note: Metadata is received via postMessage from the iframe content
                // (see message listener below)
            } catch (e) {
                // Cross-origin - URL/title not accessible, but metadata still comes via postMessage
                console.log('[AIMax Nav] Cross-origin iframe, waiting for postMessage');
            }
        };

        // Listen for metadata from iframe content (postMessage from markdown pages)
        window.addEventListener('message', (event) => {
            if (event.data?.type === 'aimaxMetadata' && event.data.metadata) {
                console.log('[AIMax] Received metadata via postMessage:', event.data.metadata);
                updateInfoTooltip(currentUrl, event.data.metadata);
            }
        });

        // Initialize
        ${showDropdown ? 'loadArtifactsList();' : '// Dropdown disabled - using sidebar navigation'}

        // Handle iframe load errors
        frame.onerror = function() {
            document.body.innerHTML = \`
                <div class="error">
                    <h2>Cannot load page</h2>
                    <p>The page might be unavailable or blocked by security restrictions.</p>
                    <br><br>
                    <button onclick="openExternal()" style="background:#0e639c;color:white;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;">Open in External Browser</button>
                </div>
            \`;
        };
    </script>
</body>
</html>`;
}

function startHttpServer(workspaceFolder: string) {
    if (httpServer) {
        return; // Already running
    }

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

        // API endpoint: list artifact files from all configured folders
        if (url === '/api/artifacts') {
            const config = getConfig();
            const allFilesPromises = config.browserFolders.map(async (folder) => {
                // Support absolute paths (works on Mac, Windows, Linux)
                const folderPath = path.isAbsolute(folder.path)
                    ? folder.path
                    : path.join(workspaceFolder, folder.path);
                if (fs.existsSync(folderPath)) {
                    return listArtifactFiles(folderPath, workspaceFolder, folder.label);
                }
                return [];
            });

            Promise.all(allFilesPromises).then(results => {
                const allFiles = results.flat().sort((a, b) => b.modified - a.modified);
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify(allFiles));
            }).catch(() => {
                res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'Failed to list artifacts' }));
            });
            return;
        }

        // Handle CORS preflight requests
        if (req.method === 'OPTIONS') {
            res.writeHead(200, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            });
            res.end();
            return;
        }

        // API endpoint: send prompt to Claude Code (supports modes: terminal, vscode, print, copy)
        if (url === '/__claude' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            req.on('end', () => {
                const raw = body.trim();
                let prompt = '';
                let mode = 'terminal';

                // Try JSON parse, fall back to plain text
                try {
                    const parsed = JSON.parse(raw);
                    prompt = (parsed.prompt || '').trim();
                    mode = parsed.mode || 'terminal';
                } catch {
                    prompt = raw;
                }

                if (!prompt) {
                    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'Empty prompt' }));
                    return;
                }

                const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

                if (mode === 'vscode') {
                    // Copy prompt to clipboard, then open Claude Code panel
                    vscode.env.clipboard.writeText(prompt).then(() => {
                        vscode.commands.executeCommand('claude-vscode.newConversation');
                        res.writeHead(200, headers);
                        res.end(JSON.stringify({ ok: true, mode: 'vscode', prompt, note: 'Prompt copied to clipboard. Paste into Claude Code panel.' }));
                    });
                } else if (mode === 'terminal') {
                    // Open interactive Claude session in terminal with prompt
                    const terminal = vscode.window.createTerminal('Claude Code');
                    terminal.show();
                    const escaped = prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`').replace(/'/g, "'\\''");
                    terminal.sendText(`claude "${escaped}"`);
                    res.writeHead(200, headers);
                    res.end(JSON.stringify({ ok: true, mode: 'terminal', prompt }));
                } else if (mode === 'print') {
                    // Non-interactive: run claude -p and return the response via stdin
                    console.log('[AIMax] print mode: spawning claude -p -, cwd:', workspaceFolder);
                    const child = spawn('claude', ['-p', '-'], {
                        cwd: workspaceFolder,
                        shell: true,
                        env: { ...process.env }
                    });
                    child.stdin.write(prompt);
                    child.stdin.end();
                    console.log('[AIMax] print mode: wrote prompt to stdin, length:', prompt.length);
                    let stdout = '';
                    let stderr = '';
                    const timeout = setTimeout(() => {
                        child.kill();
                        console.log('[AIMax] print mode: TIMEOUT after 120s. stdout so far:', stdout.length, 'chars. stderr:', stderr);
                        res.writeHead(504, headers);
                        res.end(JSON.stringify({ ok: false, error: 'Timeout (120s)' }));
                    }, 120000);
                    child.stdout.on('data', (data: Buffer) => {
                        stdout += data.toString();
                        console.log('[AIMax] print mode: stdout chunk, total:', stdout.length);
                    });
                    child.stderr.on('data', (data: Buffer) => {
                        stderr += data.toString();
                        console.log('[AIMax] print mode: stderr:', data.toString().trim());
                    });
                    child.on('close', (code: number | null) => {
                        clearTimeout(timeout);
                        console.log('[AIMax] print mode: process closed, code:', code, 'stdout:', stdout.length, 'stderr:', stderr.length);
                        if (code !== 0) {
                            res.writeHead(500, headers);
                            res.end(JSON.stringify({ ok: false, error: stderr || 'Exit code ' + code }));
                        } else {
                            res.writeHead(200, headers);
                            res.end(JSON.stringify({ ok: true, mode: 'print', response: stdout }));
                        }
                    });
                    child.on('error', (err: Error) => {
                        clearTimeout(timeout);
                        console.log('[AIMax] print mode: spawn error:', err.message);
                        res.writeHead(500, headers);
                        res.end(JSON.stringify({ ok: false, error: err.message }));
                    });
                } else if (mode === 'copy') {
                    // Just echo back the prompt for client-side clipboard handling
                    res.writeHead(200, headers);
                    res.end(JSON.stringify({ ok: true, mode: 'copy', prompt }));
                } else {
                    res.writeHead(400, headers);
                    res.end(JSON.stringify({ ok: false, error: 'Unknown mode: ' + mode }));
                }
            });
            return;
        }

        // API endpoint: list apps with status
        if (url === '/api/apps') {
            if (!appsManager) {
                res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'Apps Manager not enabled' }));
                return;
            }
            appsManager.getStatus().then(statuses => {
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify(statuses));
            }).catch((err) => {
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: err.message }));
            });
            return;
        }

        // API endpoint: identity (workspace name for cross-instance discovery)
        if (url === '/api/identity') {
            const workspaceName = vscode.workspace.name || path.basename(workspaceFolder);
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({ workspace: workspaceName }));
            return;
        }

        // API endpoint: list ports in use
        if (url === '/api/ports') {
            if (!appsManager) {
                res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'Apps Manager not enabled' }));
                return;
            }
            appsManager.getPortsInUse().then(ports => {
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify(ports));
            }).catch((err) => {
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: err.message }));
            });
            return;
        }

        // API endpoint: start app
        const startMatch = url.match(/^\/api\/apps\/(.+)\/start$/);
        if (req.method === 'POST' && startMatch) {
            const appId = decodeURIComponent(startMatch[1]);
            if (!appsManager) {
                res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'Apps Manager not enabled' }));
                return;
            }
            appsManager.startApp(appId).then(success => {
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ success }));
                appsTreeProvider?.refresh();
            }).catch((err) => {
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: err.message }));
            });
            return;
        }

        // API endpoint: stop app
        const stopMatch = url.match(/^\/api\/apps\/(.+)\/stop$/);
        if (req.method === 'POST' && stopMatch) {
            const appId = decodeURIComponent(stopMatch[1]);
            if (!appsManager) {
                res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'Apps Manager not enabled' }));
                return;
            }
            appsManager.stopApp(appId).then(success => {
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ success }));
                appsTreeProvider?.refresh();
            }).catch((err) => {
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: err.message }));
            });
            return;
        }

        // Serve slide-presenter.html from extension bundle
        if (url === '/__presenter' || url === '/__presenter/') {
            const presenterPath = path.join(extensionContext.extensionPath, 'slide-presenter.html');
            if (fs.existsSync(presenterPath)) {
                const data = fs.readFileSync(presenterPath);
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(data);
            } else {
                res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
                res.end('Presenter not found');
            }
            return;
        }

        // Handle root path: redirect to /Artifacts/index.html
        if (url === '/' || url === '') {
            res.writeHead(302, {
                'Location': '/Artifacts/index.html',
                'Access-Control-Allow-Origin': '*'
            });
            res.end();
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
                const rawContent = fs.readFileSync(filePath, 'utf-8');
                const { content, metadata } = extractFrontmatter(rawContent);
                const title = (metadata?.title as string) || path.basename(filePath, ext).replace(/_/g, ' ');
                const html = wrapMarkdownHtml(parseMarkdown(content), title, metadata);
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

    httpServer.listen(serverPort, '127.0.0.1', () => {
        console.log(`AIMax HTTP server running on http://127.0.0.1:${serverPort}`);
    });

    // Try next port if current is busy
    httpServer.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE') {
            serverPort++;
            httpServer = undefined;
            startHttpServer(workspaceFolder);
        }
    });
}

function getHttpUrl(filePath: string, workspaceFolder: string): string {
    // Convert file path to HTTP URL via our server
    const relativePath = filePath.replace(workspaceFolder, '').replace(/^\//, '');
    return `http://127.0.0.1:${serverPort}/${relativePath}`;
}

// Recursively list artifact files (HTML and MD) in a directory
async function listArtifactFiles(
    dir: string,
    workspaceFolder: string,
    folderLabel: string = 'Artifacts'
): Promise<{name: string, path: string, url: string, modified: number, type: 'html' | 'md', folderLabel: string}[]> {
    const results: {name: string, path: string, url: string, modified: number, type: 'html' | 'md', folderLabel: string}[] = [];

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
    // Sort by modification date, newest first
    return results.sort((a, b) => b.modified - a.modified);
}

// Open home page with link handler (reads file directly, intercepts clicks)
function openArtifactsHome(workspaceFolder: string, homePage: string = 'Artifacts/index.html') {
    const indexPath = path.join(workspaceFolder, homePage);

    if (!fs.existsSync(indexPath)) {
        console.log('[AIMax] Home page not found:', indexPath);
        return;
    }

    console.log('[AIMax] Opening home page:', indexPath);

    // Read HTML file directly
    let htmlContent = fs.readFileSync(indexPath, 'utf8');

    if (homePanel) {
        homePanel.reveal(vscode.ViewColumn.One);
    } else {
        homePanel = vscode.window.createWebviewPanel(
            'aimaxHome',
            'Artifacts Home',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(workspaceFolder, 'projects')),
                    extensionContext.extensionUri
                ]
            }
        );

        homePanel.onDidDispose(() => {
            homePanel = undefined;
        });

        // Handle link clicks and toolbar buttons
        homePanel.webview.onDidReceiveMessage(message => {
            if (message.command === 'openUrl') {
                const url = message.url;
                console.log('[AIMax] Link clicked:', url);
                if (url.startsWith('vscode://')) {
                    // Handle vscode:// protocol internally
                    if (url.includes('/openBrowser')) {
                        const targetUrl = url.split('?')[1];
                        if (targetUrl) {
                            openInBrowser(targetUrl);
                        }
                    }
                } else if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) {
                    openInBrowser(url);
                } else {
                    // External URLs - open in system browser
                    vscode.env.openExternal(vscode.Uri.parse(url));
                }
            } else if (message.command === 'navigateLocal') {
                // Open local file in browser panel
                const filePath = path.join(workspaceFolder, 'projects', message.path);
                if (fs.existsSync(filePath)) {
                    const httpUrl = getHttpUrl(filePath, workspaceFolder);
                    openInBrowser(httpUrl);
                }
            } else if (message.command === 'openTerminal') {
                vscode.commands.executeCommand('workbench.action.terminal.new');
            } else if (message.command === 'openClaudeCode') {
                vscode.commands.executeCommand('claude-vscode.newConversation');
            } else if (message.command === 'openArtifactsBrowser') {
                vscode.commands.executeCommand('aimaxViewer.openArtifactsBrowser');
            } else if (message.command === 'reload') {
                // Re-render the home panel by re-reading the file
                openArtifactsHome(workspaceFolder);
            }
        });
    }

    // Get favicon URI
    const faviconPath = vscode.Uri.joinPath(extensionContext.extensionUri, 'icon.png');
    const faviconUri = homePanel.webview.asWebviewUri(faviconPath).toString();

    homePanel.webview.html = wrapWithToolbarAndLinkHandler(htmlContent, 'Artifacts Home', faviconUri);
}

// Wrap HTML with toolbar and inject link handler
function wrapWithToolbarAndLinkHandler(html: string, title: string, faviconUri: string): string {
    const toolbarStyles = `
    <style>
        .aimax-toolbar {
            background: linear-gradient(90deg, #1a1a2e 0%, #16213e 100%);
            padding: 8px 12px;
            display: flex;
            align-items: center;
            gap: 8px;
            border-bottom: 2px solid #00d4ff;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 100000;
        }
        .aimax-brand-icon {
            height: 22px;
            width: auto;
            cursor: pointer;
            border-radius: 4px;
            transition: opacity 0.2s;
            margin-right: 4px;
        }
        .aimax-brand-icon:hover { opacity: 0.7; }
        .aimax-nav-btn {
            background: transparent;
            border: 1px solid rgba(255,255,255,0.15);
            color: #666;
            padding: 2px 6px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-family: system-ui;
            line-height: 1;
        }
        .aimax-nav-btn:hover:not(:disabled) { color: #00d4ff; border-color: #00d4ff; }
        .aimax-nav-btn:disabled { opacity: 0.3; cursor: default; }
        .aimax-title {
            color: #cccccc;
            font-size: 12px;
            flex: 1;
        }
        .aimax-toolbar-btn {
            background: transparent;
            border: 1px solid #3c3c3c;
            color: #cccccc;
            font-size: 11px;
            cursor: pointer;
            padding: 4px 8px;
            border-radius: 4px;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .aimax-toolbar-btn:hover {
            color: #00d4ff;
            border-color: #00d4ff;
        }
        .aimax-info-btn {
            background: transparent;
            border: none;
            color: #888;
            font-size: 14px;
            cursor: pointer;
            padding: 4px 6px;
        }
        .aimax-info-btn:hover { color: #00d4ff; }
        .aimax-content-wrapper {
            padding-top: 44px;
        }
    </style>
    `;

    const toolbar = `
    <div class="aimax-toolbar">
        <img src="${faviconUri}" class="aimax-brand-icon" onclick="goHome()" alt="AI, MAX" title="Home" />
        <button class="aimax-nav-btn" id="backBtn" onclick="goBack()" title="Back" disabled>←</button>
        <button class="aimax-nav-btn" id="fwdBtn" onclick="goForward()" title="Forward" disabled>→</button>
        <button class="aimax-info-btn" onclick="reload()" title="Reload" style="font-size: 18px;">↻</button>
        <span class="aimax-title">${title}</span>
        <button class="aimax-toolbar-btn" onclick="openArtifactsBrowser()" title="Open Artifacts Browser">
            <span style="font-size: 12px;">[:]</span>
        </button>
        <button class="aimax-toolbar-btn" onclick="openTerminal()" title="Open new terminal">
            <span style="font-family: monospace; font-weight: bold;">&gt;_</span>
        </button>
        <button class="aimax-toolbar-btn" onclick="openClaudeCode()" title="New Claude Code conversation">
            <span style="color: #ff9500; font-size: 20px; line-height: 1;">*</span>
        </button>
    </div>
    `;

    const script = `
    <script>
        const vscode = acquireVsCodeApi();

        function goHome() {
            // Already on home, just scroll to top
            window.scrollTo(0, 0);
        }

        function goBack() {
            // Home page has no navigation history - buttons stay disabled
        }

        function goForward() {
            // Home page has no navigation history - buttons stay disabled
        }

        function openTerminal() {
            vscode.postMessage({ command: 'openTerminal' });
        }

        function openClaudeCode() {
            vscode.postMessage({ command: 'openClaudeCode' });
        }

        function openArtifactsBrowser() {
            vscode.postMessage({ command: 'openArtifactsBrowser' });
        }

        function reload() {
            vscode.postMessage({ command: 'reload' });
        }

        document.addEventListener('click', (e) => {
            const link = e.target.closest('a');
            if (!link) return;

            const href = link.getAttribute('href');
            if (!href) return;

            // Handle different URL types
            if (href.startsWith('vscode://') ||
                href.startsWith('http://localhost') ||
                href.startsWith('http://127.0.0.1') ||
                href.startsWith('http://') ||
                href.startsWith('https://')) {
                e.preventDefault();
                vscode.postMessage({ command: 'openUrl', url: href });
            } else if (href.startsWith('../') || (!href.startsWith('http') && href.endsWith('.html'))) {
                e.preventDefault();
                vscode.postMessage({ command: 'navigateLocal', path: href.replace('../', '') });
            }
        });
    </script>
    `;

    // Inject styles in head
    let result = html.replace('</head>', toolbarStyles + '</head>');

    // Wrap body content with toolbar and wrapper
    result = result.replace(/<body([^>]*)>/, `<body$1>${toolbar}<div class="aimax-content-wrapper">`);
    result = result.replace('</body>', '</div>' + script + '</body>');

    return result;
}

// Show setup instructions when Artifacts folder is not found
function openSetupInstructions() {
    const examplePath = path.join(extensionContext.extensionPath, 'example', 'index.html');

    if (!fs.existsSync(examplePath)) {
        console.log('[AIMax] Example file not found:', examplePath);
        vscode.window.showWarningMessage('AIMax Viewer: Setup instructions not found. Please create Artifacts/ folder in your workspace.');
        return;
    }

    console.log('[AIMax] Opening setup instructions:', examplePath);

    // Read HTML file directly
    let htmlContent = fs.readFileSync(examplePath, 'utf8');

    const panel = vscode.window.createWebviewPanel(
        'aimaxSetup',
        'AIMax Viewer Setup',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                extensionContext.extensionUri,
                vscode.Uri.joinPath(extensionContext.extensionUri, 'example')
            ]
        }
    );

    // Get favicon URI
    const faviconPath = vscode.Uri.joinPath(extensionContext.extensionUri, 'icon.png');
    const faviconUri = panel.webview.asWebviewUri(faviconPath).toString();

    // Wrap with minimal toolbar (no navigation since it's standalone)
    panel.webview.html = wrapSetupPageWithToolbar(htmlContent, 'AIMax Viewer Setup', faviconUri);
}

// Simplified wrapper for setup page (no navigation needed)
function wrapSetupPageWithToolbar(html: string, title: string, faviconUri: string): string {
    const toolbarStyles = `
    <style>
        .aimax-toolbar {
            background: linear-gradient(90deg, #1a1a2e 0%, #16213e 100%);
            padding: 8px 12px;
            display: flex;
            align-items: center;
            gap: 8px;
            border-bottom: 2px solid #00d4ff;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 100000;
        }
        .aimax-brand-icon {
            height: 22px;
            width: auto;
            border-radius: 4px;
            margin-right: 4px;
        }
        .aimax-title {
            color: #cccccc;
            font-size: 12px;
            flex: 1;
        }
        .aimax-content-wrapper {
            padding-top: 44px;
        }
    </style>
    `;

    const toolbar = `
    <div class="aimax-toolbar">
        <img src="${faviconUri}" class="aimax-brand-icon" alt="AI, MAX" title="AI, MAX" />
        <span class="aimax-title">${title}</span>
    </div>
    `;

    // Inject styles in head
    let result = html.replace('</head>', toolbarStyles + '</head>');

    // Wrap body content with toolbar and wrapper
    result = result.replace(/<body([^>]*)>/, `<body$1>${toolbar}<div class="aimax-content-wrapper">`);
    result = result.replace('</body>', '</div></body>');

    return result;
}

export function deactivate() {
    if (browserPanel) {
        browserPanel.dispose();
    }
    if (homePanel) {
        homePanel.dispose();
    }
    if (httpServer) {
        httpServer.close();
    }
    if (appsTreeProvider) {
        appsTreeProvider.dispose();
    }
}
