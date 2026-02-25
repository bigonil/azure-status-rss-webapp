# Azure Status RSS Fault Webapp (Docker)

Webapp semplice (backend + UI) che legge il feed RSS ufficiale Microsoft Azure Status e mostra gli eventi filtrando quelli relativi a fault/incident/outage.

## Feed ufficiale usato

- `https://azure.status.microsoft/en-us/status/feed/` (ufficiale Microsoft)
- Il vecchio URL `https://status.azure.com/en-us/status/feed/` reindirizza a quello sopra.

Nota: il feed può essere vuoto quando non ci sono incidenti pubblicati.

## Avvio con Docker Compose

```bash
docker compose up --build
```

Apri:

- UI: `http://localhost:3000`
- API feed summary: `http://localhost:3000/api/feeds`
- API eventi: `http://localhost:3000/api/events?onlyFaults=1`

## Configurazione (env)

- `PORT` (default `3000`)
- `AZURE_RSS_FEEDS` (lista separata da virgole, default feed ufficiale Azure Status)
- `CACHE_TTL_MS` (default `60000`)
- `REQUEST_TIMEOUT_MS` (default `10000`)

## Avvio locale senza Docker

```bash
npm install
npm start
```
