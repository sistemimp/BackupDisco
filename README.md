# Backup Disco (Electron)

App desktop Electron per backup schedulati di una o piu cartelle locali verso una cartella su disco esterno.

## Funzionalita
- Configurazioni multiple (profili) salvate in modo persistente.
- Ogni configurazione puo avere:
  - piu cartelle sorgente
  - una cartella destinazione
  - schedulazione dedicata
- Backup manuale immediato sulla configurazione attiva.
- Schedulazione:
  - ogni N minuti
  - ogni giorno a un orario specifico
- Confronto file per metadati e dimensione.
- Rilevamento file spostati tra sottocartelle (all'interno della stessa sorgente):
  - firma file `dimensione + mtime + hash parziale`
  - se la firma esiste gia in destinazione ma in un path diverso, il file viene spostato in destinazione invece di ricopiato.
- Log eventi nell'interfaccia.

## Avvio
```bash
npm install
npm start
```

## Aggiornamenti automatici
- Integrato `electron-updater`.
- In build pacchettizzata controlla aggiornamenti automaticamente all'avvio e ogni 6 ore.
- In sviluppo locale (`npm start`) l'auto-update non scarica update reali.
- Puoi sovrascrivere il feed aggiornamenti con variabile ambiente:
  - `UPDATE_FEED_URL=https://tuo-server/updates/`

## Persistenza configurazioni
- Configurazioni salvate in: `%USERPROFILE%\\.backup-disco\\config.json`
- Non serve reinserire le cartelle a ogni avvio.

## Struttura destinazione
Per evitare collisioni tra sorgenti diverse, ogni cartella sorgente viene salvata in una sottocartella dedicata dentro la destinazione.

## Note tecniche
- Indice backup salvato in destinazione: `.backup-index.json`
- I file in destinazione non presenti in sorgente non vengono cancellati automaticamente.
