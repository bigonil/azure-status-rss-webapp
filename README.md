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
- `AZURE_RSS_APP_BASE_URL`, `AZURE_RSS_APP_TIMEOUT_MS` (usati dal MCP server verso la webapp)

## Integrazione MCP (Agenti AI)

Il progetto include un MCP server (`mcp-server/server.mjs`) che espone la webapp agli Agenti AI tramite protocollo MCP, usando le API REST già presenti come backend.

Comandi:

```bash
npm run mcp:start
npm run mcp:doctor
```

Documentazione dettagliata:
- `mcp-server/README.md`

## Avvio completo con MOCK + MCP (step-by-step)

Questa procedura avvia tutto in locale senza dipendenze esterne:
- webapp Azure RSS
- feed RSS mock (evento `West Europe`)
- SMTP mock (per verificare invio email)
- MCP server (stdio) per integrazione con Agenti AI

### 1. Apri la cartella del progetto

```bash
cd azure-status-rss-webapp
```

### 2. Installa dipendenze

```bash
npm install
```

### 3. Avvia la demo mock della webapp (feed mock + SMTP mock inclusi)

```bash
npm run start:mock
```

Cosa fa:
- avvia la webapp Express
- avvia un feed RSS mock locale
- avvia un SMTP mock locale
- abilita il notifier email verso il mock SMTP

Output atteso (simile):
- `Webapp demo in ascolto su http://127.0.0.1:3000`
- `Feed mock: http://127.0.0.1:xxxxx/feed.xml`
- `SMTP mock: smtp://127.0.0.1:xxxxx`

Nota: se la porta `3000` è occupata, la demo usa automaticamente una porta libera e stampa l'URL corretto.

### 4. Verifica la UI e il pulsante notifier

Apri nel browser l'URL stampato a console (es. `http://127.0.0.1:3000` oppure una porta diversa).

Controlla che siano presenti:
- pulsante `Test Notifier Email`
- elenco eventi (dal feed mock)

### 5. Prova l'invio notifica mock dalla UI

1. Clicca `Test Notifier Email`
2. La UI esegue `POST /api/notifier/check`
3. Dovresti vedere un messaggio di esito (email inviata / nessun nuovo evento / errore)

Le email mock ricevute vengono salvate in:
- `data/mock-smtp/` (`.eml` + `.json`)

### 6. (Opzionale) Verifica automatica notifier mock

In un altro terminale:

```bash
npm run test:notifier:mock
```

Questo test avvia un ambiente temporaneo e verifica automaticamente che una mail venga ricevuta dal mock SMTP.

### 7. Avvia il MCP server (stdio) puntando alla webapp mock

Apri **un altro terminale** nella stessa cartella `azure-status-rss-webapp`.

Se la webapp mock è su `3000`:

```bash
npm run mcp:start
```

Se la webapp mock è partita su una porta diversa (es. `57549`), imposta la base URL prima di avviare MCP.

PowerShell:

```powershell
$env:AZURE_RSS_APP_BASE_URL="http://127.0.0.1:57549"
npm run mcp:start
```

Git Bash:

```bash
export AZURE_RSS_APP_BASE_URL="http://127.0.0.1:57549"
npm run mcp:start
```

### 8. Verifica MCP -> webapp con doctor mode

In un terminale separato (stessa cartella):

PowerShell (se porta non standard):

```powershell
$env:AZURE_RSS_APP_BASE_URL="http://127.0.0.1:57549"
npm run mcp:doctor
```

Git Bash (se porta non standard):

```bash
export AZURE_RSS_APP_BASE_URL="http://127.0.0.1:57549"
npm run mcp:doctor
```

Output atteso:
- `ok: true`
- `feedsSummary.totalItems` > 0 (con mock feed)
- `notifierSummary.enabled: true`

Override diretto della URL (senza env), utile per debug rapido:

```bash
npm run mcp:doctor -- --base-url http://127.0.0.1:57549
```

### 9. Configura un host MCP (IDE / Agent runtime)

Usa `mcp-server/server.mjs` come comando `stdio`.

Esempio (generico):

```json
{
  "mcpServers": {
    "azure-rss-status": {
      "command": "node",
      "args": ["C:\\\\Users\\\\luca.bigoni\\\\azure-status-rss-webapp\\\\mcp-server\\\\server.mjs"],
      "env": {
        "AZURE_RSS_APP_BASE_URL": "http://127.0.0.1:3000"
      }
    }
  }
}
```

Se la demo mock non usa `3000`, sostituisci il valore con la porta stampata da `start:mock`.

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
