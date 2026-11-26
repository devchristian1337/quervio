# Infrastruttura di Testing E2E e Matrice di Copertura — Quervio

Questo documento descrive l'architettura di testing end-to-end multilivello di Quervio, i confini di responsabilità tra ogni suite, le garanzie di isolamento dei dati/credenziali e la matrice di copertura funzionale aggiornata al **26 novembre 2026** (Quervio `0.1.40`).

## 1. Architettura multilivello (senza duplicazioni)

| Livello | Strumento | Percorso | Scopo principale |
| --- | --- | --- | --- |
| Unit frontend | Vitest 5 | `src/**/*.test.{ts,tsx}` | Logica pura TypeScript, store Zustand, completamento SQL, formatter client, recovery, shortcut, temi |
| Unit backend | Cargo Test | `crates/quervio-core/src/`, `src-tauri/src/` | Batch splitting, destructive guard, scripting, DPAPI/Keyring, sqruff, SQLCMD, tab snapshots, `test-profile` |
| Bridge .NET | Self-test nativo | `Quervio.MicrosoftBridge --self-test` | Round-trip CSV/Excel, NULL vs stringa vuota, Unicode, `decimal(38)`, rifiuto formule CSV, hash DACPAC |
| Integrazione SQL | Cargo Test (`--ignored`) + Docker | `crates/quervio-core/tests/`, `scripts/test-sql-compatibility.mjs` | Driver `mssql-tds`, catalogo, esecuzioni, cancellazione, transazioni, piani e gestione su SQL Server 2019/2022/2025 isolati |
| UI, Accessibilità e Visual (mock) | Playwright + `@axe-core/playwright` | `tests/ui/*.spec.ts` | Interazioni UI veloci e deterministiche su `?mock`, animazioni Motion/Animate UI, tutti i 15 temi, layout, safety dialog, WCAG 2.1 A/AA |
| E2E Desktop Reale | WebdriverIO 9 + `@wdio/tauri-service` 1.5.1 + `tauri-driver` 2.1.0 | `tests/e2e/*.e2e.ts`, `wdio.tauri.conf.ts`, `scripts/run-desktop-e2e.mjs` | Applicazione desktop Tauri 2 reale su Windows (WebView2) e Linux (WebKitGTK), IPC Rust reale, filesystem, clipboard OS, DPAPI/Keyring, bridge reale, finestra nativa e flussi SQL Server reali in Docker |
| Smoke pacchetti Linux | `tauri-driver` nativo | `tests/native/linux-smoke.mjs`, `scripts/test-linux-native.sh` | Verifica post-packaging AppImage e Flatpak (x64/ARM64), permessi SquashFS e risorse Microsoft incluse |

## 2. Scelta del provider WebDriver e separazione delle build distribuite

- **Provider scelto**: `driverProvider: "external"` in `@wdio/tauri-service@1.5.1`, riutilizzando `tauri-driver` 2.1.0 (già adottato dal workflow Linux). Su Windows `@wdio/tauri-service` gestisce automaticamente il download della versione esatta di `msedgedriver` compatibile con Edge/WebView2; su Linux usa `WebKitWebDriver` + `xvfb-run` + `dbus-run-session` + `gnome-keyring`.
- **Zero plugin di automazione nelle build distribuite**: non è stato aggiunto né `tauri-plugin-wdio` né `tauri-plugin-wdio-webdriver`, e `src-tauri/capabilities/default.json` non contiene permessi di test aggiuntivi. Le invocazioni IPC reali nei test desktop usano `window.__TAURI_INTERNALS__.invoke` tramite WebDriver, coerentemente con `tests/native/linux-smoke.mjs`.
- **Isolamento profili opt-in**: `src-tauri/Cargo.toml` definisce la feature `test-profile = []` (disabilitata di default). Solo le build compilate esplicitamente con `--features "test-profile,tauri/custom-protocol"` riconoscono la variabile d'ambiente `QUERVIO_TEST_DATA_DIR` (solo percorsi assoluti) e disabilitano `copy_querydeck_data`, evitando qualsiasi accesso a `%APPDATA%\com.quervio.app`, alle Connessioni salvate o ai dati Querydeck dell'utente. Le build release (`scripts/pack-velopack.ps1`, `scripts/pack-linux.sh`, `pnpm tauri build`) non abilitano mai `test-profile`.
- **SQL Server isolati in Docker**: `scripts/run-desktop-e2e.mjs --with-sql` crea un container effimero `mcr.microsoft.com/mssql/server:2022-latest` su `127.0.0.1` (porta casuale) con password generata in memoria (mascherata in CI, mai salvata su disco) e rimuove il container nel blocco `finally`. Non legge mai `.env` né le Connessioni salvate dell'utente.

## 3. Comandi operativi

