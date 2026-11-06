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

`0.1.35/` contiene il manifest per il primo invio al repository
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs). Dopo
l'approvazione la fonte del manifest è winget-pkgs e quella cartella si può
rimuovere.

```powershell
winget validate --manifest packaging\winget\0.1.35
winget install Microsoft.WingetCreate
wingetcreate submit --prtitle "New package: devchristian1337.Quervio version 0.1.35" packaging\winget\0.1.35
```

Senza `--token`, `wingetcreate` apre l'accesso a GitHub nel browser; crea anche
il fork `devchristian1337/winget-pkgs` da cui parte la pull request. La revisione
di Microsoft richiede in genere alcuni giorni: l'installer non è firmato, quindi
può ricevere controlli aggiuntivi.

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
