import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { execFile, execFileSync, spawn } from 'child_process';
import { parseMarkdown, wrapMarkdownHtml, extractFrontmatter } from './markdown-parser';
import { ANNOTATION_CLIENT_JS, injectAnnotationClient } from './annotation-client';
import { injectLinkHandler } from './link-handler-client';
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
// Snapshot of the Live Annotation toggle + skip-list taken at activation.
// Kept in module scope so any setting change requires a window reload —
// predictable behaviour.
let liveInspectEnabledSnapshot = true;
let liveInspectSkipHostsSnapshot: string[] = [];
let appsTreeProvider: AppsTreeProvider | undefined;
let recentsProvider: RecentsWebviewProvider | undefined;
let cachedFaviconDataUri: string | undefined;

function getFaviconDataUri(): string {
    if (cachedFaviconDataUri) return cachedFaviconDataUri;
    try {
        const iconPath = path.join(extensionContext.extensionPath, 'icon.png');
        const data = fs.readFileSync(iconPath);
        cachedFaviconDataUri = `data:image/png;base64,${data.toString('base64')}`;
    } catch {
        cachedFaviconDataUri = '';
    }
    return cachedFaviconDataUri;
}

// Claude Bridge result delivered to caller (HTTP /__claude or webview postMessage).
type BridgeResult = { ok: boolean; mode?: string; prompt?: string; response?: string; error?: string; opened?: boolean; note?: string };

// Human-friendly labels + reload-required map for toolbar config toggles.
// Shown as an info banner when a user flips a toggle from the toolbar menu.
const CONFIG_TOGGLE_INFO: Record<string, { label: string; reload: boolean }> = {
    'aimaxViewer.liveInspect.enabled': { label: 'Live Annotation', reload: true },
};

