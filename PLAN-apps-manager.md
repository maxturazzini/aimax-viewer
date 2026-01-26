# Piano: Apps Manager per AIMax Viewer

**Data**: 2026-01-21
**Obiettivo**: Aggiungere funzionalità di monitoraggio e gestione delle app web locali (start/stop/status) integrata nell'estensione AIMax Viewer.

---

## Architettura

```
AIMax Viewer (esistente)
├── Artifacts Tree (esistente)
├── Browser Panel (esistente)
└── Apps Manager (NUOVO)
    ├── Apps Tree View (sidebar)
    ├── Apps Dashboard (webview panel)
    └── API Endpoints (/api/apps/*)
```

---

## File da Modificare

### 1. package.json

**Aggiungere command** (~linea 58):
```json
{
  "command": "aimaxViewer.openAppsManager",
  "title": "AIMax Viewer: Apps Manager"
},
{
  "command": "aimaxViewer.startApp",
  "title": "Start App"
},
{
  "command": "aimaxViewer.stopApp",
  "title": "Stop App"
},
{
  "command": "aimaxViewer.refreshApps",
  "title": "Refresh Apps Status"
}
```

**Aggiungere view** (~linea 77):
```json
"views": {
  "aimax-viewer": [
    { "id": "aimaxViewer.artifactsTree", "name": "Artifacts" },
    { "id": "aimaxViewer.appsTree", "name": "Apps Manager" }
  ]
}
```

**Aggiungere menu items** (~linea 90):
```json
"view/item/context": [
  {
    "command": "aimaxViewer.startApp",
    "when": "view == aimaxViewer.appsTree && viewItem == app-stopped",
    "group": "inline"
  },
  {
    "command": "aimaxViewer.stopApp",
    "when": "view == aimaxViewer.appsTree && viewItem == app-running",
    "group": "inline"
  }
]
```

**Aggiungere configuration** (~linea 150):
```json
"aimaxViewer.appsManager.enabled": {
  "type": "boolean",
  "default": true,
  "description": "Enable Apps Manager feature"
},
"aimaxViewer.appsManager.configPath": {
  "type": "string",
  "default": "utils/apps-config.json",
  "description": "Path to apps configuration file"
},
"aimaxViewer.appsManager.refreshInterval": {
  "type": "number",
  "default": 5000,
  "description": "Auto-refresh interval in milliseconds"
}
```

---

### 2. src/apps-manager.ts (NUOVO FILE)

```typescript
import * as vscode from 'vscode';
import { exec, spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface AppConfig {
  id: string;
  name: string;
  port: number;
  startCmd: string;
  stopCmd?: string;  // se null, kill by port
  cwd: string;
  healthUrl: string;
  category?: string;
}

export interface AppStatus extends AppConfig {
  running: boolean;
  pid?: number;
  uptime?: number;
}

export class AppsManager {
  private config: AppConfig[] = [];
  private configPath: string;
  private workspaceRoot: string;

  constructor(workspaceRoot: string, configPath: string) {
    this.workspaceRoot = workspaceRoot;
    this.configPath = path.join(workspaceRoot, configPath);
    this.loadConfig();
  }

  loadConfig(): void {
    // Legge apps-config.json
  }

  async getStatus(): Promise<AppStatus[]> {
    // Per ogni app in config:
    // 1. Check porta con lsof
    // 2. Check health URL con fetch
    // 3. Ritorna array di status
  }

  async startApp(appId: string): Promise<boolean> {
    // 1. Trova app in config
    // 2. Spawn processo con startCmd
    // 3. Attendi health check
  }

  async stopApp(appId: string): Promise<boolean> {
    // 1. Se stopCmd definito, esegui
    // 2. Altrimenti kill by port (lsof -ti :PORT | xargs kill)
  }

  async getPortsInUse(): Promise<{port: number, pid: number, process: string}[]> {
    // Esegue: lsof -iTCP -sTCP:LISTEN -P -n
    // Parsa output e ritorna array
  }
}
```

---

### 3. src/apps-tree-provider.ts (NUOVO FILE)

