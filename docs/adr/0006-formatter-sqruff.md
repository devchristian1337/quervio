# Formattazione delle query con sqruff, in Rust

Sostituisce [ADR 0004](0004-formatter-poor-mans-t-sql.md).

Format Document e Format Selection usano `sqruff-lib` (github.com/quarylabs/sqruff, licenza Apache-2.0, versione 0.43.0 fissata esattamente) con il dialetto `tsql`. Il modulo è `crates/quervio-core/src/sql_format.rs` e il frontend lo chiama col comando `format_sql`. Poor Man's T-SQL Formatter imponeva la licenza AGPL-3.0 a tutta l'app, non era più aggiornato dal 2022 e pesava 1,2 MB di JavaScript transpilato da C#.

Sono attive solo le regole di layout (`LT01`–`LT15`) e il maiuscolo o minuscolo di parole chiave e `NULL` (`CP01`, `CP04`). Il maiuscolo dei nomi (`CP02`) resta spento: con una collation case-sensitive cambierebbe il codice.

## Considered Options

- **Restare su Poor Man's T-SQL Formatter**: impagina meglio il codice procedurale, ma ha la licenza AGPL-3.0 e non è mantenuto.
- **sqruff solo per le query, Poor Man's per il codice procedurale**: dà il risultato migliore su entrambi, ma tiene la dipendenza AGPL e due formatter con stili diversi.

## Consequences

- Su SELECT, JOIN, CTE, `APPLY` e `OPTION` il risultato è pulito. Il codice procedurale invece è impaginato peggio di prima. Con la 0.43.0:
  - più istruzioni restano sulla stessa riga (`a = @a; IF @b IS NOT NULL BEGIN`);
  - `AS BEGIN` resta sulla riga della firma della procedura;
  - `MERGE` va a capo in punti poco naturali.
- Una parte che sqruff non riesce a leggere resta com'era scritta. Il resto viene formattato e una notifica indica la prima riga lasciata intatta.
- sqruff legge `N'x'` come un nome seguito da una stringa, e la regola sugli spazi (`LT01`) li separa: `N 'x'` fa di `N` un alias. Per questo il prefisso `N` viene tolto prima della formattazione e rimesso dopo, sulle stesse stringhe.
- Il commento a fine riga resta dopo il codice che seguiva (`trailing_comments = after`). Con il valore predefinito sqruff lo sposta prima, e l'ordine dei token cambierebbe.
- Il controllo dell'ADR 0004 resta: il risultato è accettato solo se ha gli stessi Batch, le stesse righe `GO` e gli stessi token dell'originale, letti come li legge SQL Server. Serve davvero: sqruff legge diversamente un commento a blocco annidato subito dopo una `/` (`2//* /* */ */1`), e il suo risultato cambierebbe la condizione di una `DELETE`.
- Ogni Batch si formatta da solo e le righe `GO` restano come sono scritte. sqruff non le divide come `batch.rs`.
- `sqruff-lib` compila tutti i suoi dialetti, perché le sue dipendenze attivano le feature predefinite: il binario cresce. Formattare un Batch richiede pochi millisecondi. Un `Linter` per stile resta in memoria, perché costruirlo costa più che formattare.
- La versione è 0.x e cambia spesso: un aggiornamento va provato con i test di `sql_format.rs` e di `src/lib/format-sql.test.ts`.
