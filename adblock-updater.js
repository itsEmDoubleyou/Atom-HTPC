// Hält die Filter-Engine aktuell: lädt sie beim Start aus dem Zwischenspeicher (schnell), erneuert die Listen im
// Hintergrund, sobald sie älter als einen Tag sind, und tauscht die neue Engine OHNE Neustart ein.
// Die Bibliothek selbst erneuert ihren Zwischenspeicher nie; die dortige Datei bliebe für immer auf dem Stand des ersten Starts.
//
// Alles Äußere (Netz, Dateien, Uhr, Zeitgeber, Aufbau-Thread) wird von außen hereingegeben: so lässt sich der Ablauf
// ohne echtes Netz und ohne Electron prüfen.
const lists = require('./adblock-lists');

const RETRY_BASE_MS = 10 * 60 * 1000;      // nach einem Fehlschlag nach 10 Minuten erneut, dann 20, 40 ... (höchstens alle 3 Stunden)
const FIRST_REFRESH_DELAY_MS = 3000;       // Erneuern nach dem Start erst, wenn die App oben ist

// Baut die Engine in einem eigenen Thread (das Parsen dauert 1-2 s und würde den Launcher sonst ruckeln lassen)
function buildInWorker(workerPath, input, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const { Worker } = require('worker_threads');
    const worker = new Worker(workerPath, { workerData: input });
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('Aufbau der Engine dauerte zu lange')), timeoutMs);
    worker.once('message', (m) => (m && m.ok ? finish(resolve, m) : finish(reject, new Error((m && m.error) || 'Aufbau fehlgeschlagen'))));
    worker.once('error', (err) => finish(reject, err));
    worker.once('exit', (code) => finish(reject, new Error(`Aufbau-Thread beendet (Code ${code})`)));
  });
}

