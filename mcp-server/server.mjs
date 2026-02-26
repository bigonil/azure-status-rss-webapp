import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AzureRssApiClient, toPrettyJson } from "./api-client.mjs";

const SERVER_NAME = "azure-status-rss-mcp";
const SERVER_VERSION = "1.0.0";

function readCliOption(name, alias = null) {
  const args = process.argv.slice(2);
  const names = [name, alias].filter(Boolean);
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    for (const optionName of names) {
      const prefix = `${optionName}=`;
      if (token === optionName && args[i + 1]) return args[i + 1];
      if (token.startsWith(prefix)) return token.slice(prefix.length);
    }
  }
  return null;
}

const cliBaseUrl = readCliOption("--base-url", "--url");
const client = new AzureRssApiClient(cliBaseUrl || undefined);

function jsonTextResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: toPrettyJson(payload)
      }
    ]
  };
}

function errorTextResult(error, context = "Errore MCP") {
  return {
    content: [
      {
        type: "text",
        text: `${context}: ${String(error)}`
      }
    ],
    isError: true
  };
}

function buildServer() {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  });

  server.registerTool(
    "azure_rss_health",
    {
      title: "Azure RSS App Health",
      description: "Verifica salute della webapp Azure RSS e configurazione notifier.",
      inputSchema: {}
    },
    async () => {
      try {
        const health = await client.health();
        return jsonTextResult({
          targetBaseUrl: client.baseUrl,
          health
        });
      } catch (error) {
        return errorTextResult(error, "Health check fallito");
      }
    }
  );

  server.registerTool(
    "azure_rss_feeds_summary",
    {
      title: "Azure RSS Feeds Summary",
      description: "Ritorna il riepilogo dei feed RSS configurati e il conteggio eventi.",
      inputSchema: {
        refresh: z.boolean().optional().describe("Forza refresh del feed (bypass cache)")
      }
    },
    async ({ refresh = false }) => {
      try {
        const summary = await client.feeds({ refresh });
        return jsonTextResult({
          targetBaseUrl: client.baseUrl,
          summary
        });
      } catch (error) {
        return errorTextResult(error, "Recupero summary feed fallito");
      }
    }
  );

  server.registerTool(
    "azure_rss_list_events",
    {
      title: "Azure RSS List Events",
      description:
        "Elenca eventi dal feed Azure Status. Di default restituisce solo eventi fault/incident.",
      inputSchema: {
        onlyFaults: z
          .boolean()
          .optional()
          .default(true)
          .describe("true = solo fault/outage/degradation"),
        search: z
          .string()
          .optional()
          .describe("Filtro testuale (es. 'Europe', 'SQL', 'Storage')"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(50)
          .describe("Numero massimo di eventi da restituire"),
        refresh: z.boolean().optional().describe("Forza refresh del feed (bypass cache)")
      }
    },
    async ({ onlyFaults = true, search = "", limit = 50, refresh = false }) => {
      try {
        const events = await client.events({ onlyFaults, search, limit, refresh });
        return jsonTextResult({
          targetBaseUrl: client.baseUrl,
          query: { onlyFaults, search, limit, refresh },
          events
        });
      } catch (error) {
        return errorTextResult(error, "Recupero eventi fallito");
      }
    }
  );

  server.registerTool(
    "azure_rss_notifier_status",
    {
      title: "Azure RSS Notifier Status",
      description: "Legge stato e configurazione del notifier email della webapp.",
      inputSchema: {}
    },
    async () => {
      try {
        const status = await client.notifierStatus();
        return jsonTextResult({
          targetBaseUrl: client.baseUrl,
          notifier: status
        });
      } catch (error) {
        return errorTextResult(error, "Recupero stato notifier fallito");
      }
    }
  );

  server.registerTool(
    "azure_rss_notifier_check",
    {
      title: "Azure RSS Trigger Notifier Check",
      description:
        "Esegue POST /api/notifier/check per forzare un controllo immediato e (se applicabile) inviare email.",
      inputSchema: {}
    },
    async () => {
      try {
        const result = await client.notifierCheck();
        return jsonTextResult({
          targetBaseUrl: client.baseUrl,
          result
        });
      } catch (error) {
        return errorTextResult(error, "Trigger notifier fallito");
      }
    }
  );

  return server;
}

