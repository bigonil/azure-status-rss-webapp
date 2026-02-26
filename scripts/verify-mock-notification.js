async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function main() {
  const appBase = process.env.APP_BASE_URL || "http://127.0.0.1:3000";
  const mailhogBase = process.env.MAILHOG_BASE_URL || "http://127.0.0.1:8025";

  console.log(`Checking app: ${appBase}`);
  console.log(`Checking MailHog: ${mailhogBase}`);

  const notifierBefore = await fetchJson(`${appBase}/api/notifier`);
  console.log("Notifier status before:", {
    enabled: notifierBefore.enabled,
    configured: notifierBefore.configured,
    sentEmails: notifierBefore.status.sentEmails,
    sentEvents: notifierBefore.status.sentEvents
  });

  const trigger = await fetchJson(`${appBase}/api/notifier/check`, { method: "POST" });
  console.log("Trigger result:", trigger);

  await sleep(1500);

  const messages = await fetchJson(`${mailhogBase}/api/v2/messages`);
  const count = Array.isArray(messages.items) ? messages.items.length : 0;
  console.log(`MailHog messages: ${count}`);

  if (count === 0) {
    throw new Error(
      "Nessuna email trovata in MailHog. Verifica stato notifier/data/notified-events.json."
    );
  }

  const latest = messages.items[0];
  console.log("Latest message summary:", {
    from: latest?.Content?.Headers?.From?.[0] || null,
    to: latest?.Content?.Headers?.To?.[0] || null,
    subject: latest?.Content?.Headers?.Subject?.[0] || null
  });
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
