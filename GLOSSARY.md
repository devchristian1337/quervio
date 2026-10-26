# Quervio

Strumento desktop per chi fa supporto e sviluppo su SQL Server: navigare i database, scrivere ed eseguire T-SQL, leggere i risultati. Ispirato a SQL Server Management Studio, con un'interfaccia moderna e veloce.

## Connessioni

**Server** (Server):
Un'istanza SQL Server raggiungibile, identificata da host, nome istanza o porta.
_Avoid_: host, macchina, DB

**Connessione salvata** (Saved Connection):
La definizione persistente di come raggiungere un Server: indirizzo, metodo di autenticazione, credenziali, database predefinito e Ambiente.
_Avoid_: profilo, connection string, connessione (da sola)

**Ambiente** (Environment):
La classificazione di rischio di una Connessione salvata: Produzione, Test o Sviluppo. Determina il colore mostrato e le protezioni applicate.
_Avoid_: tag, etichetta, stage

**Sessione** (Session):
Una connessione attiva a un Server con il suo stato: database corrente, opzioni `SET`, tabelle temporanee, transazioni aperte.
_Avoid_: connessione (da sola), link

## Esecuzione

**Scheda query** (Query Tab):
Un documento T-SQL modificabile, legato a una sola Sessione dedicata per tutta la sua vita.
_Avoid_: finestra, editor, tab

**Batch** (Batch):
Una porzione dello script delimitata da `GO`, inviata al Server come unità.
_Avoid_: blocco, statement

**Esecuzione** (Execution):
L'invio dello script di una Scheda query, o della sua selezione, come sequenza di Batch, con i Result set e i Messaggi che produce.
_Avoid_: run, lancio

**Result set** (Result Set):
Una tabella di righe restituita da una singola istruzione durante un'Esecuzione.
_Avoid_: risultato, griglia, tabella

**Messaggio** (Message):
Un output del Server che non è un Result set: testo di `PRINT`, conteggio delle righe interessate, avvisi ed errori.
_Avoid_: log, output

**Istruzione distruttiva** (Destructive Statement):
Un'istruzione che può distruggere o alterare in massa dati o struttura: una Scrittura non filtrata, `TRUNCATE TABLE`, `DROP` o `ALTER TABLE`.
_Avoid_: query pericolosa, comando rischioso

**Scrittura non filtrata** (Unfiltered Write):
Un'istruzione `UPDATE` o `DELETE` senza clausola `WHERE`; è un tipo di Istruzione distruttiva.
_Avoid_: update/delete globale

## Catalogo

**Object Explorer** (Object Explorer):
L'albero di navigazione Server → Database → Oggetti, che può mostrare più Server insieme.
_Avoid_: sidebar, albero, navigator

**Oggetto** (Database Object):
Un elemento di un database mostrato nell'Object Explorer: tabella, vista, stored procedure, funzione, trigger, colonna, chiave, indice.
_Avoid_: entità, elemento

**Modulo** (Module):
Un Oggetto la cui definizione è codice T-SQL: vista, stored procedure, funzione o trigger.
_Avoid_: routine, programmabilità
