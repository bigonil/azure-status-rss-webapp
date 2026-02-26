# MCP Server for Azure RSS Webapp

Questo MCP server espone la webapp `azure-status-rss-webapp` a un ecosistema di Agenti AI tramite protocollo MCP (Model Context Protocol).

## Architettura

```text
AI Agent Host (Claude Desktop / IDE / orchestratore)
            |
            | MCP (stdio)
            v
  MCP Server (this project: mcp-server/server.mjs)
            |
            | HTTP REST (API già esistenti)
            v
  Azure RSS Webapp (Express)
```

## Decisione su API / API Gateway

### Serve un nuovo livello API tra MCP Server e applicazione?

No, **non è necessario** creare un nuovo layer API aggiuntivo in questa fase.

Motivo:
- la webapp ha già API REST stabili (`/api/health`, `/api/feeds`, `/api/events`, `/api/notifier`, `/api/notifier/check`)
- il MCP server funge da **adapter di protocollo** (MCP -> REST)
- introdurre un ulteriore gateway ora aumenterebbe complessità senza benefici immediati

### Quando valutare un API Gateway separato

Ha senso solo se vuoi:
- autenticazione centralizzata (JWT/OAuth/API key)
- rate limiting / throttling multi-tenant
- audit trail / policy enforcement
- esposizione internet pubblica del backend
- routing verso più servizi oltre alla webapp Azure RSS

## Prerequisiti

1. Webapp avviata (`npm start` oppure `docker compose up`)
2. Node.js >= 20
3. `npm install`

## Avvio MCP server (stdio)

```bash
npm run mcp:start
```

Config env (opzionali):
- `AZURE_RSS_APP_BASE_URL` (default `http://127.0.0.1:3000`)
- `AZURE_RSS_APP_TIMEOUT_MS` (default `15000`)

## Doctor mode (test connettività verso webapp)

```bash
npm run mcp:doctor
```

## Tool esposti dal MCP server

- `azure_rss_health`
- `azure_rss_feeds_summary`
- `azure_rss_list_events`
- `azure_rss_notifier_status`
- `azure_rss_notifier_check`

## Esempio config MCP (stdio, generico)

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

Nota: il formato preciso del file di configurazione dipende dall’host MCP (IDE / desktop app / orchestratore).
