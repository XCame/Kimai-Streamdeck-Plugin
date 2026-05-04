/*
 * Kimai Timer Stream Deck Plugin
 * =====================================================
 *
 * Diese Datei ist der Node.js-Entry-Point des Stream-Deck-Plugins.
 * Sie spricht direkt mit der Stream-Deck-WebSocket-API und mit der Kimai-REST-API.
 *
 * Zielverhalten:
 * - Pro Button wird eine Kimai-Kombination aus Kunde, Projekt und Tätigkeit konfiguriert.
 * - Ein Klick startet diese Tätigkeit.
 * - Läuft bereits eine andere Tätigkeit, wird diese zuerst gestoppt und danach die neue gestartet.
 * - Läuft die Tätigkeit dieses Buttons, wird der Button grün.
 * - Läuft eine andere Tätigkeit, wird der Button grau.
 * - Läuft keine Tätigkeit, wird der Button rot.
 * - Optional wird beim Stoppen oder alle 15 Minuten ein Browser-Dialog zur Beschreibung geöffnet.
 * - Optional wird die Laufzeit direkt auf dem Button angezeigt.
 *
 * Architekturhinweis:
 * - Es werden bewusst keine npm-Abhängigkeiten verwendet.
 * - Für HTTPS mit selbstsignierten Zertifikaten wird, sofern verfügbar, Node/Undici genutzt.
 * - Die kleinen Beschreibungsfenster werden über einen lokalen HTTP-Server auf 127.0.0.1 erzeugt.
 */

// Lokaler HTTP-Server für die Beschreibungsdialoge im Browser.
const http = require('http');
// Zum Öffnen des Default-Browsers je Betriebssystem.
const { execFile } = require('child_process');
// Für einmalige Tokens, damit ein Browserdialog eindeutig einer Pending-Aktion zugeordnet ist.
const crypto = require('crypto');

// Muss exakt zur UUID der Action im manifest.json passen.
const ACTION_UUID = 'de.xcame.kimai.start-activity';
// Kimai wird nicht jede Sekunde abgefragt, sondern nur periodisch synchronisiert.
const POLL_MS = 10000;
// Der Button-Titel, z. B. die Laufzeit, wird lokal jede Sekunde aktualisiert.
const TICK_MS = 1000;
// Verhindert endlos hängende API-Requests, etwa nach Standby/WLAN-Verlust.
const REQUEST_TIMEOUT_MS = 12000;
// Wenn Kimai nicht erreichbar ist, wird nach diesem Intervall erneut synchronisiert.
const API_ERROR_RETRY_MS = 5000;
// Wenn der Rechner aus dem Schlaf kommt, ist die Zeitdifferenz zwischen Ticks auffällig groß.
const SLEEP_WAKE_GAP_MS = 30000;
// Intervall für den optionalen Erinnerungsdialog zur Beschreibungsergänzung.
const DESCRIPTION_REVIEW_MS = 15 * 60 * 1000;
// Undici ist in modernen Node-Versionen die Fetch-Implementierung.
// Der Agent erlaubt uns optional rejectUnauthorized=false für lokale selbstsignierte Zertifikate.
let UndiciAgent = null;
try { ({ Agent: UndiciAgent } = require('undici')); } catch {}
const insecureDispatchers = new Map();

// Stream Deck startet das Plugin mit CLI-Argumenten wie Port, Plugin-UUID und Register-Event.
const args = Object.fromEntries(process.argv.map((arg, i, all) => arg.startsWith('-') ? [arg.replace(/^-+/, ''), all[i + 1]] : []).filter(Boolean));
const port = args.port;
const pluginUUID = args.pluginUUID;
const registerEvent = args.registerEvent;

if (!port || !pluginUUID || !registerEvent) {
  console.error('Missing Stream Deck launch arguments', { port, pluginUUID, registerEvent });
  process.exit(1);
}

