const express = require("express");
const { XMLParser } = require("fast-xml-parser");
const nodemailer = require("nodemailer");
const fs = require("node:fs/promises");
const path = require("path");

const app = express();
const port = Number(process.env.PORT || 3000);

const DEFAULT_FEEDS = [
  "https://azure.status.microsoft/en-us/status/feed/"
];

const FEED_URLS = (process.env.AZURE_RSS_FEEDS || DEFAULT_FEEDS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 60_000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 10_000);
const ALERT_EMAIL_TO = (process.env.ALERT_EMAIL_TO || "luca.bigoni@gruppohera.it")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM || "azure-status-rss-webapp@localhost";
const EMAIL_SUBJECT_PREFIX = process.env.EMAIL_SUBJECT_PREFIX || "[Azure Status][EU]";
const EMAIL_NOTIFICATIONS_ENABLED = ["1", "true", "yes", "on"].includes(
  String(process.env.EMAIL_NOTIFICATIONS_ENABLED || "false").toLowerCase()
);
const NOTIFY_POLL_MS = Number(process.env.NOTIFY_POLL_MS || 300_000);
const NOTIFY_MAX_ITEM_AGE_HOURS = Number(process.env.NOTIFY_MAX_ITEM_AGE_HOURS || 72);
const NOTIFIER_STATE_FILE =
  process.env.NOTIFIER_STATE_FILE ||
  path.join(__dirname, "..", "data", "notified-events.json");

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = ["1", "true", "yes", "on"].includes(
  String(process.env.SMTP_SECURE || "false").toLowerCase()
);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_STREAM_TRANSPORT = ["1", "true", "yes", "on"].includes(
  String(process.env.SMTP_STREAM_TRANSPORT || "false").toLowerCase()
);

const DEFAULT_EUROPE_KEYWORDS = [
  "europe",
  "european",
  "emea",
  "west europe",
  "north europe",
  "uksouth",
  "uk south",
  "uk west",
  "ukwest",
  "france central",
  "france south",
  "germany west central",
  "germany north",
  "switzerland north",
  "switzerland west",
  "norway east",
  "norway west",
  "sweden central",
  "sweden south",
  "italy north",
  "spain central",
  "poland central",
  "austria east",
  "belgium central",
  "denmark east",
  "finland central"
];

const EUROPE_KEYWORDS = (
  process.env.EUROPE_REGION_KEYWORDS || DEFAULT_EUROPE_KEYWORDS.join(",")
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true
});

let cache = {
  expiresAt: 0,
  payload: null
};

const notifierState = {
  lastRunAt: null,
  lastCheckReason: null,
  lastSentAt: null,
  lastError: null,
  sentEmails: 0,
  sentEvents: 0,
  lastMatchedCount: 0,
  lastNewEventCount: 0,
  notifiedKeys: new Set(),
  stateLoaded: false
};

let notifierTimer = null;
let notifierRunPromise = null;
let mailTransport = null;

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeCategory(category) {
  if (Array.isArray(category)) {
    return category.map((c) => normalizeCategory(c)).filter(Boolean).join(", ");
  }
  if (category == null) return null;
  if (typeof category === "object") {
    return category["#text"] || JSON.stringify(category);
  }
  return String(category);
}