function applyConfigToggle(key: string, value: unknown): void {
    vscode.workspace.getConfiguration().update(
        key, value, vscode.ConfigurationTarget.Workspace
    ).then(() => {
        const info = CONFIG_TOGGLE_INFO[key];
        const label = info?.label || key;
        const state = value ? 'ON' : 'OFF';
        const msg = `AIMax: ${label} → ${state} (saved to workspace settings)`;
        if (info?.reload) {
            vscode.window.showInformationMessage(msg + '. Reload required to apply.', 'Reload Window')
                .then(choice => {
                    if (choice === 'Reload Window') {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
        } else {
            vscode.window.showInformationMessage(msg);
        }
    }, (err: Error) => {
        console.error('[AIMax] updateConfig failed:', err);
        vscode.window.showErrorMessage(`AIMax: failed to update setting ${key}: ${err.message}`);
    });
}

// Run Claude Bridge action for given mode/prompt and call back with result.
// Used by both the /__claude HTTP endpoint (proxy-injected pages and skill artifacts)
// and the toolbar Bridge dropdown (webview chrome via postMessage).
function handleClaudeBridge(mode: string, prompt: string, callback: (result: BridgeResult) => void, opts?: { allowEdits?: boolean; readOnly?: boolean }): void {
    if (!prompt) {
        callback({ ok: false, error: 'Empty prompt' });
        return;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const allowEdits = !!opts?.allowEdits;
    // allowEdits wins if both are set, so readOnly can never widen an edit session.
    const readOnly = !allowEdits && !!opts?.readOnly;

    if (mode === 'vscode') {
        const claudeUri = vscode.Uri.parse(
            `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`
        );
        vscode.env.clipboard.writeText(prompt).then(() => {
            return vscode.env.openExternal(claudeUri);
        }).then((opened) => {
            callback({ ok: true, mode: 'vscode', prompt, opened, note: 'Prompt pre-filled in Claude Code panel.' });
        }, (err: Error) => {
            callback({ ok: false, error: err.message || String(err) });
        });
        return;
    }

    if (mode === 'terminal') {
        const terminal = vscode.window.createTerminal('Claude Code');
        terminal.show();
        const escaped = prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`').replace(/'/g, "'\\''");
        terminal.sendText(`claude "${escaped}"`);
        callback({ ok: true, mode: 'terminal', prompt });
        return;
    }

    if (mode === 'print') {
        // Three flavors:
        //   chat (default) — quick conversational answer, no tools, no file changes (~60s budget)
        //   readOnly — answers using non-mutating tools only, for artifacts that need
        //              real context (workspace files) but must never write (~3min budget)
        //   edit (allowEdits) — full agent with auto-approved permissions (~5min budget)
        const args = ['-p', '--no-session-persistence'];
        if (allowEdits) {
            args.push('--dangerously-skip-permissions');
        } else if (readOnly) {
            // Explicit allowlist. Every tool here is non-mutating: no Bash, no Edit/Write.
            args.push('--tools', '"Read,Grep,Glob,WebFetch,WebSearch"');
            // Appended rather than replacing: the default system prompt carries the
            // tool-use guidance these tools need in order to be used well.
            args.push('--append-system-prompt', '"You are answering inside a live slide deck during a demo. Your tools are read-only: never create, modify or delete files, and never run shell commands. Keep answers under 5 sentences unless more detail is requested. Reply in the language of the question."');
        } else {
            args.push('--tools', '""');
            args.push('--system-prompt', '"You are a concise assistant. Answer in 1-3 sentences. Do not modify any files; describe changes only if asked."');
        }
        args.push('-');
        const timeoutMs = allowEdits ? 300000 : (readOnly ? 180000 : 60000);
        const child = spawn('claude', args, {
            cwd: workspaceFolder,
            shell: true,
            env: { ...process.env }
        });
        child.stdin.write(prompt);
        child.stdin.end();
        let stdout = '';
        let stderr = '';
        let done = false;
        const finish = (result: BridgeResult) => {
            if (done) return;
            done = true;
            clearTimeout(timeout);
            callback(result);
        };
        const timeout = setTimeout(() => {
            child.kill();
            finish({ ok: false, mode: 'print', error: `Timeout (${timeoutMs / 1000}s)` });
        }, timeoutMs);
        child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
        child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
        child.on('close', (code: number | null) => {
            if (code === 0) {
                finish({ ok: true, mode: 'print', response: stdout });
            } else {
                finish({ ok: false, mode: 'print', error: stderr || `Exit code ${code}` });
            }
        });
        child.on('error', (err: Error) => {
            finish({ ok: false, mode: 'print', error: err.message });
        });
        return;
    }

    if (mode === 'copy') {
        callback({ ok: true, mode: 'copy', prompt });
        return;
    }

    callback({ ok: false, error: 'Unknown mode: ' + mode });
}


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
        cspAllowedHttpHosts: config.get<string[]>('csp.allowedHttpHosts', []),
        browserLayout: config.get<string>('browser.layout', 'sidebar'),
        browserFolders: config.get<FolderConfig[]>('browser.folders', [
            { label: 'Artifacts', path: 'Artifacts' }
        ]),
        appsManagerEnabled: config.get<boolean>('appsManager.enabled', true),
        appsManagerRefreshInterval: config.get<number>('appsManager.refreshInterval', 30000),
        appsManagerBurstDurationMs: config.get<number>('appsManager.burstDurationMs', 30000),
        appsManagerBurstIntervalMs: config.get<number>('appsManager.burstIntervalMs', 3000),
        // ZeroUI layout options
        startupOpenClaudeCode: config.get<boolean>('startup.openClaudeCode', false),
        startupFocusSidebar: config.get<boolean>('startup.focusSidebar', true),
        // Live Annotation (cross-port proxy with annotation-client injection)
        liveInspectEnabled: config.get<boolean>('liveInspect.enabled', true),
        liveInspectSkipHosts: config.get<string[]>('liveInspect.skipHosts', [])
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

    // Extra plain-HTTP hosts (e.g. minimacs.local, Tailscale IPs) so remote HTTP
    // services load in the browser panel iframe. Empty by default.
    const httpHosts = config.cspAllowedHttpHosts || [];
    const httpScheme = httpHosts.map(h => `http://${h}:*`).join(' ');
    const extra = [httpsScheme, httpScheme].filter(Boolean).join(' ');

    // Explicit frame-src so the iframe can load the http hosts (otherwise it
    // inherits default-src). Includes localhost + the http hosts.
    const frameSrc = ['http://127.0.0.1:*', 'http://localhost:*', httpScheme].filter(Boolean).join(' ');

    return `default-src 'self' http://127.0.0.1:* http://localhost:* ${extra}; frame-src 'self' ${frameSrc}; script-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:* ${extra}; style-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:* ${extra}; img-src 'self' data: http://127.0.0.1:* http://localhost:* ${extra}; font-src 'self' data: http://127.0.0.1:* http://localhost:* ${extra}; connect-src 'self' http://127.0.0.1:* http://localhost:* ${extra};`;
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

    // Snapshot Live Annotation + skip list. Subsequent setting changes are
    // ignored until the window is reloaded — predictable rule for the user.
    liveInspectEnabledSnapshot = config.liveInspectEnabled;
    liveInspectSkipHostsSnapshot = config.liveInspectSkipHosts || [];

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
    webviewProvider = new ArtifactsWebviewProvider(workspaceFolder, config.browserFolders, context.extensionUri, context.workspaceState);
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
            case 'commitFolder':
                vscode.commands.executeCommand('aimaxViewer.commitFolderWithClaude', uri);
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
            config.appsManagerRefreshInterval,
            config.appsManagerBurstDurationMs,
            config.appsManagerBurstIntervalMs
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

        // Open app URL inside the AIMax Viewer browser panel
        const openAppInViewerCmd = vscode.commands.registerCommand(
            'aimaxViewer.openAppInViewer',
            (item: AppTreeItem) => {
                if (item && item.status) {
                    vscode.commands.executeCommand(
                        'aimaxViewer.openBrowser',
                        item.status.healthUrl,
                        item.status.name
                    );
                }
            }
        );

        // Open app URL in the system's default browser
        const openAppInBrowserCmd = vscode.commands.registerCommand(
            'aimaxViewer.openAppInBrowser',
            (item: AppTreeItem) => {
                if (item && item.status) {
                    vscode.env.openExternal(vscode.Uri.parse(item.status.healthUrl));
                }
            }
        );

        // Copy app URL to clipboard
        const copyAppUrlCmd = vscode.commands.registerCommand(
            'aimaxViewer.copyAppUrl',
            (item: AppTreeItem) => {
                if (item && item.status) {
                    vscode.env.clipboard.writeText(item.status.healthUrl);
                    vscode.window.showInformationMessage(`Copied ${item.status.healthUrl}`);
                }
            }
        );

        // Open settings.json (user) so the user can edit appsManager.apps directly
        const editAppInSettingsCmd = vscode.commands.registerCommand(
            'aimaxViewer.editAppInSettings',
            async (item: AppTreeItem) => {
                await vscode.commands.executeCommand('workbench.action.openSettingsJson');
                if (item && item.status) {
                    vscode.window.showInformationMessage(
                        `Edit aimaxViewer.appsManager.apps — id: ${item.status.id}`
                    );
                }
            }
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
            openAppInViewerCmd,
            openAppInBrowserCmd,
            copyAppUrlCmd,
            editAppInSettingsCmd,
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

    // Add a folder from explorer to aimaxViewer.browser.folders (workspace settings)
    const addFolderToViewerCommand = vscode.commands.registerCommand('aimaxViewer.addFolderToViewer', async (uri: vscode.Uri) => {
        if (!uri || !uri.fsPath) {
            vscode.window.showWarningMessage('No folder selected');
            return;
        }
        let stat: fs.Stats;
        try {
            stat = fs.statSync(uri.fsPath);
        } catch {
            vscode.window.showWarningMessage('Folder does not exist');
            return;
        }
        if (!stat.isDirectory()) {
            vscode.window.showWarningMessage('Selected item is not a folder');
            return;
        }
        const ws = vscode.workspace.getWorkspaceFolder(uri) || (workspaceFolder ? { uri: vscode.Uri.file(workspaceFolder) } as vscode.WorkspaceFolder : undefined);
        if (!ws) {
            vscode.window.showWarningMessage('No workspace open — cannot save folder');
            return;
        }
        const relPath = path.relative(ws.uri.fsPath, uri.fsPath);
        if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) {
            vscode.window.showWarningMessage('Folder must be inside the current workspace');
            return;
        }
        const suggested = path.basename(uri.fsPath);
        const config = vscode.workspace.getConfiguration('aimaxViewer');
        const existing = config.get<FolderConfig[]>('browser.folders', []) || [];
        if (existing.some(f => f.path === relPath)) {
            vscode.window.showInformationMessage(`"${relPath}" is already in AIMax Viewer`);
            return;
        }
        const label = await vscode.window.showInputBox({
            prompt: 'Alias for this folder in AIMax Viewer',
            value: suggested,
            placeHolder: suggested,
            validateInput: v => v && v.trim().length > 0 ? null : 'Alias cannot be empty'
        });
        if (!label) return;
        const next: FolderConfig[] = [...existing, { label: label.trim(), path: relPath }];
        try {
            await config.update('browser.folders', next, vscode.ConfigurationTarget.Workspace);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to update settings: ${err?.message || err}`);
            return;
        }
        if (treeProvider) treeProvider.refresh();
        if (webviewProvider) webviewProvider.refresh();
        vscode.window.showInformationMessage(`Added "${label.trim()}" → ${relPath} to AIMax Viewer`);
    });

    // Open a folder in a new VS Code window
    const openFolderInNewWindowCommand = vscode.commands.registerCommand('aimaxViewer.openFolderInNewWindow', (uri: vscode.Uri) => {
        if (!uri || !uri.fsPath) {
            vscode.window.showWarningMessage('No folder selected');
            return;
        }
        try {
            const stat = fs.statSync(uri.fsPath);
            if (!stat.isDirectory()) {
                vscode.window.showWarningMessage('Selected item is not a folder');
                return;
            }
        } catch {
            vscode.window.showWarningMessage('Folder does not exist');
            return;
        }
        vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
    });

    // Command: Commit with Claude (folder-scoped selective commit via Claude Code)
    const commitFolderWithClaudeCommand = vscode.commands.registerCommand('aimaxViewer.commitFolderWithClaude', (folderUri: vscode.Uri) => {
        if (!folderUri || !folderUri.fsPath) {
            vscode.window.showWarningMessage('Commit with Claude: no folder selected');
            return;
        }
        const folderPath = folderUri.fsPath;
        const folderName = path.basename(folderPath);

        let repoRoot: string;
        try {
            repoRoot = execFileSync('git', ['-C', folderPath, 'rev-parse', '--show-toplevel'],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        } catch {
            vscode.window.showWarningMessage(`${folderName} is not inside a git repository`);
            return;
        }

        let status: string;
        try {
            status = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--', folderPath],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e: any) {
            vscode.window.showErrorMessage(`git status failed: ${e.message || e}`);
            return;
        }
        if (status.trim() === '') {
            vscode.window.showInformationMessage(`Nothing to commit in ${folderName}`);
            return;
        }

        const relativePath = path.relative(repoRoot, folderPath) || '.';
        const relForPrompt = relativePath.split(path.sep).join('/');
        const userLang = vscode.env.language || 'en';

        const prompt =
`Selective commit of the modified files inside ${relForPrompt}.

Steps:
1. Show me \`git status -s -- ${relForPrompt}\`
2. If more than 3 files, group them by logical theme
3. Propose commit messages for each group
4. Wait for my explicit OK before committing
5. Do not touch files outside ${relForPrompt}

Reply to me in language: ${userLang} (IETF BCP 47 tag).`;

        const terminal = vscode.window.createTerminal({ name: 'Claude — Commit', cwd: repoRoot });
        terminal.show();
        const escaped = prompt.replace(/'/g, "'\\''");
        terminal.sendText(`claude '${escaped}'`);
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
        addFolderToViewerCommand,
        openFolderInNewWindowCommand,
        commitFolderWithClaudeCommand,
        openTerminalCommand,
        openClaudeCodeCommand,
        openArtifactsBrowserCommand,
        uriHandler
    );
}

// Map a URL served by the AIMax HTTP server back to a workspace-relative path.
// Returns null for proxy/presenter/api URLs, non-HTML files, missing files, or
// URLs that don't belong to AIMax. Used by the "Add Claude Bridge to this page"
// menu action to confirm we know which file to ask Claude to edit.
function urlToWorkspacePath(url: string): { absolute: string; relative: string } | null {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return null;
    try {
        const u = new URL(url);
        if (u.hostname !== '127.0.0.1' || u.port !== String(serverPort)) return null;
        const p = u.pathname;
        if (p.startsWith('/__proxy__/') || p.startsWith('/__presenter') || p.startsWith('/api/')) return null;
        if (!p.toLowerCase().endsWith('.html')) return null;
        const rel = decodeURIComponent(p).replace(/^\/+/, '');
        const abs = path.join(ws, rel);
        if (!fs.existsSync(abs)) return null;
        return { absolute: abs, relative: rel };
    } catch {
        return null;
    }
}

// Host-side twin of the panel script's cacheBusted() (same gates), needed for
// the iframe's FIRST load: that src attribute is rendered before any panel
// script runs, and it's the load most likely to hit a legacy cache entry left
// by an older build. Only the iframe src is busted — the URL the panel tracks
// stays clean.
function cacheBustUrl(url: string): string {
    try {
        const u = new URL(url);
        const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
        if (!local || u.port !== String(serverPort)) return url;
        if (u.pathname.startsWith('/__proxy__/')
            || u.pathname.startsWith('/__presenter')
            || u.pathname.startsWith('/api/')) return url;
        u.searchParams.set('__aimaxcb', String(Date.now()));
        return u.toString();
    } catch {
        return url;
    }
}

// Resolve a directly-supplied file path (Home Panel case). Mirrors the gates
// of urlToWorkspacePath() so the save handler can trust both entry points.
function filePathToWorkspacePath(filePath: string): { absolute: string; relative: string } | null {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return null;
    if (!filePath) return null;
    const abs = path.resolve(filePath);
    if (!abs.startsWith(ws)) return null;
    if (!abs.toLowerCase().endsWith('.html')) return null;
    if (!fs.existsSync(abs)) return null;
    return { absolute: abs, relative: path.relative(ws, abs) };
}

// Tracks files for which we've already created a .bak in the current session.
// Reset each activation. The .bak captures the on-disk content right before
// the FIRST save of the session — subsequent saves never overwrite it.
const editBackupOnce = new Set<string>();

interface HtmlEditRequest {
    n: number;
    oldText: string;
    newText: string;
    selector?: string;
    occurrenceIndex?: number;  // 0-based position of the element among same-text DOM siblings
    outerHTML?: string;        // full opening tag + text + closing tag (stronger anchor)
}
interface HtmlEditOutcome { applied: number[]; failed: { n: number; reason: string }[]; }

// Find every starting offset of `needle` in `hay`. Empty needle returns [].
function findAllOffsets(hay: string, needle: string): number[] {
    if (!needle) return [];
    const out: number[] = [];
    let i = hay.indexOf(needle);
    while (i !== -1) {
        out.push(i);
        i = hay.indexOf(needle, i + needle.length);
    }
    return out;
}

// Anchored text replace with three levels of disambiguation:
//   1. oldText is unique → replace directly
//   2. ambiguous → if outerHTML is also unique, replace inside it
//   3. still ambiguous → use occurrenceIndex (DOM order ≈ source order) to pick the Nth match
// On all-fail (0 anywhere, or ambiguous with no occurrenceIndex hint) → reject.
// Failed edits don't block other edits in the batch.
function applyHtmlEdits(absolutePath: string, edits: HtmlEditRequest[]): HtmlEditOutcome {
    const out: HtmlEditOutcome = { applied: [], failed: [] };
    let source: string;
    try {
        source = fs.readFileSync(absolutePath, 'utf8');
    } catch (err: any) {
        for (const e of edits) out.failed.push({ n: e.n, reason: 'Read error: ' + (err?.message || err) });
        return out;
    }
    if (!editBackupOnce.has(absolutePath)) {
        try {
            fs.writeFileSync(absolutePath + '.bak', source, 'utf8');
            editBackupOnce.add(absolutePath);
        } catch (err: any) {
            for (const e of edits) out.failed.push({ n: e.n, reason: 'Backup failed: ' + (err?.message || err) });
            return out;
        }
    }
    let working = source;
    for (const e of edits) {
        if (typeof e.oldText !== 'string' || typeof e.newText !== 'string') {
            out.failed.push({ n: e.n, reason: 'Invalid edit payload' });
            continue;
        }
        if (e.oldText === e.newText) {
            out.applied.push(e.n);
            continue;
        }

        // Level 1: unique oldText
        const positions = findAllOffsets(working, e.oldText);
        if (positions.length === 1) {
            const pos = positions[0];
            working = working.slice(0, pos) + e.newText + working.slice(pos + e.oldText.length);
            out.applied.push(e.n);
            continue;
        }
        if (positions.length === 0) {
            out.failed.push({ n: e.n, reason: 'Text not found in source (file changed externally?)' });
            continue;
        }

        // Level 2: ambiguous oldText, but unique outerHTML
        if (typeof e.outerHTML === 'string' && e.outerHTML) {
            const outerPositions = findAllOffsets(working, e.outerHTML);
            if (outerPositions.length === 1) {
                // Find the oldText inside the unique outerHTML match and replace just that
                const outerPos = outerPositions[0];
                const inside = working.indexOf(e.oldText, outerPos);
                if (inside !== -1 && inside < outerPos + e.outerHTML.length) {
                    working = working.slice(0, inside) + e.newText + working.slice(inside + e.oldText.length);
                    out.applied.push(e.n);
                    continue;
                }
            }
        }

        // Level 3: positional fallback via occurrenceIndex (DOM order == source order)
        if (typeof e.occurrenceIndex === 'number'
            && e.occurrenceIndex >= 0
            && e.occurrenceIndex < positions.length) {
            const pos = positions[e.occurrenceIndex];
            working = working.slice(0, pos) + e.newText + working.slice(pos + e.oldText.length);
            out.applied.push(e.n);
            continue;
        }

        out.failed.push({
            n: e.n,
            reason: `Ambiguous: text appears ${positions.length} times and disambiguators didn't resolve — edit manually`
        });
    }
    if (out.applied.length > 0) {
        try {
            fs.writeFileSync(absolutePath, working, 'utf8');
        } catch (err: any) {
            const failedAll = out.applied.map(n => ({ n, reason: 'Write error: ' + (err?.message || err) }));
            return { applied: [], failed: [...failedAll, ...out.failed] };
        }
    }
    return out;
}

// ---- Layout persistence (Edit mode → Move/Resize sub-mode) ----
//
// Moving or resizing a frame must NOT rewrite the artifact's markup: an
// anchored text replace can't safely patch an opening tag (attribute order and
// quoting never round-trip), and rewriting elements would break every other
// anchor in the file. Instead every gesture becomes a CSS rule keyed on a
// selector the client verified resolves to exactly one element, merged into a
// single <style data-aimax-layout> block kept at the end of <body>. The block
// is idempotent (re-saving the same selector overwrites its declarations), it
// is trivially removable by hand, and it survives alongside text edits.
interface LayoutEditRequest {
    n: number;
    selector: string;
    css: Record<string, string>;
    // Revert: drop this selector's rule from the block entirely. Removing the
    // declaration is the only correct neutral — overriding with `auto`/`none`
    // would keep an !important rule that beats the artifact's own CSS.
    remove?: boolean;
}

const LAYOUT_BLOCK_RE = /<style\s+data-aimax-layout(?:\s*=\s*"[^"]*")?[^>]*>([\s\S]*?)<\/style>/i;

// Only geometry and stacking are writable — the sub-mode moves, resizes and
// reorders, it is not a general-purpose CSS injector.
const LAYOUT_PROPS = new Set([
    'transform', 'width', 'height', 'box-sizing',
    'min-width', 'min-height', 'max-width', 'max-height',
    // Ride along with 'transform' on SVG shapes only, where the rotation
    // reference differs from HTML: transform-box defaults to view-box and
    // transform-origin to 0 0, which together would rotate the shape about the
    // diagram's corner instead of its own centre.
    'transform-box', 'transform-origin',
    // z-order: 'position' rides along because z-index is inert on a static
    // element, so raising one means making it positioned first.
    'z-index', 'position',
    // Delete-a-frame is display:none — the markup stays in the file, so the
    // action is reversible by removing one declaration.
    'display'
]);

// 'position' is the one whitelisted property that can restructure a layout, so
// its value is checked against the keyword set rather than the generic pattern.
const LAYOUT_POSITION_VALUES = new Set(['static', 'relative', 'absolute', 'fixed', 'sticky']);

const LAYOUT_TRANSFORM_BOX_VALUES = new Set([
    'content-box', 'border-box', 'fill-box', 'stroke-box', 'view-box'
]);

// One to three position components: keywords, lengths or percentages. Narrow on
// purpose — the client only ever writes '50% 50%'.
const LAYOUT_ORIGIN_COMPONENT = '(?:center|top|bottom|left|right|-?\\d+(?:\\.\\d+)?(?:px|%|em|rem)?)';
const LAYOUT_ORIGIN_RE = new RegExp(
    '^' + LAYOUT_ORIGIN_COMPONENT + '(?:\\s+' + LAYOUT_ORIGIN_COMPONENT + '){0,2}$', 'i');

// 'display' exists only to hide a frame and to put it back; anything else would
// be a layout rewrite, which this channel is not for.
const LAYOUT_DISPLAY_VALUES = new Set([
    'none', 'block', 'inline', 'inline-block', 'flex', 'inline-flex',
    'grid', 'inline-grid', 'contents', 'list-item', 'table', 'table-cell', 'table-row'
]);

function sanitizeLayoutSelector(sel: unknown): string | null {
    if (typeof sel !== 'string') return null;
    const s = sel.trim();
    if (!s || s.length > 400) return null;
    // Structural selectors and #ids only — nothing that could close the <style>
    // element or smuggle an at-rule into the file. '>' is the child combinator
    // we rely on and must stay allowed; '<' is what would break out of <style>.
    if (!/^[A-Za-z0-9_#.:>()\-\s]+$/.test(s)) return null;
    if (/[{}<;@*]/.test(s)) return null;
    return s;
}

function sanitizeLayoutValue(prop: string, val: unknown): string | null {
    if (typeof val !== 'string') return null;
    const v = val.trim().replace(/\s*!important\s*$/i, '').trim();
    if (!v || v.length > 200) return null;
    if (!/^[A-Za-z0-9 .,%()+\-_/]+$/.test(v)) return null;
    if (/url\s*\(/i.test(v)) return null;
    if (prop === 'position' && !LAYOUT_POSITION_VALUES.has(v.toLowerCase())) return null;
    if (prop === 'z-index' && !/^(auto|-?\d{1,6})$/.test(v)) return null;
    if (prop === 'transform-box' && !LAYOUT_TRANSFORM_BOX_VALUES.has(v.toLowerCase())) return null;
    if (prop === 'transform-origin' && !LAYOUT_ORIGIN_RE.test(v)) return null;
    if (prop === 'display' && !LAYOUT_DISPLAY_VALUES.has(v.toLowerCase())) return null;
    return v;
}

function parseLayoutBlock(rawCss: string): Map<string, Map<string, string>> {
    const map = new Map<string, Map<string, string>>();
    // Comments would otherwise be swallowed into the following selector, which
    // then fails sanitization and silently drops that rule on the next merge.
    const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css)) !== null) {
        const sel = sanitizeLayoutSelector(m[1]);
        if (!sel) continue;
        const decls = new Map<string, string>();
        for (const part of m[2].split(';')) {
            const i = part.indexOf(':');
            if (i < 0) continue;
            const prop = part.slice(0, i).trim().toLowerCase();
            const value = sanitizeLayoutValue(prop, part.slice(i + 1));
            if (!LAYOUT_PROPS.has(prop) || !value) continue;
            decls.set(prop, value);
        }
        if (decls.size) map.set(sel, decls);
    }
    return map;
}

function serializeLayoutBlock(map: Map<string, Map<string, string>>): string {
    const lines: string[] = ['<style data-aimax-layout="1">'];
    lines.push('/* AIMax Viewer — layout overrides (Edit > Move/Resize). Machine-managed:');
    lines.push('   safe to delete wholesale, but hand edits here get rewritten on the next save. */');
    for (const [sel, decls] of map) {
        const body = Array.from(decls).map(([p, v]) => p + ': ' + v + ' !important;').join(' ');
        lines.push(sel + ' { ' + body + ' }');
    }
    lines.push('</style>');
    return lines.join('\n');
}

function applyLayoutEdits(absolutePath: string, rules: LayoutEditRequest[]): HtmlEditOutcome {
    const out: HtmlEditOutcome = { applied: [], failed: [] };
    let source: string;
    try {
        source = fs.readFileSync(absolutePath, 'utf8');
    } catch (err: any) {
        for (const r of rules) out.failed.push({ n: r.n, reason: 'Read error: ' + (err?.message || err) });
        return out;
    }
    if (!editBackupOnce.has(absolutePath)) {
        try {
            fs.writeFileSync(absolutePath + '.bak', source, 'utf8');
            editBackupOnce.add(absolutePath);
        } catch (err: any) {
            for (const r of rules) out.failed.push({ n: r.n, reason: 'Backup failed: ' + (err?.message || err) });
            return out;
        }
    }
    const existing = LAYOUT_BLOCK_RE.exec(source);
    const map = existing ? parseLayoutBlock(existing[1]) : new Map<string, Map<string, string>>();
    for (const r of rules) {
        const sel = sanitizeLayoutSelector(r.selector);
        if (!sel) {
            out.failed.push({ n: r.n, reason: 'Unsafe or unusable selector — layout not written' });
            continue;
        }
        if (r.remove) {
            map.delete(sel);
            out.applied.push(r.n);
            continue;
        }
        const incoming = (r.css && typeof r.css === 'object') ? r.css : {};
        const decls = map.get(sel) || new Map<string, string>();
        let wrote = 0;
        for (const rawProp of Object.keys(incoming)) {
            const prop = rawProp.trim().toLowerCase();
            if (!LAYOUT_PROPS.has(prop)) continue;
            const value = sanitizeLayoutValue(prop, incoming[rawProp]);
            if (!value) continue;
            decls.set(prop, value);
            wrote++;
        }
        if (!wrote) {
            out.failed.push({ n: r.n, reason: 'No writable geometry properties in payload' });
            continue;
        }
        map.set(sel, decls);
        out.applied.push(r.n);
    }
    if (!out.applied.length) return out;

    // Reverting the last override leaves no block behind — the file goes back to
    // exactly the markup it had before AIMax ever touched its layout.
    if (map.size === 0) {
        if (!existing) return out;
        const head = source.slice(0, existing.index).replace(/[ \t]*\n?$/, '');
        const tail = source.slice(existing.index + existing[0].length).replace(/^\n/, '');
        try {
            fs.writeFileSync(absolutePath, head + '\n' + tail, 'utf8');
        } catch (err: any) {
            const failedAll = out.applied.map(n => ({ n, reason: 'Write error: ' + (err?.message || err) }));
            return { applied: [], failed: [...failedAll, ...out.failed] };
        }
        return out;
    }

    const block = serializeLayoutBlock(map);
    let working: string;
    if (existing) {
        working = source.slice(0, existing.index) + block + source.slice(existing.index + existing[0].length);
    } else {
        const idx = source.toLowerCase().lastIndexOf('</body>');
        working = idx >= 0
            ? source.slice(0, idx) + block + '\n' + source.slice(idx)
            : source + '\n' + block + '\n';
    }
    try {
        fs.writeFileSync(absolutePath, working, 'utf8');
    } catch (err: any) {
        const failedAll = out.applied.map(n => ({ n, reason: 'Write error: ' + (err?.message || err) }));
        return { applied: [], failed: [...failedAll, ...out.failed] };
    }
    return out;
}

// Drop the whole layout block: the artifact goes back to laying itself out.
// This is the only way out of a state the UI can otherwise not undo — a frame
// hidden with Delete has no box left to click, so after a reload there is
// nothing to select and revert.
function removeLayoutBlock(absolutePath: string): { ok: boolean; removed: boolean; error?: string } {
    try {
        const source = fs.readFileSync(absolutePath, 'utf8');
        const m = LAYOUT_BLOCK_RE.exec(source);
        if (!m) return { ok: true, removed: false };
        if (!editBackupOnce.has(absolutePath)) {
            fs.writeFileSync(absolutePath + '.bak', source, 'utf8');
            editBackupOnce.add(absolutePath);
        }
        const head = source.slice(0, m.index).replace(/[ \t]*\n?$/, '');
        const tail = source.slice(m.index + m[0].length).replace(/^\n/, '');
        fs.writeFileSync(absolutePath, head + '\n' + tail, 'utf8');
        return { ok: true, removed: true };
    } catch (err: any) {
        return { ok: false, removed: false, error: err?.message || String(err) };
    }
}

// Put the file back to the copy taken before this session's first edit.
function restoreFileFromBackup(absolutePath: string): { ok: boolean; error?: string } {
    const bak = absolutePath + '.bak';
    try {
        if (!fs.existsSync(bak)) return { ok: false, error: 'no-backup' };
        fs.copyFileSync(bak, absolutePath);
        // The .bak now matches the file, so the next edit should take a fresh
        // one rather than reuse this session's marker.
        editBackupOnce.delete(absolutePath);
        return { ok: true };
    } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
    }
}

// Full-file overwrite used by the Slide Sorter (reorder / hide-show), which
// rewrites the whole deck rather than patching individual blocks. Writes a
// one-per-session .bak first (same policy as applyHtmlEdits) so the original
// on-disk content is always recoverable.
// AIMax injects its annotation/edit and link-handler clients into every served
// HTML response. Anything that round-trips a served page back to disk therefore
// risks writing those scripts INTO the source — and because the client
// self-disables when it finds one already loaded, a baked-in copy silently
// pins the artifact to the version it was saved under, while every save adds
// another. Callers should read the source with ?aimax-raw=1; this is the
// backstop at the one place where whole files get written.
const INJECTED_SCRIPT_RE = /[ \t]*<script\s+data-aimax-injected(?:\s*=\s*"[^"]*")?[^>]*>[\s\S]*?<\/script>\n?/gi;

export function stripInjectedClients(html: string): { html: string; removed: number } {
    let removed = 0;
    const out = html.replace(INJECTED_SCRIPT_RE, () => { removed++; return ''; });
    return { html: out, removed };
}

function writeDeckFile(absolutePath: string, content: string): { ok: boolean; error?: string } {
    try {
        if (!editBackupOnce.has(absolutePath)) {
            const source = fs.readFileSync(absolutePath, 'utf8');
            fs.writeFileSync(absolutePath + '.bak', source, 'utf8');
            editBackupOnce.add(absolutePath);
        }
        const cleaned = stripInjectedClients(content);
        if (cleaned.removed > 0) {
            console.warn('[AIMax] Stripped ' + cleaned.removed + ' injected client script(s) before writing ' + absolutePath);
        }
        fs.writeFileSync(absolutePath, cleaned.html, 'utf8');
        return { ok: true };
    } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
    }
}

// Resolve edit target from either a Browser Panel (url) or Home Panel (filePath)
// payload. Returns null if not eligible — callers must abort silently.
function resolveEditTarget(message: any): { absolute: string; relative: string } | null {
    if (message.url) return urlToWorkspacePath(String(message.url));
    if (message.filePath) return filePathToWorkspacePath(String(message.filePath));
    return null;
}

// The two "put it back" commands from the hamburger menu. Both rewrite the file,
// so both ask first — and both are phrased in terms of what SURVIVES, since that
// is the only difference the person clicking cares about.
function handleRestore(message: any, panel: vscode.WebviewPanel | undefined): void {
    const target = resolveEditTarget(message);
    if (!target) {
        vscode.window.showWarningMessage('AIMax: this page is not an editable .html served from your workspace.');
        return;
    }
    const name = path.basename(target.absolute);
    const reload = () => panel?.webview.postMessage({ command: 'reloadFrame' });

    if (message.command === 'restoreLayout') {
        vscode.window.showWarningMessage(
            'Put every element of "' + name + '" back where the page itself places it?',
            { modal: true, detail: 'Undoes moves, resizes, rotations, stacking order and hidden frames. Your text edits are kept.' },
            'Restore layout'
        ).then(choice => {
            if (choice !== 'Restore layout') return;
            const out = removeLayoutBlock(target.absolute);
            if (!out.ok) {
                vscode.window.showErrorMessage('AIMax: could not restore layout — ' + out.error);
            } else if (!out.removed) {
                vscode.window.showInformationMessage('AIMax: this file has no layout changes to undo.');
            } else {
                vscode.window.showInformationMessage('AIMax: original layout restored in ' + name + '.');
                reload();
            }
        });
        return;
    }

    const bakExists = fs.existsSync(target.absolute + '.bak');
    if (!bakExists) {
        vscode.window.showInformationMessage('AIMax: no backup for ' + name + ' yet — one is written automatically before the first edit of a session.');
        return;
    }
    vscode.window.showWarningMessage(
        'Bring "' + name + '" back to how it was before your first edit in this session?',
        { modal: true, detail: 'Undoes everything AIMax wrote to this file since the panel opened, text edits included. Anything saved before that stays.' },
        'Restore file'
    ).then(choice => {
        if (choice !== 'Restore file') return;
        const out = restoreFileFromBackup(target.absolute);
        if (!out.ok) {
            vscode.window.showErrorMessage('AIMax: could not restore — ' + (out.error === 'no-backup' ? 'the backup disappeared' : out.error));
            return;
        }
        vscode.window.showInformationMessage('AIMax: ' + name + ' restored from backup.');
        reload();
    });
}

function handleSaveEdit(message: any, panel: vscode.WebviewPanel | undefined): void {
    if (!panel) return;
    const target = resolveEditTarget(message);
    const edits = Array.isArray(message.edits) ? message.edits as HtmlEditRequest[] : [];
    const layout = Array.isArray(message.layout) ? message.layout as LayoutEditRequest[] : [];
    const allNs = [...edits.map(e => e.n), ...layout.map(l => l.n)];
    if (!target) {
        panel.webview.postMessage({
            command: 'saveEditResult',
            applied: [],
            failed: allNs.map(n => ({ n, reason: 'File not eligible for edit (not an AIMax-served .html under workspace)' }))
        });
        return;
    }
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws || !target.absolute.startsWith(ws)) {
        panel.webview.postMessage({
            command: 'saveEditResult',
            applied: [],
            failed: allNs.map(n => ({ n, reason: 'Path escapes workspace' }))
        });
        return;
    }
    // Text first, then layout: applyHtmlEdits writes synchronously, so the
    // layout pass re-reads the already-updated source and its <style> block
    // insertion can't invalidate the verbatim anchors of the text edits.
    const outcome: HtmlEditOutcome = edits.length
        ? applyHtmlEdits(target.absolute, edits)
        : { applied: [], failed: [] };
    if (layout.length) {
        const layoutOutcome = applyLayoutEdits(target.absolute, layout);
        outcome.applied.push(...layoutOutcome.applied);
        outcome.failed.push(...layoutOutcome.failed);
    }
    panel.webview.postMessage({ command: 'saveEditResult', ...outcome });
}

// Canonical Claude Bridge snippet lives in the aimax-bridge skill on GitHub.
// The extension never inlines it — single source of truth.
const BRIDGE_SKILL_TEMPLATE_URL =
    'https://raw.githubusercontent.com/maxturazzini/aimax-viewer/main/skills/aimax-bridge/templates/bridge-buttons.md';

// Add the host:port behind a proxied URL to liveInspect.skipHosts so future
// loads of that app bypass the proxy entirely. Adds both localhost and
// 127.0.0.1 forms because either may appear in user-typed URLs. Reload
// required (snapshots are taken at activation).
function dispatchSkipAnnotForHost(url: string): void {
    let port: number | null = null;
    try {
        const u = new URL(url);
        const m = u.pathname.match(/^\/__proxy__\/(\d+)\//);
        if (m) port = parseInt(m[1], 10);
    } catch { /* parse failure → port stays null */ }
    if (!port) {
        vscode.window.showWarningMessage(
            'AIMax: This page is not a proxied URL — nothing to add to the skip list.'
        );
        return;
    }
    const cfg = vscode.workspace.getConfiguration('aimaxViewer');
    const current = cfg.get<string[]>('liveInspect.skipHosts', []);
    const additions = [`localhost:${port}`, `127.0.0.1:${port}`].filter(h => !current.includes(h));
    if (additions.length === 0) {
        vscode.window.showInformationMessage(
            `AIMax: localhost:${port} is already in the Live Annotation skip list.`
        );
        return;
    }
    const next = [...current, ...additions];
    cfg.update('liveInspect.skipHosts', next, vscode.ConfigurationTarget.Workspace).then(() => {
        vscode.window.showInformationMessage(
            `AIMax: added ${additions.join(', ')} to Live Annotation skip list. Reload required to apply.`,
            'Reload Window'
        ).then(choice => {
            if (choice === 'Reload Window') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        });
    }, (err: Error) => {
        vscode.window.showErrorMessage(`AIMax: failed to update skip list: ${err.message}`);
    });
}

// Open Claude Code with a prompt asking it to inject the bridge into the
// given local AIMax-served URL. Falls back to clipboard if Claude Code is
// not installed (vscode.env.openExternal returns false). Used by the
// "Add Claude Bridge to this page" menu action in both browser panels.
function dispatchAddBridgeToPage(url: string): void {
    const mapped = urlToWorkspacePath(url);
    if (!mapped) {
        vscode.window.showWarningMessage(
            'AIMax: This page is not a local AIMax-served HTML file — cannot add the bridge here.'
        );
        return;
    }
    const prompt = buildBridgeInjectionPrompt(mapped.relative);
    const claudeUri = vscode.Uri.parse(
        `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`
    );
    vscode.env.openExternal(claudeUri).then(opened => {
        if (!opened) {
            vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage(
                'Claude Code not available — bridge injection prompt copied to clipboard.'
            );
        }
    });
}

function buildBridgeInjectionPrompt(relativePath: string): string {
    return [
        `Add the AIMax Claude Bridge floating panel persistently to this artifact.`,
        ``,
        `**Target file:** \`${relativePath}\` (an HTML artifact served by AIMax Viewer).`,
        ``,
        `**How to apply** — try in this order:`,
        ``,
        `1. **Skill path (preferred).** If the \`aimax-bridge\` skill is installed in this Claude Code session, run \`/aimax-bridge buttons\` targeting \`${relativePath}\`. The skill knows where to insert the snippet.`,
        ``,
        `2. **GitHub fallback.** If the skill is not installed, WebFetch the template:`,
        `   \`${BRIDGE_SKILL_TEMPLATE_URL}\``,
        `   The fetched markdown contains a single \`\`\`html code block — extract it and insert it verbatim into \`${relativePath}\`, immediately before the closing \`</body>\` tag.`,
        ``,
        `**Constraints:**`,
        `- Before inserting, check if the file already contains \`data-aimax-bridge-injected\` or \`window.__aimaxBridgeLoaded\`. If yes, STOP and tell me — the bridge is already there.`,
        `- Do not modify any other content in the file.`,
        `- Preserve original indentation outside the inserted block.`,
        ``,
        `After the edit, ask me to reload the page in AIMax Viewer to see the floating Claude button (bottom-right of the artifact).`
    ].join('\n');
}

function rewriteToProxy(url: string): string {
    // Route external localhost URLs through the AIMaxViewer proxy so the
    // annotation client can be injected. Skip our own server port
    // (already served directly). Gated by liveInspect.enabled and the
    // per-host skip list. Uses activation-time snapshots — config changes
    // need a window reload.
    if (!liveInspectEnabledSnapshot) return url;
    try {
        const u = new URL(url);
        if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return url;
        const port = parseInt(u.port || (u.protocol === 'https:' ? '443' : '80'), 10);
        if (!port || port === serverPort) return url;
        // Skip-list bypass: pages on these host:port pairs load directly,
        // no proxy, no annotation-client injection. For apps that conflict
        // with the proxy (e.g. strict frame-ancestors CSP, in-page routers
        // that choke on /__proxy__/<port>/ prefixes).
        const hostPort = `${u.hostname}:${port}`;
        if (liveInspectSkipHostsSnapshot.includes(hostPort)) return url;
        return `http://127.0.0.1:${serverPort}/__proxy__/${port}${u.pathname}${u.search}${u.hash}`;
    } catch {
        return url;
    }
}

function openInBrowser(url: string, customTitle?: string) {
    url = rewriteToProxy(url);
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

        // Get favicon as inline base64 data URI (works in webview, iframe, and proxy contexts)
        const faviconUri = getFaviconDataUri();

        // Handle messages from webview
        newPanel.webview.onDidReceiveMessage(message => {
            if (message.command === 'copyToClipboard') {
                vscode.env.clipboard.writeText(message.text || '');
            } else if (message.command === 'openExternal' && message.url) {
                vscode.env.openExternal(vscode.Uri.parse(message.url));
            } else if (message.command === 'openInBrowser' && message.url) {
                openInBrowser(message.url);
            } else if (message.command === 'updateTitle' && message.title) {
                newPanel.title = message.title;
            } else if (message.command === 'openCurrentFile') {
                vscode.commands.executeCommand('aimaxViewer.openCurrentFile');
            } else if (message.command === 'restoreLayout' || message.command === 'restoreBackup') {
                handleRestore(message, newPanel);
            } else if (message.command === 'openDevTools') {
                // Webview devtools, not the window's: this opens the console of
                // the panel itself, which is where the viewer's own errors land.
                vscode.commands.executeCommand('workbench.action.webview.openDeveloperTools');
            } else if (message.command === 'openTerminal') {
                vscode.commands.executeCommand('aimaxViewer.openTerminal');
            } else if (message.command === 'openClaudeCode') {
                vscode.commands.executeCommand('aimaxViewer.openClaudeCode');
            } else if (message.command === 'presentFile' && message.url) {
                const presenterUrl = `http://127.0.0.1:${serverPort}/__presenter#${message.url}`;
                vscode.env.openExternal(vscode.Uri.parse(presenterUrl));
            } else if (message.command === 'makePresentable' && message.url) {
                openMakePresentableInClaude(message.url);
            } else if (message.command === 'addBridgeToPage' && message.url) {
                dispatchAddBridgeToPage(message.url);
            } else if (message.command === 'skipAnnotForHost' && message.url) {
                dispatchSkipAnnotForHost(message.url);
            } else if (message.command === 'claudeBridge') {
                handleClaudeBridge(message.mode, (message.prompt || '').trim(), (result) => {
                    newPanel.webview.postMessage({ command: 'bridgeResult', ...result });
                }, { allowEdits: !!message.allowEdits });
            } else if (message.command === 'saveEdit') {
                handleSaveEdit(message, newPanel);
            } else if (message.command === 'updateConfig' && message.key) {
                applyConfigToggle(message.key, message.value);
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
            if (message.command === 'copyToClipboard') {
                vscode.env.clipboard.writeText(message.text || '');
            } else if (message.command === 'openExternal' && message.url) {
                vscode.env.openExternal(vscode.Uri.parse(message.url));
            } else if (message.command === 'openInBrowser' && message.url) {
                openInBrowser(message.url);
            } else if (message.command === 'updateTitle' && message.title) {
                if (browserPanel) {
                    browserPanel.title = message.title;
                }
            } else if (message.command === 'openCurrentFile') {
                vscode.commands.executeCommand('aimaxViewer.openCurrentFile');
            } else if (message.command === 'restoreLayout' || message.command === 'restoreBackup') {
                handleRestore(message, browserPanel);
            } else if (message.command === 'openDevTools') {
                // Webview devtools, not the window's: this opens the console of
                // the panel itself, which is where the viewer's own errors land.
                vscode.commands.executeCommand('workbench.action.webview.openDeveloperTools');
            } else if (message.command === 'openTerminal') {
                vscode.commands.executeCommand('aimaxViewer.openTerminal');
            } else if (message.command === 'openClaudeCode') {
                vscode.commands.executeCommand('aimaxViewer.openClaudeCode');
            } else if (message.command === 'presentFile' && message.url) {
                const presenterUrl = `http://127.0.0.1:${serverPort}/__presenter#${message.url}`;
                vscode.env.openExternal(vscode.Uri.parse(presenterUrl));
            } else if (message.command === 'makePresentable' && message.url) {
                openMakePresentableInClaude(message.url);
            } else if (message.command === 'addBridgeToPage' && message.url) {
                dispatchAddBridgeToPage(message.url);
            } else if (message.command === 'skipAnnotForHost' && message.url) {
                dispatchSkipAnnotForHost(message.url);
            } else if (message.command === 'claudeBridge') {
                handleClaudeBridge(message.mode, (message.prompt || '').trim(), (result) => {
                    if (browserPanel) {
                        browserPanel.webview.postMessage({ command: 'bridgeResult', ...result });
                    }
                }, { allowEdits: !!message.allowEdits });
            } else if (message.command === 'saveEdit') {
                handleSaveEdit(message, browserPanel);
            } else if (message.command === 'updateConfig' && message.key) {
                applyConfigToggle(message.key, message.value);
            }
        });
    }

    const faviconUri = getFaviconDataUri();

    browserPanel.title = pageTitle;
    const showDropdown = config.browserLayout === 'top';
    browserPanel.webview.html = getBrowserHtml(url, pageTitle, faviconUri, showDropdown);
    }

function getBrowserHtml(url: string, title: string, faviconUri: string, showDropdown: boolean = true): string {
    const csp = generateCSP();
    const cfg = getConfig();
    const homePage = cfg.homePage;
    const liveInspectEnabled = cfg.liveInspectEnabled;
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
            gap: 6px;
            min-width: 0;
        }
        .address-display {
            flex: 1;
            min-width: 0;
            color: #cccccc;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 12px;
            padding: 0 8px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            opacity: 0.85;
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
        .menu-item:disabled,
        .menu-item[aria-disabled="true"] {
            opacity: 0.4;
            cursor: not-allowed;
        }
        .menu-item:disabled:hover,
        .menu-item[aria-disabled="true"]:hover {
            background: transparent;
            color: #cccccc;
        }
        .menu-divider { border-top: 1px solid #3c3c3c; margin: 4px 0; }
        /* Claude Bridge toolbar button + dropdown */
        .bridge-toolbar-btn {
            background: transparent;
            border: 1px solid #3c3c3c;
            color: #fff;
            cursor: pointer;
            padding: 4px 8px;
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            line-height: 1;
        }
        .bridge-toolbar-btn:hover {
            color: #00d4ff;
            border-color: #00d4ff;
        }
        .bridge-menu {
            display: none;
            position: fixed;
            top: 44px;
            right: 60px;
            background: #252526;
            border: 1px solid #3c3c3c;
            border-radius: 8px;
            padding: 12px;
            z-index: 100000;
            width: 320px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }
        .bridge-menu.open { display: block; }
        .bridge-menu .bridge-title {
            color: #cdd6f4;
            font-weight: 600;
            font-size: 13px;
            margin-bottom: 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .bridge-menu .bridge-close {
            background: none;
            border: none;
            color: #888;
            cursor: pointer;
            font-size: 16px;
            line-height: 1;
            padding: 0;
        }
        .bridge-menu textarea {
            width: 100%;
            height: 80px;
            background: #181825;
            color: #cdd6f4;
            border: 1px solid #555;
            border-radius: 6px;
            padding: 8px;
            font-size: 12px;
            resize: vertical;
            box-sizing: border-box;
            font-family: inherit;
        }
        .bridge-menu .bridge-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 8px;
            justify-content: flex-start;
        }
        .bridge-menu .bridge-allow-edits {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-top: 8px;
            font-size: 11px;
            color: #cdd6f4;
            cursor: help;
            user-select: none;
        }
        .bridge-menu .bridge-allow-edits input { cursor: pointer; accent-color: #00d4ff; }
        .bridge-response {
            display: none;
            margin-top: 8px;
            padding: 8px;
            background: #181825;
            border-radius: 6px;
            color: #cdd6f4;
            font-size: 12px;
            max-height: 200px;
            overflow-y: auto;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .bridge-status {
            margin-top: 6px;
            font-size: 10px;
            color: #888;
            text-align: center;
            min-height: 12px;
        }
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
        .toolbar-btn.active {
            color: #00d4ff;
            border-color: #00d4ff;
            background: rgba(0, 212, 255, 0.12);
        }
        .toolbar-btn.active-edit {
            color: #ff9500;
            border-color: #ff9500;
            background: rgba(255, 149, 0, 0.14);
        }
        .toolbar-btn.active-draw {
            color: #ff2d92;
            border-color: #ff2d92;
            background: rgba(255, 45, 146, 0.14);
        }
        .toolbar-btn:disabled {
            opacity: 0.35;
            cursor: not-allowed;
        }
        .annot-window.edit-mode { border-color: #ff9500; }
        .annot-window.edit-mode .annot-header strong { color: #ff9500; }
        .annot-window.edit-mode .aimax-comment-only { display: none !important; }
        .aimax-icon-btn.aimax-save-btn { color: #34c759; border-color: #34c759; padding: 3px 10px; }
        .aimax-icon-btn.aimax-save-btn:not(:disabled):hover { background: rgba(52, 199, 89, 0.15); }
        .aimax-icon-btn.aimax-save-btn .save-text { font-size: 11px; font-weight: 600; letter-spacing: 0.3px; }
        .aimax-icon-btn.notes-active { background: rgba(181, 137, 0, 0.20); border-color: #b58900; color: #ffcc44; }
        .aimax-icon-btn.layout-active { background: rgba(255, 149, 0, 0.22); border-color: #ff9500; color: #ffb347; }
        /* Move/Resize tool row, rendered in the panel body: present only while
           the sub-mode is on, so text-edit mode keeps its plain hint. */
        .aimax-lay-tools { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
        .aimax-lay-tools button {
            min-width: 30px;
            justify-content: center;
            font-size: 13px;
            line-height: 1;
            background: #1a1a2e;
            border: 1px solid rgba(255, 149, 0, 0.45);
            color: #ffb347;
            border-radius: 4px;
            padding: 4px 10px;
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }
        .aimax-lay-tools button:hover:not(:disabled) { background: #2a2a3e; border-color: #ff9500; }
        .aimax-lay-tools button:disabled { opacity: 0.35; cursor: not-allowed; }
        .aimax-lay-tools .lay-key { opacity: 0.55; font-weight: 400; font-size: 10px; }
        .aimax-lay-tools .lay-group { align-self: center; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.5; margin-right: 2px; }
        /* Sub-mode toggles: one group per top-level mode, only the active
           group is mounted, and exactly one button in it reads as selected. */
        .submode-group { display: inline-flex; gap: 3px; padding: 2px; background: rgba(0,0,0,0.25); border-radius: 6px; }
        .aimax-icon-btn.submode.on { background: rgba(0, 212, 255, 0.20); border-color: #00d4ff; color: #6fe3ff; }
        .annot-window.edit-mode .aimax-icon-btn.submode.on { background: rgba(255, 149, 0, 0.22); border-color: #ff9500; color: #ffb347; }
        /* Action row: what you DO with what you collected, kept out of the header. */
        .annot-actions { padding: 8px 10px 0; }
        .annot-actions:empty { display: none; }
        .annot-act-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
        .annot-window {
            display: none;
            position: fixed;
            top: 56px;
            right: 12px;
            width: 380px;
            max-height: 70vh;
            background: #1e1e1e;
            border: 1px solid #00d4ff;
            border-radius: 8px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
            z-index: 100002;
            flex-direction: column;
            overflow: hidden;
        }
        .annot-window.open { display: flex; }
        .annot-header {
            background: linear-gradient(90deg, #16213e 0%, #1a1a2e 100%);
            padding: 8px 12px;
            color: #cccccc;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
            border-bottom: 1px solid #3c3c3c;
        }
        .annot-header strong { color: #00d4ff; flex: 1; }
        .annot-header button {
            background: transparent;
            border: 1px solid #3c3c3c;
            color: #cccccc;
            font-size: 11px;
            cursor: pointer;
            padding: 3px 8px;
            border-radius: 4px;
        }
        .annot-header button:hover { color: #00d4ff; border-color: #00d4ff; }
        .annot-body {
            flex: 1;
            overflow: auto;
            padding: 6px 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 12px;
            color: #cccccc;
            background: #14141a;
        }
        .annot-row {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            border-bottom: 1px solid #232330;
            cursor: default;
        }
        .annot-row:hover { background: #1f1f2c; }
        .annot-num {
            background: #00d4ff;
            color: #001018;
            font-weight: bold;
            font-size: 10px;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }
        .annot-draw-mark {
            color: #ff2d92;
            font-size: 11px;
            flex-shrink: 0;
        }
        .annot-text {
            flex: 1;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .annot-tag {
            color: #888;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 10px;
            flex-shrink: 0;
        }
        .annot-x {
            color: #888;
            cursor: pointer;
            padding: 0 4px;
            flex-shrink: 0;
            font-size: 14px;
            line-height: 1;
        }
        .annot-x:hover { color: #ff5757; }
        .annot-empty {
            color: #666;
            font-style: italic;
            padding: 12px;
            text-align: center;
        }
        .annot-response {
            display: none;
            margin: 6px 8px 8px 8px;
            padding: 8px;
            background: #181825;
            border: 1px solid #3c3c3c;
            border-radius: 6px;
            color: #cdd6f4;
            font-size: 11px;
            max-height: 240px;
            overflow-y: auto;
            white-space: pre-wrap;
            word-break: break-word;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        /* Shared icon button (annotations + bridge — same actions, same look) */
        .aimax-icon-btn {
            background: transparent;
            border: 1px solid #3c3c3c;
            color: #00d4ff;
            cursor: pointer;
            padding: 3px 6px;
            border-radius: 4px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 3px;
            min-width: 26px;
            height: 24px;
            line-height: 1;
            font-size: 11px;
        }
        .aimax-icon-btn:hover { background: #2a2a3e; border-color: #00d4ff; }
        .aimax-icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .aimax-icon-btn .label { font-size: 10px; font-weight: 600; }
        .aimax-icon-btn svg { display: block; }
    </style>
</head>
<body>
    <div class="toolbar">
        <button class="nav-btn" id="backBtn" onclick="goBack()" title="Back" disabled>←</button>
        <button class="nav-btn" id="fwdBtn" onclick="goForward()" title="Forward" disabled>→</button>
        <button class="nav-btn" onclick="reload()" title="Reload" style="display:inline-flex;align-items:center;justify-content:center;color:#00d4ff;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.51-7.13"/><polyline points="21 4 21 10 15 10"/></svg>
        </button>
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
            <span id="addressDisplay" class="address-display" title="${url}">${url}</span>
            <button class="select-info-btn" id="infoBtn">
                ⓘ
                <span class="info-tooltip" id="infoTooltip">${url}</span>
            </button>
        </div>
        `}
        <button class="toolbar-btn" id="annotBtn" onclick="toggleAnnotMode()" title="Toggle annotation mode">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00d4ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button class="toolbar-btn" id="editBtn" onclick="toggleEditMode()" title="Edit text in place (HTML only)" disabled>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff9500" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
        <button class="toolbar-btn" id="bridgeToolbarBtn" onclick="aimaxBridgeToggle()" title="Claude Bridge"><span style="color:#00d4ff;font-size:14px;line-height:1;">&#10042;</span></button>
        <button class="toolbar-btn" onclick="openTerminal()" title="Open new terminal">
            <span style="color: #00d4ff; font-size: 14px;">&gt;</span>
        </button>
        <button class="toolbar-btn" onclick="openClaudeCode()" title="New Claude Code conversation">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="#d97757" aria-hidden="true"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>
        </button>
        <button class="menu-btn" onclick="toggleMenu()">☰</button>
    </div>
    <div class="annot-window" id="annotWindow">
        <!-- Header carries ONLY the sub-modes of whatever mode is active, plus
             Save and Close. Everything you *do* with what you collected lives in
             the action row below, so the header answers one question: where am I. -->
        <div class="annot-header">
            <strong id="annotCount">Annotations (0)</strong>
            <span class="submode-group aimax-comment-only" id="annotSubmodes">
                <button class="aimax-icon-btn submode" id="pointBtn" onclick="setAnnotSubmode('point')" title="Point mode — click an element to comment on it">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7 17 2-7 7-2z"/></svg>
                </button>
                <button class="aimax-icon-btn submode" id="drawSubBtn" onclick="setAnnotSubmode('draw')" title="Draw mode — freehand pencil to mark changes">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3-1 5-3 7-7"/><path d="M14.5 5.5l4 4"/><path d="M12 19l7-7a2.5 2.5 0 0 0-3.5-3.5l-7 7L7 19z"/></svg>
                </button>
            </span>
            <span class="submode-group aimax-edit-only" id="editSubmodes" style="display:none">
                <button class="aimax-icon-btn submode" id="textBtn" onclick="setEditSubmode('text')" title="Text mode — click any text and type over it">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5h16v2M9 19h6M12 5v14"/></svg>
                </button>
                <button class="aimax-icon-btn submode" id="layoutBtn" onclick="setEditSubmode('move')" title="Move/Resize mode — drag frames, drag handles to resize, arrows to nudge">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M2 12h20M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3"/></svg>
                </button>
                <button class="aimax-icon-btn submode" id="notesBtn" onclick="setEditSubmode('notes')" title="Notes mode — reveal and edit hidden .speaker-notes blocks">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h6M8 17h4"/></svg>
                </button>
            </span>
            <button class="aimax-icon-btn aimax-save-btn" id="saveBtn" onclick="triggerSave()" style="display:none" disabled title="Save pending edits to disk">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                <span class="save-text">Save</span>
                <span class="label" id="saveCountLbl">0</span>
            </button>
            <button class="aimax-icon-btn" onclick="closeAnnotPanel()" title="Close">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>
            </button>
        </div>
        <div class="annot-actions" id="annotActions">
            <div class="annot-act-row aimax-comment-only">
                <button class="aimax-icon-btn" onclick="copyAnnotPrompt()" title="Copy prompt">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    <span class="label">Copy</span>
                </button>
                <button class="aimax-icon-btn" onclick="annotSend('terminal')" title="Copy &amp; send to Terminal">
                    <span class="label">&gt;_</span>
                </button>
                <button class="aimax-icon-btn" onclick="annotSend('vscode')" title="Copy &amp; send to Claude Code">
                    <span class="label">&lt;/&gt;</span>
                </button>
                <button class="aimax-icon-btn" id="annotRunBtn" onclick="annotRun()" title="Run inline (Ask Claude)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1.5 L13.6 9.2 L21.3 7.6 L15.7 12 L21.3 16.4 L13.6 14.8 L12 22.5 L10.4 14.8 L2.7 16.4 L8.3 12 L2.7 7.6 L10.4 9.2 Z"/></svg>
                </button>
                <button class="aimax-icon-btn" onclick="annotRefresh()" title="Refresh page">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.51-7.13"/><polyline points="21 4 21 10 15 10"/></svg>
                </button>
                <button class="aimax-icon-btn" onclick="clearAnnotations()" title="Clear all">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
                </button>
            </div>
            <div id="annotLayoutTools"></div>
        </div>
        <div class="annot-body" id="annotBody"><div class="annot-empty">Hover an element and click to add a comment.</div></div>
        <div class="annot-response" id="annotResponse"></div>
    </div>
    <div class="bridge-menu" id="bridgeMenu">
        <div class="bridge-title">
            <span>Claude Bridge</span>
            <button class="bridge-close" onclick="aimaxBridgeToggle()" title="Close">&times;</button>
        </div>
        <textarea id="bridgePrompt" placeholder="Ask Claude about this page..."></textarea>
        <label class="bridge-allow-edits" title="Allow Claude to read and modify files (skips permission prompts).&#10;Off: quick chat answer, no file changes (60s budget).&#10;On: full agent with auto-approved edits (5min budget).">
            <input type="checkbox" id="bridgeAllowEdits" />
            <span>Allow file edits</span>
        </label>
        <div class="bridge-actions">
            <button class="aimax-icon-btn" onclick="aimaxBridgeAction('copy')" title="Copy prompt">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
            <button class="aimax-icon-btn" onclick="aimaxBridgeAction('terminal',true)" title="Copy &amp; send to Terminal">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span class="label">&gt;_</span>
            </button>
            <button class="aimax-icon-btn" onclick="aimaxBridgeAction('vscode',true)" title="Copy &amp; send to Claude Code">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span class="label">&lt;/&gt;</span>
            </button>
            <button class="aimax-icon-btn" id="bridgeInlineBtn" onclick="aimaxBridgeAction('print')" title="Ask Claude inline">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1.5 L13.6 9.2 L21.3 7.6 L15.7 12 L21.3 16.4 L13.6 14.8 L12 22.5 L10.4 14.8 L2.7 16.4 L8.3 12 L2.7 7.6 L10.4 9.2 Z"/></svg>
            </button>
        </div>
        <div class="bridge-response" id="bridgeResponse"></div>
        <div class="bridge-status" id="bridgeStatus"></div>
    </div>
    <div class="menu" id="menu">
        <!-- Page actions -->
        <button class="menu-item" onclick="reload()">Reload</button>
        <button class="menu-item" onclick="toggleAnnotMode()">Annotation Mode</button>
        <div class="menu-divider"></div>
        <!-- URL actions -->
        <button class="menu-item" onclick="copyUrl()">Copy URL</button>
        <button class="menu-item" id="presentMenuItem" onclick="presentInBrowser()" disabled title="Not a slide deck (need ≥2 &lt;section&gt; elements)">Present in Browser</button>
        <button class="menu-item" id="presenterModeMenuItem" onclick="togglePresenter()" disabled title="Not a slide deck (need ≥2 &lt;section&gt; elements)">Enter Presenter Mode</button>
        <button class="menu-item" id="makePresentableMenuItem" onclick="makePresentable()" style="display:none;" title="Open Claude Code to convert this file into an AIMax-presentable deck">Make it presentable</button>
        <div class="menu-divider"></div>
        <!-- Open * group -->
        <button class="menu-item" onclick="openTerminal()">Open Terminal</button>
        <button class="menu-item" onclick="openClaudeCode()">Open Claude Code</button>
        <button class="menu-item" onclick="openExternal()">Open External Browser</button>
        <button class="menu-item" onclick="openCurrentFile()">Open Current Editor File</button>
        <button class="menu-item" id="addBridgeMenuItem" onclick="addBridgeToPage()" disabled title="Available only on local HTML artifacts served by AIMax Viewer">Add Claude Bridge to this page (persistent)…</button>
        <button class="menu-item" onclick="goHome()">Go to Home</button>
        <div class="menu-divider"></div>
        <!-- Annotation toggles -->
        <button class="menu-item" id="toggleLiveInspectBtn" onclick="toggleLiveInspect()">
            <span id="liveInspectStatus">${liveInspectEnabled ? '✓' : '✗'}</span> Enable Live Annotation
        </button>
        <button class="menu-item" id="skipAnnotMenuItem" onclick="skipAnnotForHost()" disabled title="Available only on proxied (cross-port) pages">Skip Live Annotation for this host…</button>
        <div class="menu-divider"></div>
        <button class="menu-item" id="restoreLayoutItem" onclick="restoreLayout()" title="Put every element back where the page itself places it. Your text edits are kept.">Restore original layout</button>
        <button class="menu-item" id="restoreBackupItem" onclick="restoreBackup()" title="Bring the whole file back to how it was before your first edit in this session. Text edits are undone too.">Restore file from backup</button>
        <div class="menu-divider"></div>
        <button class="menu-item" onclick="openDevTools()" title="Open the Developer Tools for this panel — console, DOM and network of the viewer itself">Show Dev Console</button>
    </div>
    <iframe id="frame" src="${cacheBustUrl(url)}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation allow-downloads" allow="clipboard-read; clipboard-write; fullscreen"></iframe>

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

        // Serving HTML with no-store stops NEW stale entries, but a page cached
        // by an OLDER build (which sent etag/last-modified and no cache-control)
        // can still be replayed from the webview's HTTP cache — bringing that
        // build's injected annotation/edit client back with it, so the toolbar
        // is new while the page behaves like the version it was cached under.
        // A one-shot query param makes the cache key miss those legacy entries.
        // currentUrl stays clean: address bar, history, presenter and the
        // edit-target resolution all read it, and the server splits the query
        // off before resolving the file.
        function cacheBusted(url) {
            try {
                const u = new URL(url);
                const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
                if (!local || u.port !== '${serverPort}') return url;
                if (u.pathname.startsWith('/__proxy__/')
                    || u.pathname.startsWith('/__presenter')
                    || u.pathname.startsWith('/api/')) return url;
                u.searchParams.set('__aimaxcb', String(Date.now()));
                return u.toString();
            } catch (e) {
                return url;
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
            frame.src = cacheBusted(url);
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
            // Reassigning frame.src replays the cached response; reload from the
            // canonical URL with a fresh cache-buster instead.
            frame.src = cacheBusted(currentUrl);
            toggleMenu();
        }

        function copyUrl() {
            vscode.postMessage({ command: 'copyToClipboard', text: currentUrl });
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

        // In-panel presenter toggle: swaps the iframe content to the slide
        // presenter (/__presenter#<deckUrl>) and back, staying inside AIMax Viewer.
        let presenterActive = false;
        let deckUrlBeforePresenter = null;
        function togglePresenter() {
            if (!presenterActive) {
                deckUrlBeforePresenter = currentUrl;
                const presUrl = 'http://127.0.0.1:${serverPort}/__presenter#' + currentUrl;
                presenterActive = true;
                navigateToUrl(presUrl);
            } else {
                presenterActive = false;
                if (deckUrlBeforePresenter) navigateToUrl(deckUrlBeforePresenter);
            }
            syncPresenterUI();
            toggleMenu();
        }

        function syncPresenterUI() {
            const item = document.getElementById('presenterModeMenuItem');
            if (item) {
                item.textContent = presenterActive ? 'Exit Presenter Mode' : 'Enter Presenter Mode';
                // Keep enabled while active so the user can exit.
                if (presenterActive) item.disabled = false;
            }
        }

        function makePresentable() {
            vscode.postMessage({ command: 'makePresentable', url: currentUrl });
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

        function addBridgeToPage() {
            vscode.postMessage({ command: 'addBridgeToPage', url: currentUrl });
            toggleMenu();
        }

        function skipAnnotForHost() {
            vscode.postMessage({ command: 'skipAnnotForHost', url: currentUrl });
            toggleMenu();
        }

        // Populate the toolbar address bar with the page title (preferred) or
        // the current URL (fallback). The title is read from the iframe when
        // accessible (same-origin AIMax pages); otherwise we show the URL.
        // The (i) tooltip always carries the full URL regardless.
        function refreshAddressDisplay() {
            const el = document.getElementById('addressDisplay');
            if (!el) return;
            let label = currentUrl || '';
            try {
                const t = (frame.contentDocument && frame.contentDocument.title || '').trim();
                if (t) label = t;
            } catch (_) { /* cross-origin → keep URL */ }
            el.textContent = label;
            el.title = currentUrl || '';
        }

        // Enable "Skip Live Annotation for this host" only when the iframe
        // is currently loading a proxied URL (recognisable by /__proxy__/<port>/
        // in the path). On AIMax-internal or external pages it's not applicable.
        function refreshSkipAnnotAvailability(url) {
            const item = document.getElementById('skipAnnotMenuItem');
            if (!item) return;
            const proxyMatch = (url || '').match(/\\/__proxy__\\/(\\d+)\\//);
            item.disabled = !proxyMatch;
            item.title = proxyMatch
                ? 'Add localhost:' + proxyMatch[1] + ' to the Live Annotation skip list (reload required)'
                : 'Available only on proxied (cross-port) pages';
        }

        // Toggle the "Add Claude Bridge…" menu item: enabled only when the
        // current iframe URL is a local AIMax-served HTML file (i.e. one we
        // know how to map back to a workspace path on the host side).
        function refreshAddBridgeAvailability(url) {
            const item = document.getElementById('addBridgeMenuItem');
            if (!item) return;
            let isLocalAimax = false;
            try {
                const u = new URL(url);
                isLocalAimax = u.hostname === '127.0.0.1' &&
                    u.port === '${serverPort}' &&
                    !u.pathname.startsWith('/__proxy__/') &&
                    !u.pathname.startsWith('/__presenter') &&
                    !u.pathname.startsWith('/api/') &&
                    u.pathname.toLowerCase().endsWith('.html');
            } catch (_) { /* keep disabled */ }
            item.disabled = !isLocalAimax;
            item.title = isLocalAimax
                ? 'Open Claude Code with a prompt to inject the bridge into this HTML file'
                : 'Available only on local HTML artifacts served by AIMax Viewer';
        }

        function openTerminal() {
            vscode.postMessage({ command: 'openTerminal' });
        }

        function openDevTools() {
            vscode.postMessage({ command: 'openDevTools' });
            toggleMenu();
        }

        // Both rewrite the file, so the host asks for confirmation before doing
        // anything and tells us to reload once it has.
        function restoreLayout() {
            vscode.postMessage({ command: 'restoreLayout', url: currentUrl });
            toggleMenu();
        }

        function restoreBackup() {
            vscode.postMessage({ command: 'restoreBackup', url: currentUrl });
            toggleMenu();
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
                    // If the user navigated away from the presenter (dropdown,
                    // back/forward, in-page link), drop presenter state so the
                    // menu label resets to "Enter Presenter Mode".
                    if (presenterActive && newUrl.indexOf('/__presenter') === -1) {
                        presenterActive = false;
                        syncPresenterUI();
                    }
                    console.log('[AIMax Nav] Back button disabled?', document.getElementById('backBtn').disabled);
                } else {
                    console.log('[AIMax Nav] URL unchanged or about:blank, skipping history update');
                }

                // Try to get page title, fallback to current URL
                const iframeTitle = frame.contentDocument?.title;
                vscode.postMessage({ command: 'updateTitle', title: iframeTitle || currentUrl });

                // Defer to the fetch-based detector below (works around the
                // webview-iframe cross-origin restriction that blocks
                // frame.contentDocument access).
                detectDeckByFetch(currentUrl);
                refreshAddBridgeAvailability(currentUrl);
                refreshSkipAnnotAvailability(currentUrl);
                refreshEditAvailability(currentUrl);
                refreshAnnotEmptyMessage();
                refreshAddressDisplay();

                // Note: Metadata is received via postMessage from the iframe content
                // (see message listener below)
            } catch (e) {
                // Cross-origin - title not accessible, fallback to URL
                console.log('[AIMax Nav] Cross-origin iframe, using URL as title');
                vscode.postMessage({ command: 'updateTitle', title: currentUrl });
                // Detection still runs — fetch works regardless of iframe sandbox.
                detectDeckByFetch(currentUrl);
                refreshAddBridgeAvailability(currentUrl);
                refreshSkipAnnotAvailability(currentUrl);
                refreshEditAvailability(currentUrl);
                refreshAnnotEmptyMessage();
                refreshAddressDisplay();
            }
        };

        // Detect whether the current URL points at a slide deck by fetching
        // the raw HTML and counting <section> tags. Webview-iframe is always
        // cross-origin (vscode-webview:// vs http://127.0.0.1:port), so
        // frame.contentDocument is blocked. This works because our local
        // server sets Access-Control-Allow-Origin: * and the CSP allows
        // connect-src http://127.0.0.1:*.
        let _detectToken = 0;
        function detectDeckByFetch(url) {
            const presentItem = document.getElementById('presentMenuItem');
            const presenterItem = document.getElementById('presenterModeMenuItem');
            const makeItem = document.getElementById('makePresentableMenuItem');
            const myToken = ++_detectToken;
            const setState = (state, sectionCount) => {
                if (myToken !== _detectToken) return;  // stale
                const deckTitle = state === 'isDeck'
                    ? 'Open this deck in the slide presenter'
                    : (state === 'crossOrigin'
                        ? 'Cross-origin or unreachable content — cannot inspect for slides'
                        : 'Not a slide deck (found ' + sectionCount + ' <section>, need ≥2)');
                if (presentItem) {
                    presentItem.disabled = state !== 'isDeck';
                    presentItem.title = deckTitle;
                }
                if (presenterItem) {
                    // Stay enabled while presenter is active (so the user can exit),
                    // otherwise mirror the deck-detection state.
                    presenterItem.disabled = !presenterActive && state !== 'isDeck';
                    presenterItem.title = presenterActive ? 'Return to the normal view' : deckTitle;
                }
                if (makeItem) {
                    makeItem.style.display = state === 'notDeck' ? 'block' : 'none';
                }
            };
            // Skip fetch for non-http URLs (about:blank, data:, etc.)
            if (!/^https?:\\/\\//.test(url || '')) {
                setState('crossOrigin', 0);
                return;
            }
            fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store' })
                .then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
                .then(html => {
                    const matches = html.match(/<section\\b/gi);
                    const count = matches ? matches.length : 0;
                    setState(count >= 2 ? 'isDeck' : 'notDeck', count);
                    // The webview iframe is cross-origin (vscode-webview:// vs
                    // http://127.0.0.1), so frame.contentDocument.title is
                    // unreadable and the tab falls back to the full URL. Recover
                    // the real <title> from the HTML we just fetched and use it
                    // as the tab label. Guard with the staleness token so a slow
                    // fetch for an old URL can't relabel a newer page.
                    if (myToken !== _detectToken) return;
                    const titleMatch = html.match(/<title[^>]*>([^<]*)<\\/title>/i);
                    const pageTitle = titleMatch && titleMatch[1].trim();
                    if (pageTitle) {
                        vscode.postMessage({ command: 'updateTitle', title: pageTitle });
                    }
                })
                .catch(_ => setState('crossOrigin', 0));
        }

        // Annotation mode state
        let annotActive = false;
        let editActive = false;
        let drawActive = false;
        let notesActive = false;
        let layoutActive = false;
        // Undo/redo state mirrored from the page's gesture history, so the tool
        // row can disable buttons that would do nothing. Declared up here with
        // the other state: the init calls below reach annotEmptyMessage(), and a
        // let declared further down would be in its temporal dead zone.
        let layoutState = { canUndo: false, canRedo: false, hasSelection: false, hasChanges: false };
        // How many .speaker-notes the page reports; null = not asked yet.
        let notesCount = null;
        let annotations = [];
        let pendingEdits = []; // [{n, oldText, newText, selector, href}]
        let pendingLayout = []; // [{n, selector, css}] — one entry per moved frame
        let editCounter = 0;
        const annotWindow = document.getElementById('annotWindow');
        const annotBody = document.getElementById('annotBody');
        const annotCount = document.getElementById('annotCount');
        const annotBtn = document.getElementById('annotBtn');
        const editBtn = document.getElementById('editBtn');
        const notesBtn = document.getElementById('notesBtn');
        const layoutBtn = document.getElementById('layoutBtn');
        const saveBtn = document.getElementById('saveBtn');
        const saveCountLbl = document.getElementById('saveCountLbl');

        // Run detection at first load too (frame.onload fires after this script,
        // but if currentUrl is already set we want a result immediately).
        // NOTE: must run AFTER the const/let declarations above — refreshEditAvailability
        // and the empty-state refresh touch editBtn/annotations, which are in the
        // temporal dead zone earlier in this script. Calling them before the
        // declarations throws a ReferenceError that aborts the rest of init
        // (consts unassigned, message/load listeners never registered), which
        // silently breaks annotation mode in the browser panel.
        detectDeckByFetch(currentUrl);
        refreshAddBridgeAvailability(currentUrl);
        refreshSkipAnnotAvailability(currentUrl);
        refreshEditAvailability(currentUrl);
        refreshAddressDisplay();
        refreshAnnotEmptyMessage();

        function postFrameToggle() {
            const on = annotActive || editActive || drawActive;
            const mode = editActive ? 'edit' : (drawActive ? 'draw' : 'comment');
            try {
                frame.contentWindow.postMessage({ type: 'annot:toggle', on: on, mode: mode, notes: notesActive, layout: layoutActive }, '*');
            } catch (err) {}
        }

        function syncToggleUI() {
            // Draw is a sub-mode of annotation now, so the toolbar shows the two
            // top-level modes and the panel header shows where you are inside one.
            annotBtn.classList.toggle('active', annotActive || drawActive);
            editBtn.classList.toggle('active-edit', editActive);
            const open = annotActive || editActive || drawActive;
            annotWindow.classList.toggle('open', open);
            annotWindow.classList.toggle('edit-mode', editActive);
            document.querySelectorAll('.aimax-edit-only').forEach(el => {
                el.style.display = editActive ? 'inline-flex' : 'none';
            });
            // Comment-only chrome is hidden by the .edit-mode CSS rule, not by
            // inline styles: the action row is a flex container and forcing
            // inline-flex on it would break its layout.
            const pointBtn = document.getElementById('pointBtn');
            const drawSubBtn = document.getElementById('drawSubBtn');
            const textBtn = document.getElementById('textBtn');
            if (pointBtn) pointBtn.classList.toggle('on', annotActive && !drawActive);
            if (drawSubBtn) drawSubBtn.classList.toggle('on', drawActive);
            if (textBtn) textBtn.classList.toggle('on', editActive && !layoutActive && !notesActive);
            notesBtn.classList.toggle('on', notesActive);
            if (layoutBtn) layoutBtn.classList.toggle('on', layoutActive);
            renderLayoutTools();
            updateSaveUI();
            // Draw collects comments just like comment mode — same panel & list.
            if ((annotActive || drawActive) && !editActive) {
                annotCount.textContent = 'Annotations (' + annotations.length + ')';
            } else if (editActive) {
                annotCount.textContent = layoutActive
                    ? 'Edit · Move/Resize'
                    : (notesActive ? 'Edit · Notes' : 'Edit');
            }
            if (editActive) {
                renderLayoutBody();
            } else if (annotations.length === 0) {
                refreshAnnotEmptyMessage();
            }
        }

        function updateSaveUI() {
            const n = pendingEdits.length + pendingLayout.length;
            saveCountLbl.textContent = String(n);
            saveBtn.disabled = (n === 0);
            // Save button is visible only inside Edit mode. If user closes the
            // panel with pending edits, the edits stay in memory (and in DOM);
            // re-toggling Edit makes the SAVE button reappear so they can flush.
            saveBtn.style.display = editActive ? 'inline-flex' : 'none';
        }

        // Annotate is the top-level mode; Point/Draw are its sub-modes, so the
        // toolbar button restores whichever sub-mode was last used.
        function toggleAnnotMode(forceState) {
            const wasOn = annotActive || drawActive;
            const next = (typeof forceState === 'boolean') ? forceState : !wasOn;
            if (next) {
                if (editActive) { editActive = false; notesActive = false; layoutActive = false; }
                if (!drawActive) annotActive = true;
            } else {
                annotActive = false;
                drawActive = false;
            }
            syncToggleUI();
            postFrameToggle();
        }

        function toggleEditMode(forceState) {
            if (editBtn.disabled) return;
            const next = (typeof forceState === 'boolean') ? forceState : !editActive;
            editActive = next;
            if (editActive) {
                annotActive = false;
                drawActive = false;
                // Always land in Text: it's the sub-mode that matches what the
                // Edit button promises, and the other two are opt-in.
                notesActive = false;
                layoutActive = false;
            }
            if (!editActive) {
                notesActive = false;
                layoutActive = false;
            }
            notesCount = null;
            syncToggleUI();
            postFrameToggle();
        }

        // Kept for the keyboard/menu entry points that still name it.
        function toggleDrawMode(forceState) {
            const next = (typeof forceState === 'boolean') ? forceState : !drawActive;
            setAnnotSubmode(next ? 'draw' : 'point');
        }

        function layoutToolsHtml() {
            const u = layoutState.canUndo ? '' : ' disabled';
            const r = layoutState.canRedo ? '' : ' disabled';
            const s = layoutState.hasSelection ? '' : ' disabled';
            // Enabled only when the selected frame actually carries an override
            // (pending or already in the file) — otherwise the button offers to
            // undo something that was never done.
            const c = layoutState.hasChanges ? '' : ' disabled';
            return '<div class="aimax-lay-tools">' +
                '<button onclick="layoutUndo()"' + u + ' title="Undo the last move/resize  (⌘Z)">↶</button>' +
                '<button onclick="layoutRedo()"' + r + ' title="Redo the last undone gesture  (⇧⌘Z)">↷</button>' +
                '<button onclick="layoutDelete()"' + s + ' title="Hide the selected frame (display:none). The markup stays in the file — ⌘Z or Back to original brings it back"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button>' +
                '<button onclick="layoutReset()"' + c + ' title="Back to original — drop every move/resize/reorder on the selected frame, including overrides already written to the file (removed on the next Save)">⤺</button>' +
                '</div>' +
                '<div class="aimax-lay-tools">' +
                '<span class="lay-group">Order</span>' +
                '<button onclick="layoutZ(\\'back\\')"' + s + ' title="Send to back — behind every sibling. Only visible where frames overlap">⤓</button>' +
                '<button onclick="layoutZ(\\'backward\\')"' + s + ' title="Send backward one step">↓</button>' +
                '<button onclick="layoutZ(\\'forward\\')"' + s + ' title="Bring forward one step">↑</button>' +
                '<button onclick="layoutZ(\\'front\\')"' + s + ' title="Bring to front — above every sibling">⤒</button>' +
                '</div>';
        }

        function postToFrame(msg) {
            try { frame.contentWindow.postMessage(msg, '*'); } catch (err) {}
        }

        function layoutUndo() { postToFrame({ type: 'edit:layout-undo' }); }
        function layoutRedo() { postToFrame({ type: 'edit:layout-redo' }); }
        function layoutReset() { postToFrame({ type: 'edit:layout-reset' }); }
        function layoutZ(dir) { postToFrame({ type: 'edit:layout-z', dir: dir }); }
        function layoutDelete() { postToFrame({ type: 'edit:layout-delete' }); }

        // The Move tool rows live in the action strip, alongside (never with)
        // the comment actions — one mode's tools at a time.
        function renderLayoutTools() {
            const host = document.getElementById('annotLayoutTools');
            if (!host) return;
            host.innerHTML = (editActive && layoutActive) ? layoutToolsHtml() : '';
        }

        // The hint must show even when comments were collected earlier in the
        // session (refreshAnnotEmptyMessage bails out in that case).
        function renderLayoutBody() {
            const body = document.getElementById('annotBody');
            if (body) body.innerHTML = '<div class="annot-empty">' + annotEmptyMessage() + '</div>';
        }

        // One selected sub-mode at a time, always exactly one.
        function setEditSubmode(which) {
            if (!editActive) return;
            layoutActive = (which === 'move');
            notesActive = (which === 'notes');
            if (!layoutActive) layoutState = { canUndo: false, canRedo: false, hasSelection: false, hasChanges: false };
            if (!notesActive) notesCount = null;
            syncToggleUI();
            postFrameToggle();
        }

        function setAnnotSubmode(which) {
            drawActive = (which === 'draw');
            annotActive = !drawActive;
            editActive = false;
            syncToggleUI();
            postFrameToggle();
        }

        function closeAnnotPanel() {
            annotActive = false;
            editActive = false;
            drawActive = false;
            notesActive = false;
            layoutActive = false;
            syncToggleUI();
            postFrameToggle();
        }

        function triggerSave() {
            if (pendingEdits.length === 0 && pendingLayout.length === 0) return;
            saveBtn.disabled = true;
            vscode.postMessage({
                command: 'saveEdit',
                url: currentUrl,
                edits: pendingEdits.map(e => ({
                    n: e.n,
                    oldText: e.oldText,
                    newText: e.newText,
                    selector: e.selector,
                    occurrenceIndex: e.occurrenceIndex,
                    outerHTML: e.outerHTML
                })),
                layout: pendingLayout.map(l => ({
                    n: l.n,
                    selector: l.selector,
                    css: l.css
                }))
            });
        }

        function applySaveResult(payload) {
            const applied = payload.applied || [];
            const failed = payload.failed || [];
            applied.forEach(n => {
                try { frame.contentWindow.postMessage({ type: 'edit:result', n: n, ok: true }, '*'); } catch (e) {}
            });
            failed.forEach(f => {
                try { frame.contentWindow.postMessage({ type: 'edit:result', n: f.n, ok: false, toast: f.reason }, '*'); } catch (e) {}
            });
            pendingEdits = pendingEdits.filter(e => !applied.includes(e.n));
            pendingLayout = pendingLayout.filter(l => !applied.includes(l.n));
            updateSaveUI();
            const orig = annotCount.dataset.origText || annotCount.textContent;
            annotCount.dataset.origText = '';
            if (failed.length === 0) {
                annotCount.textContent = '✓ ' + applied.length + ' saved';
            } else {
                annotCount.textContent = applied.length + ' saved · ' + failed.length + ' failed';
            }
            setTimeout(() => { syncToggleUI(); }, 1800);
        }

        // Enable Edit toggle only when current URL is an AIMax-served .html file
        // (mirrors urlToWorkspacePath() gate on the host side).
        function refreshEditAvailability(url) {
            let eligible = false;
            try {
                const u = new URL(url);
                eligible = (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
                    && u.port === '${serverPort}'
                    && !u.pathname.startsWith('/__proxy__/')
                    && !u.pathname.startsWith('/__presenter')
                    && !u.pathname.startsWith('/api/')
                    && u.pathname.toLowerCase().endsWith('.html');
            } catch (_) {}
            editBtn.disabled = !eligible;
            editBtn.title = eligible
                ? 'Edit text in place (writes to source HTML on disk)'
                : 'Edit available only on .html files served by AIMax (not .md, proxied, or external)';
            if (!eligible && editActive) {
                // URL navigated away from eligible — turn edit off but keep pending edits
                editActive = false;
                notesActive = false;
                layoutActive = false;
                syncToggleUI();
                postFrameToggle();
            }
        }

        function basenameFromUrl(u) {
            try { return decodeURIComponent(u.split('/').pop().split('?')[0] || u); }
            catch (e) { return u; }
        }

        function escapeHtml(s) {
            return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        }

        // Format the normalized stroke bbox as a human/agent-readable region line.
        function annotRegionLine(a) {
            if (a.kind !== 'draw' || !a.bbox) return '';
            const pct = (v) => Math.round((v || 0) * 100) + '%';
            const vp = a.viewport ? (' (viewport ' + a.viewport.w + 'x' + a.viewport.h + ')') : '';
            return 'Region: freehand stroke bbox x=' + pct(a.bbox.x) + ' y=' + pct(a.bbox.y) +
                ' w=' + pct(a.bbox.w) + ' h=' + pct(a.bbox.h) + vp;
        }

        function annotEntryDetails(a) {
            const info = a.info || {};
            const dim = (info.width || 0) + 'x' + (info.height || 0);
            const meta = '<' + info.tag + '>' + (info.text ? ' "' + info.text + '"' : '') +
                ' (' + dim + (info.color ? ', color ' + info.color : '') +
                (info.font ? ', font ' + info.font : '') + ')';
            const region = annotRegionLine(a);
            return (a.kind === 'draw' ? 'Gesture: freehand drawing\\n' : '') +
                'Selector: ' + a.selector + '\\nElement: ' + meta +
                (region ? '\\n' + region : '') + '\\nRequest: ' + a.comment;
        }

        function buildPromptText() {
            if (annotations.length === 0) return '';
            const href = annotations[0].href || currentUrl;
            const lines = [
                'Modify the file ' + href + '.',
                'Apply each <request> below to its element (use Selector first, fall back to the Element description). Do not change anything else.',
                ''
            ];
            annotations.forEach((a, i) => {
                const info = a.info || {};
                const dim = (info.width || 0) + 'x' + (info.height || 0);
                const meta = '<' + info.tag + '>' + (info.text ? ' "' + info.text + '"' : '') +
                    ' (' + dim + (info.color ? ', color ' + info.color : '') +
                    (info.font ? ', font ' + info.font : '') + ')';
                lines.push('<annotation n="' + (i + 1) + '">');
                if (a.kind === 'draw') lines.push('Gesture: freehand drawing (the user drew over this element to mark it)');
                lines.push('Selector: ' + a.selector);
                lines.push('Element: ' + meta);
                const region = annotRegionLine(a);
                if (region) lines.push(region);
                lines.push('<request>' + a.comment + '</request>');
                lines.push('</annotation>');
                lines.push('');
            });
            return lines.join('\\n');
        }

        // Empty-state message: depends on what kind of URL we're on.
        // Annotation only works when the AIMax annotation client is injected,
        // which happens in two cases: (a) AIMax serves the file directly
        // (its own port), (b) the AIMax proxy relays a cross-port URL.
        // If the URL is cross-port localhost without /__proxy__/ it means
        // either Live Annotation is OFF globally or this host is in the
        // skip list — annotation can't work on that URL until that changes.
        function annotEmptyMessage() {
            if (editActive) {
                const tipL = 'opacity:0.7;font-size:0.9em';
                if (layoutActive) {
                    return 'Drag a frame to move it, drag a handle to resize, ↑↓←→ to nudge (⇧ = 10px). Esc deselects.' +
                        '<br><br><span style="' + tipL + '">Saved as CSS overrides in a &lt;style data-aimax-layout&gt; block at the end of the file — the markup is untouched.</span>';
                }
                if (notesActive) {
                    // notesCount is null until the page answers; 0 means the
                    // artifact simply has no notes to edit.
                    if (notesCount === 0) {
                        return 'This artifact has no speaker notes.' +
                            '<br><br><span style="' + tipL + '">Notes mode edits <code>.speaker-notes</code> blocks, which slide decks use for the presenter view. This file has none, so there is nothing to reveal here — switch back to Text to edit the visible content.</span>';
                    }
                    return 'Hover a speaker note (yellow block) and click to edit. ⌘↵ to save the edit.';
                }
                return 'Hover an element and click to edit its text. ↵ to save the edit.';
            }
            if (drawActive) {
                const tip = 'opacity:0.7;font-size:0.9em';
                return 'Draw freehand over the element to change, then type a note. ↵ to save.' +
                    '<br><br><span style="' + tip + '">The stroke is anchored to the element underneath it — on long scrolling pages the position is approximate.</span>';
            }
            const base = 'Hover an element and click to add a comment.';
            const tipStyle = 'opacity:0.7;font-size:0.9em';
            let url = currentUrl || '';
            let u = null;
            try { u = new URL(url); } catch (_) {}
            if (!u) return base;
            const isProxied = u.pathname.indexOf('/__proxy__/') === 0 || u.pathname.indexOf('/__proxy__/') !== -1;
            const isAimaxOwn = (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
                && u.port === '${serverPort}'
                && !isProxied;
            const isCrossPortLocal = (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
                && u.port !== '${serverPort}'
                && u.port !== '';
            const isExternal = u.hostname !== 'localhost' && u.hostname !== '127.0.0.1';

            if (isAimaxOwn || isProxied) {
                // Annotation should work. Add a soft tip only on proxied URLs
                // because that's where injection can occasionally fail.
                if (isProxied) {
                    return base + '<br><br><span style="' + tipStyle + '">If overlays don\\'t appear, the proxy injection may have failed. Try reloading, or use "Skip Live Annotation for this host" if this app conflicts with the proxy.</span>';
                }
                return base;
            }
            if (isCrossPortLocal) {
                return '<span style="' + tipStyle + '">This is an external app on <code>' + u.host + '</code> loaded directly — Live Annotation is off here (either globally or because this host is in the skip list). Re-enable it from the ☰ menu, or remove <code>' + u.host + '</code> from <code>aimaxViewer.liveInspect.skipHosts</code> in settings to annotate this page.</span>';
            }
            if (isExternal) {
                return '<span style="' + tipStyle + '">Live Annotation is available only on localhost apps. This page is external (' + u.hostname + ').</span>';
            }
            return base;
        }
        function refreshAnnotEmptyMessage() {
            if (typeof annotations !== 'undefined' && annotations.length > 0) return;
            const body = document.getElementById('annotBody');
            if (body) body.innerHTML = '<div class="annot-empty">' + annotEmptyMessage() + '</div>';
        }

        function renderAnnotations() {
            annotCount.textContent = 'Annotations (' + annotations.length + ')';
            if (annotations.length === 0) {
                annotBody.innerHTML = '<div class="annot-empty">' + annotEmptyMessage() + '</div>';
                return;
            }
            const rows = annotations.map((a, i) => {
                const tag = (a.info && a.info.tag) ? a.info.tag : 'el';
                const details = annotEntryDetails(a);
                const drawMark = (a.kind === 'draw')
                    ? '<span class="annot-draw-mark" title="Freehand drawing">✏</span>'
                    : '';
                return '<div class="annot-row" title="' + escapeHtml(details) + '">' +
                    '<span class="annot-num">' + (i + 1) + '</span>' +
                    drawMark +
                    '<span class="annot-text">' + escapeHtml(a.comment) + '</span>' +
                    '<span class="annot-tag">&lt;' + escapeHtml(tag) + '&gt;</span>' +
                    '<span class="annot-x" data-n="' + a.n + '" title="Remove">×</span>' +
                    '</div>';
            }).join('');
            annotBody.innerHTML = rows;
            annotBody.querySelectorAll('.annot-x').forEach(x => {
                x.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const n = parseInt(x.getAttribute('data-n'), 10);
                    removeAnnotation(n);
                    try { frame.contentWindow.postMessage({ type: 'annot:remove', n }, '*'); } catch (err) {}
                });
            });
        }

        function copyAnnotPrompt() {
            const text = buildPromptText();
            if (!text) return;
            vscode.postMessage({ command: 'copyToClipboard', text: text });
            const orig = annotCount.textContent;
            annotCount.textContent = '✓ Copied to clipboard';
            setTimeout(() => { annotCount.textContent = orig; }, 1200);
        }

        function clearAnnotations() {
            annotations = [];
            renderAnnotations();
            try {
                frame.contentWindow.postMessage({ type: 'annot:reset' }, '*');
            } catch (err) {}
        }

        function annotSend(mode) {
            const text = buildPromptText();
            if (!text) return;
            vscode.postMessage({ command: 'claudeBridge', mode: mode, prompt: text });
            const orig = annotCount.textContent;
            annotCount.textContent = mode === 'terminal' ? '→ Terminal' : '→ VS Code';
            setTimeout(() => { annotCount.textContent = orig; }, 1500);
        }

        // Track which surface initiated an inline 'print' request so the response
        // is rendered in the right place (annotation panel vs Bridge dropdown).
        let annotRunPending = false;

        function annotRun() {
            if (annotRunPending) return;
            const text = buildPromptText();
            if (!text) return;
            annotRunPending = true;
            const runBtn = document.getElementById('annotRunBtn');
            const inlineBtn = document.getElementById('bridgeInlineBtn');
            if (runBtn) runBtn.disabled = true;
            if (inlineBtn) inlineBtn.disabled = true;
            const respBox = document.getElementById('annotResponse');
            if (respBox) { respBox.style.display = 'none'; respBox.textContent = ''; }
            const orig = annotCount.textContent;
            annotCount.dataset.origText = orig;
            annotCount.textContent = 'Running agent (up to 5 min)…';
            // Annotations always run in edit mode — their purpose is to apply changes.
            vscode.postMessage({ command: 'claudeBridge', mode: 'print', prompt: text, allowEdits: true });
        }

        function annotRefresh() {
            reload();
        }

        // --- Claude Bridge dropdown (toolbar) ---
        function aimaxBridgeToggle() {
            const m = document.getElementById('bridgeMenu');
            if (!m) return;
            m.classList.toggle('open');
            if (m.classList.contains('open')) {
                const ta = document.getElementById('bridgePrompt');
                if (ta) ta.focus();
            }
        }
        let bridgeInlinePending = false;
        function aimaxBridgeAction(mode, alsoCopy) {
            if (mode === 'print' && bridgeInlinePending) return;
            const ta = document.getElementById('bridgePrompt');
            const status = document.getElementById('bridgeStatus');
            const respBox = document.getElementById('bridgeResponse');
            const prompt = (ta && ta.value || '').trim();
            if (!prompt) return;
            if (alsoCopy) {
                vscode.postMessage({ command: 'copyToClipboard', text: prompt });
            }
            if (mode === 'copy') {
                vscode.postMessage({ command: 'copyToClipboard', text: prompt });
                if (status) {
                    status.textContent = 'Copied!';
                    setTimeout(() => { status.textContent = ''; }, 1500);
                }
                return;
            }
            const allowEdits = !!(document.getElementById('bridgeAllowEdits') || {}).checked;
            const fullPrompt = 'Context: viewing ' + currentUrl + '\\n\\n' + prompt;
            if (mode === 'print') {
                bridgeInlinePending = true;
                const inlineBtn = document.getElementById('bridgeInlineBtn');
                const runBtn = document.getElementById('annotRunBtn');
                if (inlineBtn) inlineBtn.disabled = true;
                if (runBtn) runBtn.disabled = true;
                if (status) status.textContent = allowEdits ? 'Running agent (up to 5 min)…' : 'Waiting for Claude…';
            } else if (status) {
                status.textContent = 'Sent!';
            }
            if (respBox) respBox.style.display = 'none';
            vscode.postMessage({ command: 'claudeBridge', mode: mode, prompt: fullPrompt, allowEdits: allowEdits });
        }
        function aimaxBridgeOnResult(result) {
            // If a >Run from the annotation panel is pending, route the inline
            // result there instead of the Bridge dropdown.
            if (annotRunPending && result.mode === 'print') {
                const annotBox = document.getElementById('annotResponse');
                const runBtn = document.getElementById('annotRunBtn');
                const inlineBtn = document.getElementById('bridgeInlineBtn');
                annotRunPending = false;
                bridgeInlinePending = false;
                if (runBtn) runBtn.disabled = false;
                if (inlineBtn) inlineBtn.disabled = false;
                const orig = annotCount.dataset.origText || 'Annotations (' + annotations.length + ')';
                if (result.ok && result.response) {
                    if (annotBox) {
                        annotBox.textContent = result.response;
                        annotBox.style.display = 'block';
                    }
                    annotCount.textContent = '✓ Done';
                } else {
                    annotCount.textContent = result.ok ? '✓ Sent' : 'Error';
                    if (!result.ok && annotBox) {
                        annotBox.textContent = 'Error: ' + (result.error || 'Unknown');
                        annotBox.style.display = 'block';
                    }
                }
                setTimeout(() => { annotCount.textContent = orig; }, 1800);
                return;
            }
            // Re-enable Bridge inline button on any 'print' result.
            if (result.mode === 'print') {
                bridgeInlinePending = false;
                const inlineBtn = document.getElementById('bridgeInlineBtn');
                const runBtn = document.getElementById('annotRunBtn');
                if (inlineBtn) inlineBtn.disabled = false;
                if (runBtn) runBtn.disabled = false;
            }
            const status = document.getElementById('bridgeStatus');
            const respBox = document.getElementById('bridgeResponse');
            if (!status || !respBox) return;
            if (result.ok && result.mode === 'print' && result.response) {
                respBox.textContent = result.response;
                respBox.style.display = 'block';
                status.textContent = '';
            } else if (result.ok) {
                status.textContent = 'Sent to Claude!';
                setTimeout(() => { status.textContent = ''; }, 2000);
            } else {
                status.textContent = 'Error: ' + (result.error || 'Unknown');
            }
        }

        // --- Live Inspect toggles ---
        function _setToggleStatus(spanId, value) {
            const el = document.getElementById(spanId);
            if (el) el.textContent = value ? '✓' : '✗';
        }
        let _liveInspectEnabled = ${liveInspectEnabled};
        function toggleLiveInspect() {
            _liveInspectEnabled = !_liveInspectEnabled;
            _setToggleStatus('liveInspectStatus', _liveInspectEnabled);
            vscode.postMessage({ command: 'updateConfig', key: 'aimaxViewer.liveInspect.enabled', value: _liveInspectEnabled });
        }

        function removeAnnotation(n) {
            annotations = annotations.filter(a => a.n !== n);
            renderAnnotations();
        }

        // Listen for metadata, clipboard requests, and annotations from iframe content
        window.addEventListener('message', (event) => {
            if (event.data?.type === 'aimaxMetadata' && event.data.metadata) {
                console.log('[AIMax] Received metadata via postMessage:', event.data.metadata);
                updateInfoTooltip(currentUrl, event.data.metadata);
            } else if (event.data?.command === 'copyToClipboard') {
                vscode.postMessage({ command: 'copyToClipboard', text: event.data.text });
            } else if (event.data?.type === 'annot:add') {
                annotations.push(event.data);
                renderAnnotations();
            } else if (event.data?.type === 'annot:remove' && typeof event.data.n === 'number') {
                removeAnnotation(event.data.n);
            } else if (event.data?.type === 'edit:save') {
                editCounter = Math.max(editCounter, event.data.n || 0);
                pendingEdits.push({
                    n: event.data.n,
                    oldText: event.data.oldText,
                    newText: event.data.newText,
                    selector: event.data.selector,
                    occurrenceIndex: event.data.occurrenceIndex,
                    outerHTML: event.data.outerHTML,
                    href: event.data.href,
                    notes: !!event.data.notes
                });
                updateSaveUI();
            } else if (event.data?.type === 'edit:notes-state') {
                notesCount = event.data.count | 0;
                if (editActive && notesActive) renderLayoutBody();
            } else if (event.data?.type === 'edit:layout-state') {
                layoutState = {
                    canUndo: !!event.data.canUndo,
                    canRedo: !!event.data.canRedo,
                    hasSelection: !!event.data.hasSelection,
                    hasChanges: !!event.data.hasChanges
                };
                if (layoutActive) renderLayoutTools();
            } else if (event.data?.type === 'edit:layout') {
                // One entry per frame: re-dragging the same element replaces its
                // pending geometry instead of queueing a second rule.
                editCounter = Math.max(editCounter, event.data.n || 0);
                const idx = pendingLayout.findIndex(l => l.selector === event.data.selector);
                const entry = {
                    n: event.data.n,
                    selector: event.data.selector,
                    css: event.data.css,
                    href: event.data.href
                };
                if (idx >= 0) { pendingLayout[idx] = entry; } else { pendingLayout.push(entry); }
                updateSaveUI();
            } else if (event.data?.type === 'edit:remove' && typeof event.data.n === 'number') {
                pendingEdits = pendingEdits.filter(e => e.n !== event.data.n);
                pendingLayout = pendingLayout.filter(l => l.n !== event.data.n);
                updateSaveUI();
            } else if (event.data?.command === 'bridgeResult') {
                aimaxBridgeOnResult(event.data);
            } else if (event.data?.command === 'reloadFrame') {
                reload();
            } else if (event.data?.command === 'saveEditResult') {
                applySaveResult(event.data);
            } else if (event.data?.command === 'presentFile' && event.data.url) {
                vscode.postMessage({ command: 'presentFile', url: event.data.url });
            } else if (event.data?.command === 'openExternal' && event.data.url) {
                vscode.postMessage({ command: 'openExternal', url: event.data.url });
            } else if (event.data?.command === 'openInBrowser' && event.data.url) {
                vscode.postMessage({ command: 'openInBrowser', url: event.data.url });
            }
        });

        // Re-assert annotation mode on iframe load (new page = fresh client)
        // Also inject Cmd/Ctrl+C handler so text selection inside iframe can be copied
        // (VS Code webview intercepts keyboard shortcuts; we forward selection to host)
        frame.addEventListener('load', () => {
            if (annotActive || editActive || drawActive) {
                postFrameToggle();
            }
            // No copy handler here on purpose: frame.contentDocument is always
            // cross-origin (vscode-webview:// vs http://127.0.0.1), so this
            // always threw and the handler was never installed. The injected
            // client does it from inside the page and posts 'copyToClipboard'
            // up to the listener below.
        });

        // Parent-level fallback: if user presses Cmd/Ctrl+C while iframe has selection,
        // copy that selection to clipboard via host
        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
                try {
                    const doc = frame.contentDocument;
                    const sel = doc && doc.getSelection && doc.getSelection().toString();
                    if (sel) {
                        vscode.postMessage({ command: 'copyToClipboard', text: sel });
                    }
                } catch (err) { /* cross-origin */ }
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

        // Reverse proxy: /__proxy__/<port>/<path> → http://127.0.0.1:<port>/<path>
        // Injects annotation client into HTML responses so the DOM-inspector toolbar
        // can talk to pages served by external dev servers (Vite, python http.server, etc.).
        const proxyMatch = url.match(/^\/__proxy__\/(\d+)(\/.*)?$/);
        if (proxyMatch) {
            const targetPort = parseInt(proxyMatch[1], 10);
            const rest = proxyMatch[2] || '/';
            // Strip Referer to avoid leaking the proxy URL upstream and confusing apps
            const upstreamHeaders: { [k: string]: string | string[] | undefined } = { ...req.headers };
            delete upstreamHeaders['host'];
            delete upstreamHeaders['referer'];
            delete upstreamHeaders['origin'];
            delete upstreamHeaders['accept-encoding']; // request identity so we can inject

            const proxyReq = http.request({
                host: '127.0.0.1',
                port: targetPort,
                path: rest,
                method: req.method,
                headers: upstreamHeaders as http.OutgoingHttpHeaders
            }, (proxyRes) => {
                const ct = String(proxyRes.headers['content-type'] || '');
                const isHtml = ct.toLowerCase().includes('text/html');
                const outHeaders: { [k: string]: string | string[] | undefined } = { ...proxyRes.headers };
                // Drop hop-by-hop and length (we may rewrite body)
                delete outHeaders['content-length'];
                delete outHeaders['transfer-encoding'];
                delete outHeaders['content-encoding'];
                outHeaders['access-control-allow-origin'] = '*';

                // Rewrite Location on redirects to stay inside the proxy
                if (proxyRes.headers.location) {
                    const loc = String(proxyRes.headers.location);
                    if (loc.startsWith('/')) {
                        outHeaders['location'] = `/__proxy__/${targetPort}${loc}`;
                    } else if (loc.startsWith(`http://localhost:${targetPort}`) || loc.startsWith(`http://127.0.0.1:${targetPort}`)) {
                        const u = new URL(loc);
                        outHeaders['location'] = `/__proxy__/${targetPort}${u.pathname}${u.search}`;
                    }
                }

                if (!isHtml) {
                    res.writeHead(proxyRes.statusCode || 200, outHeaders as http.OutgoingHttpHeaders);
                    proxyRes.pipe(res);
                    return;
                }

                // Strip CSP on proxied HTML responses: required so inline-script
                // injections (annotation, bridge) are not blocked by apps with
                // strict CSP (e.g. Streamlit). Affects only proxied HTML.
                delete outHeaders['content-security-policy'];
                delete outHeaders['content-security-policy-report-only'];
                // Same reason as static .html: the iframe caches the injected
                // client, so force a refetch to keep edit/annotation logic fresh.
                delete outHeaders['etag'];
                delete outHeaders['last-modified'];
                outHeaders['cache-control'] = 'no-store, no-cache, must-revalidate';

                // Buffer HTML to inject annotation client + bridge + base href
                const chunks: Buffer[] = [];
                proxyRes.on('data', (c: Buffer) => chunks.push(c));
                proxyRes.on('end', () => {
                    let html = Buffer.concat(chunks).toString('utf-8');
                    const baseTag = `<base href="/__proxy__/${targetPort}/">`;
                    if (/<head[^>]*>/i.test(html)) {
                        html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
                    } else {
                        html = baseTag + html;
                    }
                    html = injectAnnotationClient(html);
                    html = injectLinkHandler(html);
                    res.writeHead(proxyRes.statusCode || 200, outHeaders as http.OutgoingHttpHeaders);
                    res.end(html);
                });
            });
            proxyReq.on('error', (err) => {
                res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
                res.end(`Proxy error: cannot reach 127.0.0.1:${targetPort} (${err.message})`);
            });
            req.pipe(proxyReq);
            return;
        }

        // Root-relative fallback: if request comes from a proxied page (Referer header
        // points to /__proxy__/PORT/...) and the path is not a workspace file, redirect
        // through the proxy. Handles apps that fetch /api/foo or load /assets/x.js.
        //
        // Reserved AIMax endpoints (/__proxy__/, /__*, AIMax's own /api/*) are never
        // forwarded. App-owned /api/* paths (e.g. /api/quotes from sales-app) ARE
        // forwarded — these are the paths the proxied app expects to handle itself.
        const referer = String(req.headers['referer'] || '');
        const refMatch = referer.match(/\/__proxy__\/(\d+)\//);
        const aimaxOwnedPaths = new Set(['/api/artifacts', '/api/apps', '/api/identity', '/api/ports']);
        const urlPathOnly = url.split('?')[0];
        if (refMatch && !url.startsWith('/__proxy__/') && !url.startsWith('/__') && !aimaxOwnedPaths.has(urlPathOnly)) {
            res.writeHead(302, {
                'Location': `/__proxy__/${refMatch[1]}${url}`,
                'Access-Control-Allow-Origin': '*'
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

                let allowEdits = false;
                let readOnly = false;
                try {
                    const parsed = JSON.parse(raw);
                    prompt = (parsed.prompt || '').trim();
                    mode = parsed.mode || 'terminal';
                    allowEdits = !!parsed.allowEdits;
                    readOnly = !!parsed.readOnly;
                } catch {
                    prompt = raw;
                }

                const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
                handleClaudeBridge(mode, prompt, (result) => {
                    const isTimeout = typeof result.error === 'string' && result.error.startsWith('Timeout');
                    const status = result.ok ? 200 : (result.error === 'Empty prompt' ? 400 : (isTimeout ? 504 : 500));
                    res.writeHead(status, headers);
                    res.end(JSON.stringify(result));
                }, { allowEdits, readOnly });
            });
            return;
        }

        // Direct save of speaker-notes edits from the in-panel presenter.
        // Body: { url, oldText, newText }. Resolves the deck file via the same
        // gate as Edit mode (urlToWorkspacePath) and applies an anchored
        // text replace via applyHtmlEdits (writes a one-per-session .bak first).
        if (url === '/__save-notes' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            req.on('end', () => {
                const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
                let parsed: any;
                try { parsed = JSON.parse(body); } catch {
                    res.writeHead(400, headers);
                    res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
                    return;
                }
                const target = urlToWorkspacePath(String(parsed.url || ''));
                if (!target) {
                    res.writeHead(400, headers);
                    res.end(JSON.stringify({ ok: false, error: 'Deck not an AIMax-served .html under this workspace' }));
                    return;
                }
                if (typeof parsed.oldText !== 'string' || typeof parsed.newText !== 'string') {
                    res.writeHead(400, headers);
                    res.end(JSON.stringify({ ok: false, error: 'Missing oldText/newText' }));
                    return;
                }
                const outcome = applyHtmlEdits(target.absolute, [{ n: 1, oldText: parsed.oldText, newText: parsed.newText }]);
                const ok = outcome.applied.length === 1;
                res.writeHead(ok ? 200 : 409, headers);
                res.end(JSON.stringify({
                    ok,
                    error: ok ? undefined : (outcome.failed[0]?.reason || 'Save failed')
                }));
            });
            return;
        }

        // Full-file save of a deck from the Slide Sorter (reorder / hide-show).
        // Body: { url, content }. Resolves the deck via the same gate as Edit
        // mode and overwrites the file (one-per-session .bak written first).
        if (url === '/__save-deck' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            req.on('end', () => {
                const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
                let parsed: any;
                try { parsed = JSON.parse(body); } catch {
                    res.writeHead(400, headers);
                    res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
                    return;
                }
                const target = urlToWorkspacePath(String(parsed.url || ''));
                if (!target) {
                    res.writeHead(400, headers);
                    res.end(JSON.stringify({ ok: false, error: 'Deck not an AIMax-served .html under this workspace' }));
                    return;
                }
                if (typeof parsed.content !== 'string' || !parsed.content) {
                    res.writeHead(400, headers);
                    res.end(JSON.stringify({ ok: false, error: 'Missing content' }));
                    return;
                }
                const outcome = writeDeckFile(target.absolute, parsed.content);
                res.writeHead(outcome.ok ? 200 : 500, headers);
                res.end(JSON.stringify(outcome));
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

        // Parse query string to detect raw mode (skip injection, return source)
        const qIdx = url.indexOf('?');
        const pathPart = qIdx >= 0 ? url.slice(0, qIdx) : url;
        const queryPart = qIdx >= 0 ? url.slice(qIdx + 1) : '';
        const isRaw = /(^|&)aimax-raw=1(&|$)/.test(queryPart);

        const filePath = path.join(workspaceFolder, decodeURIComponent(pathPart));

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

        // Handle Markdown files: convert to HTML (or return raw .md when ?aimax-raw=1)
        if (ext === '.md' || ext === '.markdown') {
            try {
                const rawContent = fs.readFileSync(filePath, 'utf-8');
                if (isRaw) {
                    res.writeHead(200, {
                        'Content-Type': 'text/plain; charset=utf-8',
                        'Access-Control-Allow-Origin': '*'
                    });
                    res.end(rawContent);
                    return;
                }
                const { content, metadata } = extractFrontmatter(rawContent);
                const title = (metadata?.title as string) || path.basename(filePath, ext).replace(/_/g, ' ');
                const html = injectLinkHandler(injectAnnotationClient(wrapMarkdownHtml(parseMarkdown(content), title, metadata)));
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-store, no-cache, must-revalidate'
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
            const headers: { [k: string]: string } = {
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            };
            if ((ext === '.html' || ext === '.htm') && !isRaw) {
                // The injected annotation/edit client lives inside the served
                // HTML. The webview iframe (Chromium) caches responses hard, so
                // after an extension update the iframe would keep replaying the
                // OLD client (Browser panel "behaves like before"). Force a
                // refetch every load so injected logic is always current.
                headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
                const injected = injectLinkHandler(injectAnnotationClient(data.toString('utf-8')));
                res.writeHead(200, headers);
                res.end(injected);
            } else {
                res.writeHead(200, headers);
                res.end(data);
            }
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

// Inverse of getHttpUrl: convert a local AIMax HTTP URL back to a workspace path.
// Returns null when the URL is not served by our local server (cross-origin / external).
function httpUrlToWorkspacePath(url: string): string | null {
    if (!url) return null;
    try {
        const u = new URL(url);
        const isLocal = (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port === String(serverPort);
        if (!isLocal) return null;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) return null;
        const relPath = decodeURIComponent(u.pathname.replace(/^\//, ''));
        return path.join(workspaceFolder, relPath);
    } catch {
        return null;
    }
}

// Open Claude Code with the aimax-make-presentable skill targeting the given URL/path.
// Embeds a fallback that fetches the skill body from GitHub if the slash command isn't installed.
function openMakePresentableInClaude(url: string): void {
    const filePath = httpUrlToWorkspacePath(url);
    const arg = filePath || url;
    const skillRawUrl = 'https://raw.githubusercontent.com/maxturazzini/aimax-viewer/main/skills/aimax-make-presentable/SKILL.md';
    const skillPrompt = [
        `/aimax-make-presentable ${arg}`,
        '',
        `If the slash command above is not recognized (skill not installed locally), do this instead:`,
        `1. Fetch the skill body from ${skillRawUrl} (use WebFetch).`,
        `2. Tell the user: "The aimax-make-presentable skill isn't installed locally. I'll run it from GitHub this time. To install it locally for next time: copy plugins/aimax-make-presentable/ from the aimax-viewer repo into your Claude Code skills directory."`,
        `3. Apply the fetched skill instructions to the file: ${arg}`
    ].join('\n');
    const claudeUri = vscode.Uri.parse(
        `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(skillPrompt)}`
    );
    vscode.env.openExternal(claudeUri);
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
            if (message.command === 'copyToClipboard') {
                vscode.env.clipboard.writeText(message.text || '');
            } else if (message.command === 'openUrl') {
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
                // Relative links from the home page resolve against the WORKSPACE
                // ROOT. They used to be looked up under a hardcoded 'projects/'
                // folder — a leftover from an older layout — so a link to a file
                // next to the index simply did nothing, with no error anywhere.
                const rel = String(message.path || '').replace(/^\/+/, '');
                const filePath = path.resolve(workspaceFolder, rel);
                // The path comes from page content: keep it inside the workspace.
                if (filePath.startsWith(workspaceFolder) && fs.existsSync(filePath)) {
                    const httpUrl = getHttpUrl(filePath, workspaceFolder);
                    openInBrowser(httpUrl);
                } else {
                    vscode.window.showWarningMessage('AIMax: link not found in this workspace — ' + rel);
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
            } else if (message.command === 'presentFile' && message.url) {
                const presenterUrl = `http://127.0.0.1:${serverPort}/__presenter#${message.url}`;
                vscode.env.openExternal(vscode.Uri.parse(presenterUrl));
            } else if (message.command === 'openExternal' && message.url) {
                vscode.env.openExternal(vscode.Uri.parse(message.url));
            } else if (message.command === 'claudeBridge') {
                handleClaudeBridge(message.mode, (message.prompt || '').trim(), (result) => {
                    if (homePanel) {
                        homePanel.webview.postMessage({ command: 'bridgeResult', ...result });
                    }
                }, { allowEdits: !!message.allowEdits });
            } else if (message.command === 'saveEdit') {
                handleSaveEdit(message, homePanel);
            }
        });
    }

    const faviconUri = getFaviconDataUri();

    homePanel.webview.html = wrapWithToolbarAndLinkHandler(htmlContent, 'Artifacts Home', faviconUri, indexPath);
}

// Wrap HTML with toolbar and inject link handler
function wrapWithToolbarAndLinkHandler(html: string, title: string, faviconUri: string, filePath: string = ''): string {
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
            /* Home Panel shares one document with the artifact AND with the
               injected client, so the chrome claims the top of the stacking
               band (the client keeps 2147483646 and below). */
            z-index: 2147483647;
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
        .aimax-toolbar-btn.active {
            color: #00d4ff;
            border-color: #00d4ff;
            background: rgba(0, 212, 255, 0.12);
        }
        .aimax-toolbar-btn.active-edit {
            color: #ff9500;
            border-color: #ff9500;
            background: rgba(255, 149, 0, 0.14);
        }
        .aimax-toolbar-btn.active-draw {
            color: #ff2d92;
            border-color: #ff2d92;
            background: rgba(255, 45, 146, 0.14);
        }
        .aimax-annot-draw-mark {
            color: #ff2d92;
            font-size: 11px;
            flex-shrink: 0;
        }
        .aimax-toolbar-btn:disabled {
            opacity: 0.35;
            cursor: not-allowed;
        }
        .aimax-annot-window.edit-mode { border-color: #ff9500; }
        .aimax-annot-window.edit-mode .aimax-annot-header strong { color: #ff9500; }
        .aimax-annot-window.edit-mode .aimax-comment-only { display: none !important; }
        .aimax-icon-btn.aimax-save-btn { color: #34c759; border-color: #34c759; padding: 3px 10px; }
        .aimax-icon-btn.aimax-save-btn:not(:disabled):hover { background: rgba(52, 199, 89, 0.15); }
        .aimax-icon-btn.aimax-save-btn .save-text { font-size: 11px; font-weight: 600; letter-spacing: 0.3px; }
        .aimax-icon-btn.notes-active { background: rgba(181, 137, 0, 0.20); border-color: #b58900; color: #ffcc44; }
        .aimax-icon-btn.layout-active { background: rgba(255, 149, 0, 0.22); border-color: #ff9500; color: #ffb347; }
        /* Move/Resize tool row, rendered in the panel body: present only while
           the sub-mode is on, so text-edit mode keeps its plain hint. */
        .aimax-lay-tools { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
        .aimax-lay-tools button {
            min-width: 30px;
            justify-content: center;
            font-size: 13px;
            line-height: 1;
            background: #1a1a2e;
            border: 1px solid rgba(255, 149, 0, 0.45);
            color: #ffb347;
            border-radius: 4px;
            padding: 4px 10px;
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }
        .aimax-lay-tools button:hover:not(:disabled) { background: #2a2a3e; border-color: #ff9500; }
        .aimax-lay-tools button:disabled { opacity: 0.35; cursor: not-allowed; }
        .aimax-lay-tools .lay-key { opacity: 0.55; font-weight: 400; font-size: 10px; }
        .aimax-lay-tools .lay-group { align-self: center; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.5; margin-right: 2px; }
        /* Sub-mode toggles: one group per top-level mode, only the active
           group is mounted, and exactly one button in it reads as selected. */
        .submode-group { display: inline-flex; gap: 3px; padding: 2px; background: rgba(0,0,0,0.25); border-radius: 6px; }
        .aimax-icon-btn.submode.on { background: rgba(0, 212, 255, 0.20); border-color: #00d4ff; color: #6fe3ff; }
        .annot-window.edit-mode .aimax-icon-btn.submode.on { background: rgba(255, 149, 0, 0.22); border-color: #ff9500; color: #ffb347; }
        /* Action row: what you DO with what you collected, kept out of the header. */
        .annot-actions { padding: 8px 10px 0; }
        .annot-actions:empty { display: none; }
        .annot-act-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
        .aimax-content-wrapper {
            padding-top: 44px;
        }
        .aimax-annot-window {
            display: none;
            position: fixed;
            top: 56px;
            right: 12px;
            width: 380px;
            max-height: 70vh;
            background: #1e1e1e;
            border: 1px solid #00d4ff;
            border-radius: 8px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
            /* Same reason as .aimax-toolbar: single document, chrome on top. */
            z-index: 2147483647;
            flex-direction: column;
            overflow: hidden;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        .aimax-annot-window.open { display: flex; }
        .aimax-annot-header {
            background: linear-gradient(90deg, #16213e 0%, #1a1a2e 100%);
            padding: 8px 12px;
            color: #cccccc;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
            border-bottom: 1px solid #3c3c3c;
        }
        .aimax-annot-header strong { color: #00d4ff; flex: 1; }
        .aimax-annot-header button {
            background: transparent;
            border: 1px solid #3c3c3c;
            color: #cccccc;
            font-size: 11px;
            cursor: pointer;
            padding: 3px 8px;
            border-radius: 4px;
        }
        .aimax-annot-header button:hover { color: #00d4ff; border-color: #00d4ff; }
        .aimax-annot-body {
            flex: 1;
            overflow: auto;
            padding: 6px 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 12px;
            color: #cccccc;
            background: #14141a;
        }
        .aimax-annot-row {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            border-bottom: 1px solid #232330;
            cursor: default;
        }
        .aimax-annot-row:hover { background: #1f1f2c; }
        .aimax-annot-num {
            background: #00d4ff;
            color: #001018;
            font-weight: bold;
            font-size: 10px;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }
        .aimax-annot-text {
            flex: 1;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .aimax-annot-tag {
            color: #888;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 10px;
            flex-shrink: 0;
        }
        .aimax-annot-x {
            color: #888;
            cursor: pointer;
            padding: 0 4px;
            flex-shrink: 0;
            font-size: 14px;
            line-height: 1;
        }
        .aimax-annot-x:hover { color: #ff5757; }
        .aimax-annot-empty {
            color: #666;
            font-style: italic;
            padding: 12px;
            text-align: center;
        }
        .aimax-annot-response {
            display: none;
            margin: 6px 8px 8px 8px;
            padding: 8px;
            background: #181825;
            border: 1px solid #3c3c3c;
            border-radius: 6px;
            color: #cdd6f4;
            font-size: 11px;
            max-height: 240px;
            overflow-y: auto;
            white-space: pre-wrap;
            word-break: break-word;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        /* Shared icon button (coherent with browser panel annotations + bridge) */
        .aimax-icon-btn {
            background: transparent;
            border: 1px solid #3c3c3c;
            color: #00d4ff;
            cursor: pointer;
            padding: 3px 6px;
            border-radius: 4px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 3px;
            min-width: 26px;
            height: 24px;
            line-height: 1;
            font-size: 11px;
        }
        .aimax-icon-btn:hover { background: #2a2a3e; border-color: #00d4ff; }
        .aimax-icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .aimax-icon-btn .label { font-size: 10px; font-weight: 600; }
        .aimax-icon-btn svg { display: block; }
    </style>
    `;

    const toolbar = `
    <div class="aimax-toolbar" data-aimax-overlay="1">
        <img src="${faviconUri}" class="aimax-brand-icon" onclick="goHome()" alt="AI, MAX" title="Home" />
        <button class="aimax-nav-btn" id="backBtn" onclick="goBack()" title="Back" disabled>←</button>
        <button class="aimax-nav-btn" id="fwdBtn" onclick="goForward()" title="Forward" disabled>→</button>
        <button class="aimax-info-btn" onclick="reload()" title="Reload" style="display:inline-flex;align-items:center;justify-content:center;color:#00d4ff;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.51-7.13"/><polyline points="21 4 21 10 15 10"/></svg>
        </button>
        <span class="aimax-title">${title}</span>
        <button class="aimax-toolbar-btn" onclick="openArtifactsBrowser()" title="Open Artifacts Browser">
            <span style="font-size: 12px;">[:]</span>
        </button>
        <button class="aimax-toolbar-btn" id="aimaxAnnotBtn" onclick="aimaxToggleAnnot()" title="Toggle annotation mode">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00d4ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button class="aimax-toolbar-btn" id="aimaxEditBtn" onclick="aimaxToggleEdit()" title="Edit text in place (HTML only)" disabled>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff9500" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
        <button class="aimax-toolbar-btn" onclick="openTerminal()" title="Open new terminal">
            <span style="font-family: monospace; font-weight: bold;">&gt;_</span>
        </button>
        <button class="aimax-toolbar-btn" onclick="openClaudeCode()" title="New Claude Code conversation">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="#d97757" aria-hidden="true"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>
        </button>
    </div>
    <div class="aimax-annot-window" id="aimaxAnnotWindow" data-aimax-overlay="1">
        <div class="aimax-annot-header">
            <strong id="aimaxAnnotCount">Annotations (0)</strong>
            <span class="submode-group aimax-comment-only" id="aimaxAnnotSubmodes">
                <button class="aimax-icon-btn submode" id="aimaxPointBtn" onclick="aimaxSetAnnotSubmode('point')" title="Point mode — click an element to comment on it">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7 17 2-7 7-2z"/></svg>
                </button>
                <button class="aimax-icon-btn submode" id="aimaxDrawSubBtn" onclick="aimaxSetAnnotSubmode('draw')" title="Draw mode — freehand pencil to mark changes">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3-1 5-3 7-7"/><path d="M14.5 5.5l4 4"/><path d="M12 19l7-7a2.5 2.5 0 0 0-3.5-3.5l-7 7L7 19z"/></svg>
                </button>
            </span>
            <span class="submode-group aimax-edit-only" id="aimaxEditSubmodes" style="display:none">
                <button class="aimax-icon-btn submode" id="aimaxTextBtn" onclick="aimaxSetEditSubmode('text')" title="Text mode — click any text and type over it">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5h16v2M9 19h6M12 5v14"/></svg>
                </button>
                <button class="aimax-icon-btn submode" id="aimaxLayoutBtn" onclick="aimaxSetEditSubmode('move')" title="Move/Resize mode — drag frames, drag handles to resize, arrows to nudge">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M2 12h20M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3"/></svg>
                </button>
                <button class="aimax-icon-btn submode" id="aimaxNotesBtn" onclick="aimaxSetEditSubmode('notes')" title="Notes mode — reveal and edit hidden .speaker-notes blocks">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h6M8 17h4"/></svg>
                </button>
            </span>
            <button class="aimax-icon-btn aimax-save-btn" id="aimaxSaveBtn" onclick="aimaxTriggerSave()" style="display:none" disabled title="Save pending edits to disk">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                <span class="save-text">Save</span>
                <span class="label" id="aimaxSaveCountLbl">0</span>
            </button>
            <button class="aimax-icon-btn" onclick="aimaxCloseAnnotPanel()" title="Close">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>
            </button>
        </div>
        <div class="annot-actions" id="aimaxAnnotActions">
            <div class="annot-act-row aimax-comment-only">
                <button class="aimax-icon-btn" onclick="aimaxCopyAnnotPrompt()" title="Copy prompt">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    <span class="label">Copy</span>
                </button>
                <button class="aimax-icon-btn" onclick="aimaxAnnotSend('terminal')" title="Copy &amp; send to Terminal">
                    <span class="label">&gt;_</span>
                </button>
                <button class="aimax-icon-btn" onclick="aimaxAnnotSend('vscode')" title="Copy &amp; send to Claude Code">
                    <span class="label">&lt;/&gt;</span>
                </button>
                <button class="aimax-icon-btn" id="aimaxAnnotRunBtn" onclick="aimaxAnnotRun()" title="Run inline (Ask Claude)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1.5 L13.6 9.2 L21.3 7.6 L15.7 12 L21.3 16.4 L13.6 14.8 L12 22.5 L10.4 14.8 L2.7 16.4 L8.3 12 L2.7 7.6 L10.4 9.2 Z"/></svg>
                </button>
                <button class="aimax-icon-btn" onclick="aimaxAnnotRefresh()" title="Refresh page">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.51-7.13"/><polyline points="21 4 21 10 15 10"/></svg>
                </button>
                <button class="aimax-icon-btn" onclick="aimaxClearAnnot()" title="Clear all">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
                </button>
            </div>
            <div id="aimaxLayoutTools"></div>
        </div>
        <div class="aimax-annot-body" id="aimaxAnnotBody"><div class="aimax-annot-empty">Hover an element and click to add a comment.</div></div>
        <div class="aimax-annot-response" id="aimaxAnnotResponse"></div>
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

        // Annotation mode (Home Panel: same-document, no iframe)
        let aimaxAnnotActive = false;
        let aimaxEditActive = false;
        let aimaxDrawActive = false;
        let aimaxNotesActive = false;
        let aimaxLayoutActive = false;
        // Undo/redo state mirrored from the injected client (same document here).
        let aimaxLayoutState = { canUndo: false, canRedo: false, hasSelection: false, hasChanges: false };
        // Quante .speaker-notes riporta la pagina; null = non ancora chiesto.
        let aimaxNotesCount = null;
        let aimaxAnnotations = [];
        let aimaxPendingEdits = [];
        let aimaxPendingLayout = []; // [{n, selector, css}] — one entry per moved frame
        const aimaxAnnotWindow = document.getElementById('aimaxAnnotWindow');
        const aimaxAnnotBody = document.getElementById('aimaxAnnotBody');
        const aimaxAnnotCount = document.getElementById('aimaxAnnotCount');
        const aimaxAnnotBtn = document.getElementById('aimaxAnnotBtn');
        const aimaxEditBtn = document.getElementById('aimaxEditBtn');
        const aimaxNotesBtn = document.getElementById('aimaxNotesBtn');
        const aimaxLayoutBtn = document.getElementById('aimaxLayoutBtn');
        const aimaxSaveBtn = document.getElementById('aimaxSaveBtn');
        const aimaxSaveCountLbl = document.getElementById('aimaxSaveCountLbl');

        function aimaxPostToggle() {
            const on = aimaxAnnotActive || aimaxEditActive || aimaxDrawActive;
            const mode = aimaxEditActive ? 'edit' : (aimaxDrawActive ? 'draw' : 'comment');
            window.postMessage({ type: 'annot:toggle', on: on, mode: mode, notes: aimaxNotesActive, layout: aimaxLayoutActive }, '*');
        }

        function aimaxSyncToggleUI() {
            aimaxAnnotBtn.classList.toggle('active', aimaxAnnotActive || aimaxDrawActive);
            aimaxEditBtn.classList.toggle('active-edit', aimaxEditActive);
            const open = aimaxAnnotActive || aimaxEditActive || aimaxDrawActive;
            aimaxAnnotWindow.classList.toggle('open', open);
            aimaxAnnotWindow.classList.toggle('edit-mode', aimaxEditActive);
            document.querySelectorAll('.aimax-edit-only').forEach(el => {
                el.style.display = aimaxEditActive ? 'inline-flex' : 'none';
            });
            const pb = document.getElementById('aimaxPointBtn');
            const db = document.getElementById('aimaxDrawSubBtn');
            const tb = document.getElementById('aimaxTextBtn');
            if (pb) pb.classList.toggle('on', aimaxAnnotActive && !aimaxDrawActive);
            if (db) db.classList.toggle('on', aimaxDrawActive);
            if (tb) tb.classList.toggle('on', aimaxEditActive && !aimaxLayoutActive && !aimaxNotesActive);
            aimaxNotesBtn.classList.toggle('on', aimaxNotesActive);
            if (aimaxLayoutBtn) aimaxLayoutBtn.classList.toggle('on', aimaxLayoutActive);
            aimaxRenderLayoutTools();
            aimaxUpdateSaveUI();
            if ((aimaxAnnotActive || aimaxDrawActive) && !aimaxEditActive) {
                aimaxAnnotCount.textContent = 'Annotations (' + aimaxAnnotations.length + ')';
            } else if (aimaxEditActive) {
                aimaxAnnotCount.textContent = aimaxLayoutActive
                    ? 'Edit · Move/Resize'
                    : (aimaxNotesActive ? 'Edit · Notes' : 'Edit');
            }
            if (aimaxAnnotations.length === 0) {
                aimaxRenderAnnot();
            }
        }

        function aimaxUpdateSaveUI() {
            const n = aimaxPendingEdits.length + aimaxPendingLayout.length;
            aimaxSaveCountLbl.textContent = String(n);
            aimaxSaveBtn.disabled = (n === 0);
            aimaxSaveBtn.style.display = aimaxEditActive ? 'inline-flex' : 'none';
        }

        // Annotate is the top-level mode; Point/Draw are its sub-modes.
        function aimaxToggleAnnot(forceState) {
            const wasOn = aimaxAnnotActive || aimaxDrawActive;
            const next = (typeof forceState === 'boolean') ? forceState : !wasOn;
            if (next) {
                if (aimaxEditActive) { aimaxEditActive = false; aimaxNotesActive = false; aimaxLayoutActive = false; }
                if (!aimaxDrawActive) aimaxAnnotActive = true;
            } else {
                aimaxAnnotActive = false;
                aimaxDrawActive = false;
            }
            aimaxSyncToggleUI();
            aimaxPostToggle();
        }

        function aimaxToggleEdit(forceState) {
            if (aimaxEditBtn.disabled) return;
            const next = (typeof forceState === 'boolean') ? forceState : !aimaxEditActive;
            aimaxEditActive = next;
            if (aimaxEditActive) {
                aimaxAnnotActive = false;
                aimaxDrawActive = false;
            }
            // Entering or leaving Edit always lands on Text.
            aimaxNotesActive = false;
            aimaxLayoutActive = false;
            aimaxNotesCount = null;
            aimaxSyncToggleUI();
            aimaxPostToggle();
        }

        function aimaxToggleDraw(forceState) {
            const next = (typeof forceState === 'boolean') ? forceState : !aimaxDrawActive;
            aimaxSetAnnotSubmode(next ? 'draw' : 'point');
        }

        function aimaxSetAnnotSubmode(which) {
            aimaxDrawActive = (which === 'draw');
            aimaxAnnotActive = !aimaxDrawActive;
            aimaxEditActive = false;
            aimaxSyncToggleUI();
            aimaxPostToggle();
        }

        function aimaxSetEditSubmode(which) {
            if (!aimaxEditActive) return;
            aimaxLayoutActive = (which === 'move');
            aimaxNotesActive = (which === 'notes');
            if (!aimaxLayoutActive) aimaxLayoutState = { canUndo: false, canRedo: false, hasSelection: false, hasChanges: false };
            if (!aimaxNotesActive) aimaxNotesCount = null;
            aimaxSyncToggleUI();
            aimaxPostToggle();
        }

        function aimaxRenderLayoutTools() {
            const host = document.getElementById('aimaxLayoutTools');
            if (!host) return;
            host.innerHTML = (aimaxEditActive && aimaxLayoutActive) ? aimaxLayoutToolsHtml() : '';
        }

        function aimaxLayoutToolsHtml() {
            const u = aimaxLayoutState.canUndo ? '' : ' disabled';
            const r = aimaxLayoutState.canRedo ? '' : ' disabled';
            const s = aimaxLayoutState.hasSelection ? '' : ' disabled';
            const c = aimaxLayoutState.hasChanges ? '' : ' disabled';
            return '<div class="aimax-lay-tools">' +
                '<button onclick="aimaxLayoutUndo()"' + u + ' title="Undo the last move/resize  (⌘Z)">↶</button>' +
                '<button onclick="aimaxLayoutRedo()"' + r + ' title="Redo the last undone gesture  (⇧⌘Z)">↷</button>' +
                '<button onclick="aimaxLayoutDelete()"' + s + ' title="Hide the selected frame (display:none). The markup stays in the file — ⌘Z or Back to original brings it back"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button>' +
                '<button onclick="aimaxLayoutReset()"' + c + ' title="Back to original — drop every move/resize/reorder on the selected frame, including overrides already written to the file (removed on the next Save)">⤺</button>' +
                '</div>' +
                '<div class="aimax-lay-tools">' +
                '<span class="lay-group">Order</span>' +
                '<button onclick="aimaxLayoutZ(\\'back\\')"' + s + ' title="Send to back — behind every sibling. Only visible where frames overlap">⤓</button>' +
                '<button onclick="aimaxLayoutZ(\\'backward\\')"' + s + ' title="Send backward one step">↓</button>' +
                '<button onclick="aimaxLayoutZ(\\'forward\\')"' + s + ' title="Bring forward one step">↑</button>' +
                '<button onclick="aimaxLayoutZ(\\'front\\')"' + s + ' title="Bring to front — above every sibling">⤒</button>' +
                '</div>';
        }

        function aimaxLayoutUndo() { window.postMessage({ type: 'edit:layout-undo' }, '*'); }
        function aimaxLayoutRedo() { window.postMessage({ type: 'edit:layout-redo' }, '*'); }
        function aimaxLayoutReset() { window.postMessage({ type: 'edit:layout-reset' }, '*'); }
        function aimaxLayoutZ(dir) { window.postMessage({ type: 'edit:layout-z', dir: dir }, '*'); }
        function aimaxLayoutDelete() { window.postMessage({ type: 'edit:layout-delete' }, '*'); }

        function aimaxCloseAnnotPanel() {
            aimaxAnnotActive = false;
            aimaxEditActive = false;
            aimaxDrawActive = false;
            aimaxNotesActive = false;
            aimaxLayoutActive = false;
            aimaxSyncToggleUI();
            aimaxPostToggle();
        }

        function aimaxTriggerSave() {
            if (aimaxPendingEdits.length === 0 && aimaxPendingLayout.length === 0) return;
            aimaxSaveBtn.disabled = true;
            vscode.postMessage({
                command: 'saveEdit',
                filePath: aimaxKnownFilePath,
                edits: aimaxPendingEdits.map(e => ({
                    n: e.n,
                    oldText: e.oldText,
                    newText: e.newText,
                    selector: e.selector,
                    occurrenceIndex: e.occurrenceIndex,
                    outerHTML: e.outerHTML
                })),
                layout: aimaxPendingLayout.map(l => ({
                    n: l.n,
                    selector: l.selector,
                    css: l.css
                }))
            });
        }

        function aimaxApplySaveResult(payload) {
            const applied = payload.applied || [];
            const failed = payload.failed || [];
            applied.forEach(n => {
                window.postMessage({ type: 'edit:result', n: n, ok: true }, '*');
            });
            failed.forEach(f => {
                window.postMessage({ type: 'edit:result', n: f.n, ok: false, toast: f.reason }, '*');
            });
            aimaxPendingEdits = aimaxPendingEdits.filter(e => !applied.includes(e.n));
            aimaxPendingLayout = aimaxPendingLayout.filter(l => !applied.includes(l.n));
            aimaxUpdateSaveUI();
            const txt = (failed.length === 0)
                ? ('✓ ' + applied.length + ' saved')
                : (applied.length + ' saved · ' + failed.length + ' failed');
            aimaxAnnotCount.textContent = txt;
            setTimeout(() => { aimaxSyncToggleUI(); }, 1800);
        }

        function aimaxRefreshEditAvailability() {
            const eligible = !!aimaxKnownFilePath
                && aimaxKnownFilePath.toLowerCase().endsWith('.html');
            aimaxEditBtn.disabled = !eligible;
            aimaxEditBtn.title = eligible
                ? 'Edit text in place (writes to source HTML on disk)'
                : 'Edit available only on .html files served by AIMax';
        }

        function aimaxEsc(s) {
            return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        }

        function aimaxRegionLine(a) {
            if (a.kind !== 'draw' || !a.bbox) return '';
            const pct = (v) => Math.round((v || 0) * 100) + '%';
            const vp = a.viewport ? (' (viewport ' + a.viewport.w + 'x' + a.viewport.h + ')') : '';
            return 'Region: freehand stroke bbox x=' + pct(a.bbox.x) + ' y=' + pct(a.bbox.y) +
                ' w=' + pct(a.bbox.w) + ' h=' + pct(a.bbox.h) + vp;
        }

        function aimaxEntryDetails(a) {
            const info = a.info || {};
            const dim = (info.width || 0) + 'x' + (info.height || 0);
            const meta = '<' + info.tag + '>' + (info.text ? ' "' + info.text + '"' : '') +
                ' (' + dim + (info.color ? ', color ' + info.color : '') +
                (info.font ? ', font ' + info.font : '') + ')';
            const region = aimaxRegionLine(a);
            return (a.kind === 'draw' ? 'Gesture: freehand drawing\\n' : '') +
                'Selector: ' + a.selector + '\\nElement: ' + meta +
                (region ? '\\n' + region : '') + '\\nRequest: ' + a.comment;
        }

        function aimaxBuildPrompt() {
            if (aimaxAnnotations.length === 0) return '';
            const href = aimaxAnnotations[0].href || location.href;
            const lines = [
                'Modify the file ' + href + '.',
                'Apply each <request> below to its element (use Selector first, fall back to the Element description). Do not change anything else.',
                ''
            ];
            aimaxAnnotations.forEach((a, i) => {
                const info = a.info || {};
                const dim = (info.width || 0) + 'x' + (info.height || 0);
                const meta = '<' + info.tag + '>' + (info.text ? ' "' + info.text + '"' : '') +
                    ' (' + dim + (info.color ? ', color ' + info.color : '') +
                    (info.font ? ', font ' + info.font : '') + ')';
                lines.push('<annotation n="' + (i + 1) + '">');
                if (a.kind === 'draw') lines.push('Gesture: freehand drawing (the user drew over this element to mark it)');
                lines.push('Selector: ' + a.selector);
                lines.push('Element: ' + meta);
                const region = aimaxRegionLine(a);
                if (region) lines.push(region);
                lines.push('<request>' + a.comment + '</request>');
                lines.push('</annotation>');
                lines.push('');
            });
            return lines.join('\\n');
        }

        function aimaxRenderAnnot() {
            if (!aimaxEditActive) {
                aimaxAnnotCount.textContent = 'Annotations (' + aimaxAnnotations.length + ')';
            }
            // Edit owns the body: its hint must show even if comments were
            // collected earlier in the session. The tools live in the action row.
            if (aimaxEditActive) {
                let msg;
                if (aimaxLayoutActive) {
                    msg = 'Drag a frame to move it, drag a handle to resize, ↑↓←→ to nudge (⇧ = 10px). Esc deselects.';
                } else if (aimaxNotesActive) {
                    msg = (aimaxNotesCount === 0)
                        ? 'This artifact has no speaker notes — nothing to reveal here. Switch back to Text to edit the visible content.'
                        : 'Hover a speaker note (yellow block) and click to edit. ⌘↵ to save the edit.';
                } else {
                    msg = 'Hover an element and click to edit its text. ↵ to save the edit.';
                }
                aimaxAnnotBody.innerHTML = '<div class="aimax-annot-empty">' + msg + '</div>';
                return;
            }
            if (aimaxAnnotations.length === 0) {
                const msg = aimaxEditActive
                    ? 'Hover an element and click to edit its text. ↵ to save the edit.'
                    : (aimaxDrawActive
                        ? 'Draw freehand over the element to change, then type a note. ↵ to save.'
                        : 'Hover an element and click to add a comment.');
                aimaxAnnotBody.innerHTML = '<div class="aimax-annot-empty">' + msg + '</div>';
                return;
            }
            const rows = aimaxAnnotations.map((a, i) => {
                const tag = (a.info && a.info.tag) ? a.info.tag : 'el';
                const details = aimaxEntryDetails(a);
                const drawMark = (a.kind === 'draw')
                    ? '<span class="aimax-annot-draw-mark" title="Freehand drawing">✏</span>'
                    : '';
                return '<div class="aimax-annot-row" title="' + aimaxEsc(details) + '">' +
                    '<span class="aimax-annot-num">' + (i + 1) + '</span>' +
                    drawMark +
                    '<span class="aimax-annot-text">' + aimaxEsc(a.comment) + '</span>' +
                    '<span class="aimax-annot-tag">&lt;' + aimaxEsc(tag) + '&gt;</span>' +
                    '<span class="aimax-annot-x" data-n="' + a.n + '" title="Remove">×</span>' +
                    '</div>';
            }).join('');
            aimaxAnnotBody.innerHTML = rows;
            aimaxAnnotBody.querySelectorAll('.aimax-annot-x').forEach(x => {
                x.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const n = parseInt(x.getAttribute('data-n'), 10);
                    aimaxRemoveAnnot(n);
                    window.postMessage({ type: 'annot:remove', n }, '*');
                });
            });
        }

        function aimaxCopyAnnotPrompt() {
            const text = aimaxBuildPrompt();
            if (!text) return;
            vscode.postMessage({ command: 'copyToClipboard', text: text });
            const orig = aimaxAnnotCount.textContent;
            aimaxAnnotCount.textContent = '✓ Copied to clipboard';
            setTimeout(() => { aimaxAnnotCount.textContent = orig; }, 1200);
        }

        function aimaxClearAnnot() {
            aimaxAnnotations = [];
            aimaxRenderAnnot();
            window.postMessage({ type: 'annot:reset' }, '*');
        }

        function aimaxRemoveAnnot(n) {
            aimaxAnnotations = aimaxAnnotations.filter(a => a.n !== n);
            aimaxRenderAnnot();
        }

        function aimaxAnnotSend(mode) {
            const text = aimaxBuildPrompt();
            if (!text) return;
            vscode.postMessage({ command: 'claudeBridge', mode: mode, prompt: text });
            const orig = aimaxAnnotCount.textContent;
            aimaxAnnotCount.textContent = mode === 'terminal' ? '→ Terminal' : '→ VS Code';
            setTimeout(() => { aimaxAnnotCount.textContent = orig; }, 1500);
        }

        let aimaxAnnotRunPending = false;

        function aimaxAnnotRun() {
            if (aimaxAnnotRunPending) return;
            const text = aimaxBuildPrompt();
            if (!text) return;
            aimaxAnnotRunPending = true;
            const runBtn = document.getElementById('aimaxAnnotRunBtn');
            if (runBtn) runBtn.disabled = true;
            const respBox = document.getElementById('aimaxAnnotResponse');
            if (respBox) { respBox.style.display = 'none'; respBox.textContent = ''; }
            aimaxAnnotCount.dataset.origText = aimaxAnnotCount.textContent;
            aimaxAnnotCount.textContent = 'Running agent (up to 5 min)…';
            // Annotations always run in edit mode — their purpose is to apply changes.
            vscode.postMessage({ command: 'claudeBridge', mode: 'print', prompt: text, allowEdits: true });
        }

        function aimaxAnnotRefresh() {
            reload();
        }

        function aimaxOnBridgeResult(result) {
            if (!aimaxAnnotRunPending || result.mode !== 'print') return;
            aimaxAnnotRunPending = false;
            const runBtn = document.getElementById('aimaxAnnotRunBtn');
            const respBox = document.getElementById('aimaxAnnotResponse');
            if (runBtn) runBtn.disabled = false;
            const orig = aimaxAnnotCount.dataset.origText || ('Annotations (' + aimaxAnnotations.length + ')');
            if (result.ok && result.response) {
                if (respBox) { respBox.textContent = result.response; respBox.style.display = 'block'; }
                aimaxAnnotCount.textContent = '✓ Done';
            } else {
                aimaxAnnotCount.textContent = result.ok ? '✓ Sent' : 'Error';
                if (!result.ok && respBox) {
                    respBox.textContent = 'Error: ' + (result.error || 'Unknown');
                    respBox.style.display = 'block';
                }
            }
            setTimeout(() => { aimaxAnnotCount.textContent = orig; }, 1800);
        }

        const aimaxKnownFilePath = ${JSON.stringify(filePath)};

        window.addEventListener('message', (event) => {
            if (event.data?.type === 'annot:add') {
                const data = aimaxKnownFilePath ? { ...event.data, href: aimaxKnownFilePath } : event.data;
                aimaxAnnotations.push(data);
                aimaxRenderAnnot();
            } else if (event.data?.type === 'annot:remove' && typeof event.data.n === 'number') {
                aimaxRemoveAnnot(event.data.n);
            } else if (event.data?.type === 'edit:save') {
                aimaxPendingEdits.push({
                    n: event.data.n,
                    oldText: event.data.oldText,
                    newText: event.data.newText,
                    selector: event.data.selector,
                    occurrenceIndex: event.data.occurrenceIndex,
                    outerHTML: event.data.outerHTML,
                    href: aimaxKnownFilePath,
                    notes: !!event.data.notes
                });
                aimaxUpdateSaveUI();
            } else if (event.data?.type === 'edit:notes-state') {
                aimaxNotesCount = event.data.count | 0;
                if (aimaxEditActive && aimaxNotesActive) aimaxRenderAnnot();
            } else if (event.data?.type === 'edit:layout-state') {
                aimaxLayoutState = {
                    canUndo: !!event.data.canUndo,
                    canRedo: !!event.data.canRedo,
                    hasSelection: !!event.data.hasSelection,
                    hasChanges: !!event.data.hasChanges
                };
                if (aimaxLayoutActive) aimaxRenderLayoutTools();
            } else if (event.data?.type === 'edit:layout') {
                // Re-dragging the same frame replaces its pending geometry.
                const li = aimaxPendingLayout.findIndex(l => l.selector === event.data.selector);
                const lentry = {
                    n: event.data.n,
                    selector: event.data.selector,
                    css: event.data.css,
                    href: aimaxKnownFilePath
                };
                if (li >= 0) { aimaxPendingLayout[li] = lentry; } else { aimaxPendingLayout.push(lentry); }
                aimaxUpdateSaveUI();
            } else if (event.data?.type === 'edit:remove' && typeof event.data.n === 'number') {
                aimaxPendingEdits = aimaxPendingEdits.filter(e => e.n !== event.data.n);
                aimaxPendingLayout = aimaxPendingLayout.filter(l => l.n !== event.data.n);
                aimaxUpdateSaveUI();
            } else if (event.data?.command === 'copyToClipboard') {
                // Same document as the injected client here, so this is the
                // client handing us the page selection to put on the clipboard.
                vscode.postMessage({ command: 'copyToClipboard', text: event.data.text });
            } else if (event.data?.command === 'bridgeResult') {
                aimaxOnBridgeResult(event.data);
            } else if (event.data?.command === 'saveEditResult') {
                aimaxApplySaveResult(event.data);
            }
        });

        aimaxRefreshEditAvailability();

        // Inline annotation client (same-document mode)
        ${ANNOTATION_CLIENT_JS}
    </script>
    `;

    // Inject CSP + styles in head (CSP same as browser panel so Google Fonts etc. load consistently)
    const csp = generateCSP();
    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
    let result = html.replace('</head>', cspMeta + toolbarStyles + '</head>');

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

    const faviconUri = getFaviconDataUri();

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

    // Inject CSP + styles in head (CSP same as browser panel so Google Fonts etc. load consistently)
    const csp = generateCSP();
    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
    let result = html.replace('</head>', cspMeta + toolbarStyles + '</head>');

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