// Verbindung zur lokalen Stream-Deck-App. Über diesen Socket laufen alle Events und UI-Updates.
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
// contexts enthält den Zustand aller sichtbaren Button-Instanzen dieser Action.
// Ein Nutzer kann dieselbe Action mehrfach mit verschiedenen Settings aufs Stream Deck ziehen.
const contexts = new Map();
let pollTimer;
let tickTimer;
// Letzter bekannter globaler Kimai-Aktivzustand. Dient als Cache zwischen API-Polls.
let lastActive = [];
// Einfache Sperre, damit parallele Key-Presses nicht mehrere Stop/Start-Sequenzen überlappen.
let busy = false;
let retryTimer = null;
let lastTickAt = Date.now();
// Lokaler Dialogserver. Wird lazy gestartet, sobald ein Beschreibungsdialog nötig ist.
let promptServer = null;
let promptServerPort = null;
// token -> Promise-Resolver für geöffnete Browserdialoge.
const pendingPrompts = new Map();
// timesheetId -> Zeitplan und Open-State für den 15-Minuten-Beschreibungsreview.
const descriptionReviewState = new Map();

// Sobald Stream Deck verbunden ist, registrieren wir das Plugin und starten die Timer.
ws.addEventListener('open', () => {
  send({ event: registerEvent, uuid: pluginUUID });
  pollTimer = setInterval(refreshAll, POLL_MS);
  tickTimer = setInterval(updateTitlesOnly, TICK_MS);
});

// Zentraler Event-Router für alle Nachrichten der Stream-Deck-App.
ws.addEventListener('message', async (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }

  try {
    switch (msg.event) {
      case 'willAppear':
        if (msg.action === ACTION_UUID) {
          contexts.set(msg.context, { action: msg.action, settings: msg.payload?.settings || {} });
          await updateContext(msg.context);
        }
        break;
      case 'willDisappear':
        contexts.delete(msg.context);
        break;
      case 'didReceiveSettings':
        if (msg.action === ACTION_UUID) {
          const current = contexts.get(msg.context) || { action: msg.action, settings: {} };
          current.settings = msg.payload?.settings || {};
          contexts.set(msg.context, current);
          await updateContext(msg.context);
        }
        break;
      case 'keyDown':
        if (msg.action === ACTION_UUID) {
          await handleKeyDown(msg.context);
        }
        break;
      case 'sendToPlugin':
        await handlePropertyMessage(msg);
        break;
    }
  } catch (error) {
    console.error('Kimai plugin error:', error);
    if (msg.context) {
      showAlert(msg.context);
      setTitle(msg.context, trimTitle(error.message || 'Fehler'));
    }
  }
});

process.on('SIGINT', () => cleanupAndExit());
process.on('SIGTERM', () => cleanupAndExit());

// Räumt Intervalle, Retry-Timeouts, WebSocket und lokalen Server beim Beenden auf.
function cleanupAndExit() {
  if (pollTimer) clearInterval(pollTimer);
  if (tickTimer) clearInterval(tickTimer);
  if (retryTimer) clearTimeout(retryTimer);
  try { ws.close(); } catch {}
  try { if (promptServer) promptServer.close(); } catch {}
  process.exit(0);
}

