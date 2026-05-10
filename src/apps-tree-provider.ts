import * as vscode from 'vscode';
import { AppsManager, AppStatus, DiscoveredApp } from './apps-manager';

export class AppTreeItem extends vscode.TreeItem {
    constructor(public readonly status: AppStatus) {
        super(status.name, vscode.TreeItemCollapsibleState.None);

        // Icon: cloud for remote, circle for local; filled when running, outline when stopped
        const iconName = status.remote
            ? (status.running ? 'cloud' : 'cloud-outline')
            : (status.running ? 'circle-filled' : 'circle-outline');
        this.iconPath = new vscode.ThemeIcon(
            iconName,
            status.running
                ? new vscode.ThemeColor('charts.green')
                : new vscode.ThemeColor('charts.red')
        );

        // Description with port
        this.description = `:${status.port} ${status.running ? '● Running' : '○ Stopped'}`;

        // Context value drives right-click menu visibility (see package.json view/item/context)
        // Differentiated for remote so Stop is hidden / handled differently
        this.contextValue = status.remote
            ? (status.running ? 'app-running-remote' : 'app-stopped-remote')
            : (status.running ? 'app-running' : 'app-stopped');

        // Detailed tooltip
        const uptimeStr = status.uptime ? this.formatUptime(status.uptime) : 'N/A';
        const host = AppTreeItem.extractHost(status.healthUrl);
        const lines = [
            `**${status.name}**`,
            ``,
            `- Status: ${status.running ? 'Running' : 'Stopped'}`,
            `- Host: ${host}${status.remote ? ' (remote)' : ''}`,
            `- Port: ${status.port}`,
            `- PID: ${status.pid ?? 'N/A'}`,
            `- Uptime: ${uptimeStr}`,
            `- Health: ${status.healthUrl}`,
            `- Category: ${status.category || 'Default'}`
        ];
        this.tooltip = new vscode.MarkdownString(lines.join('\n'));

        // Click always opens in AIMax Viewer; if app is unreachable, the iframe
        // will surface the connection error rather than failing silently.
        this.command = {
            command: 'aimaxViewer.openBrowser',
            title: 'Open in AIMax Viewer',
            arguments: [status.healthUrl, status.name]
        };
    }

    private static extractHost(url: string): string {
        try {
            return new URL(url).hostname;
        } catch {
            return 'unknown';
        }
    }

    private formatUptime(ms: number): string {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            return `${hours}h ${minutes % 60}m`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        } else {
            return `${seconds}s`;
        }
    }
}

export class CategoryTreeItem extends vscode.TreeItem {
    constructor(
        public readonly categoryName: string,
        public readonly apps: AppStatus[]
    ) {
        super(categoryName, vscode.TreeItemCollapsibleState.Expanded);

        const runningCount = apps.filter(a => a.running).length;
        this.description = `${runningCount}/${apps.length} running`;
        this.iconPath = new vscode.ThemeIcon('folder');
        this.contextValue = 'app-category';
    }
}

export class DiscoveredAppTreeItem extends vscode.TreeItem {
    constructor(public readonly discovered: DiscoveredApp) {
        // Compute the display title - always meaningful, never undefined
        const aimaxLabel = discovered.workspaceName || 'AIMax Viewer';

        const tabTitle = discovered.isAimaxViewer
            ? `${aimaxLabel} :${discovered.port}`
            : discovered.title
                ? discovered.title
                : `${discovered.process.replace(/\\x20/g, ' ')} :${discovered.port}`;

        const displayName = discovered.isAimaxViewer
            ? `${aimaxLabel} :${discovered.port}`
            : discovered.title
                ? `${discovered.title} :${discovered.port}`
                : `${discovered.process.replace(/\\x20/g, ' ')} :${discovered.port}`;

        super(displayName, vscode.TreeItemCollapsibleState.None);

        // Different icon/color for AIMax Viewer
        this.iconPath = new vscode.ThemeIcon(
            discovered.isAimaxViewer ? 'home' : 'circle-filled',
            discovered.isAimaxViewer
                ? new vscode.ThemeColor('charts.orange')
                : new vscode.ThemeColor('charts.blue')
        );

        this.description = discovered.isAimaxViewer ? '● AIMax' : '● Discovered';
        this.contextValue = 'app-discovered';

        const typeLabel = discovered.isAimaxViewer ? 'AIMax Viewer Instance' : discovered.process;
        this.tooltip = new vscode.MarkdownString(
            `**${discovered.title || typeLabel}**\n\n` +
            `- Port: ${discovered.port}\n` +
            `- PID: ${discovered.pid}\n` +
            `- Type: ${discovered.isAimaxViewer ? '🏠 AIMax Viewer' : '🔵 Web Server'}\n` +
            `- URL: ${discovered.healthUrl}\n\n` +
            `*Click to open in browser*`
        );

        // Always pass a meaningful title - never undefined
        this.command = {
            command: 'aimaxViewer.openBrowser',
            title: 'Open in Browser',
            arguments: [discovered.healthUrl, tabTitle]
        };
    }
}

export class DiscoveredCategoryItem extends vscode.TreeItem {
    constructor(public readonly discoveredApps: DiscoveredApp[]) {
        super('🔍 Discovered', vscode.TreeItemCollapsibleState.Expanded);
        this.description = `${discoveredApps.length} running`;
        this.iconPath = new vscode.ThemeIcon('search');
        this.contextValue = 'discovered-category';
    }
}

export type AppsTreeItemType = AppTreeItem | CategoryTreeItem | DiscoveredAppTreeItem | DiscoveredCategoryItem;

