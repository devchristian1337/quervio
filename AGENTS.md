# Quervio — istruzioni per gli agenti

Queste istruzioni valgono per il repository Quervio e sono condivise da Codex e Claude Code.

## Regole di lavoro

- Rispondi sempre in italiano, in modo conciso. Distingui risultati verificati, ipotesi e verifiche mancanti.
- Resta nella richiesta corrente: correggi il sintomo segnalato e la sua causa. Segnala in chat eventuali problemi distinti e lascia all'utente la scelta di affrontarli.
- Esegui un solo comando o una sola query alla volta e attendine l'esito. Se l'utente esegue i passaggi manualmente, attendi il suo risultato prima del successivo.
- Fornisci comandi concreti: ricava prima i valori necessari con una lettura dedicata, senza lasciare segnaposto da compilare.
- Parti dalle evidenze: controlla `git status`, leggi il codice interessato e riproduci il problema al livello pertinente prima di correggerlo. Conserva le modifiche dell'utente già presenti.
- Su database di produzione, inizia in sola lettura. Modifiche ai dati richiedono autorizzazione specifica, backup verificato e controllo del risultato; usa l'autorizzazione già fornita per l'attività corrente.

## Contesto da consultare

- Per orientarti e scegliere i comandi: leggi `README.md`. Per i termini del dominio: usa `GLOSSARY.md`.
- Prima di cambiare gestione dei risultati, driver SQL, credenziali, installer o formatter: leggi l'ADR pertinente in `docs/adr/`. Per il formatter attuale fa riferimento l'ADR 0006, che sostituisce la scelta dell'ADR 0004.
- Prima di indagare un problema, se accessibile, cerca nel vault `C:\git\llm-wiki` per nome tecnico dell'oggetto e sintomo. Parti dai casi pertinenti e citali. Aggiorna il vault quando emerge conoscenza durevole; non eseguire mai commit o push sul vault.

## Confini del codice

- `crates/quervio-core/`: dominio, accesso SQL Server e gestione dei risultati, senza dipendenze da Tauri o dalla UI.
- `src-tauri/`: integrazione desktop, comandi/eventi Tauri, processi e finestra. Mantieni qui un adattatore sottile verso il core.
- `src/`: interfaccia React/TypeScript, stato Zustand, editor Monaco e griglia Glide. Mantieni componenti, tema e librerie già adottati.
- `tools/Quervio.MicrosoftBridge/`: helper .NET per le operazioni Microsoft avanzate. Per build, dipendenze e protocolli consulta la sezione dedicata del README.
- Mantieni la Sessione dedicata di ogni Scheda query: transazioni, tabelle temporanee e annullamento devono conservarne la semantica. Per modifiche a SQLCMD o agli strumenti amministrativi, conserva i consensi separati e il flusso anteprima/conferma descritti nel README.
- Per SQL Server e il bridge, mantieni password e token Entra fuori da log, righe di comando e file tracciati. Usa il canale standard input previsto dal progetto.

## Ambiente e comandi

L'ambiente di riferimento è Windows 11 con PowerShell. I prerequisiti aggiornati sono nel README.

Per gli script npm/pnpm usa PowerShell 7 (`pwsh`). Nella sola sessione di lavoro imposta:

```powershell
$env:npm_config_script_shell = (Get-Command pwsh -ErrorAction Stop).Source
```

Mantieni questa impostazione locale al processo; non cambiare la configurazione globale di pnpm. Quando l'esecutore lo consente, avvia PowerShell senza caricare il profilo.

Per preparare le dipendenze usa il lockfile:

```powershell
pnpm install --frozen-lockfile
```

Per avviare l'app in sviluppo:

```powershell
pnpm tauri dev
```

## Verifiche

