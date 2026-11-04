# Supporto Linux

Quervio viene distribuito pubblicamente sulle principali distribuzioni desktop senza
richiedere una build diversa per ogni versione. Non è possibile garantire
qualsiasi versione di Linux: contano architettura, kernel, runtime grafico e
librerie. La decisione è descritta nell'[ADR 0007](adr/0007-linux-support.md).

## Installazione

Scaricare il pacchetto per **Intel/AMD x64** dalla
[release pubblica più recente](https://github.com/devchristian1337/quervio/releases/latest).
I file pubblici si chiamano `Quervio-linux-x64.*`; i checksum sono nel file
`SHA256SUMS-linux-x64.txt` della release. La pipeline ARM64 è predisposta nel
sorgente, ma i relativi binari non fanno parte della release corrente.

Il formato consigliato per una distribuzione non specificata è Flatpak. Serve
Flatpak installato sul sistema; aprire il file `.flatpak` con il gestore software.
Su Intel/AMD, dalla cartella del download si può usare anche:

```bash
flatpak install --user ./Quervio-linux-x64.flatpak
```

Terminata l'installazione, avviare **Quervio** dal menu delle applicazioni.
Il pacchetto indica il repository Flathub da cui installare il runtime GNOME 50;
non serve avere il desktop GNOME. Non servono Node, Rust o un SDK .NET.
Il bundle è distribuito su GitHub Releases, non nel catalogo Flathub.

In alternativa, aprire il DEB/RPM con il gestore pacchetti della distribuzione.
L'AppImage è un file portabile da rendere eseguibile; richiede X11/XWayland e
le librerie di base compatibili. Per aggiornare Linux installare il pacchetto
della nuova release: le Connessioni salvate rimangono nella cartella dati utente.

## Formati

| Formato | Uso | Dipendenze dal sistema |
| --- | --- | --- |
| Flatpak | Copertura tra distribuzioni, anche con librerie di sistema meno recenti | Flatpak funzionante, runtime GNOME 50, desktop e portachiavi |
| AppImage | Un file eseguibile senza installer | glibc almeno pari alla macchina di build, desktop e portachiavi; FUSE oppure estrazione |
| DEB | Ubuntu/Debian e derivate | WebKitGTK 4.1 e dipendenze risolte dal gestore pacchetti |
| RPM | Distribuzioni con pacchetti RPM | WebKitGTK 4.1 e dipendenze risolte dal gestore pacchetti |

Ogni architettura richiede il proprio pacchetto. La release corrente distribuisce
x86_64 (Intel/AMD a 64 bit); aarch64 è predisposto nel codice e nel workflow,
senza un binario pubblico verificato. Non sono previste build a 32 bit o musl
native. Flatpak può usare il suo runtime anche su un host con librerie diverse,
purché Flatpak stesso sia supportato.

Il workflow `.github/workflows/linux.yml`, avviato manualmente, costruisce su
Ubuntu 22.04 per entrambe le architetture. La glibc di questa base è 2.35.
Una build locale su Ubuntu 24.04 può invece richiedere glibc 2.39: l'AppImage
non elimina questo vincolo. Senza parametri il workflow conserva gli artefatti
di verifica. Specificando `release_tag`, costruisce quel tag e carica i pacchetti
verificati nella release GitHub in bozza; la pubblicazione avviene dopo il
completamento anche dei pacchetti Windows.

La release 0.1.33 usa la compilazione locale verificata su Ubuntu 24.04 x64,
con caricamento diretto dei pacchetti sulla release.
Flatpak usa il proprio runtime GNOME 50 ed è il formato da preferire su sistemi
con librerie di base meno recenti. I pacchetti nativi locali non vanno descritti
come build prodotte sulla base Ubuntu 22.04 del workflow.

## Requisiti e funzioni

- Non serve installare SQL Server sul PC Linux: il Server può essere remoto,
  anche Windows. Le Schede query continuano a usare Sessioni Rust dedicate,
  con transazioni, tabelle temporanee e annullamento.
- Le password delle Connessioni salvate sono nel portachiavi Secret Service
  della sessione desktop (GNOME Keyring, oppure KWallet con il servizio
  abilitato). Il servizio deve essere attivo e sbloccato. Non vengono scritte
  password in chiaro e i file DPAPI di Windows non si possono importare come
  password Linux.
- Bridge Microsoft .NET 10 e SQL Tools Service Linux sono inclusi dal packaging.
  Non serve un SDK .NET all'utente finale. Le librerie native .NET richiedono
  ICU, OpenSSL, Kerberos e libsecret; il runtime Flatpak o il sistema devono
  fornirle. ODBC richiede driver e unixODBC per la stessa architettura.
- L'autenticazione integrata su Linux dipende da Kerberos e dai ticket
  dell'utente. Entra richiede un browser e il portachiavi protetto. Queste
  configurazioni richiedono prove dedicate, oltre alla compilazione.
- La creazione e la rotazione delle chiavi Always Encrypted e la migrazione
  delle colonne usano l'archivio certificati Windows: restano funzioni Windows.
  Il bridge restituisce un messaggio esplicito su Linux.
- SQLCMD usa `/bin/sh` per i comandi locali confermati. La sintassi dei comandi
  Windows non viene tradotta in sintassi shell Linux. I consensi per include
  e comandi locali e le conferme amministrative restano necessari.
- I pacchetti Linux iniziali si aggiornano installando la nuova versione.
  Gli aggiornamenti Velopack automatici restano disponibili su Windows.

Flatpak include le risorse dell'app e i componenti Microsoft, mentre il runtime
GNOME si installa separatamente. Il sandbox permette accesso alla rete, al
desktop, al portachiavi e alla home per aprire/salvare script e file. Driver
ODBC e configurazioni Kerberos necessari dentro il sandbox richiedono
predisposizione specifica. Le conferme dell'app non vengono aggirate.

## Build

Usare Linux nativo, una VM oppure WSL con gli strumenti Linux, evitando di
riutilizzare `node_modules` e `target` costruiti per Windows. Servono Rust
stable, Node 24+, pnpm 10, SDK .NET 10 e le dipendenze Tauri per Linux.

Su Ubuntu, i prerequisiti di compilazione sono:

```bash
sudo apt-get install build-essential curl pkg-config libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libssl-dev libdbus-1-dev libkrb5-dev libicu-dev libsecret-1-0 libodbc2
```

Dalla radice del repository:

```bash
bash scripts/pack-linux.sh
```

Lo script installa le dipendenze frontend dal lockfile, pubblica e verifica il
bridge Linux, scarica SQL Tools Service con SHA-256 verificato e genera AppImage,
DEB e RPM sotto `target/release/bundle` (oppure nella `CARGO_TARGET_DIR` impostata).
Non modifica Git e non pubblica nulla. Il download a runtime di SQL Tools
Service, se necessario, richiede Bash, curl, tar e sha256sum.

Compilazione e confezionamento sono separati: `scripts/bundle-linux.sh` può
ricreare i pacchetti da un eseguibile release già compilato, ripreparando le
risorse e verificando nuovamente il bridge senza ricompilare Rust.

Per aggiungere Flatpak servono `flatpak`, `flatpak-builder`, `dpkg-deb` e il
runtime/SDK GNOME 50 disponibili nel remoto Flathub configurato per l'utente:

```bash
flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
```

```bash
flatpak install --user flathub org.gnome.Platform//50 org.gnome.Sdk//50
```

Quindi:

```bash
bash scripts/pack-linux.sh --flatpak
```

Se i pacchetti nativi sono già costruiti basta:

```bash
bash scripts/pack-flatpak.sh
```

Il bundle è in `target/flatpak`, insieme al repository locale. Non è una
pubblicazione su Flathub.

## Pubblicazione delle release

Windows e Linux condividono versione, commit e release GitHub. Preparare il
commit con le quattro versioni allineate come descritto in `AGENTS.md`, fare
push e creare una release in bozza sul commit esatto. Avviare il workflow
**Linux packages** indicando quel tag in `release_tag`: costruisce e prova
AppImage e Flatpak per x64 e ARM64 e carica tutti e quattro i formati per
ciascuna architettura, con checksum separati. I nomi pubblici sono preparati da
`scripts/stage-linux-release.sh`, così i link `releases/latest/download` del
README restano validi nelle release successive.

Per Windows `scripts/pack-velopack.ps1 -Publish -Draft` prepara Velopack,
scarica la versione precedente per il delta e aggiunge i file alla stessa
bozza senza esporre una release incompleta. Dopo aver verificato entrambe le
architetture Linux, gli asset Windows e il commit del tag, pubblicare la bozza
come release stabile più recente. Il workflow Linux rifiuta l'upload su una
release già pubblicata. Non pubblicare future release con i soli asset Windows.

## Verifiche

I test normali restano `cargo test --locked --workspace`, `pnpm test` e
`pnpm build`. Le integrazioni SQL usano esclusivamente le impostazioni
`QUERVIO_TEST_*` del README.

Il test reale del portachiavi si avvia così, con GNOME Keyring e dbus-run-session
installati:

```bash
bash scripts/test-linux-keyring.sh
```

Lo script crea un bus D-Bus e cartelle XDG temporanei: non legge le Connessioni
salvate o il portachiavi del desktop dell'utente.

I test Unix dei processi verificano che annullare una shell termini anche i
suoi discendenti. Il self-test del bridge verifica i formati e le operazioni
offline; non certifica SQL Server, Entra, Kerberos o i driver ODBC.

Per una prova nativa dell'AppImage già costruita, senza `?mock`, servono anche
`tauri-driver` 2.1.0, `WebKitWebDriver` (pacchetto Ubuntu `webkit2gtk-driver`),
Xvfb, `unsquashfs` (pacchetto `squashfs-tools`) e GNOME Keyring:

```bash
bash scripts/test-linux-native.sh
```

Il test avvia il pacchetto con WebKitGTK reale in un display Xvfb e un profilo
XDG temporanei. Verifica rendering, sfondo opaco, chiamate Tauri, componenti
Microsoft inclusi, salvataggio/eliminazione di una Connessione salvata di prova
nel portachiavi e lettura/scrittura di file SQL Unicode. Non apre Sessioni SQL
e non usa dati o password dell'utente. Screenshot e riscontro sono in
`target/linux-smoke/appimage`, oppure nella `CARGO_TARGET_DIR` impostata.

Con il Flatpak installato per l'utente, lo stesso test si può eseguire nel
sandbox, sempre con dati e portachiavi temporanei:

```bash
QUERVIO_NATIVE_FORMAT=flatpak bash scripts/test-linux-native.sh
```

Il test concede al solo processo di prova l'accesso alla propria cartella
temporanea; i permessi del pacchetto distribuito non vengono modificati.
Il riscontro Flatpak è in `target/linux-smoke/flatpak`.

## Verifiche eseguite — 4 novembre 2026

Prove locali iniziali del porting, versione 0.1.32, su Ubuntu 24.04 x86_64 in WSL2.
Le build pubbliche successive sono verificate per architettura dal
[workflow Linux](https://github.com/devchristian1337/quervio/actions/workflows/linux.yml).

| Verifica | Esito |
| --- | --- |
| Suite Rust Windows | 87 test passati |
| Suite Rust Linux | 85 test passati |
| Portachiavi Linux reale su bus privato | Passato: rilettura, sostituzione, eliminazione e separazione dei profili |
| Frontend | 104 test passati; build TypeScript/Vite passata |
| UI browser pertinente | 11 test passati; un timeout iniziale di caricamento è passato alla ripetizione |
| Bridge .NET Linux | 9 self-test passati anche dopo la preparazione delle risorse |
| SQL Server 2022, istanza Linux dedicata e temporanea | 27 test di integrazione passati: catalogo, esecuzioni, annullamento, transazioni, precisione e protezioni amministrative |
| SQL Tools Service Linux | Test reale passato: modifiche del documento e diagnostica |
| AppImage confezionata | Avvio WebKitGTK/Xvfb, IPC, risorse incluse, bridge, portachiavi, file Unicode e login/catalogo SQL reali passati |
| Flatpak con runtime GNOME 50 | Stesse prove native nel sandbox e login/catalogo SQL reali passati |
| Pacchetti | Generati AppImage, DEB, RPM e Flatpak; installato e provato il Flatpak |

Il test del rilevamento rapido dell'istanza locale tramite registro viene
compilato solo su Windows: su Linux viene tentata la normale connessione TCP.
Nessun database di produzione o Connessione salvata dell'utente è stato usato.

Le prove locali iniziali non coprono ARM64 o Ubuntu 22.04; il loro riscontro è
nel workflow della release. Restano da verificare altre distribuzioni,
sessioni Wayland e GPU/DPI reali, Entra, Kerberos e driver ODBC specifici. Le
prove SQL coprono SQL Server 2022 con login SQL e certificato del laboratorio,
non certificano ogni versione o configurazione SQL Server. I pacchetti locali
sono costruiti su Ubuntu 24.04; per host con librerie meno recenti usare Flatpak.
