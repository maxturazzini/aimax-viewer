import * as vscode from 'vscode';
import { AppsManager, AppStatus, DiscoveredApp } from './apps-manager';

export class AppTreeItem extends vscode.TreeItem {
    constructor(public readonly status: AppStatus) {
        super(status.name, vscode.TreeItemCollapsibleState.None);

        // Icon and color based on status
        this.iconPath = new vscode.ThemeIcon(
            status.running ? 'circle-filled' : 'circle-outline',
            status.running
                ? new vscode.ThemeColor('charts.green')
                : new vscode.ThemeColor('charts.red')
        );

        // Description with port
        this.description = `:${status.port} ${status.running ? '● Running' : '○ Stopped'}`;

        // Context value for conditional menus
        this.contextValue = status.running ? 'app-running' : 'app-stopped';

        // Detailed tooltip
        const uptimeStr = status.uptime ? this.formatUptime(status.uptime) : 'N/A';
        this.tooltip = new vscode.MarkdownString(
            `**${status.name}**\n\n` +
            `- Port: ${status.port}\n` +
            `- Status: ${status.running ? '🟢 Running' : '🔴 Stopped'}\n` +
            `- PID: ${status.pid || 'N/A'}\n` +
            `- Uptime: ${uptimeStr}\n` +
            `- Health: ${status.healthUrl}\n` +
            `- Category: ${status.category || 'Default'}`
        );

        // Click opens in browser if running
        if (status.running) {
            this.command = {
                command: 'aimaxViewer.openBrowser',
                title: 'Open in Browser',
                arguments: [status.healthUrl, status.name]
            };
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
        const tabTitle = discovered.isAimaxViewer
            ? `AIMax Viewer :${discovered.port}`
            : discovered.title
                ? discovered.title
                : `${discovered.process.replace(/\\x20/g, ' ')} :${discovered.port}`;

        const displayName = discovered.isAimaxViewer
            ? `AIMax Viewer :${discovered.port}`
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
    private refreshTimer?: ReturnType<typeof setInterval>;
    private cachedStatuses: AppStatus[] = [];
    private cachedDiscovered: DiscoveredApp[] = [];

    constructor(appsManager: AppsManager, refreshInterval: number) {
        this.appsManager = appsManager;
        if (refreshInterval > 0) {
            this.startAutoRefresh(refreshInterval);
        }
        // Initial load
        this.loadStatuses();
    }

    private async loadStatuses(): Promise<void> {
        this.cachedStatuses = await this.appsManager.getStatus();
        this.cachedDiscovered = await this.appsManager.discoverApps();
    }

    refresh(): void {
        this.loadStatuses().then(() => {
            this._onDidChangeTreeData.fire(undefined);
        });
    }

    async getChildren(element?: AppsTreeItemType): Promise<AppsTreeItemType[]> {
        // Ensure we have statuses
        if (this.cachedStatuses.length === 0 && this.cachedDiscovered.length === 0) {
            await this.loadStatuses();
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

    private startAutoRefresh(interval: number): void {
        this.refreshTimer = setInterval(() => this.refresh(), interval);
    }

    dispose(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }
    }
}