```typescript
import * as vscode from 'vscode';
import { AppsManager, AppStatus } from './apps-manager';

export class AppsTreeProvider implements vscode.TreeDataProvider<AppTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AppTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private appsManager: AppsManager;
  private refreshTimer?: NodeJS.Timer;

  constructor(appsManager: AppsManager, refreshInterval: number) {
    this.appsManager = appsManager;
    this.startAutoRefresh(refreshInterval);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  async getChildren(element?: AppTreeItem): Promise<AppTreeItem[]> {
    if (!element) {
      // Root: ritorna lista app raggruppate per categoria
      const statuses = await this.appsManager.getStatus();
      return statuses.map(s => new AppTreeItem(s));
    }
    return [];
  }

  getTreeItem(element: AppTreeItem): vscode.TreeItem {
    return element;
  }

  private startAutoRefresh(interval: number): void {
    this.refreshTimer = setInterval(() => this.refresh(), interval);
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }
}

class AppTreeItem extends vscode.TreeItem {
  constructor(public readonly status: AppStatus) {
    super(status.name, vscode.TreeItemCollapsibleState.None);

    // Icon e colore basati su stato
    this.iconPath = new vscode.ThemeIcon(
      status.running ? 'circle-filled' : 'circle-outline',
      status.running
        ? new vscode.ThemeColor('charts.green')
        : new vscode.ThemeColor('charts.red')
    );

    // Description con porta
    this.description = `:${status.port} ${status.running ? '● Running' : '○ Stopped'}`;

    // Context value per menu condizionali
    this.contextValue = status.running ? 'app-running' : 'app-stopped';

    // Tooltip dettagliato
    this.tooltip = new vscode.MarkdownString(
      `**${status.name}**\n\n` +
      `- Port: ${status.port}\n` +
      `- Status: ${status.running ? 'Running' : 'Stopped'}\n` +
      `- PID: ${status.pid || 'N/A'}\n` +
      `- Health: ${status.healthUrl}`
    );

    // Click apre nel browser
    this.command = status.running ? {
      command: 'aimaxViewer.openBrowser',
      title: 'Open in Browser',
      arguments: [status.healthUrl]
    } : undefined;
  }
}
```

---

### 4. src/extension.ts

**Aggiungere imports** (inizio file):
```typescript
import { AppsManager } from './apps-manager';
import { AppsTreeProvider } from './apps-tree-provider';
```

**Aggiungere in activate()** (~linea 125):
```typescript
// Apps Manager
const appsManager = new AppsManager(
  workspaceRoot,
  getConfig().appsManagerConfigPath
);

const appsTreeProvider = new AppsTreeProvider(
  appsManager,
  getConfig().appsManagerRefreshInterval
);

const appsTreeView = vscode.window.createTreeView('aimaxViewer.appsTree', {
  treeDataProvider: appsTreeProvider,
  showCollapseAll: false
});

// Commands
const startAppCmd = vscode.commands.registerCommand(
  'aimaxViewer.startApp',
  async (item: AppTreeItem) => {
    await appsManager.startApp(item.status.id);
    appsTreeProvider.refresh();
  }
);

const stopAppCmd = vscode.commands.registerCommand(
  'aimaxViewer.stopApp',
  async (item: AppTreeItem) => {
    await appsManager.stopApp(item.status.id);
    appsTreeProvider.refresh();
  }
);

const refreshAppsCmd = vscode.commands.registerCommand(
  'aimaxViewer.refreshApps',
  () => appsTreeProvider.refresh()
);

context.subscriptions.push(
  appsTreeView,
  startAppCmd,
  stopAppCmd,
  refreshAppsCmd
);
```