// Kleine Hilfsfunktion: Nur senden, wenn der WebSocket wirklich offen ist.
function send(payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

// Rendert das komplette Button-Bild dynamisch als SVG.
// Dadurch liegt kein Manifest-Icon mehr störend über dem Statushintergrund.
function setImage(context, color, settings = {}) {
  const hex = color === 'green' ? '#2e7d32' : color === 'gray' ? '#666666' : color === 'red' ? '#e53935' : '#f9a825';
  const showIcon = !(settings.hideButtonIcon === true || settings.hideButtonIcon === 'true' || settings.hideButtonIcon === undefined);
  const icon = showIcon
    ? '<circle cx="72" cy="62" r="34" fill="rgba(255,255,255,.18)"/><path d="M72 35v29l21 12" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/><text x="72" y="122" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#fff">Kimai</text>'
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" rx="22" fill="${hex}"/>${icon}</svg>`;
  send({ event: 'setImage', context, payload: { image: `data:image/svg+xml,${encodeURIComponent(svg)}`, target: 0 } });
}

// Aktualisiert den Stream-Deck-Button-Titel. Hier erscheint optional die Laufzeit.
function setTitle(context, title) {
  send({ event: 'setTitle', context, payload: { title: title || '', target: 0 } });
}

// Bewusst leer: Die native grüne Erfolgseinblendung würde die eigene Statusfarbe überdecken.
function showOk(context) { /* keine native grüne Stream-Deck-Erfolgseinblendung, damit die Statusfarbe sichtbar bleibt */ }
function showAlert(context) { send({ event: 'showAlert', context }); }

// Hauptlogik beim Button-Klick: Settings prüfen, aktive Timer ermitteln, ggf. stoppen, dann starten.
async function handleKeyDown(context) {
  if (busy) return;
  const item = contexts.get(context);
  const settings = item?.settings || {};
  const missing = validateSettings(settings);
  if (missing) {
    setImage(context, 'red', settings);
    setTitle(context, missing);
    showAlert(context);
    return;
  }

  busy = true;
  setImage(context, 'yellow', settings);
  setTitle(context, 'Kimai…');
  try {
    const active = await getActive(settings);
    const targetActive = active.find((entry) => matchesSettings(entry, settings));

    if (targetActive) {
      if (settings.stopSame === true || settings.stopSame === 'true') {
        const stopped = await stopTimesheetWithOptionalDescription(settings, targetActive, context);
        if (!stopped) {
          setTitle(context, settings.label || 'Läuft');
          await refreshAll();
          return;
        }
        lastActive = [];
      } else {
        lastActive = active;
      }
      showOk(context);
      await refreshAll();
      return;
    }

    for (const entry of active) {
      if (entry?.id !== undefined && entry?.id !== null) {
        const stopped = await stopTimesheetWithOptionalDescription(settings, entry, context);
        if (!stopped) {
          setTitle(context, 'Abbruch');
          await refreshAll();
          return;
        }
      }
    }

    await startTimesheet(settings);
    showOk(context);
    await refreshAll();
  } finally {
    busy = false;
  }
}

// Nachrichten aus dem Property Inspector, z. B. Katalog laden oder Verbindung testen.
async function handlePropertyMessage(msg) {
  const payload = msg.payload || {};
  const context = msg.context;
  const settings = payload.settings || contexts.get(context)?.settings || {};
  console.log('Property message:', payload.type, { context, hasBaseUrl: Boolean(settings.baseUrl), allowSelfSigned: settings.allowSelfSigned });

  if (payload.type === 'loadCatalog') {
    try {
      const catalog = await getCatalog(settings);
      send({ event: 'sendToPropertyInspector', action: ACTION_UUID, context, payload: { type: 'catalog', catalog } });
    } catch (error) {
      send({ event: 'sendToPropertyInspector', action: ACTION_UUID, context, payload: { type: 'error', message: error.message } });
    }
  }

  if (payload.type === 'testConnection') {
    try {
      if (!settings.baseUrl || !settings.token) throw new Error('Kimai URL oder API-Token fehlt.');
      await getActive(settings);
      send({ event: 'sendToPropertyInspector', action: ACTION_UUID, context, payload: { type: 'testResult', ok: true } });
    } catch (error) {
      send({ event: 'sendToPropertyInspector', action: ACTION_UUID, context, payload: { type: 'testResult', ok: false, message: error.message } });
    }
  }
}

// Synchronisiert alle sichtbaren Button-Instanzen mit Kimai.
async function refreshAll() {
  for (const context of contexts.keys()) {
    try { await updateContext(context); } catch (error) { console.error('refresh failed', error); }
  }
}

// Plant einen einzelnen Retry. Mehrere Fehler erzeugen bewusst nicht mehrere parallele Retry-Timer.
function scheduleApiRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    await refreshAll();
  }, API_ERROR_RETRY_MS);
}

// Läuft jede Sekunde. Aktualisiert lokale Laufzeiten ohne Kimai zu belasten.
// Erkennt außerdem Wake-from-Sleep über eine größere Tick-Lücke.
function updateTitlesOnly() {
  const now = Date.now();
  if (now - lastTickAt > SLEEP_WAKE_GAP_MS) {
    scheduleApiRetry();
  }
  lastTickAt = now;
  for (const context of contexts.keys()) {
    try {
      renderContextFromCachedState(context);
      maybeRunDescriptionReview(context);
    } catch (error) { console.error('Tick fehlgeschlagen', error); }
  }
}

// Holt frischen Kimai-Zustand und rendert danach den passenden Button-Zustand.
async function updateContext(context) {
  const item = contexts.get(context);
  const settings = item?.settings || {};
  const missing = validateSettings(settings, true);
  if (missing) {
    item.lastActive = [];
    item.lastColor = 'red';
    setImage(context, 'red', settings);
    setTitle(context, 'Setup');
    return;
  }

  try {
    const active = await getActive(settings);
    lastActive = active;
    item.lastActive = active;
    item.lastFetch = Date.now();
    item.lastApiError = null;
  } catch (error) {
    item.lastActive = [];
    item.lastColor = 'red';
    item.lastApiError = Date.now();
    setImage(context, 'red', settings);
    setTitle(context, 'API Fehler');
    scheduleApiRetry();
    return;
  }

  renderContextFromCachedState(context, true);
}

