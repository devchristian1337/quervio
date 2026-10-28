# Installer e aggiornamenti con Velopack, non con l'installer NSIS di Tauri

Quervio si installa con il `Setup.exe` di Velopack e si aggiorna da solo dalle GitHub Release di `devchristian1337/quervio` (il repository deve essere pubblico: l'app non incorpora token). Tauri compila soltanto (`pnpm tauri build --no-bundle`); `scripts/pack-velopack.ps1` mette accanto all'exe le stesse risorse di `bundle.resources` e crea con `vpk` il setup, i pacchetti completi e delta e il feed. L'installer NSIS non aveva un meccanismo di aggiornamento: ogni versione andava riscaricata e reinstallata a mano.

## Consequences

- L'installazione è per utente, in `%LOCALAPPDATA%\Quervio.App`, senza diritti di amministratore e senza procedura guidata: niente pagine con `header.bmp`/`sidebar.bmp` né scelta della lingua. L'id del pacchetto non è `Quervio` perché NSIS installava in `%LOCALAPPDATA%\Quervio`.
- Chi ha già Quervio installato con NSIS deve disinstallarlo da Impostazioni di Windows; i dati in `%APPDATA%\com.quervio.app` restano e la nuova installazione li ritrova.
- Il bridge Microsoft e SQL Tools Service girano dalla cartella di installazione: prima di applicare un aggiornamento l'app li termina, altrimenti i file sarebbero bloccati.
- `vpk` è fissato in `dotnet-tools.json` alla stessa versione del crate `velopack` (1.2.161): vanno aggiornati insieme.
- La configurazione NSIS in `tauri.conf.json` resta: `pnpm tauri build` produce ancora quell'installer, che però non si aggiorna da solo.
