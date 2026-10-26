# I Result set restano nel backend Rust

Le righe di un Result set vengono lette dal Server in streaming e tenute nel processo Rust in formato compatto. La griglia nel WebView chiede solo la finestra di righe visibile mentre l'utente scorre. Spedire tutte le righe a JavaScript era più semplice, ma con 1M di righe vuol dire centinaia di MB di oggetti JS, pause del garbage collector e scrolling a scatti, contro l'obiettivo "risultati grandi fluidi".

## Consequences

- Copia, esportazione CSV e ordinamento lavorano sui dati lato Rust, non sulla griglia.
- La memoria dei Result set va liberata in modo esplicito quando una Scheda query viene chiusa o rieseguita.
