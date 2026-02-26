# Azure Status RSS Fault Webapp (Docker)

Webapp semplice (backend + UI) che legge il feed RSS ufficiale Microsoft Azure Status e mostra gli eventi filtrando quelli relativi a fault/incident/outage.

Include anche un notifier email opzionale: se rileva nuovi fault/outage con riferimenti a regioni europee (es. `West Europe`, `North Europe`, `Italy North`, `Europe`, ecc.) invia una mail con i dettagli.

## Feed ufficiale usato

- `https://azure.status.microsoft/en-us/status/feed/` (ufficiale Microsoft)
- Il vecchio URL `https://status.azure.com/en-us/status/feed/` reindirizza a quello sopra.

Nota: il feed può essere vuoto quando non ci sono incidenti pubblicati.

## Avvio con Docker Compose

```bash
docker compose up --build
```

## Avvio con NPM (cartella definitiva `azure-status-rss-webapp`)

Entra nella cartella del progetto:

```bash
cd azure-status-rss-webapp
```

Avvio normale:

```bash
npm install
npm start
```

Demo locale con feed mock + SMTP mock (per testare il pulsante notifier dalla UI):

```bash
npm install
npm run start:mock
```

Apri:

- UI: `http://localhost:3000`
- API feed summary: `http://localhost:3000/api/feeds`
- API eventi: `http://localhost:3000/api/events?onlyFaults=1`
- API notifier status: `http://localhost:3000/api/notifier`

Se ricevi `Cannot GET /api/notifier`, in genere stai colpendo:
- un container vecchio non rebuildato
- la porta/servizio sbagliato
- il compose lanciato dalla directory sbagliata

Verifica di essere nella cartella `azure-status-rss-webapp` e rilancia con rebuild.

## Configurazione (env)

- `PORT` (default `3000`)
- `AZURE_RSS_FEEDS` (lista separata da virgole, default feed ufficiale Azure Status)
- `CACHE_TTL_MS` (default `60000`)
- `REQUEST_TIMEOUT_MS` (default `10000`)
- `EMAIL_NOTIFICATIONS_ENABLED` (`true/false`, default `false`)
- `ALERT_EMAIL_TO` (default `luca.bigoni@gruppohera.it`)
- `ALERT_EMAIL_FROM` (mittente email)
- `NOTIFY_POLL_MS` (intervallo polling feed per notifiche, default `300000`)
- `NOTIFY_MAX_ITEM_AGE_HOURS` (evita notifiche su eventi troppo vecchi, default `72`)
- `EUROPE_REGION_KEYWORDS` (lista keyword custom per identificare eventi europei)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` (config SMTP)

## Abilitare notifiche email (Europa)

1. Copia `.env.example` in `.env`
2. Imposta i parametri SMTP reali
3. Avvia con Docker Compose

```bash
docker compose up --build
```

Il container salva lo stato delle notifiche già inviate in `data/notified-events.json` (montato come volume) per evitare duplicate dopo riavvii.

## Test con SMTP mock (MailHog) + feed mock

Questo setup crea:
- `mailhog` (SMTP mock + UI web per vedere le email)
- `mock-rss` (feed RSS fittizio con outage in `West Europe`)

Avvio:

```bash
docker compose -f docker-compose.yml -f docker-compose.mock.yml up --build
```

Trigger manuale notifier:

```bash
curl -X POST http://localhost:3000/api/notifier/check
```

Verifica email:
- UI MailHog: `http://localhost:8025`
- API status notifier: `http://localhost:3000/api/notifier`

Verifica automatica (opzionale):

```bash
node scripts/verify-mock-notification.js
```

## Test locale senza Docker (mock SMTP Node)

Se Docker Desktop non è disponibile, puoi simulare un server SMTP locale con `smtp-server` e testare l’invio end-to-end:

```bash
npm install
npm run test:notifier:mock
```

Il test avvia temporaneamente:
- feed RSS mock (con evento `West Europe outage`)
- SMTP mock locale
- app Express (in-process)

e verifica che la mail sia stata ricevuta dal mock SMTP.

Nota: se hai già inviato la notifica mock una volta, la deduplica potrebbe impedire nuovi invii. Per ritestare:
- elimina `data/notified-events.json`, oppure
- cambia il `guid` in `mock-rss/feed.xml`.

## Avvio locale senza Docker

```bash
npm install
npm start
```
