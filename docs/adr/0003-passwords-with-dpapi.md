# Password delle Connessioni salvate cifrate con DPAPI, non in Credential Manager

Le password delle Connessioni salvate stanno in un file a parte (`secrets.json` in `%APPDATA%`), ognuna cifrata con DPAPI per l'utente Windows corrente e con un'entropia propria di Quervio. All'inizio avevamo scelto Windows Credential Manager, ma sul PC di sviluppo `CredWrite` fallisce sempre ("risorse di memoria insufficienti", anche con `cmdkey` e senza criteri di gruppo che lo spieghino), mentre DPAPI funziona. È lo stesso meccanismo che usa SSMS per le password salvate: solo lo stesso utente Windows sulla stessa macchina può decifrarle.

## Consequences

- Copiare `secrets.json` su un altro PC o profilo non serve: le password vanno reinserite.
- Il file delle connessioni resta leggibile e privo di segreti, quindi si può condividere senza rischi.
- L'entropia è ancora `Querydeck saved connection`, dal primo nome dell'app: se cambiasse, nessuna password salvata sarebbe più leggibile.
