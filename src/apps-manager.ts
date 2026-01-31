import * as vscode from 'vscode';
import { exec, spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';

export interface AppConfig {
    id: string;
    name: string;
    port: number;
    startCmd: string;
    stopCmd?: string;  // if null, kill by port
    cwd: string;
    healthUrl: string;
    category?: string;
}

export interface AppStatus extends AppConfig {
    running: boolean;
    pid?: number;
    uptime?: number;
}

export interface DiscoveredApp {
    port: number;
    pid: number;
    process: string;
    healthUrl: string;
    isAimaxViewer: boolean;
    title?: string;
    workspaceName?: string;
}

export class AppsManager {
    private workspaceRoot: string;
    private runningProcesses: Map<string, ChildProcess> = new Map();
    private startTimes: Map<string, number> = new Map();

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    private getAppsFromSettings(): AppConfig[] {
        const config = vscode.workspace.getConfiguration('aimaxViewer');
        return config.get<AppConfig[]>('appsManager.apps', []);
    }

    getApps(): AppConfig[] {
        return this.getAppsFromSettings();
    }

    async getStatus(): Promise<AppStatus[]> {
        const statuses: AppStatus[] = [];
        const apps = this.getAppsFromSettings();

        for (const app of apps) {
            const portInfo = await this.checkPort(app.port);
            const running = portInfo !== null;
            const startTime = this.startTimes.get(app.id);

            statuses.push({
                ...app,
                running,
                pid: portInfo?.pid,
                uptime: running && startTime ? Date.now() - startTime : undefined
            });
        }

        return statuses;
    }

    async startApp(appId: string): Promise<boolean> {
        const apps = this.getAppsFromSettings();
        const app = apps.find(a => a.id === appId);
        if (!app) {
            vscode.window.showErrorMessage(`App not found: ${appId}`);
            return false;
        }

        // Check if already running
        const portInfo = await this.checkPort(app.port);
        if (portInfo) {
            vscode.window.showWarningMessage(`${app.name} is already running on port ${app.port}`);
            return false;
        }

        // Validate startCmd is configured
        if (!app.startCmd || app.startCmd.trim() === '') {
            vscode.window.showErrorMessage(
                `${app.name}: Start command not configured. Edit 'aimaxViewer.appsManager.apps' in Settings.`
            );
            return false;
        }

        try {
            // Resolve cwd - support absolute paths
            const cwd = path.isAbsolute(app.cwd) ? app.cwd : path.join(this.workspaceRoot, app.cwd);

            if (!fs.existsSync(cwd)) {
                vscode.window.showErrorMessage(`Working directory not found: ${cwd}`);
                return false;
            }

            console.log(`[AIMax Apps] Starting ${app.name}: ${app.startCmd} in ${cwd}`);

            // Spawn process in background
            const child = spawn(app.startCmd, {
                shell: true,
                cwd: cwd,
                detached: true,
                stdio: 'ignore'
            });

            child.unref();

            if (child.pid) {
                this.runningProcesses.set(appId, child);
                this.startTimes.set(appId, Date.now());
            }

            // Wait for health check
            const healthy = await this.waitForHealth(app.healthUrl, 10000);
            if (healthy) {
                vscode.window.showInformationMessage(`${app.name} started successfully`);
                return true;
            } else {
                vscode.window.showWarningMessage(`${app.name} started but health check timed out`);
                return true; // Process started even if health check failed
            }
        } catch (error) {
            console.error(`[AIMax Apps] Error starting ${app.name}:`, error);
            vscode.window.showErrorMessage(`Failed to start ${app.name}: ${error}`);
            return false;
        }
    }

    async stopApp(appId: string): Promise<boolean> {
        const apps = this.getAppsFromSettings();
        const app = apps.find(a => a.id === appId);
        if (!app) {
            vscode.window.showErrorMessage(`App not found: ${appId}`);
            return false;
        }

        try {
            if (app.stopCmd) {
                // Use custom stop command
                const cwd = path.isAbsolute(app.cwd) ? app.cwd : path.join(this.workspaceRoot, app.cwd);
                await this.execCommand(app.stopCmd, cwd);
            } else {
                // Kill by port
                await this.killByPort(app.port);
            }

            this.runningProcesses.delete(appId);
            this.startTimes.delete(appId);

            vscode.window.showInformationMessage(`${app.name} stopped`);
            return true;
        } catch (error) {
            console.error(`[AIMax Apps] Error stopping ${app.name}:`, error);
            vscode.window.showErrorMessage(`Failed to stop ${app.name}: ${error}`);
            return false;
        }
    }

    // Add discovered app to VS Code settings
    async addAppToSettings(discovered: DiscoveredApp, name: string): Promise<boolean> {
        try {
            const config = vscode.workspace.getConfiguration('aimaxViewer');
            const currentApps = config.get<AppConfig[]>('appsManager.apps', []);

            // Check if already exists
            if (currentApps.find(a => a.port === discovered.port)) {
                vscode.window.showWarningMessage(`App on port ${discovered.port} already configured`);
                return false;
            }

            const newApp: AppConfig = {
                id: `app-${discovered.port}`,
                name: name,
                port: discovered.port,
                startCmd: '', // User needs to fill this
                cwd: '', // User needs to fill this
                healthUrl: discovered.healthUrl
            };

            const updatedApps = [...currentApps, newApp];

            await config.update('appsManager.apps', updatedApps, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`${name} added to settings. Edit startCmd and cwd in Settings.`);
            return true;
        } catch (error) {
            console.error('[AIMax Apps] Error adding app to settings:', error);
            vscode.window.showErrorMessage(`Failed to add app: ${error}`);
            return false;
        }
    }

    async getPortsInUse(): Promise<{ port: number; pid: number; process: string }[]> {
        return new Promise((resolve) => {
            exec('lsof -iTCP -sTCP:LISTEN -P -n', (error, stdout) => {
                if (error) {
                    resolve([]);
                    return;
                }

                const ports: { port: number; pid: number; process: string }[] = [];
                const lines = stdout.split('\n').slice(1); // Skip header

                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 9) {
                        const processName = parts[0];
                        const pid = parseInt(parts[1], 10);
                        const address = parts[8];

                        // Extract port from address (e.g., "127.0.0.1:3124" or "*:3124")
                        const portMatch = address.match(/:(\d+)$/);
                        if (portMatch) {
                            const port = parseInt(portMatch[1], 10);
                            // Avoid duplicates
                            if (!ports.find(p => p.port === port && p.pid === pid)) {
                                ports.push({ port, pid, process: processName });
                            }
                        }
                    }
                }

                resolve(ports);
            });
        });
    }

    async discoverApps(): Promise<DiscoveredApp[]> {
        const ports = await this.getPortsInUse();
        const apps = this.getAppsFromSettings();
        const configuredPorts = new Set(apps.map(a => a.port));

        // Filter: only localhost web servers on common ports, exclude configured ones
        const webPorts = ports.filter(p => {
            // Skip already configured apps
            if (configuredPorts.has(p.port)) return false;
            // Skip system ports (< 1024) except common web ones
            if (p.port < 1024 && ![80, 443, 8080].includes(p.port)) return false;
            // Skip VS Code internal ports (high random ports)
            if (p.port > 50000) return false;
            // Skip common non-web services
            if ([22, 25, 53, 110, 143, 993, 995].includes(p.port)) return false;
            return true;
        });

        const discovered: DiscoveredApp[] = [];

        for (const p of webPorts) {
            const healthUrl = `http://127.0.0.1:${p.port}/`;
            // Quick check if it responds to HTTP
            const isWeb = await this.checkHealth(healthUrl);
            if (isWeb) {
                // Check if it's an AIMax Viewer instance (verify JSON response structure)
                const isAimaxViewer = await this.checkIsAimaxViewer(p.port);

                // Try to get page title
                const title = await this.fetchPageTitle(healthUrl);

                // Fetch workspace name from AIMax Viewer instances
                const workspaceName = isAimaxViewer ? await this.fetchWorkspaceName(p.port) : undefined;

                discovered.push({
                    port: p.port,
                    pid: p.pid,
                    process: p.process,
                    healthUrl,
                    isAimaxViewer,
                    title,
                    workspaceName
                });
            }
        }

        return discovered;
    }

    private fetchPageTitle(url: string): Promise<string | undefined> {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(undefined), 2000);

            http.get(url, (res) => {
                let data = '';
                res.on('data', chunk => {
                    data += chunk;
                    // Stop early if we found the title (first 4KB should be enough)
                    if (data.length > 4096) {
                        res.destroy();
                    }
                });
                res.on('end', () => {
                    clearTimeout(timeout);
                    const match = data.match(/<title[^>]*>([^<]+)<\/title>/i);
                    resolve(match ? match[1].trim() : undefined);
                });
                res.on('error', () => {
                    clearTimeout(timeout);
                    resolve(undefined);
                });
            }).on('error', () => {
                clearTimeout(timeout);
                resolve(undefined);
            });
        });
    }

    private async checkPort(port: number): Promise<{ pid: number; process: string } | null> {
        const ports = await this.getPortsInUse();
        const found = ports.find(p => p.port === port);
        return found ? { pid: found.pid, process: found.process } : null;
    }

    private async waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
        const startTime = Date.now();
        const checkInterval = 500;

        while (Date.now() - startTime < timeoutMs) {
            try {
                const healthy = await this.checkHealth(url);
                if (healthy) {
                    return true;
                }
            } catch {
                // Ignore errors, keep trying
            }
            await this.sleep(checkInterval);
        }

        return false;
    }

    private checkHealth(url: string): Promise<boolean> {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                resolve(false);
            }, 2000);

            http.get(url, (res) => {
                clearTimeout(timeout);
                resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 500);
            }).on('error', () => {
                clearTimeout(timeout);
                resolve(false);
            });
        });
    }

    // Check if endpoint returns valid AIMax Viewer /api/artifacts response
    private checkIsAimaxViewer(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(false), 2000);

            http.get(`http://127.0.0.1:${port}/api/artifacts`, (res) => {
                if (res.statusCode !== 200) {
                    clearTimeout(timeout);
                    resolve(false);
                    return;
                }

                let data = '';
                res.on('data', chunk => {
                    data += chunk;
                    if (data.length > 8192) res.destroy();
                });
                res.on('end', () => {
                    clearTimeout(timeout);
                    try {
                        const parsed = JSON.parse(data);
                        // AIMax /api/artifacts returns an array with objects having url, name, type, folderLabel
                        const isValid = Array.isArray(parsed) &&
                            (parsed.length === 0 ||
                             (parsed[0] && typeof parsed[0].url === 'string' && typeof parsed[0].name === 'string'));
                        resolve(isValid);
                    } catch {
                        resolve(false);
                    }
                });
                res.on('error', () => {
                    clearTimeout(timeout);
                    resolve(false);
                });
            }).on('error', () => {
                clearTimeout(timeout);
                resolve(false);
            });
        });
    }

    private fetchWorkspaceName(port: number): Promise<string | undefined> {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(undefined), 2000);

            http.get(`http://127.0.0.1:${port}/api/identity`, (res) => {
                if (res.statusCode !== 200) {
                    clearTimeout(timeout);
                    resolve(undefined);
                    return;
                }

                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    clearTimeout(timeout);
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed.workspace || undefined);
                    } catch {
                        resolve(undefined);
                    }
                });
                res.on('error', () => {
                    clearTimeout(timeout);
                    resolve(undefined);
                });
            }).on('error', () => {
                clearTimeout(timeout);
                resolve(undefined);
            });
        });
    }

    private async killByPort(port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            exec(`lsof -ti :${port} | xargs kill -9`, (error) => {
                if (error && error.code !== 1) { // Code 1 means no process found, which is ok
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    private execCommand(command: string, cwd: string): Promise<string> {
        return new Promise((resolve, reject) => {
            exec(command, { cwd }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                } else {
                    resolve(stdout);
                }
            });
        });
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
