// Filterlisten des Adblockers: woher sie kommen, wie sie heruntergeladen, aufbereitet und zusammengesetzt werden.
//
// Warum nicht die fertigen Listen der Bibliothek? Sie lädt aus einem Spiegel (ghostery/adblocker), der den Quellen um
// Wochen hinterherhinkt (EasyList dort: 7 Wochen alt), eine feste Dateiliste hat (endet bei filters-2024) und den
// Zwischenspeicher nie erneuert. YouTube ändert sein Antwortformat laufend; veraltete Regeln (z.B. die zwei
// Experiment-Schalter, die uBlock inzwischen abgeschaltet hat) lassen den Player in einer Startschleife hängen.
// Deshalb: Listen direkt von uBlock Origin / EasyList, der Spiegel nur als Rückfall.
//
// Dieses Modul kennt kein Electron und keine Bibliothek: es liefert Text. Gut einzeln prüfbar.

const MIRROR = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets';
const UBLOCK = 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters';
const UBLOCK_PAGES = 'https://ublockorigin.github.io/uAssets/thirdparties';
const FIRST_YEAR_LIST = 2020;          // uBlock legt jedes Jahr eine eigene Datei an (filters-2020 ... filters-<Jahr>)
const MAX_AGE_MS = 24 * 60 * 60 * 1000;      // älter als einen Tag: neu laden
const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000; // alle 3 Stunden nachsehen, ob es Zeit ist
const FORMAT = 2;                       // Aufbau des Zwischenspeichers (1 = alte Dateien der Bibliothek ohne Angaben)
const FETCH_TIMEOUT_MS = 40000;

// ---------------------------------------------------------------------------------------------------------------
// Skriptregeln: uBlock schreibt die Argumente roh (mit Anführungszeichen und maskierten Kommas). Die Engine erwartet
// sie einzeln kodiert (encodeURIComponent, ohne Anführungszeichen) - so bereitet auch der Spiegel sie auf.
// Geprüft gegen den Spiegel: 5.038 von 5.038 Regeln Byte für Byte gleich, dazu 175 knifflige.
// ---------------------------------------------------------------------------------------------------------------
function splitScriptletArgs(inner) {
  const args = [];
  const n = inner.length;
  let i = 0;
  const isSpace = (c) => c === ' ' || c === '\t';
  for (;;) {
    while (i < n && isSpace(inner[i])) i += 1;
    const quote = inner[i];
    if (quote === '"' || quote === "'" || quote === '`') {
      // Argument in Anführungszeichen: gilt nur, wenn das schließende Zeichen von Komma oder Ende gefolgt wird
      let j = i + 1;
      let found = -1;
      while (j < n) {
        if (inner[j] === '\\') { j += 2; continue; }
        if (inner[j] === quote) {
          let k = j + 1;
          while (k < n && isSpace(inner[k])) k += 1;
          if (k === n || inner[k] === ',') { found = j; break; }
        }
        j += 1;
      }
      if (found >= 0) {
        args.push(inner.slice(i + 1, found).split('\\' + quote).join(quote));
        i = found + 1;
        while (i < n && isSpace(inner[i])) i += 1;
        if (i >= n) break;
        i += 1; // das Komma
        if (i >= n) { args.push(''); break; }
        continue;
      }
    }
    let buffer = '';
    let j = i;
    while (j < n) {
      if (inner[j] === '\\' && inner[j + 1] === ',') { buffer += ','; j += 2; continue; }
      if (inner[j] === ',') break;
      buffer += inner[j];
      j += 1;
    }
    args.push(buffer.replace(/\s+$/, ''));
    if (j >= n) break;
    i = j + 1;
    if (i >= n) { args.push(''); break; }
  }
  return args;
}

function encodeScriptletRule(line) {
  const at = line.indexOf('+js(');
  if (at < 0 || !line.endsWith(')') || line.startsWith('!')) return line; // Kommentare nie anfassen
  const head = line.slice(0, at + 4);
  const inner = line.slice(at + 4, -1);
  return head + splitScriptletArgs(inner).map((arg) => encodeURIComponent(arg)).join(', ') + ')';
}

// Kodiert alle Skriptregeln eines Listentexts (Kommentare und Zeilen ohne Skript bleiben unberührt)
function encodeScriptletRules(text) {
  return text.split('\n').map((raw) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    return line.includes('+js(') && !line.startsWith('!') ? encodeScriptletRule(line) : line;
  }).join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Welche Listen, aus welchen Quellen (in dieser Reihenfolge versucht)
// ---------------------------------------------------------------------------------------------------------------
function planLists(year = new Date().getFullYear()) {
  const mirror = (path) => ({ url: `${MIRROR}/${path}`, encoded: true, label: 'Ghostery-Spiegel' });
  // optional: fehlt die Datei (z.B. die des kommenden Jahres, das es noch nicht gibt), ist das kein Fehler
  const ublock = (name, { required = false, minBytes = 200, optional = false } = {}) => ({
    id: name,
    required,
    optional,
    minBytes,
    sources: [{ url: `${UBLOCK}/${name}.txt`, encoded: false, label: 'uBlock Origin' }, ...(optional ? [] : [mirror(`ublock-origin/${name}.txt`)])]
  });
  const easy = (name) => ({
    id: name,
    required: true,
    minBytes: 100000,
    sources: [
      { url: `${UBLOCK_PAGES}/${name}.txt`, encoded: false, label: 'uBlock Origin (Kopie)' },
      { url: `https://easylist.to/easylist/${name}.txt`, encoded: false, label: 'EasyList' },
      mirror(`easylist/${name}.txt`)
    ]
  });
  const yearLists = [];
  for (let y = FIRST_YEAR_LIST; y <= year + 1; y += 1) yearLists.push(ublock(`filters-${y}`, { optional: y > year }));
  return [
    easy('easylist'),
    { id: 'peter-lowe', required: false, minBytes: 1000, sources: [mirror('peter-lowe/serverlist.txt')] },
    ublock('badware'),
    ...yearLists,
    ublock('filters', { required: true, minBytes: 100000 }),
    ublock('quick-fixes', { required: true, minBytes: 5000 }),
    ublock('resource-abuse'),
    ublock('unbreak'),
    easy('easyprivacy'),
    ublock('privacy')
  ];
}