```powershell
# Unit & Build
pnpm test
pnpm build
pnpm exec tsc -p tests/e2e/tsconfig.json --noEmit
cargo test --locked --workspace
cargo test --locked --manifest-path src-tauri/Cargo.toml --features test-profile
.\src-tauri\resources\microsoft\Quervio.MicrosoftBridge.exe --self-test

# UI, Visual & Accessibilità (Playwright + axe-core)
pnpm test:ui

# E2E Desktop reale su Windows (profilo temporaneo isolato)
pnpm test:e2e:desktop

# E2E Desktop reale su Windows con container SQL Server 2022 isolato (richiede Docker Linux engine avviato)
pnpm test:e2e:desktop:sql

# Integrazione Rust SQL Server 2022 isolata in Docker
node scripts/test-sql-compatibility.mjs --version 2022
```

Su Linux (headless con Xvfb + D-Bus + GNOME Keyring temporaneo):

```bash
bash scripts/run-linux-desktop-e2e.sh --with-sql
```

## 4. Matrice di copertura funzionale

| Area funzionale | Vitest | Cargo / Bridge | Playwright (`tests/ui`) | WebdriverIO Desktop (`tests/e2e`) | Linux Smoke | Stato verifica (2026-11-26) |
| --- | --- | --- | --- | --- | --- | --- |
| Pulsanti, menu e componenti interattivi | — | — | `management`, `command-palette`, `group-and-menu-focus`, `editor-shortcuts-and-animations`, `ui-regressions` | `desktop-core` (Tour, Settings, Escape) | `linux-smoke` | **Verificato (100% verde, BUG-UI-09 risolto)** |
| Animazioni Motion e Animate UI (`useReducedMotion`, stepper, toast, tabs, blobs, tour) | — | — | `product-tour`, `output-tabs`, `editor-shortcuts-and-animations`, `ui-regressions` (LiveLine rAF) | `desktop-core` (Tour reale) | — | **Verificato** |
| Monaco Editor (editing, commenti, formattazione, IntelliSense, scroll, layout) | `editor`, `format-sql`, `intellisense`, `sql-completion` | `sql_format` (sqruff) | `intellisense-execute`, `sidebar-resize`, `editor-shortcuts-and-animations`, `file-saving` | `desktop-core` (`format_sql` IPC), `sql-server-real` (clipboard paste + multi-batch `GO` su SQL 2022) | — | **Verificato end-to-end (anche su SQL Server 2022 reale)** |
| Glide Data Grid (virtualizzazione, ordinamento, selezioni Ctrl, freeze, Find, ValueViewer, export) | `result-column-widths` | `results`, `query` | `explorer-results`, `result-tabs`, `ui-regressions`, `editor-shortcuts-and-animations` | `sql-server-real` (rendering live su SQL Server 2022) | — | **Verificato end-to-end (anche su SQL Server 2022 reale)** |
| Object Explorer (albero virtualizzato, filtro, gruppi, tastiera, context menu, scripting) | `explorer`, `connections` | `catalog`, `scripting` | `explorer-results`, `search-clear`, `object-scope`, `editor-shortcuts-and-animations` | `desktop-core` (gruppi/connessioni), `sql-server-real` (catalogo live `master`, `Databases`, `Security`, `Agent`) | `linux-smoke` | **Verificato end-to-end (anche su SQL Server 2022 reale)** |
| Scorciatoie da tastiera e gestione focus | `shortcuts` | — | `command-palette`, `group-and-menu-focus`, `product-tour`, `editor-shortcuts-and-animations`, `safety-and-transactions` | `desktop-core` (Escape dialog), `sql-server-real` (`Ctrl+A`/`Ctrl+V`) | — | **Verificato** |
| Temi (tutti i 15 + System), layout e ridimensionamento finestre | `themes`, `window-theme` | — | `accessibility-and-themes` (15 temi + `900x600`/`1280x800`/`1440x900`), `sidebar-resize`, `management` | `desktop-core` (Dracula persistito + `setWindowSize(1024, 700)`) | `linux-smoke` | **Verificato (100% verde)** |
| Connessioni SQL Server reali | — | `driver`, `catalog`, `compatibility` (28/28 passati su SQL 2022 `16.0.4325.4`) | `connect-dialog-warning`, `connection-consistency` (mock) | `sql-server-real` (`ConnectDialog` + `Test connection` + DPAPI + login SQL 2022) | `linux-smoke` (opzionale) | **Verificato su SQL Server 2022 reale in Docker** |
| Esecuzione, cancellazione e gestione query | `queries` | `batch`, `execution`, `driver` | `intellisense-execute`, `editor-shortcuts-and-animations` | `sql-server-real` (multi-batch `GO`, `#Temp` isolata tra tab, `WAITFOR DELAY` cancel + `@@SPID` preservato) | — | **Verificato su SQL Server 2022 reale in Docker** |
| Transazioni, rollback e conferme operazioni distruttive | `exit`, `queries` | `guard`, `query`, `execution` | `safety-and-transactions`, `management` (SQLCMD & preview) | `sql-server-real` (`BEGIN TRAN` -> chiusura tab -> `Roll back` verificato in DB; `DELETE` su `Production` -> `Cancel` preserva 3 righe, `Run anyway` elimina) | — | **Verificato su SQL Server 2022 reale in Docker** |
| Comunicazione IPC con Rust | — | `src-tauri` unit | Mock IPC contract checks | `desktop-core` + `sql-server-real` | `linux-smoke` | **Verificato realmente su Windows** |
| Filesystem, clipboard e persistenza | `files`, `settings` | `files`, `secrets`, `settings`, `tabs` | `file-saving`, `session-recovery` | `desktop-core` (Unicode CRLF, OS clipboard, DPAPI `secrets.json`, `settings.json`, `tabs.json`) | `linux-smoke` | **Verificato realmente su Windows** |
| Importazione ed esportazione dati (CSV, XLSX, Markdown, SSMS, Bridge) | `ssms-import` | `ssms`, `query`, Bridge `--self-test` (17 test) | `management` (Transfer mapping), `editor-shortcuts-and-animations` (SSMS + CSV/XLSX/MD export) | `sql-server-real` (CSV RFC-4180 + `\N`, rifiuto formule `=SUM(...)`, XLSX `PK` da SQL 2022 reale) | — | **Verificato end-to-end (Bridge 17/17 + export reale da SQL 2022)** |
| Ripristino delle sessioni (`tabs.json` / `.bak`) | `session-restore` | `tabs` (corruzione, BOM, atomicity) | `session-recovery` | `desktop-core` (`tabs_save`/`tabs_load`) | — | **Verificato** |
| Regressioni visive e accessibilità (WCAG 2.1 A/AA) | — | — | `accessibility-and-themes` (`@axe-core/playwright` + screenshot), `connect-dialog-warning`, `output-tabs`, `result-tabs` | `desktop-core` (screenshot reali WebView2) | `linux-smoke` | **Verificato (0 violazioni WCAG 2.1 A/AA gravi/critiche)** |
| Gestione errori e condizioni limite | `files`, `queries`, `session-restore` | `sqlcmd`, `tabs`, `language`, `settings` | `ui-regressions`, `object-scope`, `session-recovery`, `editor-shortcuts-and-animations` | `desktop-core` (`format_sql` invalido) | `linux-smoke` (certificati Windows su Linux) | **Verificato** |