**Aggiungere API endpoints** nel server HTTP (~linea 986):
```typescript
// GET /api/apps - Lista app con status
if (req.url === '/api/apps') {
  const statuses = await appsManager.getStatus();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(statuses));
  return;
}

// POST /api/apps/:id/start
if (req.method === 'POST' && req.url?.match(/^\/api\/apps\/(.+)\/start$/)) {
  const appId = req.url.match(/^\/api\/apps\/(.+)\/start$/)?.[1];
  if (appId) {
    await appsManager.startApp(appId);
    res.writeHead(200);
    res.end(JSON.stringify({ success: true }));
  }
  return;
}

// POST /api/apps/:id/stop
if (req.method === 'POST' && req.url?.match(/^\/api\/apps\/(.+)\/stop$/)) {
  const appId = req.url.match(/^\/api\/apps\/(.+)\/stop$/)?.[1];
  if (appId) {
    await appsManager.stopApp(appId);
    res.writeHead(200);
    res.end(JSON.stringify({ success: true }));
  }
  return;
}

// GET /api/ports - Lista porte in uso
if (req.url === '/api/ports') {
  const ports = await appsManager.getPortsInUse();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(ports));
  return;
}
```

---

### 5. File di Configurazione App

**Creare in miniMe workspace**: `utils/apps-config.json`

```json
{
  "apps": [
    {
      "id": "sales",
      "name": "Sales App",
      "port": 8766,
      "startCmd": "bash Sales/_appV1/scripts/ensure-server.sh",
      "cwd": "/Users/maxturazzini/Library/CloudStorage/OneDrive-Personale/miniMe",
      "healthUrl": "http://127.0.0.1:8766/",
      "category": "Business"
    },
    {
      "id": "energy",
      "name": "Energy Dashboard",
      "port": 5001,
      "startCmd": "python server.py",
      "cwd": "/Users/maxturazzini/Library/CloudStorage/OneDrive-Personale/miniMe/projects/HomeStats/NEW",
      "healthUrl": "http://127.0.0.1:5001/",
      "category": "Home"
    },
    {
      "id": "academy",
      "name": "AI, MAX Academy",
      "port": 8080,
      "startCmd": "npm run dev",
      "cwd": "/Users/maxturazzini/claude_projects/AiMaxAcademy",
      "healthUrl": "http://127.0.0.1:8080/",
      "category": "Products"
    }
  ]
}
```

---

## Fasi di Implementazione

### Fase 1: Core Infrastructure
1. [ ] Creare `src/apps-manager.ts` con logica base
2. [ ] Implementare `getPortsInUse()` (lsof parsing)
3. [ ] Implementare `getStatus()` (check porte + health)

### Fase 2: Tree View
4. [ ] Creare `src/apps-tree-provider.ts`
5. [ ] Aggiornare `package.json` con view e commands
6. [ ] Registrare tree view in `extension.ts`

### Fase 3: Start/Stop
7. [ ] Implementare `startApp()` con spawn
8. [ ] Implementare `stopApp()` con kill
9. [ ] Aggiungere commands con menu contestuali

### Fase 4: API Endpoints
10. [ ] Aggiungere `/api/apps` endpoint
11. [ ] Aggiungere `/api/apps/:id/start` e `/stop`
12. [ ] Aggiungere `/api/ports`

### Fase 5: Polish
13. [ ] Auto-refresh configurabile
14. [ ] Notifiche VS Code per start/stop
15. [ ] Aggiornare CLAUDE.md

---

## Verifica

```bash
# 1. Build estensione
cd /Users/maxturazzini/claude_projects/AIMaxViewer
npm run compile

# 2. Test in VS Code
# - Premere F5 per lanciare Extension Development Host
# - Verificare che Apps Manager appaia in sidebar
# - Verificare icone verde/rosso per status
# - Testare start/stop

# 3. Test API
curl http://127.0.0.1:3124/api/apps
curl http://127.0.0.1:3124/api/ports
curl -X POST http://127.0.0.1:3124/api/apps/sales/start
```

---

## Note Tecniche

- **lsof parsing**: `lsof -iTCP -sTCP:LISTEN -P -n` → parse con regex
- **Health check**: `fetch` con timeout 2s, catch errors
- **Process spawn**: `child_process.spawn` con `detached: true` per background
- **Kill by port**: `lsof -ti :PORT | xargs kill -9`
- **Tree refresh**: EventEmitter pattern già usato in artifacts tree