const RESOURCES_SOURCES = [{ url: `${MIRROR}/ublock-origin/resources.json`, label: 'Ghostery-Spiegel' }];

// ---------------------------------------------------------------------------------------------------------------
// Herunterladen
// ---------------------------------------------------------------------------------------------------------------
class FetchError extends Error {
  constructor(message, { retryable }) { super(message); this.retryable = retryable; }
}

async function fetchText(fetchImpl, url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new FetchError(`HTTP ${response.status}`, { retryable: response.status >= 500 || response.status === 429 });
    return await response.text();
  } catch (err) {
    if (err instanceof FetchError) throw err;
    throw new FetchError(err && err.name === 'AbortError' ? 'Zeitüberschreitung' : String((err && err.message) || err), { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

// Sieht der Text wie eine Liste aus (und nicht wie eine Fehlerseite)?
function looksLikeList(text, minBytes) {
  if (typeof text !== 'string' || text.length < minBytes) return false;
  const start = text.slice(0, 400).trimStart().toLowerCase();
  if (start.startsWith('<!doctype') || start.startsWith('<html') || start.startsWith('<?xml')) return false;
  return text.includes('\n');
}

async function fetchFirstValid(fetchImpl, sources, validate, { retries = 1, retryDelayMs = 800, timeoutMs } = {}) {
  const errors = [];
  for (const source of sources) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const text = await fetchText(fetchImpl, source.url, { timeoutMs });
        if (!validate(text)) throw new FetchError('unbrauchbare Antwort', { retryable: false });
        return { text, source, errors };
      } catch (err) {
        errors.push(`${source.label}: ${err.message}`);
        if (!(err instanceof FetchError) || !err.retryable || attempt === retries) break;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  return { text: null, source: null, errors };
}

// Lädt alle Listen (höchstens `concurrency` gleichzeitig) und die Skript-Bibliothek
async function downloadLists(fetchImpl, plan, { concurrency = 6, timeoutMs, retryDelayMs } = {}) {
  const results = new Array(plan.length);
  const failed = [];
  let next = 0;
  const worker = async () => {
    while (next < plan.length) {
      const index = next;
      next += 1;
      const list = plan[index];
      const got = await fetchFirstValid(fetchImpl, list.sources, (t) => looksLikeList(t, list.minBytes), { timeoutMs, retryDelayMs });
      if (got.text === null) { if (!list.optional) failed.push({ id: list.id, required: list.required, errors: got.errors }); }
      else results[index] = { id: list.id, text: got.text, encoded: got.source.encoded, label: got.source.label, bytes: got.text.length, fallback: got.errors.length > 0 };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, plan.length) }, worker));
  const res = await fetchFirstValid(fetchImpl, RESOURCES_SOURCES, (t) => {
    try { const j = JSON.parse(t); return Array.isArray(j.scriptlets) && j.scriptlets.length >= 50 && Array.isArray(j.redirects); } catch (err) { return false; }
  }, { timeoutMs, retryDelayMs });
  return { results: results.filter(Boolean), failed, resourcesText: res.text, resourcesErrors: res.errors, resourcesLabel: res.source && res.source.label };
}

// Fehlt etwas Wesentliches? (Liefert eine Fehlermeldung oder null)
function missingEssentials(download) {
  const required = download.failed.filter((f) => f.required);
  if (required.length) return `Wesentliche Liste fehlt: ${required.map((f) => `${f.id} (${f.errors.join('; ')})`).join(', ')}`;
  if (download.resourcesText === null) return `Skript-Bibliothek nicht ladbar (${download.resourcesErrors.join('; ')})`;
  return null;
}

// Setzt die Listen in der Reihenfolge des Plans zusammen; Quellen von uBlock (nicht kodiert) bekommen kodierte Skriptregeln
function assembleListText(results) {
  return results.map((r) => (r.encoded ? r.text : encodeScriptletRules(r.text))).join('\n');
}

function summarize(download) {
  return {
    lists: download.results.map((r) => ({ id: r.id, source: r.label, bytes: r.bytes, fallback: r.fallback })),
    failed: download.failed.map((f) => ({ id: f.id, errors: f.errors })),
    resources: download.resourcesLabel || null
  };
}

// Muss neu geladen werden? (Datei fehlt, alter Aufbau, zu alt, kaputtes Datum)
function needsRefresh(meta, now = Date.now(), maxAgeMs = MAX_AGE_MS) {
  if (!meta || meta.format !== FORMAT) return true;
  const built = Date.parse(meta.builtAt);
  if (!Number.isFinite(built)) return true;
  return now - built > maxAgeMs || built - now > 60 * 60 * 1000; // zu alt, oder "aus der Zukunft" (falsche Uhr)
}

module.exports = {
  splitScriptletArgs, encodeScriptletRule, encodeScriptletRules, planLists, RESOURCES_SOURCES, fetchText, looksLikeList, fetchFirstValid,
  downloadLists, missingEssentials, assembleListText, summarize, needsRefresh, FetchError,
  FORMAT, MAX_AGE_MS, CHECK_INTERVAL_MS
};
