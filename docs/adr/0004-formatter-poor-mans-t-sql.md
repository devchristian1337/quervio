# Formattazione delle query con Poor Man's T-SQL Formatter

Le query si formattano con Poor Man's T-SQL Formatter (pacchetto npm `poor-mans-t-sql-formatter`, versione 1.6.10 fissata esattamente). L'alternativa era `sql-formatter`, con licenza MIT e mantenuta, che però sbaglia sul T-SQL procedurale: spezza `SET NOCOUNT ON`, scambia `WITH (NOLOCK)` per una CTE e divide `DECLARE @t TABLE`. Poor Man's produce uno stile da SSMS, è corretto anche su procedure, `IF`/`BEGIN`/`END`, `MERGE` e hint, e lascia intatti i commenti. Scrivere un formatter nostro avrebbe richiesto troppo lavoro per arrivare allo stesso livello.

## Consequences

- La licenza è AGPL-3.0: se Querydeck viene distribuito fuori dal team, il suo sorgente va reso disponibile alle stesse condizioni.
- Il pacchetto non viene aggiornato dal 2022: è codice C# transpilato in JavaScript con Bridge.NET. Legge la variabile `global` di Node (vedi `src/lib/node-global.ts`) e contiene un `new Function` che il formatter non usa, quindi funziona anche con la CSP senza `unsafe-eval`.
- Il formatter unisce `GO 5` alla riga precedente, perciò ogni Batch viene formattato da solo e le righe `GO` restano come sono scritte.
- Un risultato viene accettato solo se ha gli stessi token dello script di partenza: un errore del formatter può cambiare l'impaginazione, mai il codice.
- Il bundle pesa circa 1,2 MB e si carica solo alla prima formattazione.
