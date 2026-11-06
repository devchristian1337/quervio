# Verifiche di compatibilità

Una build riuscita e i test browser con `?mock` non certificano le operazioni su
SQL Server. Registrare sempre versione effettiva del server, sistema del client,
autenticazione e funzionalità provate.

## Controlli automatici

Il workflow [Checks](../.github/workflows/ci.yml) parte su push ai branch, pull
request e avvio manuale. Esegue:

- Windows x64 e Linux x64: test frontend, build frontend, test Rust, build
  dell'eseguibile desktop, test browser con mock e self-test del bridge Microsoft.
- SQL Server Developer 2019, 2022 e 2025 in container Linux x64 distinti:
  autenticazione SQL, versione effettiva, test driver, catalogo, esecuzione e
  gestione del core Rust.

Il confezionamento e le prove native Linux x64/ARM64 rimangono nel workflow
manuale [Linux packages](../.github/workflows/linux.yml). `Checks` non pubblica
pacchetti né release. I test browser usano il Chromium installato da Playwright
in CI; localmente restano disponibili Chrome/Edge e `QUERVIO_BROWSER`.

## Ripetere le prove SQL in locale

Servono Node 24+, Rust e Docker con il motore Linux avviato e `docker` nel PATH.
Ogni comando crea un container con nome univoco, porta casuale su `127.0.0.1` e
password temporanea, esegue le suite e rimuove solo il container creato. Non legge
le Connessioni salvate e sovrascrive nel processo i tre parametri `QUERVIO_TEST_*`
che altrimenti potrebbero arrivare dal file `.env`. Non usa il container esistente
di `docker-compose.yml`.
Il test Windows sul rilevamento di un'istanza locale assente viene escluso:
contatta intenzionalmente `localhost` e non il server dedicato configurato.

Eseguire una versione alla volta:

```powershell
node scripts/test-sql-compatibility.mjs --version 2019
```

```powershell
node scripts/test-sql-compatibility.mjs --version 2022
```

```powershell
node scripts/test-sql-compatibility.mjs --version 2025
```

I rapporti vengono scritti in `target/sql-compatibility/<versione>-<timestamp>/`:

- `server.json`: versione, livello di aggiornamento, edizione, tipo di motore,
  autenticazione osservata e piattaforma del client.
- `run.json`: esito complessivo, orari, immagine richiesta, ID effettivo
  dell'immagine e risultato del controllo server, se eseguito.

Un `server.json` riuscito non basta: l'intera esecuzione deve terminare con codice
zero e `run.json` deve riportare `passed`. In CI i rapporti sono gli artefatti
`sql-compatibility-2019`, `sql-compatibility-2022` e `sql-compatibility-2025`.
I tag `*-latest` verificano gli aggiornamenti correnti; l'ID immagine nel rapporto
identifica i byte effettivamente provati. Non includere password, token o file
`.env` nei rapporti.

## Matrice delle evidenze

La configurazione di una riga automatica non equivale al suo superamento. Per le
nuove righe registrare il collegamento alla prima esecuzione CI riuscita oppure
conservare il relativo `run.json`. Le evidenze storiche del README restano valide
solo per gli ambienti e le funzionalità lì specificati.

| Server e autenticazione | Procedura | Evidenza disponibile |
| --- | --- | --- |
| SQL Server 2022, autenticazione SQL | Suite SQL e prove operative indicate nel README | Prove storiche documentate il 30/10/2026; nessuna nuova esecuzione implicita |
| SQL Server 2019, autenticazione SQL | Esecutore isolato e job CI dedicato | 06/11/2026: 28 test passati, versione 15.0.4500.2, client Windows x64; [rapporto](validation/sql-server-2019-2026-11-06.json) |
| SQL Server 2022, autenticazione SQL, nuova matrice | Esecutore isolato e job CI dedicato | 06/11/2026: 28 test passati, versione 16.0.4305.5, client Windows x64; [rapporto](validation/sql-server-2022-2026-11-06.json) |
| SQL Server 2025, autenticazione SQL | Esecutore isolato e job CI dedicato | 06/11/2026: 28 test passati, versione 17.0.5035.5, client Windows x64; [rapporto](validation/sql-server-2025-2026-11-06.json) |
| SQL Server 2012/2014/2016/2017 | Ambiente dedicato e procedura manuale sotto | Da verificare |
| SQL Server su Windows, autenticazione Windows | Client Windows e istanza dedicata nel dominio di test | Da verificare |
| Azure SQL Database, SQL/Entra | Database Azure dedicato e identità di test | Da verificare |
| Azure SQL Managed Instance, SQL/Entra | Istanza Azure dedicata e identità di test | Da verificare |

