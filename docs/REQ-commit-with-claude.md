# Requisiti — "Commit with Claude" (folder context menu)

**Documento**: Requisiti funzionali
**Feature**: Commit selettivo via Claude Code da context menu su cartella
**Versione target estensione**: 0.1.33
**Autore**: miniMe per Max Turazzini
**Data**: 2026-05-20
**Stato**: Draft per approvazione

---

## 1. Obiettivo

Permettere a Max di avviare un **commit selettivo via Claude Code** facendo tasto destro su una cartella, senza aprire un terminale a mano, senza scrivere prompt, e **senza aprire Claude se non c'è nulla da committare**.

## 2. Motivazione

Oggi il flusso è:
1. Apre terminale
2. `cd` nella cartella
3. `git status` per vedere se c'è qualcosa
4. Lancia `claude` con prompt scritto a mano
5. Iterazione con Claude per commit

Con la feature: tasto destro → click → Claude parte già pronto, o un banner dice che non serve.

## 3. User Stories

**US-1**: Come Max, da Explorer di VS Code, voglio fare tasto destro su una cartella e vedere una voce "Commit with Claude". Cliccandola, se ci sono modifiche git dentro quella cartella, si apre un terminale VS Code con Claude Code già avviato e con un prompt pre-confezionato per commit selettivo.

**US-2**: Come Max, se la cartella **non ha modifiche pendenti**, voglio vedere un **banner informativo** ("Nothing to commit in `<folder>`") e nessuna sessione Claude aperta. Zero costi di token, zero terminali inutili.

**US-3**: Come Max, lo stesso comportamento di US-1 e US-2 deve essere disponibile **anche dal tree "Artifacts" di AIMax Viewer**, quando il nodo selezionato è una cartella.

**US-4**: Come Max, se la cartella **non è dentro un repo git**, voglio un messaggio di warning chiaro ("`<folder>` is not inside a git repository") e nessuna azione ulteriore.

## 4. Requisiti Funzionali

### RF-1 — Nuovo comando
- ID comando: `aimaxViewer.commitFolderWithClaude`
- Titolo user-facing: **"Commit with Claude"** (decisione provvisoria — confermare con Max)
- Categoria: `AIMax Viewer`
- Argomento ricevuto: `vscode.Uri` di una cartella

### RF-2 — Check pre-condizione (git repo)
- Eseguire `git -C <folder> rev-parse --show-toplevel`
- Se exit code ≠ 0 → `vscode.window.showWarningMessage("<folder-name> is not inside a git repository")` → STOP

### RF-3 — Check modifiche pendenti
- Eseguire `git -C <repo-root> status --porcelain -- <folder>`
- Lo scope del check è **limitato alla cartella selezionata** (pathspec)
- Include: file modified, untracked, staged, deleted, renamed
- Se output **vuoto** → `vscode.window.showInformationMessage("Nothing to commit in <folder-name>")` → STOP

### RF-4 — Avvio sessione Claude
Se ci sono modifiche:
1. Aprire un nuovo terminale VS Code (`vscode.window.createTerminal`)
2. Working directory: **repo root** (non la cartella selezionata) — necessario per i comandi git
3. Mostrare il terminale (`terminal.show()`)
4. Inviare il comando `claude` con prompt pre-confezionato (vedi RF-5)

### RF-5 — Prompt Claude pre-confezionato
Il prompt inviato a `claude` deve:
- Citare il **path relativo** della cartella rispetto alla repo root
- Chiedere `git status -s -- <relative-path>` come primo step
- Chiedere raggruppamento logico se >3 file
- Chiedere proposta di messaggi di commit
- Chiedere conferma esplicita prima di committare
- Vincolare lo scope ai soli file dentro `<relative-path>`

Template:
```
Commit selettivo dei file modificati dentro <RELATIVE_PATH>.

Step:
1. Mostrami `git status -s -- <RELATIVE_PATH>`
2. Se sono più di 3 file, raggruppa per tema logico
3. Proponi messaggi di commit per ogni gruppo
4. Attendi mio OK prima di committare
5. Non toccare file fuori da <RELATIVE_PATH>
```