// Rendert den Button ausschließlich aus gecachtem Aktivzustand.
// Das ist wichtig für die sekundengenaue Laufzeit ohne API-Request pro Sekunde.
function renderContextFromCachedState(context, forceImage = false) {
  const item = contexts.get(context);
  if (!item) return;
  const settings = item.settings || {};
  const active = Array.isArray(item.lastActive) ? item.lastActive : [];
  let color = 'red';
  let title = settings.label || 'Keine läuft';

  if (!active.length) {
    color = 'red';
    title = settings.label || 'Keine läuft';
  } else {
    const ownEntry = active.find((entry) => matchesSettings(entry, settings));
    if (ownEntry) {
      color = 'green';
      title = titleForState(settings, ownEntry, true);
    } else {
      color = 'gray';
      title = titleForState(settings, active[0], false);
    }
  }

  if (forceImage || item.lastColor !== color || item.lastHideButtonIcon !== settings.hideButtonIcon) {
    setImage(context, color, settings);
    item.lastColor = color;
    item.lastHideButtonIcon = settings.hideButtonIcon;
  }
  if (item.lastTitle !== title) {
    setTitle(context, title);
    item.lastTitle = title;
  }
}

// Erzeugt den Button-Titel abhängig von den Anzeigeoptionen und dem Laufstatus.
function titleForState(settings, entry, isOwnRunning) {
  const label = settings.label || labelForEntry(entry) || (isOwnRunning ? 'Läuft' : 'Andere läuft');
  const showRuntime = settings.showRuntime === true || settings.showRuntime === 'true';
  if (!showRuntime || !isOwnRunning) return isOwnRunning ? label : (settings.label || 'Andere läuft');
  const runtime = formatRuntime(elapsedSeconds(entry), settings.runtimeFormat || 'hhmm');
  const mode = settings.runtimeTitleMode || 'label_runtime';
  if (mode === 'runtime_only') return runtime;
  if (mode === 'project_runtime') return `${nameOf(entry.project) || label}\n${runtime}`;
  if (mode === 'activity_runtime') return `${nameOf(entry.activity) || label}\n${runtime}`;
  return `${label}\n${runtime}`;
}

// Berechnet die vergangene Zeit lokal aus dem Kimai-Beginnzeitpunkt.
function elapsedSeconds(entry) {
  const begin = entry.begin || entry.start || entry.from;
  const start = begin ? Date.parse(begin) : NaN;
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((Date.now() - start) / 1000));
}

// Formatiert Sekunden in HH:MM oder HH:MM:SS für den Button-Titel.
function formatRuntime(totalSeconds, format) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const sec = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (format === 'hhmmss') return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return `${pad(h)}:${pad(m)}`;
}

// Minimale Validierung. customerId ist optional, projectId und activityId sind Pflicht.
function validateSettings(settings, quiet = false) {
  if (!settings.baseUrl || !settings.token) return quiet ? 'Setup' : 'Kimai URL/Token fehlt';
  if (!settings.projectId || !settings.activityId) return quiet ? 'Setup' : 'Projekt/Tätigkeit fehlt';
  return '';
}