function stripHtml(input) {
  return String(input || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyFault(item) {
  const haystack = [
    item.title,
    item.description,
    item.category
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const faultKeywords = [
    "fault",
    "incident",
    "outage",
    "degradation",
    "degraded",
    "disruption",
    "unavailable",
    "failure",
    "error",
    "service issue",
    "service issues"
  ];

  return faultKeywords.some((kw) => haystack.includes(kw));
}

function classifyEurope(item) {
  const haystack = [
    item.title,
    item.description,
    item.category
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return EUROPE_KEYWORDS.some((kw) => haystack.includes(kw));
}

function normalizeItem(item, feedUrl, channelTitle) {
  const publishedRaw = item.pubDate || item.published || item.updated || null;
  const published = parseDate(publishedRaw);

  const normalized = {
    title: item.title || "(no title)",
    link: item.link || null,
    description: item.description || item["content:encoded"] || null,
    category: normalizeCategory(item.category),
    guid: typeof item.guid === "string" ? item.guid : item.guid?.["#text"] || null,
    pubDate: publishedRaw,
    pubDateIso: published ? published.toISOString() : null,
    sourceFeed: feedUrl,
    sourceName: channelTitle || "Azure Status"
  };

  normalized.isFaultLike = classifyFault(normalized);
  normalized.isEuropeRelated = classifyEurope(normalized);
  normalized.isEuropeFaultAlert = normalized.isFaultLike && normalized.isEuropeRelated;
  return normalized;
}

function buildItemKey(item) {
  return [item.guid, item.link, item.title, item.pubDate].join("|");
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "azure-status-rss-webapp/1.0"
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function loadFeeds(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cache.payload && cache.expiresAt > now) {
    return cache.payload;
  }

  const results = await Promise.allSettled(
    FEED_URLS.map(async (feedUrl) => {
      const xml = await fetchWithTimeout(feedUrl, REQUEST_TIMEOUT_MS);
      const parsed = parser.parse(xml);
      const channel = parsed?.rss?.channel || {};
      const items = asArray(channel.item).map((item) =>
        normalizeItem(item, feedUrl, channel.title)
      );

      return {
        feedUrl,
        title: channel.title || feedUrl,
        link: channel.link || null,
        description: channel.description || null,
        lastBuildDate: channel.lastBuildDate || null,
        itemCount: items.length,
        items
      };
    })
  );

  const feeds = [];
  const errors = [];
  const allItems = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      feeds.push({
        feedUrl: result.value.feedUrl,
        title: result.value.title,
        link: result.value.link,
        description: result.value.description,
        lastBuildDate: result.value.lastBuildDate,
        itemCount: result.value.itemCount
      });
      allItems.push(...result.value.items);
    } else {
      errors.push(String(result.reason));
    }
  }

  const seen = new Set();
  const deduped = allItems.filter((item) => {
    const key = buildItemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => {
    const ta = a.pubDateIso ? Date.parse(a.pubDateIso) : 0;
    const tb = b.pubDateIso ? Date.parse(b.pubDateIso) : 0;
    return tb - ta;
  });

  const payload = {
    updatedAt: new Date().toISOString(),
    feeds,
    totalItems: deduped.length,
    faultLikeItems: deduped.filter((i) => i.isFaultLike).length,
    items: deduped,
    errors
  };

  cache = {
    expiresAt: now + CACHE_TTL_MS,
    payload
  };

  return payload;
}

function itemIsRecentEnoughForNotification(item) {
  if (!NOTIFY_MAX_ITEM_AGE_HOURS || NOTIFY_MAX_ITEM_AGE_HOURS <= 0) {
    return true;
  }
  if (!item.pubDateIso) {
    return true;
  }
  const ageMs = Date.now() - Date.parse(item.pubDateIso);
  if (Number.isNaN(ageMs)) return true;
  return ageMs <= NOTIFY_MAX_ITEM_AGE_HOURS * 60 * 60 * 1000;
}

function emailIsConfigured() {
  if (!EMAIL_NOTIFICATIONS_ENABLED) return false;
  if (SMTP_STREAM_TRANSPORT) return ALERT_EMAIL_TO.length > 0;
  return Boolean(SMTP_HOST && ALERT_EMAIL_TO.length > 0 && ALERT_EMAIL_FROM);
}

async function loadNotifierState() {
  if (notifierState.stateLoaded) return;
  notifierState.stateLoaded = true;

  try {
    const raw = await fs.readFile(NOTIFIER_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const keys = Array.isArray(parsed?.notifiedKeys) ? parsed.notifiedKeys : [];
    for (const key of keys) notifierState.notifiedKeys.add(String(key));
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      notifierState.lastError = `State load failed: ${String(error)}`;
      console.error(notifierState.lastError);
    }
  }
}

async function persistNotifierState() {
  const payload = {
    updatedAt: new Date().toISOString(),
    notifiedKeys: Array.from(notifierState.notifiedKeys).slice(-5000)
  };

  await fs.mkdir(path.dirname(NOTIFIER_STATE_FILE), { recursive: true });
  await fs.writeFile(NOTIFIER_STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
}

async function getMailTransport() {
  if (!EMAIL_NOTIFICATIONS_ENABLED) return null;
  if (mailTransport) return mailTransport;

  if (SMTP_STREAM_TRANSPORT) {
    mailTransport = nodemailer.createTransport({
      streamTransport: true,
      newline: "unix",
      buffer: true
    });
    return mailTransport;
  }

  if (!SMTP_HOST) {
    throw new Error("SMTP_HOST non configurato");
  }

  const transportConfig = {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE
  };

  if (SMTP_USER || SMTP_PASS) {
    transportConfig.auth = {
      user: SMTP_USER,
      pass: SMTP_PASS
    };
  }

  mailTransport = nodemailer.createTransport(transportConfig);
  return mailTransport;
}

function buildAlertEmailContent(items) {
  const subject =
    `${EMAIL_SUBJECT_PREFIX} Fault/Outage Europa rilevati (${items.length})`;

  const lines = [
    "Sono stati rilevati nuovi fault/outage Azure con riferimento all'Europa.",
    "",
    `Totale nuovi eventi: ${items.length}`,
    `Rilevazione: ${new Date().toLocaleString("it-IT")}`,
    ""
  ];

  for (const item of items) {
    lines.push(`- Titolo: ${item.title}`);
    lines.push(`  Data: ${item.pubDateIso || item.pubDate || "n/d"}`);
    lines.push(`  Categoria: ${item.category || "n/d"}`);
    lines.push(`  Fonte: ${item.sourceName || "Azure Status"}`);
    if (item.link) lines.push(`  Link: ${item.link}`);
    const desc = stripHtml(item.description);
    if (desc) lines.push(`  Dettagli: ${desc.slice(0, 700)}`);
    lines.push("");
  }

  const htmlItems = items
    .map((item) => {
      const desc = stripHtml(item.description).slice(0, 700);
      return `
        <tr>
          <td style="padding:8px;border:1px solid #ddd;"><strong>${escapeHtml(
            item.title
          )}</strong><br><small>${escapeHtml(item.sourceName || "Azure Status")}</small></td>
          <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(
            item.pubDateIso || item.pubDate || "n/d"
          )}</td>
          <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(
            item.category || "n/d"
          )}</td>
          <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(desc || "-")}${
            item.link
              ? `<br><a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">Apri evento</a>`
              : ""
          }</td>
        </tr>`;
    })
    .join("");

  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;color:#1f2a36">
      <h2 style="margin:0 0 12px;">Azure Status - Fault/Outage Europa</h2>
      <p>Rilevati <strong>${items.length}</strong> nuovi eventi dal feed RSS ufficiale Microsoft Azure Status.</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f6f6f6;">Evento</th>
            <th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f6f6f6;">Data</th>
            <th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f6f6f6;">Categoria</th>
            <th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f6f6f6;">Dettagli</th>
          </tr>
        </thead>
        <tbody>${htmlItems}</tbody>
      </table>
      <p style="margin-top:16px;color:#5b6773;">Feed: ${FEED_URLS.map(escapeHtml).join(", ")}</p>
    </div>`;

  return { subject, text: lines.join("\n"), html };
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function sendNotificationEmail(items) {
  const transport = await getMailTransport();
  if (!transport) return { skipped: true, reason: "disabled" };

  const content = buildAlertEmailContent(items);
  const info = await transport.sendMail({
    from: ALERT_EMAIL_FROM,
    to: ALERT_EMAIL_TO.join(", "),
    subject: content.subject,
    text: content.text,
    html: content.html
  });

  return {
    messageId: info.messageId || null,
    envelope: info.envelope || null
  };
}

async function runNotifierCheck({ reason = "manual", forceRefresh = true } = {}) {
  await loadNotifierState();
  notifierState.lastRunAt = new Date().toISOString();
  notifierState.lastCheckReason = reason;
  notifierState.lastError = null;

  if (!EMAIL_NOTIFICATIONS_ENABLED) {
    return { skipped: true, reason: "EMAIL_NOTIFICATIONS_ENABLED=false" };
  }

  if (!emailIsConfigured()) {
    const msg = "Notifier abilitato ma configurazione email incompleta";
    notifierState.lastError = msg;
    return { skipped: true, reason: msg };
  }

  const payload = await loadFeeds(forceRefresh);
  const matches = payload.items.filter(
    (item) => item.isEuropeFaultAlert && itemIsRecentEnoughForNotification(item)
  );
  notifierState.lastMatchedCount = matches.length;

  const newItems = matches.filter((item) => !notifierState.notifiedKeys.has(buildItemKey(item)));
  notifierState.lastNewEventCount = newItems.length;

  if (newItems.length === 0) {
    return { sent: false, matched: matches.length, newItems: 0 };
  }

  const sendResult = await sendNotificationEmail(newItems);
  for (const item of newItems) {
    notifierState.notifiedKeys.add(buildItemKey(item));
  }
  notifierState.sentEmails += 1;
  notifierState.sentEvents += newItems.length;
  notifierState.lastSentAt = new Date().toISOString();
  await persistNotifierState();

  return {
    sent: true,
    matched: matches.length,
    newItems: newItems.length,
    sendResult
  };
}

function scheduleNotifierCheck(options) {
  if (!EMAIL_NOTIFICATIONS_ENABLED) {
    return;
  }

  if (notifierRunPromise) {
    return notifierRunPromise;
  }

  notifierRunPromise = runNotifierCheck(options)
    .then((result) => {
      if (result?.sent) {
        console.log(
          `Notifier: inviata email (${result.newItems} eventi europei fault/outage).`
        );
      }
      return result;
    })
    .catch((error) => {
      notifierState.lastError = String(error);
      console.error(`Notifier error: ${String(error)}`);
      return { error: String(error) };
    })
    .finally(() => {
      notifierRunPromise = null;
    });

  return notifierRunPromise;
}

function startNotifierScheduler() {
  if (!EMAIL_NOTIFICATIONS_ENABLED) {
    console.log("Notifier email disabilitato (EMAIL_NOTIFICATIONS_ENABLED=false)");
    return;
  }

  console.log(
    `Notifier email attivo: poll=${NOTIFY_POLL_MS}ms, recipients=${ALERT_EMAIL_TO.join(", ")}`
  );

  scheduleNotifierCheck({ reason: "startup", forceRefresh: true });
  notifierTimer = setInterval(() => {
    scheduleNotifierCheck({ reason: "scheduler", forceRefresh: true });
  }, Math.max(NOTIFY_POLL_MS, 30_000));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "azure-status-rss-webapp",
    feeds: FEED_URLS,
    emailNotifier: {
      enabled: EMAIL_NOTIFICATIONS_ENABLED,
      configured: emailIsConfigured(),
      recipients: ALERT_EMAIL_TO
    }
  });
});

app.get("/api/feeds", async (req, res) => {
  try {
    const payload = await loadFeeds(req.query.refresh === "1");
    res.json({
      updatedAt: payload.updatedAt,
      feeds: payload.feeds,
      totalItems: payload.totalItems,
      faultLikeItems: payload.faultLikeItems,
      errors: payload.errors
    });
  } catch (error) {
    res.status(502).json({ error: "Feed fetch failed", detail: String(error) });
  }
});

app.get("/api/events", async (req, res) => {
  try {
    const payload = await loadFeeds(req.query.refresh === "1");
    const onlyFaults = req.query.onlyFaults !== "0";
    const search = (req.query.search || "").toString().trim().toLowerCase();
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);

    let items = payload.items;
    if (onlyFaults) {
      items = items.filter((i) => i.isFaultLike);
    }
    if (search) {
      items = items.filter((i) =>
        [i.title, i.description, i.category]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(search)
      );
    }

    res.json({
      updatedAt: payload.updatedAt,
      total: items.length,
      returned: Math.min(items.length, limit),
      onlyFaults,
      search,
      errors: payload.errors,
      items: items.slice(0, limit)
    });
  } catch (error) {
    res.status(502).json({ error: "Feed fetch failed", detail: String(error) });
  }
});

async function getNotifierStatus(_req, res) {
  await loadNotifierState();
  res.json({
    enabled: EMAIL_NOTIFICATIONS_ENABLED,
    configured: emailIsConfigured(),
    recipients: ALERT_EMAIL_TO,
    from: ALERT_EMAIL_FROM,
    pollMs: Math.max(NOTIFY_POLL_MS, 30_000),
    maxItemAgeHours: NOTIFY_MAX_ITEM_AGE_HOURS,
    europeKeywordCount: EUROPE_KEYWORDS.length,
    stateFile: NOTIFIER_STATE_FILE,
    status: {
      lastRunAt: notifierState.lastRunAt,
      lastCheckReason: notifierState.lastCheckReason,
      lastSentAt: notifierState.lastSentAt,
      lastError: notifierState.lastError,
      sentEmails: notifierState.sentEmails,
      sentEvents: notifierState.sentEvents,
      lastMatchedCount: notifierState.lastMatchedCount,
      lastNewEventCount: notifierState.lastNewEventCount,
      notifiedKeysCount: notifierState.notifiedKeys.size
    }
  });
}

app.get("/api/notifier", getNotifierStatus);
app.get("/api/notifier/status", getNotifierStatus);

app.post("/api/notifier/check", async (req, res) => {
  try {
    const result = await scheduleNotifierCheck({
      reason: "api",
      forceRefresh: true
    });
    res.json(result || { scheduled: true });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get("/api/notifier/check", (_req, res) => {
  res.status(405).json({
    error: "Method not allowed",
    detail: "Usa POST /api/notifier/check per eseguire un controllo immediato."
  });
});

app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API route not found",
    path: req.originalUrl,
    available: [
      "GET /api/health",
      "GET /api/feeds",
      "GET /api/events",
      "GET /api/notifier",
      "GET /api/notifier/status",
      "POST /api/notifier/check"
    ]
  });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Azure RSS webapp listening on http://localhost:${port}`);
    console.log(`Feeds: ${FEED_URLS.join(", ")}`);
    startNotifierScheduler();
  });
}

module.exports = app;
module.exports._internals = {
  classifyFault,
  classifyEurope,
  buildItemKey,
  itemIsRecentEnoughForNotification
};