### RF-6 — Punto di ingresso 1: Explorer VS Code
Aggiungere voce al menu `explorer/context`:
- `command`: `aimaxViewer.commitFolderWithClaude`
- `when`: `explorerResourceIsFolder`
- `group`: `navigation` (in alto, vicino alle altre voci AIMax Viewer)

### RF-7 — Punto di ingresso 2: Artifacts tree di AIMax Viewer
Aggiungere voce al menu `view/item/context`:
- `command`: `aimaxViewer.commitFolderWithClaude`
- `when`: `view == aimaxViewer.artifactsTree && viewItem == folder`
- `group`: `navigation`

> Nota tecnica: verificare il valore esatto di `viewItem` impostato dai tree item cartella in `ArtifactsTreeProvider`. Se non già esposto, va aggiunto come `contextValue = 'folder'`.

## 5. Requisiti Non Funzionali

### RNF-1 — Performance
- Il check git deve essere veloce (<200 ms per cartelle medie).
- Niente check periodici, solo on-demand al click.

### RNF-2 — Robustezza
- Gestire cartelle con path contenenti spazi (quoting corretto).
- Gestire submodule (per ora: trattati come file modificati del parent, OK).
- Gestire repo nested (la repo root del check è quella che contiene la cartella, non il workspace).

### RNF-3 — UX banner
- Banner "Nothing to commit" deve essere `showInformationMessage` (non error, non warning).
- Banner "Not a git repo" deve essere `showWarningMessage`.
- Niente modal dialog: usare le notifiche standard VS Code (non-bloccanti).

### RNF-4 — Compatibilità
- Funzionare su VS Code ≥ 1.80 (come il resto dell'estensione).
- Funzionare su macOS (target primario di Max, dual-machine minimacs + macchia).

## 6. Fuori scope (v1)

- ❌ Badge/decorator sulle cartelle che hanno modifiche pendenti (rimandato a v2)
- ❌ Integrazione con Claude Bridge (sessione resta interattiva in terminale)
- ❌ Commit automatico senza Claude (esiste già `git commit`, non è questo lo scopo)
- ❌ Multi-folder selection (per ora una cartella alla volta)
- ❌ Configurabilità del prompt Claude (hard-coded in v1, esponibile in `settings.json` in v2)

## 7. Edge case da gestire

| Caso | Comportamento atteso |
|------|---------------------|
| Cartella non in repo git | Warning "Not inside a git repository" |
| Cartella in repo ma senza modifiche | Info "Nothing to commit in `<name>`" |
| Cartella con solo file ignorati (`.gitignore`) | Trattati come "nothing to commit" |
| Cartella è la repo root stessa | Funziona normalmente, scope = tutto il repo |
| Cartella è un submodule | v1: trattato come file modificato del parent (TBD se servono raffinamenti) |
| `claude` CLI non installata | Il terminale mostrerà `command not found` (errore di sistema, non gestito dall'estensione) |
| Path con spazi/accenti | Quoting corretto via `terminal.sendText` (gestisce automaticamente) |

## 8. Criteri di accettazione

- [ ] Tasto destro su cartella in Explorer mostra "Commit with Claude"
- [ ] Tasto destro su cartella in Artifacts tree mostra "Commit with Claude"
- [ ] Click su cartella vuota → banner info, nessun terminale aperto
- [ ] Click su cartella non-git → warning, nessun terminale aperto
- [ ] Click su cartella con modifiche → terminale aperto in repo root con `claude` lanciato
- [ ] Il prompt inviato contiene il path relativo corretto della cartella
- [ ] Path con spazi gestito correttamente
- [ ] Version bump a 0.1.33 in `package.json`
- [ ] Entry in `CHANGELOG.md`

## 9. Open questions (da confermare con Max)

1. **Nome user-facing**: "Commit with Claude" / "Commit selettivo con Claude" / altro?
2. **Gruppo menu**: `navigation` (alto, visibile) o `7_modification` (basso, vicino a cut/copy)?
3. **Solo modified o anche untracked**: default `git status --porcelain` include entrambi → OK?
4. **Sessione Claude**: terminale interno VS Code (interattivo, consigliato) o Claude Bridge (asincrono via browser)?

---

**Next step**: approvazione di Max sulle 4 open questions → implementazione in `src/extension.ts` + update `package.json` menus → build VSIX 0.1.33.