export class AppsTreeProvider implements vscode.TreeDataProvider<AppsTreeItemType> {
    private _onDidChangeTreeData = new vscode.EventEmitter<AppsTreeItemType | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private appsManager: AppsManager;
    private statusTimer?: ReturnType<typeof setInterval>;
    private discoveryTimer?: ReturnType<typeof setInterval>;
    private burstTimeout?: ReturnType<typeof setTimeout>;
    private cachedStatuses: AppStatus[] = [];
    private cachedDiscovered: DiscoveredApp[] = [];
    private _refreshingStatus = false;
    private _refreshingDiscovery = false;
    private slowIntervalMs: number;
    private burstDurationMs: number;
    private burstIntervalMs: number;

    constructor(
        appsManager: AppsManager,
        refreshInterval: number,
        burstDurationMs: number = 30000,
        burstIntervalMs: number = 3000
    ) {
        this.appsManager = appsManager;
        this.slowIntervalMs = refreshInterval;
        this.burstDurationMs = burstDurationMs;
        this.burstIntervalMs = burstIntervalMs;

        // Initial load (status + discovery) and start burst
        this.refreshStatus();
        this.refreshDiscovery();
        this.startBurst();
        this.startSlowTimers();
    }

    private async loadStatuses(): Promise<void> {
        this.cachedStatuses = await this.appsManager.getStatus();
    }

    private async loadDiscovered(): Promise<void> {
        this.cachedDiscovered = await this.appsManager.discoverApps();
    }

    /** Light-weight HTTP-only refresh of configured app statuses. */
    refreshStatus(): void {
        if (this._refreshingStatus) { return; }
        this._refreshingStatus = true;
        this.loadStatuses().then(() => {
            this._onDidChangeTreeData.fire(undefined);
        }).finally(() => {
            this._refreshingStatus = false;
        });
    }

    /** Heavy lsof-based refresh of discovered (non-configured) running services. */
    refreshDiscovery(): void {
        if (this._refreshingDiscovery) { return; }
        this._refreshingDiscovery = true;
        this.loadDiscovered().then(() => {
            this._onDidChangeTreeData.fire(undefined);
        }).finally(() => {
            this._refreshingDiscovery = false;
        });
    }

    /** Manual full refresh (status + discovery) and restart the burst window. */
    refresh(): void {
        this.refreshStatus();
        this.refreshDiscovery();
        this.startBurst();
    }

    /** Restart the fast-refresh window (status only, never lsof). */
    startBurst(): void {
        if (this.burstDurationMs <= 0 || this.burstIntervalMs <= 0) return;
        // If a burst is already running, stop it cleanly first
        if (this.burstTimeout) {
            clearTimeout(this.burstTimeout);
            this.burstTimeout = undefined;
        }
        // Switch the status timer to burst cadence
        if (this.statusTimer) {
            clearInterval(this.statusTimer);
        }
        this.statusTimer = setInterval(() => this.refreshStatus(), this.burstIntervalMs);

        // After burst window, fall back to slow cadence
        this.burstTimeout = setTimeout(() => {
            if (this.statusTimer) {
                clearInterval(this.statusTimer);
            }
            if (this.slowIntervalMs > 0) {
                this.statusTimer = setInterval(() => this.refreshStatus(), this.slowIntervalMs);
            } else {
                this.statusTimer = undefined;
            }
            this.burstTimeout = undefined;
        }, this.burstDurationMs);
    }

    private startSlowTimers(): void {
        // Discovery uses slow cadence only — never burst (lsof is expensive)
        if (this.slowIntervalMs > 0) {
            this.discoveryTimer = setInterval(() => this.refreshDiscovery(), this.slowIntervalMs);
        }
    }

    async getChildren(element?: AppsTreeItemType): Promise<AppsTreeItemType[]> {
        // Ensure caches are warm on first call
        if (this.cachedStatuses.length === 0 && this.cachedDiscovered.length === 0) {
            await Promise.all([this.loadStatuses(), this.loadDiscovered()]);
        }

        if (!element) {
            const items: AppsTreeItemType[] = [];

            // Configured apps section
            if (this.cachedStatuses.length > 0) {
                // Group by category
                const categories = new Map<string, AppStatus[]>();
                for (const status of this.cachedStatuses) {
                    const category = status.category || 'Configured';
                    if (!categories.has(category)) {
                        categories.set(category, []);
                    }
                    categories.get(category)!.push(status);
                }

                // If only one category with few apps, show directly
                if (categories.size === 1 && this.cachedStatuses.length <= 3) {
                    items.push(...this.cachedStatuses.map(s => new AppTreeItem(s)));
                } else {
                    // Multiple categories: show category nodes
                    for (const [categoryName, apps] of categories) {
                        items.push(new CategoryTreeItem(categoryName, apps));
                    }
                }
            }

            // Discovered apps section
            if (this.cachedDiscovered.length > 0) {
                items.push(new DiscoveredCategoryItem(this.cachedDiscovered));
            }

            return items;
        }

        // Category level: show apps in category
        if (element instanceof CategoryTreeItem) {
            return element.apps.map(s => new AppTreeItem(s));
        }

        // Discovered category: show discovered apps
        if (element instanceof DiscoveredCategoryItem) {
            return element.discoveredApps.map(d => new DiscoveredAppTreeItem(d));
        }

        return [];
    }

    getTreeItem(element: AppsTreeItemType): vscode.TreeItem {
        return element;
    }

    dispose(): void {
        if (this.statusTimer) clearInterval(this.statusTimer);
        if (this.discoveryTimer) clearInterval(this.discoveryTimer);
        if (this.burstTimeout) clearTimeout(this.burstTimeout);
    }
}
