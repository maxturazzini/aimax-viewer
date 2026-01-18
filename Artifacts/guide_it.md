---
title: AIMax Viewer - Guida Completa
author: Max Turazzini
version: 0.1.17
tags: [vscode, artifacts, ai, workflow]
---

# AIMax Viewer - Guida Completa

## Perché esiste AIMax Viewer?

**Il problema:** Quando lavori con AI agent come Claude Code in VS Code, gli artifact generati (report HTML, analisi, dashboard) finiscono in una cartella. Per visualizzarli devi aprirli nel browser esterno, perdendo il contesto del lavoro.

**La soluzione:** AIMax Viewer porta tutto dentro VS Code. Un viewer integrato che mostra gli artifact senza uscire dall'editor.

---

## L'Outcome Oriented Approach

AIMax Viewer nasce per supportare un metodo di lavoro specifico: l'**Outcome Oriented Approach** (OOA).

### Cos'è OOA?

Invece di dire all'AI "scrivi codice per fare X", definisci l'**outcome** desiderato:

> "Voglio un report HTML che mostri le vendite per categoria con grafici interattivi"

L'AI genera l'artifact completo. Tu lo visualizzi, valuti, iteri.

### Il ciclo OOA con AIMax Viewer

1. **Definisci l'outcome** - Descrivi cosa vuoi ottenere
2. **L'AI genera l'artifact** - File HTML/MD in `Artifacts/`
3. **Visualizza immediatamente** - AIMax Viewer lo mostra in VS Code
4. **Valuta e itera** - Feedback all'AI per raffinare
5. **Esporta se necessario** - PDF, condivisione, archiviazione

### Vantaggi rispetto al browser esterno

| Browser Esterno | AIMax Viewer |
|-----------------|--------------|
| Cambio contesto | Rimani in VS Code |
| Perdi il flusso | Workflow continuo |
| Copia-incolla URL | Click dal tree |
| Nessuna integrazione AI | Bottone Claude Code |

---

## Filosofia del Progetto

### 1. Zero Friction

Nessuna configurazione obbligatoria. Crea una cartella `Artifacts/`, mettici un `index.html`, fatto. L'estensione parte automaticamente.

### 2. AI-First

Pensato per chi lavora con AI agent. Ogni feature risponde alla domanda: "Come posso rendere più fluido il ciclo umano-AI?"

### 3. Markdown Native

I file `.md` sono cittadini di prima classe. Vengono renderizzati automaticamente in HTML con uno stile pulito e professionale.

### 4. Estensibile

URI handler (`vscode://`) per automazione. L'AI può aprire artifact programmaticamente.

---

## Come Usare AIMax Viewer

### Setup Iniziale

1. Installa l'estensione
2. Crea la cartella `Artifacts/` nel tuo workspace
3. Crea un `index.html` (o copia quello di esempio)
4. Ricarica VS Code

### Navigazione

- **Sidebar** - Tree view con tutti i file HTML/MD
- **Dropdown** - Selettore rapido nella toolbar (se layout="top")
- **Status Bar** - Icona home per tornare alla pagina principale

### Toolbar

| Icona | Funzione |
|-------|----------|
| Logo | Torna alla Home |
| `←` `→` | Cronologia navigazione |
| `↻` | Ricarica pagina |
| `(i)` | Info file + metadata YAML |
| `>` | Apri nuovo terminale |
| `*` | Nuova conversazione Claude |
| `☰` | Menu (Export PDF, etc.) |

### Export PDF

Dal menu hamburger `☰` → "Export to PDF". Il file viene scaricato automaticamente con lo stesso nome dell'artifact.

---

## Configurazione Avanzata

### Porta del Server

```json
{
  "aimaxViewer.server.port": 8080
}
```

- **Default (vuoto o 3124)**: Porta calcolata automaticamente per workspace (evita conflitti tra finestre VS Code)
- **Custom (qualsiasi valore diverso da 3124)**: Porta fissa, utile per firewall o bookmark

### Multi-Folder

```json
{
  "aimaxViewer.browser.folders": [
    { "label": "Artifacts", "path": "Artifacts" },
    { "label": "Reports", "path": "reports" }
  ]
}
```

### Layout

```json
{
  "aimaxViewer.browser.layout": "sidebar"
}
```

- **sidebar** - Usa tree view laterale (consigliato)
- **top** - Dropdown nella toolbar

### Startup

```json
{
  "aimaxViewer.startup.mode": "browser",
  "aimaxViewer.startup.homePage": "Artifacts/index.html"
}
```

- **home** - Apre la home page direttamente
- **browser** - Apre nel browser panel con toolbar
- **none** - Non apre nulla all'avvio

---

## YAML Frontmatter

I file Markdown possono avere metadata YAML all'inizio tra marcatori `---`:

```yaml
---
title: Report Vendite Q1
author: Max Turazzini
date: 2026-01-18
tags: [vendite, analisi, Q1]
---
```

I metadata appaiono nel popup `(i)` della toolbar.

---

## Integrazione con Claude Code

### Configurazione CLAUDE.md

Aggiungi questo al file **CLAUDE.md** del tuo progetto:

```markdown
## Artifact Viewer

Quando crei file HTML o MD in Artifacts/, visualizzali con:

open "vscode://aimax.aimax-viewer/openBrowser?http://127.0.0.1:3124/Artifacts/NOMEFILE"

Naming convention: YYYY-MM-DD_descrizione-breve.html o .md

IMPORTANTE: Non usare mai browser esterno - usa sempre il protocollo vscode://.
```

### URI Disponibili

| Azione | URI |
|--------|-----|
| Apri URL | `vscode://aimax.aimax-viewer/openBrowser?<url>` |
| Apri Home | `vscode://aimax.aimax-viewer/openHome` |
| Apri file corrente | `vscode://aimax.aimax-viewer/openCurrentFile` |
| Apri terminale | `vscode://aimax.aimax-viewer/openTerminal` |

---

## Best Practices

### Naming Convention

```
YYYY-MM-DD_descrizione-breve.html
YYYY-MM-DD_descrizione-breve.md
```

Esempio: **2026-01-18_analisi-vendite-q1.html**

### Struttura Artifacts

```
Artifacts/
├── index.html          # Dashboard/home page
├── 2026-01-18_report.html
├── 2026-01-17_analisi.md
└── templates/          # Template riutilizzabili
```

### index.html come Dashboard

La home page dovrebbe essere un hub di navigazione:

- Link agli artifact recenti
- Accesso rapido alle risorse
- Overview del progetto

---

## Troubleshooting

### Il viewer non si apre

1. Verifica che esista `Artifacts/index.html`
2. Controlla Output → "AIMax Viewer" per errori
3. Ricarica la finestra VS Code

### Porta già in uso

Se hai più finestre VS Code, ogni workspace usa una porta diversa (calcolata da hash). Se vuoi una porta fissa, impostala esplicitamente.

### PDF non si genera

1. Verifica connessione internet (carica CDN)
2. Prova con un file più semplice
3. Fallback: usa "Open in External Browser" + Print

---

## Roadmap

- [ ] Supporto code syntax highlighting
- [ ] Temi light/dark
- [ ] Esportazione batch PDF
- [ ] Integrazione MCP server

---

*AIMax Viewer - v0.1.17*
*AI, MAX*