// Zentraler Kimai-API-Wrapper: URL bauen, Auth-Header setzen, Timeout, TLS-Option und Fehlertexte.
async function kimaiFetch(settings, path, options = {}) {
  const base = String(settings.baseUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('Kimai URL fehlt.');
  const url = `${base}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const fetchOptions = {
    ...options,
    signal: controller.signal,
    headers: {
      'Authorization': `Bearer ${settings.token}`,
      'Accept': 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  };

  if (settings.allowSelfSigned === true || settings.allowSelfSigned === 'true') {
    if (UndiciAgent) {
      fetchOptions.dispatcher = getInsecureDispatcher(base);
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
  }

  try {
    const res = await fetch(url, fetchOptions);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Kimai ${res.status}: ${text.slice(0, 220) || res.statusText}`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    const message = String(error?.message || '');
    if (error?.name === 'AbortError') throw new Error(`Kimai antwortet nicht innerhalb von ${REQUEST_TIMEOUT_MS / 1000} Sekunden.`);
    if (message.includes('self-signed certificate')) throw new Error('TLS-Zertifikat wird nicht akzeptiert. Aktiviere „Selbstsigniertes Zertifikat zulassen“ oder installiere deine lokale CA.');
    if (message.toLowerCase().includes('certificate') || message.toLowerCase().includes('tls')) throw new Error(`TLS/Zertifikatsfehler: ${message}`);
    if (message.includes('fetch failed')) throw new Error('Verbindung zu Kimai fehlgeschlagen. Prüfe URL, Port, DNS/IP und Zertifikat.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// Liefert einen gecachten Undici-Agent pro Kimai-Basis-URL für selbstsignierte Zertifikate.
function getInsecureDispatcher(baseUrl) {
  if (!UndiciAgent) return undefined;
  if (!insecureDispatchers.has(baseUrl)) {
    insecureDispatchers.set(baseUrl, new UndiciAgent({
      connect: { rejectUnauthorized: false }
    }));
  }
  return insecureDispatchers.get(baseUrl);
}

// Liest alle aktuell laufenden Kimai-Timesheets des Nutzers.
async function getActive(settings) {
  const data = await kimaiFetch(settings, '/api/timesheets/active');
  return Array.isArray(data) ? data : [];
}

// Stoppt einen Timesheet-Eintrag. Optional wird vorher ein Beschreibungsdialog geöffnet.
async function stopTimesheetWithOptionalDescription(settings, entry, context) {
  const id = entry?.id;
  if (id === undefined || id === null) return false;

  if (settings.promptDescriptionOnStop === true || settings.promptDescriptionOnStop === 'true') {
    setImage(context, 'yellow', settings);
    setTitle(context, 'Beschreibung');
    const result = await promptForStopDescription(settings, entry);
    if (!result || result.cancelled) return false;
    await updateTimesheetDescription(settings, id, result.description || '');
  }

  await stopTimesheet(settings, id);
  clearDescriptionReviewState(id);
  return true;
}


// Öffnet, falls aktiviert, alle 15 Minuten einen Ergänzungsdialog für den aktuell laufenden eigenen Timer.
function maybeRunDescriptionReview(context) {
  const item = contexts.get(context);
  if (!item || item.descriptionReviewOpen) return;
  const settings = item.settings || {};
  if (!(settings.promptDescriptionEvery15 === true || settings.promptDescriptionEvery15 === 'true')) return;
  const active = Array.isArray(item.lastActive) ? item.lastActive : [];
  const entry = active.find((candidate) => matchesSettings(candidate, settings));
  if (!entry || entry.id === undefined || entry.id === null) return;

  const id = String(entry.id);
  const now = Date.now();
  let state = descriptionReviewState.get(id);
  if (!state) {
    state = { nextPromptAt: now + DESCRIPTION_REVIEW_MS, open: false };
    descriptionReviewState.set(id, state);
    return;
  }
  if (state.open || now < state.nextPromptAt || busy) return;

  state.open = true;
  item.descriptionReviewOpen = true;
  setImage(context, 'yellow', settings);
  setTitle(context, 'Beschreibung');
  promptForDescriptionReview(settings, entry)
    .then(async (result) => {
      if (!result || result.cancelled || result.action === 'none') {
        state.nextPromptAt = Date.now() + DESCRIPTION_REVIEW_MS;
        return;
      }

      const addition = String(result.addition || '').trim();
      const updatedDescription = appendDescription(entry.description || '', addition);
      if (addition) await updateTimesheetDescription(settings, entry.id, updatedDescription);

      if (result.action === 'save_stop') {
        await stopTimesheet(settings, entry.id);
        clearDescriptionReviewState(entry.id);
      } else {
        state.nextPromptAt = Date.now() + DESCRIPTION_REVIEW_MS;
      }
    })
    .catch((error) => {
      console.error('description review failed', error);
      state.nextPromptAt = Date.now() + API_ERROR_RETRY_MS;
      showAlert(context);
    })
    .finally(async () => {
      state.open = false;
      item.descriptionReviewOpen = false;
      await refreshAll();
    });
}

// Fügt den neuen Text sauber an die bestehende Beschreibung an.
function appendDescription(current, addition) {
  const base = String(current || '').trimEnd();
  const extra = String(addition || '').trim();
  if (!extra) return base;
  return base ? `${base}\n${extra}` : extra;
}

function clearDescriptionReviewState(id) {
  if (id !== undefined && id !== null) descriptionReviewState.delete(String(id));
}

// Speichert die Beschreibung vor dem Stoppen oder beim 15-Minuten-Review.
async function updateTimesheetDescription(settings, id, description) {
  return kimaiFetch(settings, `/api/timesheets/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ description })
  });
}

// Erzeugt einen Stop-Dialog, der die gesamte Beschreibung bearbeiten kann.
async function promptForStopDescription(settings, entry) {
  await ensurePromptServer();
  const token = crypto.randomBytes(18).toString('hex');
  const label = settings.label || labelForEntry(entry) || 'Kimai Timer';
  const currentDescription = entry.description || settings.description || '';
  const url = `http://127.0.0.1:${promptServerPort}/stop?token=${encodeURIComponent(token)}`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingPrompts.delete(token);
      resolve({ cancelled: true, timeout: true });
    }, 10 * 60 * 1000);

    pendingPrompts.set(token, {
      kind: 'stop',
      label,
      currentDescription,
      resolve: (result) => {
        clearTimeout(timeout);
        pendingPrompts.delete(token);
        resolve(result);
      }
    });

    openInBrowser(url);
  });
}

