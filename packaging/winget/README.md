# Quervio su WinGet

Gli utenti Windows installano Quervio con:

```powershell
winget install devchristian1337.Quervio
```

WinGet serve solo alla prima installazione: dopo, Quervio si aggiorna da solo con
Velopack ([ADR 0005](../../docs/adr/0005-installer-velopack.md)). Il manifest
installa `Quervio.App-win-Setup.exe` con `--silent`, per utente, e riconosce
l'installazione dalla voce `Quervio.App` di App installate, che Velopack aggiorna
a ogni versione.

## Primo invio

`0.1.35/` contiene il manifest (schema 1.28.0) del primo invio,
[microsoft/winget-pkgs#473334](https://github.com/microsoft/winget-pkgs/pull/473334).
Dopo l'approvazione la fonte del manifest è winget-pkgs e quella cartella si può
rimuovere.

L'invio è partito con `wingetcreate submit`, che ha creato il fork
`devchristian1337/winget-pkgs`; wingetcreate 1.12.13 accetta manifest fino allo
schema 1.12.0, quindi lo schema 1.28.0 è stato applicato poi sul branch della
pull request. La revisione di Microsoft richiede in genere alcuni giorni:
l'installer non è firmato, quindi può ricevere controlli aggiuntivi.

Per provare il manifest in locale, `winget install --manifest` richiede
l'impostazione `LocalManifestFiles`, che si attiva da un terminale amministratore:

```powershell
winget settings --enable LocalManifestFiles
winget install --manifest packaging\winget\0.1.35
winget settings --disable LocalManifestFiles
```

## Versioni successive

Il workflow [WinGet](../../.github/workflows/winget.yml) parte quando una bozza
di release viene pubblicata e apre la pull request della nuova versione dal fork,
riprendendo il manifest precedente con il nuovo URL e lo SHA256. Richiede:

- il pacchetto già presente in winget-pkgs (primo invio approvato);
- il fork `devchristian1337/winget-pkgs`;
- il segreto di repository `WINGET_TOKEN`: un token GitHub classico con il solo
  scope `public_repo`, registrato con `gh secret set WINGET_TOKEN --repo devchristian1337/quervio`,
  che lo legge dallo standard input.

Per inviare di nuovo una release già pubblicata: Actions › WinGet › Run workflow,
con il tag (per esempio `v0.1.36`).
