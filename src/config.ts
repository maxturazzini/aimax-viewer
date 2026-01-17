import * as vscode from 'vscode';

export interface AimaxConfig {
    serverPort: number;
    startupMode: string;
    homePage: string;
    consoleOpenByDefault: boolean;
    enableJavaScript: boolean;
    multiTab: boolean;
    cspMode: string;
    cspAllowedDomains: string[];
}

export function getConfig(): AimaxConfig {
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
        ])
    };
}

export function generateCSP(): string {
    const config = getConfig();

    if (config.cspMode === 'strict') {
        return `default-src 'self' http://127.0.0.1:* http://localhost:*; script-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:*; style-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:*; img-src 'self' data: http://127.0.0.1:* http://localhost:*; font-src 'self' data: http://127.0.0.1:* http://localhost:*;`;
    }

    const domains = config.cspAllowedDomains;
    const httpsScheme = domains.map(d => `https://${d}`).join(' ');

    return `default-src 'self' http://127.0.0.1:* http://localhost:*; script-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:* ${httpsScheme}; style-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:* ${httpsScheme}; img-src 'self' data: http://127.0.0.1:* http://localhost:* ${httpsScheme}; font-src 'self' data: http://127.0.0.1:* http://localhost:* ${httpsScheme}; connect-src 'self' http://127.0.0.1:* http://localhost:* ${httpsScheme};`;
}