// Erzeugt den 15-Minuten-Review-Dialog, in dem nur Ergänzungstext eingegeben wird.
async function promptForDescriptionReview(settings, entry) {
  await ensurePromptServer();
  const token = crypto.randomBytes(18).toString('hex');
  const label = settings.label || labelForEntry(entry) || 'Kimai Timer';
  const currentDescription = entry.description || '';
  const url = `http://127.0.0.1:${promptServerPort}/review?token=${encodeURIComponent(token)}`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingPrompts.delete(token);
      resolve({ cancelled: true, timeout: true });
    }, 10 * 60 * 1000);

    pendingPrompts.set(token, {
      kind: 'review',
      label,
      currentDescription,
      resolve: (result) => {
        clearTimeout(timeout);
        pendingPrompts.delete(token);
        resolve(result);
      }
    });

    openInBrowser(url);
  });
}

// Startet bei Bedarf einen lokalen HTTP-Server für Browserdialoge.
// Der Server bindet nur an 127.0.0.1 und ist damit nicht aus dem LAN erreichbar.
async function ensurePromptServer() {
  if (promptServer && promptServerPort) return;

  promptServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/stop') {
        const token = url.searchParams.get('token') || '';
        const prompt = pendingPrompts.get(token);
        if (!prompt) return sendHtml(res, expiredPage());
        return sendHtml(res, stopPromptPage(token, prompt));
      }

      if (req.method === 'GET' && url.pathname === '/review') {
        const token = url.searchParams.get('token') || '';
        const prompt = pendingPrompts.get(token);
        if (!prompt) return sendHtml(res, expiredPage());
        return sendHtml(res, reviewPromptPage(token, prompt));
      }

      if (req.method === 'POST' && url.pathname === '/submit') {
        const body = await readRequestBody(req);
        const params = new URLSearchParams(body);
        const token = params.get('token') || '';
        const action = params.get('action') || 'stop';
        const prompt = pendingPrompts.get(token);
        if (!prompt) return sendHtml(res, expiredPage());

        if (action === 'cancel') {
          prompt.resolve({ cancelled: true });
          return sendHtml(res, donePage('Abgebrochen. Der Timer wurde nicht gestoppt.'));
        }

        if (action === 'none') {
          prompt.resolve({ cancelled: false, action: 'none' });
          return sendHtml(res, donePage('Keine Änderung gespeichert. Der Timer läuft weiter.'));
        }

        if (action === 'save_continue') {
          prompt.resolve({ cancelled: false, action: 'save_continue', addition: params.get('addition') || '' });
          return sendHtml(res, donePage('Gespeichert. Der Timer läuft weiter.'));
        }

        if (action === 'save_stop') {
          prompt.resolve({ cancelled: false, action: 'save_stop', addition: params.get('addition') || '' });
          return sendHtml(res, donePage('Gespeichert. Der Timer wird jetzt gestoppt.'));
        }

        prompt.resolve({ cancelled: false, action: 'stop', description: params.get('description') || '' });
        return sendHtml(res, donePage('Gespeichert. Der Timer wird jetzt gestoppt.'));
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Nicht gefunden');
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(error?.message || error));
    }
  });

  await new Promise((resolve, reject) => {
    promptServer.once('error', reject);
    promptServer.listen(0, '127.0.0.1', () => {
      promptServer.off('error', reject);
      promptServerPort = promptServer.address().port;
      resolve();
    });
  });
}

