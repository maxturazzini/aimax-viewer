# AIMax Viewer - TODO

## ✅ Completate (v0.1.0)

### Core
- [x] WebviewPanel con Home e Browser panels
- [x] HTTP server interno (porta 3124 configurabile)
- [x] CORS headers per fetch JSON
- [x] URI handler (`vscode://aimax.aimax-viewer/...`)
- [x] Toolbar con branding "AI, MAX"
- [x] Hamburger menu con opzioni
- [x] Toggle Console per debug JavaScript

### Comandi (namespace: `aimaxViewer.*`)
- [x] `openHome` - Apri Home panel
- [x] `openBrowser` - Apri URL in Browser panel
- [x] `openArtifactsBrowser` - Browser con dropdown artifacts
- [x] `openCurrentFile` - Apri file HTML attivo
- [x] `openFileInViewer` - Context menu per HTML
- [x] `copyViewerState` - Copia stato viewer
- [x] `openTerminal` - Nuovo terminale
- [x] `openClaudeCode` - Nuova conversazione Claude

### Settings (namespace: `aimaxViewer.*`)
- [x] `server.port` - Porta HTTP (default: 3124)
- [x] `startup.mode` - Comportamento avvio: home/browser/none
- [x] `startup.homePage` - Path home page
- [x] `panels.multiTab` - Multi-tab mode
- [x] `console.openByDefault` - Visibilità console
- [x] `webview.enableJavaScript` - Esecuzione JavaScript

### UI
- [x] Dropdown artifacts nel Browser panel
- [x] Status Bar icon per quick Home access
- [x] Info button (ⓘ) con tooltip URL
- [x] Multi-tab: ogni artifact in nuovo tab

## 📋 Feature Future

### Browser/Viewer
- [ ] Navigazione back/forward
- [ ] History delle pagine visitate
- [ ] Zoom in/out
- [ ] Ricerca nel contenuto (Cmd+F)

### Console/Debug
- [ ] Filtri console (error/warn/info/log)
- [ ] Timestamp nei log
- [ ] Esporta log su file
- [ ] Console ridimensionabile

### Home/Artifacts
- [ ] Refresh automatico quando file cambia
- [ ] Ricerca artifacts
- [ ] Preview thumbnail
- [ ] Ordinamento per data/nome/dimensione

### UX/Polish
- [ ] Keyboard shortcuts (Cmd+R reload, etc.)
- [ ] Indicatore caricamento (spinner)
- [ ] Responsive toolbar per finestre strette

### Integrazione
- [ ] File watcher - ricarica automatica
- [ ] Supporto altri formati (PDF, immagini, markdown)

## 🔴 Limitazione Nota: Claude Code e WebviewPanel

Claude Code vede solo file aperti negli editor di testo. Le WebviewPanel non sono editor - Claude non può vedere cosa è visualizzato.

**Workaround attuale**: comando `copyViewerState` copia info strutturate che l'utente può incollare in chat.

**Soluzioni future possibili**:
1. File di stato `.aimax-viewer-state.json` nel workspace
2. MCP Tool custom per esporre stato viewer
3. Screenshot automatico in file temporaneo

## 🐛 Bug Noti

Nessuno! (v0.1.0 stabile)

---

*Ultimo aggiornamento: 2026-01-02 | Versione: 0.1.0*
