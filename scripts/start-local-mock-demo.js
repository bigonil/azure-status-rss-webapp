const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { SMTPServer } = require("smtp-server");

function startMockFeed() {
  let seq = 1;

  const server = http.createServer((req, res) => {
    const now = new Date();
    const currentSeq = seq++;
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>Azure Status Mock Feed (Local Demo)</title>
    <link>https://azure.status.microsoft/en-us/status/</link>
    <description>Mock feed for local UI notification tests</description>
    <lastBuildDate>${now.toUTCString()}</lastBuildDate>
    <item>
      <title>Storage outage in West Europe causing service degradation</title>
      <description>Microsoft is investigating a fault causing degradation in West Europe (demo event #${currentSeq}).</description>
      <link>https://example.local/mock/west-europe-${currentSeq}</link>
      <guid>demo-west-europe-${currentSeq}</guid>
      <pubDate>${now.toUTCString()}</pubDate>
      <category>Incident</category>
    </item>
  </channel>
</rss>`;

    res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
    res.end(xml);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}/feed.xml`
      });
    });
  });
}

function startMockSmtp() {
  const messages = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    onData(stream, session, callback) {
      const chunks = [];
      stream.on("data", (c) => chunks.push(Buffer.from(c)));
      stream.on("end", async () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        messages.push({
          at: new Date().toISOString(),
          envelope: session.envelope,
          raw
        });

        try {
          const outDir = path.join(__dirname, "..", "data", "mock-smtp");
          await fs.mkdir(outDir, { recursive: true });
          const fileBase = `${Date.now()}-${messages.length}`;
          await fs.writeFile(path.join(outDir, `${fileBase}.eml`), raw, "utf8");
          await fs.writeFile(
            path.join(outDir, `${fileBase}.json`),
            JSON.stringify(
              {
                at: new Date().toISOString(),
                envelope: session.envelope
              },
              null,
              2
            ),
            "utf8"
          );
        } catch (error) {
          console.error(`Mock SMTP save error: ${String(error)}`);
        }

        const subjectMatch = raw.match(/^Subject:\s*(.+)$/im);
        console.log(
          `Mock SMTP: email #${messages.length} ricevuta` +
            (subjectMatch ? ` | subject=${subjectMatch[1]}` : "")
        );
        callback();
      });
      stream.on("error", callback);
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.server.address();
      resolve({
        server,
        port: addr.port,
        host: "127.0.0.1",
        messages
      });
    });
  });
}

function listenServer(handler, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

async function startWebAppServer(app, preferredPort) {
  try {
    const server = await listenServer(app, preferredPort);
    const actualPort = server.address()?.port || preferredPort;
    return { server, port: actualPort, usedFallbackPort: false };
  } catch (error) {
    if (error?.code !== "EADDRINUSE") {
      throw error;
    }

    console.warn(
      `Porta ${preferredPort} occupata. Avvio la demo su una porta libera automatica...`
    );
    const server = await listenServer(app, 0);
    const actualPort = server.address()?.port || 0;
    return { server, port: actualPort, usedFallbackPort: true };
  }
}

async function main() {
  const feed = await startMockFeed();
  const smtp = await startMockSmtp();

  process.env.AZURE_RSS_FEEDS = feed.url;
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
  process.env.ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || "luca.bigoni@gruppohera.it";
  process.env.ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM || "azure-alerts@example.local";
  process.env.SMTP_HOST = smtp.host;
  process.env.SMTP_PORT = String(smtp.port);
  process.env.SMTP_SECURE = "false";
  process.env.SMTP_USER = "";
  process.env.SMTP_PASS = "";
  process.env.NOTIFY_POLL_MS = process.env.NOTIFY_POLL_MS || "3600000";
  process.env.NOTIFIER_STATE_FILE =
    process.env.NOTIFIER_STATE_FILE ||
    path.join(__dirname, "..", "data", "notified-events-local-demo.json");

  const app = require("../src/server");
  const preferredPort = Number(process.env.PORT || 3000);
  let web;
  let actualPort = preferredPort;

  try {
    const started = await startWebAppServer(app, preferredPort);
    web = started.server;
    actualPort = started.port;
    console.log(`Webapp demo in ascolto su http://127.0.0.1:${actualPort}`);
    if (started.usedFallbackPort) {
      console.log(
        `Nota: la porta richiesta (${preferredPort}) era occupata, uso ${actualPort}.`
      );
    }
    console.log(`Feed mock: ${feed.url}`);
    console.log(`SMTP mock: smtp://${smtp.host}:${smtp.port}`);
    console.log("UI: usa il pulsante 'Test Notifier Email' per inviare la mail mock.");
    console.log(
      "Nota: per ritestare più volte, elimina data/notified-events-local-demo.json oppure riavvia e cambia GUID mock."
    );
  } catch (error) {
    await new Promise((resolve) => feed.server.close(resolve));
    await new Promise((resolve) => smtp.server.close(resolve));
    throw error;
  }

  const shutdown = async (signal) => {
    console.log(`Ricevuto ${signal}, chiusura...`);
    await new Promise((resolve) => web.close(resolve));
    await new Promise((resolve) => feed.server.close(resolve));
    await new Promise((resolve) => smtp.server.close(resolve));
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
