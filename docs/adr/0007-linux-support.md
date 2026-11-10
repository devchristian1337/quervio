# Linux: pacchetti nativi e Flatpak, password nel portachiavi del desktop

Quervio deve essere installabile pubblicamente anche sulle principali
distribuzioni Linux. Il frontend React e il driver Rust restano gli
stessi; non usiamo Wine e non cambiamo le Sessioni dedicate delle Schede query.

## Decisione

- Costruiamo nativamente per x86_64 e aarch64. Il workflow Linux usa Ubuntu
  22.04 come base per limitare il requisito glibc dei pacchetti AppImage, DEB e
  RPM. Un pacchetto costruito su una distribuzione più recente può richiedere
  librerie più recenti: non va presentato come equivalente alla build di base.
- Offriamo anche un bundle Flatpak con runtime GNOME 50. Il runtime porta
  WebKitGTK e le librerie di base, riducendo la dipendenza dalle versioni
  installate sul sistema ospite. Flatpak richiede comunque un host compatibile,
  un desktop grafico e un'architettura corrispondente. Nessun formato garantisce
  il funzionamento su qualsiasi distribuzione, kernel o hardware mai esistito.
- Windows mantiene DPAPI e il formato di `secrets.json` dell'ADR 0003. Linux
  usa Secret Service tramite il crate `keyring` 4.2.0 (backend zbus), con cifratura sul bus.
  Serve un provider sbloccato nella sessione desktop, come GNOME Keyring o
  KWallet con Secret Service abilitato. Non esiste un ripiego su file in chiaro.
  Le voci sono separate per cartella dati e id della Connessione salvata.
- Il bridge .NET viene pubblicato self-contained per l'architettura Linux.
  SQL Tools Service è una distribuzione ufficiale Microsoft, con versione e
  SHA-256 fissati separatamente per x64 e ARM64. Il packaging include entrambi
  i componenti; non distribuisce gli eseguibili Windows su Linux.
  Il solo provider opzionale di profiling CoreCLR/LTTng viene escluso: richiede
  `liblttng-ust.so.0`, assente sulle distribuzioni con la nuova ABI. Non è usato
  dalle funzioni SQL o dagli Extended Events. I self-test verificano il bridge
  dopo questa preparazione; i file distribuiti hanno permessi leggibili anche
  quando il pacchetto li installa come root.
- Le risorse Tauri e la finestra hanno configurazioni per piattaforma. Su Linux
  la finestra è opaca e il tema dipinge lo sfondo; su Windows restano Mica e
  l'avvio massimizzato sul monitor principale.
- I comandi locali SQLCMD usano `/bin/sh -c` su Linux e `cmd.exe` su Windows,
  dopo gli stessi consensi e la stessa anteprima già previsti. Su Unix ciascun
  processo avviato viene assegnato a un proprio gruppo per annullarne anche i
  discendenti.

## Conseguenze

- La creazione/rotazione delle chiavi Always Encrypted e la migrazione delle
  colonne, implementate con l'archivio certificati Windows, restano operazioni
  Windows: il bridge le rifiuta esplicitamente su Linux.
- Kerberos dipende dai ticket e dalla configurazione del sistema; ODBC dipende
  dai driver installati per l'architettura corretta (nel sandbox per Flatpak).
  Il porting non costituisce una certificazione di queste integrazioni.
- Velopack e gli aggiornamenti automatici Windows restano disponibili. Linux
  si aggiorna installando il nuovo pacchetto. Il workflow verifica entrambe le
  architetture e può caricare i pacchetti in una release GitHub in bozza, sullo
  stesso tag di Windows. La bozza viene pubblicata dopo aver verificato tutti
  gli asset. I download pubblici hanno nomi stabili e checksum per architettura.
- Il bundle Flatpak concede rete, visualizzazione, accesso al portachiavi e
  alla cartella home per script, include, import ed export. Restano in vigore
  i consensi SQLCMD e le conferme delle operazioni amministrative.

## Riferimenti

- [Tauri: limiti delle AppImage](https://v2.tauri.app/distribute/appimage/)
- [Tauri: Flatpak](https://v2.tauri.app/distribute/flatpak/)
- [Keyring 4.2.0: backend Secret Service](https://docs.rs/keyring/4.2.0/keyring/)
- [.NET: provider nativi per ETW/LTTng](https://github.com/dotnet/designs/blob/main/accepted/2020/single-file/design.md)

Per build, distribuzione e verifiche effettivamente eseguite vedere
[Supporto Linux](../linux.md).