La matrice automatica copre il core Rust da client Linux. Non certifica il login
interattivo Entra, il bridge contro quei server, l'interfaccia desktop nativa,
operazioni con certificati Windows o le funzioni amministrative non esercitate
dalle suite. Non eseguire le suite che creano/eliminano database su Azure SQL
Database o su ambienti condivisi.

Le tre prove del 06/11/2026 sono state eseguite localmente con Quervio 0.1.34 da
Windows x64 verso container Linux x64, usando la stessa procedura configurata in
CI. Per ogni versione sono passati 6 test catalogo, 1 controllo versione e
autenticazione, 7 test driver, 11 di esecuzione e 3 di gestione. I container sono
stati rimossi al termine. Il workflow `Checks` è stato validato con actionlint
1.7.12; la sua esecuzione sui runner GitHub Windows/Linux resta da verificare
dopo la pubblicazione delle modifiche.

## Procedura per Windows Authentication, Entra e ambienti aggiuntivi

Usare un profilo applicativo vuoto e un ambiente SQL dedicato, con dati di prova.
Per Entra usare il flusso interattivo previsto dall'app e i permessi del database
di test; non passare token nella riga di comando o negli script SQL.

1. Creare una Connessione salvata di ambiente Test con l'autenticazione da
   verificare. Registrare versione Quervio, sistema e architettura del client.
2. Aprire una Scheda query ed eseguire questa lettura, conservando il risultato:

   ```sql
   SELECT CONVERT(nvarchar(128), SERVERPROPERTY('ProductVersion')) AS product_version,
          CONVERT(nvarchar(128), SERVERPROPERTY('Edition')) AS edition,
          SERVERPROPERTY('EngineEdition') AS engine_edition,
          CONVERT(nvarchar(128), CONNECTIONPROPERTY('auth_scheme')) AS auth_scheme,
          DB_NAME() AS database_name, @@SPID AS session_id;
   ```

3. Aprire una seconda Scheda query sulla stessa Connessione salvata. Ripetere la
   lettura e verificare che `session_id` sia diverso.
4. Nella prima scheda creare una tabella temporanea:

   ```sql
   CREATE TABLE #QuervioCompatibility (id int NOT NULL);
   INSERT INTO #QuervioCompatibility VALUES (1);
   ```

5. In un'esecuzione successiva della stessa scheda verificare la persistenza e
   il rollback:

   ```sql
   BEGIN TRANSACTION;
   INSERT INTO #QuervioCompatibility VALUES (2);
   ROLLBACK TRANSACTION;
   SELECT COUNT(*) AS expected_one FROM #QuervioCompatibility;
   ```

6. Nella seconda scheda verificare l'isolamento della tabella temporanea:

   ```sql
   SELECT OBJECT_ID('tempdb..#QuervioCompatibility') AS expected_null;
   ```

7. Nella prima scheda eseguire e annullare dopo l'avvio:

   ```sql
   WAITFOR DELAY '00:00:20';
   ```

8. Nella stessa scheda eseguire nuovamente `SELECT @@SPID;` e verificare che la
   Sessione sia ancora utilizzabile e conservi lo stesso identificativo.
9. Salvare il testo di prova, riavviare l'app e verificare ripristino delle
   schede e nuova autenticazione. Le Sessioni SQL vengono ricreate: transazioni
   e tabelle temporanee non vengono ripristinate.

Annotare esito e messaggio di ogni errore, distinguendo autorizzazioni mancanti,
funzioni non disponibili sul server e regressioni del client. Segnare una riga
come verificata solo per le operazioni effettivamente completate; backup,
restore, Agent e cifratura richiedono ulteriori prove dedicate.
