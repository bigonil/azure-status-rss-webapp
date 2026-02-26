const els = {
  search: document.getElementById("search"),
  onlyFaults: document.getElementById("onlyFaults"),
  limit: document.getElementById("limit"),
  refreshBtn: document.getElementById("refreshBtn"),
  loadBtn: document.getElementById("loadBtn"),
  notifierBtn: document.getElementById("notifierBtn"),
  notifierResult: document.getElementById("notifierResult"),
  meta: document.getElementById("meta"),
  feeds: document.getElementById("feeds"),
  errors: document.getElementById("errors"),
  events: document.getElementById("events"),
  emptyState: document.getElementById("emptyState")
};

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(text, max = 400) {
  if (!text) return "";
  const clean = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function buildQuery({ refresh = false } = {}) {
  const params = new URLSearchParams();
  params.set("onlyFaults", els.onlyFaults.checked ? "1" : "0");
  params.set("limit", String(els.limit.value || 100));
  if (els.search.value.trim()) params.set("search", els.search.value.trim());
  if (refresh) params.set("refresh", "1");
  return params.toString();
}

async function loadSummary(refresh = false) {
  const res = await fetch(`/api/feeds?${refresh ? "refresh=1" : ""}`);
  if (!res.ok) throw new Error(`Summary fetch failed (${res.status})`);
  return res.json();
}

async function loadEvents(refresh = false) {
  const query = buildQuery({ refresh });
  const res = await fetch(`/api/events?${query}`);
  if (!res.ok) throw new Error(`Events fetch failed (${res.status})`);
  return res.json();
}

async function triggerNotifierCheck() {
  const res = await fetch("/api/notifier/check", { method: "POST" });
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Notifier response non valida (${res.status}): ${text}`);
  }
  if (!res.ok) {
    throw new Error(payload.detail || payload.error || `Notifier failed (${res.status})`);
  }
  return payload;
}

function renderSummary(summary, events) {
  els.meta.textContent =
    `Feed: ${summary.feeds.length} | Item totali: ${summary.totalItems} | ` +
    `Fault-like: ${summary.faultLikeItems} | Visualizzati: ${events.returned} | ` +
    `Aggiornato: ${new Date(events.updatedAt).toLocaleString("it-IT")}`;

  els.feeds.innerHTML = summary.feeds.length
    ? summary.feeds
        .map(
          (f) =>
            `<div><strong>${escapeHtml(f.title)}</strong> (${f.itemCount} item) - ` +
            `<a href="${escapeHtml(f.feedUrl)}" target="_blank" rel="noreferrer">RSS</a></div>`
        )
        .join("")
    : "<div>Nessun feed disponibile.</div>";

  els.errors.innerHTML =
    summary.errors && summary.errors.length
      ? `<strong>Errori feed:</strong> ${summary.errors.map(escapeHtml).join(" | ")}`
      : "";
}

function renderEvents(items) {
  els.events.innerHTML = "";
  if (!items.length) {
    els.emptyState.classList.remove("hidden");
    return;
  }
  els.emptyState.classList.add("hidden");

  const html = items
    .map((item) => {
      const when = item.pubDateIso
        ? new Date(item.pubDateIso).toLocaleString("it-IT")
        : "Data non disponibile";
      const desc = truncate(item.description);

      return `
        <li class="event">
          <div class="event-header">
            <h3 class="event-title">${escapeHtml(item.title)}</h3>
            <span class="badge ${item.isFaultLike ? "fault" : "info"}">
              ${item.isFaultLike ? "FAULT" : "INFO"}
            </span>
          </div>
          <p class="event-meta">
            <strong>${escapeHtml(item.sourceName || "Azure Status")}</strong> |
            ${escapeHtml(when)}
            ${item.category ? ` | ${escapeHtml(String(item.category))}` : ""}
          </p>
          ${desc ? `<p class="event-desc">${escapeHtml(desc)}</p>` : ""}
          ${
            item.link
              ? `<p class="event-meta"><a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">Apri sorgente</a></p>`
              : ""
          }
        </li>`;
    })
    .join("");

  els.events.innerHTML = html;
}

function renderNotifierResult(message, kind = "info") {
  els.notifierResult.classList.remove("hidden", "ok", "error", "info");
  els.notifierResult.classList.add(kind);
  els.notifierResult.textContent = message;
}

async function refreshPage(forceRefresh = false) {
  try {
    els.meta.textContent = "Caricamento feed...";
    const [summary, events] = await Promise.all([
      loadSummary(forceRefresh),
      loadEvents(forceRefresh)
    ]);
    renderSummary(summary, events);
    renderEvents(events.items || []);
  } catch (error) {
    els.meta.textContent = "Errore caricamento feed";
    els.errors.textContent = String(error);
    renderEvents([]);
  }
}

els.loadBtn.addEventListener("click", () => {
  refreshPage(false);
});

els.refreshBtn.addEventListener("click", () => {
  refreshPage(true);
});

els.notifierBtn.addEventListener("click", async () => {
  const originalText = els.notifierBtn.textContent;
  els.notifierBtn.disabled = true;
  els.notifierBtn.textContent = "Invio in corso...";
  renderNotifierResult("Esecuzione controllo notifier...", "info");

  try {
    const result = await triggerNotifierCheck();
    const msg = result.sent
      ? `Email inviata: ${result.newItems} nuovi eventi (match=${result.matched}).`
      : result.skipped
        ? `Notifier non eseguito: ${result.reason || "skip"}.`
        : `Nessuna nuova email inviata (match=${result.matched ?? 0}, nuovi=${result.newItems ?? 0}).`;
    renderNotifierResult(`${msg} Risposta: ${JSON.stringify(result)}`, "ok");
    await refreshPage(true);
  } catch (error) {
    renderNotifierResult(`Errore notifier: ${String(error)}`, "error");
  } finally {
    els.notifierBtn.disabled = false;
    els.notifierBtn.textContent = originalText;
  }
});

els.search.addEventListener("keydown", (event) => {
  if (event.key === "Enter") refreshPage(false);
});

refreshPage(true);
