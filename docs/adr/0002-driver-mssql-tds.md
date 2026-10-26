# Driver SQL Server: `mssql-tds` di Microsoft, non tiberius

Il backend parla con SQL Server tramite `mssql-tds` (github.com/microsoft/mssql-rs), con la versione esatta bloccata e dietro un'interfaccia nostra in `quervio-core`. Alla data della scelta (ottobre 2026) era l'unica libreria Rust che supportasse insieme: SSPI Negotiate (Kerberos/NTLM), annullamento tramite Attention mantenendo viva la Sessione, Messaggi (`PRINT`, `RAISERROR`, righe interessate) in ordine rispetto ai Result set, e prosecuzione dopo un errore nel Batch. Tutte queste funzioni sono indispensabili per un clone di SSMS.

## Considered Options

- **tiberius**: scarta i token INFO/DONE (niente Messaggi), supporta solo NTLM, ha un bug di annullamento con SQL Server 2022 (issue #459) e legge `money` come `f64`. Richiederebbe un fork.
- **odbc-api + ODBC Driver 18**: annullamento e Messaggi solo tramite handle raw `unsafe`, e ogni utente deve installare l'MSI del driver.
- **Sidecar .NET (Microsoft.Data.SqlClient)**: il più completo e collaudato, ma aggiunge un secondo processo, un livello IPC e un runtime di decine di MB. Resta il piano B.

## Consequences

- `mssql-tds` è 0.x e non accetta PR esterne: gli aggiornamenti di versione sono deliberati e coperti dai test di integrazione.
- La milestone 0 (2026-10-26) ha verificato `mssql-tds` 0.3.0 contro SQL Server 2022 in Docker, con i test in `crates/quervio-core/tests/driver.rs`:
  - Messaggi, Result set e righe interessate arrivano nell'ordine dello script.
  - Con `BatchErrorMode::Continue` un errore non ferma il Batch e riporta il numero di riga.
  - L'annullamento da un altro task funziona sia con il Server occupato (`WAITFOR`) sia durante lo streaming delle righe: circa 770k righe lette, annullamento completato in meno di 0,5 s, Sessione ancora viva con le sue tabelle temporanee.
  - `money` e `decimal(38)` arrivano esatti.
  - `USE` aggiorna il database corrente.
- Restano da verificare su un server reale: l'autenticazione Windows (SSPI) e le istanze con nome tramite SQL Browser.