## 5. Esiti dell'ultima esecuzione (2026-11-27, Windows 11 x64)

- **Vitest (`pnpm test`)**: **19 file, 160/160 passati** (0.65s).
- **Frontend Build (`pnpm build`)**: **Passato** (`tsc && vite build`, 0 errori).
- **Typecheck E2E (`tsc -p tests/e2e/tsconfig.json --noEmit`)**: **Passato** (0 errori).
- **Cargo Test (`cargo test --locked --workspace`)**: **139 passati, 0 falliti** (`quervio-core`: 110; `quervio_lib`: 29 + 1 ignored SQL Tools Service).
- **Cargo Test (`test-profile`)**: **30 passati, 0 falliti**, incluso `test_profile_override_accepts_only_absolute_paths`.
- **Microsoft Bridge (`Quervio.MicrosoftBridge.exe --self-test`)**: **17/17 passati**.
- **Playwright UI (`pnpm test:ui`)**: **84/84 passati (0 falliti)** in 3.4m, inclusi audit WCAG 2.1 A/AA (`accessibility-and-themes.spec.ts`) e tooltip `SQLCMD` (`management.spec.ts`).
- **WebdriverIO Desktop Reale + Docker SQL Server 2022 (`node scripts/run-desktop-e2e.mjs --with-sql`)**: **13/13 passati in 18s** su WebView2 `158.0.4370.45` (`desktop-core.e2e.ts`: **8/8** in 4.8s; `sql-server-real.e2e.ts`: **5/5** in 10s contro container SQL Server 2022 isolato, rimosso automaticamente al termine).
- **Integrazione Rust SQL Server 2022 (`node scripts/test-sql-compatibility.mjs --version 2022`)**: **28/28 passati** (`catalog`: 6, `compatibility`: 1, `driver`: 7, `execution`: 11, `management`: 3) contro SQL Server `16.0.4325.4` (`Developer Edition (64-bit)`, autenticazione SQL, immagine `sha256:4525e3efac9f3e241cb003bb2ff2a82818b502f37e12049d788b1a9fa7e13b7f`).

## 6. Bug identificati e risoluzioni

