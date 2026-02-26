const DEFAULT_TIMEOUT_MS = Number(process.env.AZURE_RSS_APP_TIMEOUT_MS || 15_000);

export class AzureRssApiClient {
  constructor(baseUrl = process.env.AZURE_RSS_APP_BASE_URL || "http://127.0.0.1:3000") {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
  }

  buildUrl(pathname, query = {}) {
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  async requestJson(pathname, { method = "GET", query, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const url = this.buildUrl(pathname, query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json"
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal
      });

      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Risposta non JSON da ${url}: ${text.slice(0, 500)}`);
      }

      if (!res.ok) {
        throw new Error(
          `HTTP ${res.status} ${res.statusText} su ${url}: ${JSON.stringify(json)}`
        );
      }

      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  health() {
    return this.requestJson("/api/health");
  }

  feeds({ refresh = false } = {}) {
    return this.requestJson("/api/feeds", {
      query: refresh ? { refresh: 1 } : {}
    });
  }

  events({ onlyFaults = true, search = "", limit = 50, refresh = false } = {}) {
    return this.requestJson("/api/events", {
      query: {
        onlyFaults: onlyFaults ? 1 : 0,
        search: search || undefined,
        limit,
        refresh: refresh ? 1 : undefined
      }
    });
  }

  notifierStatus() {
    return this.requestJson("/api/notifier");
  }

  notifierCheck() {
    return this.requestJson("/api/notifier/check", {
      method: "POST"
    });
  }
}

export function toPrettyJson(value) {
  return JSON.stringify(value, null, 2);
}