- Scegli le verifiche in base alla modifica e riporta gli esiti effettivi. Per soli documenti controlla contenuto, percorsi e `git diff --check`; una build desktop completa non è necessaria.
- Frontend: `pnpm test` per i test unitari; `pnpm build` per TypeScript e build di produzione. Per interazioni e layout usa i test Playwright pertinenti tramite `pnpm test:ui`.
- Backend Rust: usa i test pertinenti e, quando serve la verifica complessiva, `cargo test --workspace`.
- Le integrazioni SQL sono opt-in: segui il README e usa esclusivamente le impostazioni `QUERVIO_TEST_*` e ambienti dedicati. Usa profili vuoti per le prove automatiche, evitando le Connessioni salvate dell'utente. Nelle prove di avvio isolate considera anche la migrazione automatica da Querydeck in `src-tauri/src/lib.rs`.
- I test browser con `?mock` verificano la UI; non provano le operazioni reali su SQL Server o il comportamento della finestra nativa. Per modifiche desktop verifica direttamente finestra, monitor e DPI pertinenti.
- Per modifiche al bridge consulta i comandi di self-test nel README. Non equiparare compilazione o mock a compatibilità con versioni SQL Server e autenticazioni non provate.

## Finestra e icone

- L'avvio sempre massimizzato sul monitor principale è una scelta esplicita dell'utente per l'uso con portatile e monitor esterno. Mantieni questo comportamento in `src-tauri/tauri.conf.json`; nelle modifiche alla finestra verifica anche schermi con scale DPI diverse.
- Per le icone native usa la sorgente approvata `src-tauri/icons/source.png`. Per rigenerazione e provenienza consulta `design/branding/README.md` e `design/branding/SOURCES.json`. Conserva il logo e l'inquadratura scelti dall'utente salvo richiesta di cambiarli.

## Git e release

- Commit, push e pubblicazione richiedono una richiesta per l'attività corrente. Quando sono già autorizzati, completa i passaggi ordinari senza chiedere nuovamente conferma. Includi nel commit solo le modifiche pertinenti.
- Gli artefatti di build in `target/`, `dist/` e il bridge pubblicato restano locali secondo `.gitignore`; le icone native già tracciate fanno parte degli asset del progetto.

Quando l'utente richiede una release:

1. Verifica branch, remote, modifiche locali e stato remoto; controlla l'ultima release pubblicata. Per questo repository il controllo è `gh release list --repo devchristian1337/quervio --limit 3`.
2. Ricava la nuova versione e allinea `package.json`, `src-tauri/tauri.conf.json`, la versione workspace in `Cargo.toml` e le sole voci locali `quervio` e `quervio-core` in `Cargo.lock`. Evita sostituzioni globali delle versioni nel lockfile.
3. Completa i controlli pertinenti, crea il commit e fai il push sul branch richiesto dall'utente.
4. Usa la procedura Velopack descritta in `docs/adr/0005-installer-velopack.md` e implementata in `scripts/pack-velopack.ps1`. Verifica la presenza del bridge e che i percorsi di pulizia dello script siano dentro il workspace. L'installer NSIS di Tauri non distribuisce gli aggiornamenti automatici.
5. In PowerShell 7, con l'impostazione di sessione sopra, `.\scripts\pack-velopack.ps1` prepara i pacchetti locali. Il parametro `-Publish` pubblica su GitHub; `-ReleaseNotes` riceve il testo Markdown delle sole modifiche incluse. Usa `gh` autenticato e lascia che lo script acquisisca il token, senza stamparlo o salvarlo nel repository.
6. Attendi l'esito della build: il collegamento Rust ottimizzato può restare diversi minuti senza output. Valuta il codice di uscita e distingui gli avvisi dagli errori bloccanti.
7. Prima di dichiarare la release pubblicata, verifica su GitHub stato pubblico, versione, commit del tag e asset caricati: installer, portable, pacchetti completo/delta e feed. Controlla la versione dell'eseguibile e lo stato finale del repository. Distingui pubblicazione della release e aggiornamento dell'app installata sul PC.

## Manutenzione delle istruzioni

Aggiorna qui le regole condivise. `CLAUDE.md` importa questo file: mantieni una sola fonte delle istruzioni comuni e usa README e ADR per i dettagli già documentati.
