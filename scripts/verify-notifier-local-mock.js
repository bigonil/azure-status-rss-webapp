const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { SMTPServer } = require("smtp-server");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startMockSmtp() {
  const messages = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    onData(stream, session, callback) {
      const chunks = [];
      stream.on("data", (c) => chunks.push(Buffer.from(c)));
      stream.on("end", () => {
        messages.push({
          envelope: session.envelope,
          raw: Buffer.concat(chunks).toString("utf8")
        });
        callback();
      });
      stream.on("error", callback);
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  return {
    host: "127.0.0.1",
    port: address.port,
    messages,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function startMockFeed() {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>Azure Status Mock Feed</title>
    <item>
      <title>Network outage in West Europe impacting Azure Storage</title>
      <description>Microsoft is investigating a fault causing degradation in West Europe.</description>
      <link>https://example.local/mock/incident-eu-001</link>
      <guid>verify-local-mock-eu-001</guid>
      <pubDate>${new Date().toUTCString()}</pubDate>
      <category>Incident</category>
    </item>
  </channel>
</rss>`;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
    res.end(xml);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/feed.xml`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function main() {
  const tempStateDir = path.join(__dirname, "..", "data");
  await fs.mkdir(tempStateDir, { recursive: true });
  const tempStateFile = path.join(tempStateDir, `verify-local-${Date.now()}.json`);

  const smtp = await startMockSmtp();
  const feed = await startMockFeed();

  process.env.AZURE_RSS_FEEDS = feed.url;
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
  process.env.ALERT_EMAIL_TO = "luca.bigoni@gruppohera.it";
  process.env.ALERT_EMAIL_FROM = "azure-alerts@example.local";
  process.env.SMTP_HOST = smtp.host;
  process.env.SMTP_PORT = String(smtp.port);
  process.env.SMTP_SECURE = "false";
  process.env.SMTP_USER = "";
  process.env.SMTP_PASS = "";
  process.env.NOTIFY_POLL_MS = "999999";
  process.env.NOTIFIER_STATE_FILE = tempStateFile;

  const app = require("../src/server");
  const apiServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => apiServer.once("listening", resolve));
  const apiAddress = apiServer.address();
  const baseUrl = `http://127.0.0.1:${apiAddress.port}`;

  try {
    const triggerRes = await fetch(`${baseUrl}/api/notifier/check`, { method: "POST" });
    const trigger = await triggerRes.json();
    if (!triggerRes.ok) {
      throw new Error(`Trigger failed: ${JSON.stringify(trigger)}`);
    }

    await sleep(1000);

    if (smtp.messages.length === 0) {
      throw new Error("Mock SMTP non ha ricevuto nessuna email");
    }

    const raw = smtp.messages[0].raw;
    const checks = {
      hasRecipient: raw.includes("luca.bigoni@gruppohera.it"),
      hasSubject: raw.toLowerCase().includes("azure status"),
      hasEurope: raw.toLowerCase().includes("west europe"),
      trigger
    };

    if (!checks.hasRecipient || !checks.hasSubject || !checks.hasEurope) {
      throw new Error(`Email ricevuta ma contenuto inatteso: ${JSON.stringify(checks)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      smtpPort: smtp.port,
      feedUrl: feed.url,
      messagesReceived: smtp.messages.length,
      checks
    }, null, 2));
  } finally {
    await new Promise((resolve) => apiServer.close(resolve));
    await feed.close();
    await smtp.close();
    try {
      await fs.unlink(tempStateFile);
    } catch {}
  }
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