| ID | Gravità | Stato | Area | Descrizione, causa radice e risoluzione | Riferimento codice |
| --- | --- | --- | --- | --- | --- |
| BUG-A11Y-01 | **Critica** | **Risolto** | Object Explorer | I pulsanti chevron `<button tabIndex={-1}>` dentro `role="treeitem"` mancavano di nome accessibile (`button-name`). Sostituiti con `<span aria-hidden="true">` cliccabile (l'espansione da tastiera e `aria-expanded` restano sul `treeitem`). | `src/components/ObjectExplorer.tsx:490` |
| BUG-A11Y-02 | **Critica** | **Risolto** | ConnectDialog | I `SelectTrigger` (`Authentication`, `Environment`, `Encrypt`) non erano collegati al `<Label>` (`button-name`). Aggiunti `htmlFor`/`id` (`authentication`, `environment`, `encrypt`). | `src/components/ConnectDialog.tsx:150,221,239` |
| BUG-A11Y-03 | **Critica** | **Risolto** | Query TabBar | `TabBar` renderizzava `role="tab"` senza contenitore `role="tablist"` (`aria-required-parent`). Aggiunto `role="tablist" aria-label="Query tabs"` collegato ai tab tramite `aria-owns`. | `src/components/QueryWorkspace.tsx:130-141` |
| BUG-A11Y-04 | **Critica** | **Risolto** | CommandPalette | `CommandPrimitive.Separator` emetteva `role="separator"` dentro `role="listbox"` (`aria-required-children`). `CommandSeparator` ora renderizza un divisore `role="presentation" aria-hidden="true"` visibile solo a ricerca vuota (`useCommandState`). | `src/components/ui/command.tsx:77-94` |
| BUG-A11Y-05 | **Alta** | **Risolto** | Query TabBar | `<button aria-label="Close">` era annidato dentro `<div role="tab">` (`nested-interactive`). Separati il trigger `role="tab"` e il pulsante fratello `Close` dentro il wrapper visivo del tab. | `src/components/QueryWorkspace.tsx:184-230` |
| BUG-A11Y-06 | **Alta** | **Risolto** | StartScreen | `<ul role="group" aria-label={...}>` sovrascriveva il ruolo `list` lasciando gli `<li>` orfani (`listitem`). Rimosso `role="group"` perché `ScrollFade` tratta già nativamente `<ul>`. | `src/components/StartScreen.tsx:77` |
| BUG-A11Y-07 | **Alta** | **Risolto** | Top bar / Command search | `button[data-tour="command-search"]` presentava `label-content-name-mismatch` tra testo visibile + `<kbd>` e `aria-label`. Rimossa la sovrascrittura `aria-label`, marcati icona e `<kbd>` con `aria-hidden="true"` e aggiunto `aria-keyshortcuts`. | `src/components/management/Workspace.tsx:180-183` |
| BUG-A11Y-08 | **Alta** | **Chiuso (verificato)** | Contrasto colori (Dark/Settings/Palette) | Le 3 segnalazioni iniziali di `color-contrast` in dark mode (`settings`, `GlowingKeyboard`, `CommandPalette` `Esc`) erano dovute ad `axe.analyze()` eseguito durante le transizioni/animazioni di ingresso (`150–500ms`). Con attesa delle animazioni finite (`waitForSettledAnimations`), i contrasti a regime (`Quervio Dark` `#ABA9BC` su `#1E1E24`/`#2A2A35`, 6.17:1–7.15:1) superano integralmente WCAG 2.1 AA (≥ 4.5:1). | `tests/ui/accessibility-and-themes.spec.ts:10-24`, `src/lib/themes.ts:98-102` |
| BUG-UI-09 | **Media** | **Risolto** | Query Toolbar / Tooltip | In Radix `TooltipContentHoverable` (`disableHoverableContent={false}`), spostando il puntatore direttamente da `SQLCMD` a `Tools` la grace area restava armata senza successivi `pointermove`, lasciando il tooltip aperto (`management.spec.ts:55`). Abilitato `disableHoverableContent` su `TooltipProvider` (tutti i `<Tip>` sono puramente informativi). | `src/components/ui/flexnative-tooltip.tsx:8-19`, `src/main.tsx:25` |
| NOTE-ISO-10 | **Media (Infra/Test)** | **Nota nota/mitigata** | Isolamento WebView2 Windows | Con `test-profile`, `QUERVIO_TEST_DATA_DIR` isola al 100% `connections.json`, `secrets.json`, `settings.json` e `tabs.json`, ma su Windows Tauri imposta `data_directory` della WebView2 su `%LOCALAPPDATA%\com.quervio.app\EBWebView` ignorando `WEBVIEW2_USER_DATA_FOLDER`. Le suite E2E salvano e ripristinano `quervio.tour.seen`; una separazione completa di `EBWebView` richiederebbe `WebviewWindowBuilder::data_directory` dedicato sotto `test-profile`. | `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json` |