// Liest Formulardaten aus POST-Requests und begrenzt die maximale Größe.
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error('Eingabe ist zu groß.'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Einheitliche Antwort für die kleinen HTML-Dialogseiten.
function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

// HTML für den Stop-Dialog. Strg/Cmd+Enter löst den Default-Button aus.
function stopPromptPage(token, prompt) {
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Kimai Timer stoppen</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #181818; color: #eee; }
    main { width: min(720px, calc(100vw - 32px)); background: #252525; border: 1px solid #444; border-radius: 16px; padding: 22px; box-shadow: 0 18px 70px rgba(0,0,0,.35); }
    h1 { margin: 0 0 6px; font-size: 22px; }
    p { color: #bbb; margin: 0 0 16px; }
    textarea { width: 100%; min-height: 180px; box-sizing: border-box; resize: vertical; border-radius: 10px; border: 1px solid #555; background: #1f1f1f; color: #fff; padding: 12px; font: inherit; }
    .buttons { display: flex; gap: 10px; justify-content: flex-end; margin-top: 14px; }
    button { border: 0; border-radius: 10px; padding: 10px 16px; color: #fff; font: inherit; cursor: pointer; }
    button[name=action][value=stop] { background: #2e7d32; }
    button[name=action][value=cancel] { background: #555; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(prompt.label)} stoppen</h1>
    <p>Beschreibung eintragen oder anpassen und dann stoppen. Strg+Enter speichert und stoppt.</p>
    <form method="post" action="/submit">
      <input type="hidden" name="token" value="${escapeHtml(token)}" />
      <textarea name="description" autofocus>${escapeHtml(prompt.currentDescription)}</textarea>
      <div class="buttons">
        <button type="submit" name="action" value="cancel">Abbrechen</button>
        <button type="submit" name="action" value="stop" data-default="true">Speichern & stoppen</button>
      </div>
    </form>
  </main>
  <script>
    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        document.querySelector('button[data-default="true"]')?.click();
      }
    });
  </script>
</body>
</html>`;
}

// HTML für den 15-Minuten-Review. Der bestehende Text ist read-only, neuer Text wird angehängt.
function reviewPromptPage(token, prompt) {
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Kimai Beschreibung ergänzen</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #181818; color: #eee; }
    main { width: min(780px, calc(100vw - 32px)); background: #252525; border: 1px solid #444; border-radius: 16px; padding: 22px; box-shadow: 0 18px 70px rgba(0,0,0,.35); }
    h1 { margin: 0 0 6px; font-size: 22px; }
    p { color: #bbb; margin: 0 0 16px; }
    label { display: block; margin: 14px 0 6px; color: #ddd; font-weight: 650; }
    .readonly { white-space: pre-wrap; min-height: 70px; max-height: 220px; overflow: auto; border-radius: 10px; border: 1px solid #555; background: #1b1b1b; color: #ccc; padding: 12px; }
    textarea { width: 100%; min-height: 140px; box-sizing: border-box; resize: vertical; border-radius: 10px; border: 1px solid #555; background: #1f1f1f; color: #fff; padding: 12px; font: inherit; }
    .buttons { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
    button { border: 0; border-radius: 10px; padding: 10px 12px; color: #fff; font: inherit; cursor: pointer; }
    button[name=action][value=none] { background: #555; }
    button[name=action][value=save_stop] { background: #9a3412; }
    button[name=action][value=save_continue] { background: #2e7d32; }
    .hint { color:#aaa; font-size: 13px; margin-top: 8px; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(prompt.label)}</h1>
    <p>Du kannst die Beschreibung ergänzen. Der bestehende Text ist nur zur Kontrolle sichtbar.</p>
    <form method="post" action="/submit">
      <input type="hidden" name="token" value="${escapeHtml(token)}" />
      <label>Bisherige Beschreibung</label>
      <div class="readonly">${escapeHtml(prompt.currentDescription || '—')}</div>
      <label for="addition">Text anhängen</label>
      <textarea id="addition" name="addition" autofocus placeholder="Nur der Text, der ergänzt werden soll"></textarea>
      <div class="buttons">
        <button type="submit" name="action" value="none">Keine Änderung</button>
        <button type="submit" name="action" value="save_stop">Speichern und Beenden</button>
        <button type="submit" name="action" value="save_continue" data-default="true">Speichern und weiter</button>
      </div>
      <p class="hint">Strg+Enter löst „Speichern und weiter“ aus.</p>
    </form>
  </main>
  <script>
    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        document.querySelector('button[data-default="true"]')?.click();
      }
    });
  </script>
</body>
</html>`;
}

// Abschlussseite: versucht nach 1 Sekunde den Browser-Tab zu schließen.
function donePage(message) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kimai</title><style>:root{color-scheme:dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#181818;color:#eee}main{background:#252525;border:1px solid #444;border-radius:16px;padding:24px;max-width:560px;text-align:center}.muted{color:#bbb}</style><script>window.addEventListener('load',()=>setTimeout(()=>{try{window.open('', '_self');window.close();}catch(e){}},1000));</script></head><body><main><h1>${escapeHtml(message)}</h1><p class="muted">Du kannst diesen Tab jetzt schließen.</p></main></body></html>`;
}

function expiredPage() {
  return donePage('Diese Stopp-Anfrage ist nicht mehr gültig.');
}

function openInBrowser(url) {
  openDefaultBrowser(url);
}

// Öffnet bewusst den Default-Browser, keine Chrome/Edge-App-Fenster-Logik.
function openDefaultBrowser(url) {
  const platform = process.platform;
  if (platform === 'darwin') return execFile('open', [url], () => {});
  if (platform === 'win32') return execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  return execFile('xdg-open', [url], () => {});
}

// Fallback-Label, falls kein eigener Button-Titel gesetzt ist.
function labelForEntry(entry) {
  const project = nameOf(entry.project);
  const activity = nameOf(entry.activity);
  return [project, activity].filter(Boolean).join(' · ');
}

// Extrahiert einen menschenlesbaren Namen aus Kimai-Objekten oder Strings.
function nameOf(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.name || value.title || value.comment || '';
}

// Verhindert HTML-Injection in den lokal gerenderten Dialogseiten.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

// Kimai-Endpunkt zum Stoppen eines Timesheets.
async function stopTimesheet(settings, id) {
  return kimaiFetch(settings, `/api/timesheets/${encodeURIComponent(id)}/stop`, { method: 'PATCH' });
}

// Startet einen neuen Timesheet-Eintrag mit Projekt, Tätigkeit und optionaler Beschreibung/Tags.
async function startTimesheet(settings) {
  const body = {
    project: Number(settings.projectId),
    activity: Number(settings.activityId),
    begin: localDateTimeNow(),
    description: settings.description || ''
  };
  if (settings.tags) body.tags = String(settings.tags).split(',').map((x) => x.trim()).filter(Boolean);
  if (settings.billable === false || settings.billable === 'false') body.billable = false;
  return kimaiFetch(settings, '/api/timesheets?full=true', { method: 'POST', body: JSON.stringify(body) });
}

// Lädt Kunden, Projekte und Tätigkeiten für die Dropdowns im Property Inspector.
async function getCatalog(settings) {
  const [customers, projects, activities] = await Promise.all([
    kimaiFetch(settings, '/api/customers?visible=1&size=500').catch(() => []),
    kimaiFetch(settings, '/api/projects?visible=1&size=500').catch(() => []),
    kimaiFetch(settings, '/api/activities?visible=1&size=500').catch(() => [])
  ]);
  return { customers: asArray(customers), projects: asArray(projects), activities: asArray(activities) };
}

// Normalisiert verschiedene mögliche API-Antwortformen auf ein Array.
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

// Prüft, ob ein aktiver Kimai-Eintrag exakt zur Button-Konfiguration passt.
function matchesSettings(entry, settings) {
  const projectId = idOf(entry.project);
  const activityId = idOf(entry.activity);
  const customerId = idOf(entry.customer) || idOf(entry.project?.customer);
  const settingsCustomer = settings.customerId ? Number(settings.customerId) : null;
  return Number(projectId) === Number(settings.projectId)
    && Number(activityId) === Number(settings.activityId)
    && (!settingsCustomer || Number(customerId) === settingsCustomer);
}

// Kimai liefert Relationen je nach Version/Serialisierung als Zahl, String oder Objekt.
function idOf(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' || typeof value === 'string') return value;
  return value.id ?? value['@id']?.split('/').pop();
}

// Kimai akzeptiert lokale ISO-ähnliche Datumszeit ohne Zeitzonen-Suffix.
function localDateTimeNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}