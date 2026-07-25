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
    cspAllowedHttpHosts: string[];
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
        ]),
        cspAllowedHttpHosts: config.get<string[]>('csp.allowedHttpHosts', [])
    };
}

export function generateCSP(): string {
    const config = getConfig();

    if (config.cspMode === 'strict') {
        return `default-src 'self' http://127.0.0.1:* http://localhost:*; script-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:*; style-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:*; img-src 'self' data: http://127.0.0.1:* http://localhost:*; font-src 'self' data: http://127.0.0.1:* http://localhost:*;`;
    }

    const domains = config.cspAllowedDomains;
    const httpsScheme = domains.map(d => `https://${d}`).join(' ');

    // Extra plain-HTTP hosts (e.g. minimacs.local, Tailscale IPs) so remote HTTP
    // services load in the browser panel iframe. Empty by default.
    const httpHosts = config.cspAllowedHttpHosts || [];
    const httpScheme = httpHosts.map(h => `http://${h}:*`).join(' ');
    const extra = [httpsScheme, httpScheme].filter(Boolean).join(' ');
    const frameSrc = ['http://127.0.0.1:*', 'http://localhost:*', httpScheme].filter(Boolean).join(' ');

    return `default-src 'self' http://127.0.0.1:* http://localhost:* ${extra}; frame-src 'self' ${frameSrc}; script-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:* ${extra}; style-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:* ${extra}; img-src 'self' data: http://127.0.0.1:* http://localhost:* ${extra}; font-src 'self' data: http://127.0.0.1:* http://localhost:* ${extra}; connect-src 'self' http://127.0.0.1:* http://localhost:* ${extra};`;
}