function buildDoctorHints(error) {
  const cause = error?.cause;
  const causeCode = cause?.code || error?.code || null;
  const hints = [];
  const examples = [];

  hints.push("`mcp:doctor` non avvia la webapp: verifica che sia già in esecuzione.");

  if (causeCode === "ECONNREFUSED") {
    hints.push(
      `Connessione rifiutata su ${client.baseUrl}: molto probabilmente la webapp non è attiva su quella porta.`
    );
  } else if (causeCode === "ETIMEDOUT" || causeCode === "UND_ERR_CONNECT_TIMEOUT") {
    hints.push(
      `Timeout di connessione verso ${client.baseUrl}: verifica firewall, porta e processo in ascolto.`
    );
  } else if (causeCode === "ENOTFOUND") {
    hints.push(
      `Host non risolto (${new URL(client.baseUrl).hostname}): controlla AZURE_RSS_APP_BASE_URL.`
    );
  } else if (String(error).includes("fetch failed")) {
    hints.push(
      "Errore di rete generico (`fetch failed`): webapp spenta, URL errato o porta diversa sono le cause più comuni."
    );
  }

  hints.push(
    "Se hai avviato `npm run start:mock`, usa l'URL stampato a console (`Webapp demo in ascolto su http://127.0.0.1:PORT`)."
  );

  examples.push({
    shell: "CMD",
    command:
      "set AZURE_RSS_APP_BASE_URL=http://127.0.0.1:PORT && npm run mcp:doctor"
  });
  examples.push({
    shell: "PowerShell",
    command:
      "$env:AZURE_RSS_APP_BASE_URL='http://127.0.0.1:PORT'; npm run mcp:doctor"
  });
  examples.push({
    shell: "Git Bash",
    command:
      "export AZURE_RSS_APP_BASE_URL='http://127.0.0.1:PORT' && npm run mcp:doctor"
  });
  examples.push({
    shell: "CLI direct override",
    command:
      "npm run mcp:doctor -- --base-url http://127.0.0.1:PORT"
  });

  return {
    probableCauseCode: causeCode,
    cause: cause ? String(cause) : null,
    hints,
    quickChecks: [
      `curl ${client.baseUrl}/api/health`,
      "npm run start:mock  (in un altro terminale)"
    ],
    examples
  };
}

async function runDoctor() {
  console.log(`MCP doctor -> target webapp: ${client.baseUrl}`);
  try {
    const [health, feeds, notifier] = await Promise.all([
      client.health(),
      client.feeds(),
      client.notifierStatus()
    ]);

    console.log(
      toPrettyJson({
        ok: true,
        targetBaseUrl: client.baseUrl,
        health,
        feedsSummary: {
          totalItems: feeds.totalItems,
          faultLikeItems: feeds.faultLikeItems,
          errors: feeds.errors
        },
        notifierSummary: {
          enabled: notifier.enabled,
          configured: notifier.configured,
          recipients: notifier.recipients,
          lastRunAt: notifier.status?.lastRunAt,
          lastError: notifier.status?.lastError
        }
      })
    );
    return 0;
  } catch (error) {
    const doctorHints = buildDoctorHints(error);
    console.error(
      toPrettyJson({
        ok: false,
        targetBaseUrl: client.baseUrl,
        error: String(error),
        ...doctorHints
      })
    );
    return 1;
  }
}

async function main() {
  if (process.argv.includes("--doctor")) {
    process.exitCode = await runDoctor();
    return;
  }

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Scriviamo su stderr per non rompere il protocollo stdio (stdout è riservato al trasporto MCP)
  console.error(
    `${SERVER_NAME}@${SERVER_VERSION} pronto (stdio). Target webapp: ${client.baseUrl}`
  );
}

main().catch((error) => {
  console.error(`${SERVER_NAME} fatal error: ${String(error)}`);
  process.exit(1);
});