function createUpdater({
  fetchImpl, buildEngine, deserialize, fs, enginePath, metaPath, onEngine,
  now = Date.now, scheduler = { setTimeout, clearTimeout, setInterval, clearInterval }, log = () => {}, year = () => new Date().getFullYear(),
  downloadOptions = {}   // z.B. { retryDelayMs, timeoutMs, concurrency } - in Tests kurz
}) {
  const state = { meta: null, refreshing: null, lastError: null, failures: 0, installed: false, retryTimer: null, intervalTimer: null, lastAttemptAt: null };

  async function loadCache() {
    let buffer;
    try { buffer = await fs.promises.readFile(enginePath); } catch (err) { return null; }
    let blocker;
    try { blocker = deserialize(buffer); } catch (err) { log(`LISTEN Zwischenspeicher nicht lesbar (${err.message}), wird neu aufgebaut`); return null; }
    let meta = null;
    try { meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')); } catch (err) { /* alte Datei ohne Angaben */ }
    return { blocker, meta };
  }

  async function writeAtomic(file, data) {
    const tmp = file + '.tmp';
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, file);
  }

  async function doRefresh(reason) {
    state.lastAttemptAt = now();
    log(`LISTEN Aktualisierung gestartet (${reason})`);
    const download = await lists.downloadLists(fetchImpl, lists.planLists(year()), downloadOptions);
    const missing = lists.missingEssentials(download);
    if (missing) throw new Error(missing);
    const text = lists.assembleListText(download.results);
    const built = await buildEngine({ text, resourcesText: download.resourcesText });
    const blocker = deserialize(built.buffer);   // prüft nebenbei, dass sich die neue Datei laden lässt
    const meta = {
      format: lists.FORMAT,
      builtAt: new Date(now()).toISOString(),
      networkFilters: built.networkFilters,
      cosmeticFilters: built.cosmeticFilters,
      ...lists.summarize(download)
    };
    await writeAtomic(enginePath, built.buffer);
    await writeAtomic(metaPath, JSON.stringify(meta, null, 2));
    state.meta = meta;
    state.lastError = null;
    state.failures = 0;
    onEngine(blocker, meta);
    state.installed = true;
    const fallback = meta.lists.filter((l) => l.fallback).map((l) => l.id);
    log(`LISTEN Aktualisierung erfolgreich: ${meta.networkFilters} Netzwerkfilter, ${meta.cosmeticFilters} Ausblendfilter, ${meta.lists.length} Listen${fallback.length ? ' | Rückfall auf andere Quelle: ' + fallback.join(', ') : ''}${meta.failed.length ? ' | nicht ladbar: ' + meta.failed.map((f) => f.id).join(', ') : ''}`);
    return meta;
  }

  // Erneuert die Listen jetzt (ein laufender Vorgang wird mitbenutzt). Liefert { ok, error?, meta }
  function refresh(reason = 'manuell') {
    if (state.refreshing) return state.refreshing;
    state.refreshing = doRefresh(reason)
      .then((meta) => ({ ok: true, meta }))
      .catch((err) => {
        state.lastError = String((err && err.message) || err);
        state.failures += 1;
        log(`LISTEN Aktualisierung fehlgeschlagen: ${state.lastError}`);
        return { ok: false, error: state.lastError, meta: state.meta };
      })
      .finally(() => { state.refreshing = null; });
    return state.refreshing;
  }

  function scheduleRetry() {
    scheduler.clearTimeout(state.retryTimer);
    const delay = Math.min(lists.CHECK_INTERVAL_MS, RETRY_BASE_MS * 2 ** Math.max(0, state.failures - 1));
    state.retryTimer = scheduler.setTimeout(() => checkNow('Wiederholung'), delay);
    if (state.retryTimer && state.retryTimer.unref) state.retryTimer.unref();
  }

  async function checkNow(reason) {
    const isFresh = state.installed && !lists.needsRefresh(state.meta, now());
    if (state.refreshing || isFresh) return;
    const result = await refresh(reason);
    if (!result.ok) scheduleRetry();
  }

  // Beim Start: Zwischenspeicher nutzen (schnell); gibt es keinen, die Listen jetzt laden. Danach regelmäßig nachsehen.
  async function start() {
    const cached = await loadCache();
    if (cached) {
      state.meta = cached.meta;
      onEngine(cached.blocker, cached.meta);
      state.installed = true;
      if (lists.needsRefresh(cached.meta, now())) {
        const t = scheduler.setTimeout(() => checkNow('Start, Listen sind veraltet'), FIRST_REFRESH_DELAY_MS);
        if (t && t.unref) t.unref();
      }
    } else {
      const result = await refresh('Start, kein Zwischenspeicher');
      if (!result.ok) scheduleRetry();
    }
    state.intervalTimer = scheduler.setInterval(() => checkNow('Zeitplan'), lists.CHECK_INTERVAL_MS);
    if (state.intervalTimer && state.intervalTimer.unref) state.intervalTimer.unref();
    return state.installed;
  }

  function stop() {
    scheduler.clearTimeout(state.retryTimer);
    if (state.intervalTimer) scheduler.clearInterval(state.intervalTimer);
  }

  // Für die Einstellungsseite
  function info() {
    const meta = state.meta;
    const built = meta ? Date.parse(meta.builtAt) : NaN;
    return {
      installed: state.installed,
      refreshing: !!state.refreshing,
      lastError: state.lastError,
      builtAt: meta && Number.isFinite(built) ? meta.builtAt : null,
      ageHours: Number.isFinite(built) ? Math.max(0, (now() - built) / 3600000) : null,
      outdated: lists.needsRefresh(meta, now()),
      networkFilters: meta ? meta.networkFilters || null : null,
      cosmeticFilters: meta ? meta.cosmeticFilters || null : null,
      sources: meta && meta.lists ? [...new Set(meta.lists.map((l) => l.source))] : [],
      failed: meta && meta.failed ? meta.failed.map((f) => f.id) : []
    };
  }

  return { start, stop, refresh, info, loadCache, checkNow, state };
}

module.exports = { createUpdater, buildInWorker, RETRY_BASE_MS, FIRST_REFRESH_DELAY_MS };
