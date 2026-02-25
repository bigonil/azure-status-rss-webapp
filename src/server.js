const express = require("express");
const { XMLParser } = require("fast-xml-parser");
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

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true
});

let cache = {
  expiresAt: 0,
  payload: null
};

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

function normalizeItem(item, feedUrl, channelTitle) {
  const publishedRaw = item.pubDate || item.published || item.updated || null;
  const published = parseDate(publishedRaw);

  const normalized = {
    title: item.title || "(no title)",
    link: item.link || null,
    description: item.description || item["content:encoded"] || null,
    category: item.category || null,
    guid: typeof item.guid === "string" ? item.guid : item.guid?.["#text"] || null,
    pubDate: publishedRaw,
    pubDateIso: published ? published.toISOString() : null,
    sourceFeed: feedUrl,
    sourceName: channelTitle || "Azure Status"
  };

  normalized.isFaultLike = classifyFault(normalized);
  return normalized;
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
    const key = [item.guid, item.link, item.title, item.pubDate].join("|");
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

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "azure-status-rss-webapp",
    feeds: FEED_URLS
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

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Azure RSS webapp listening on http://localhost:${port}`);
    console.log(`Feeds: ${FEED_URLS.join(", ")}`);
  });
}

module.exports = app;
