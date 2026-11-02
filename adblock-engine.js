// Adblocker: lädt beim App-Start die Filter-Engine (uBlock-Origin-/EasyList-Listen, Bibliothek @ghostery/adblocker),
// hält sie aktuell (adblock-updater.js, adblock-lists.js) und schaltet sie für die gemeinsame Sitzung ein.
// Die Einbindung in Electron ist hier selbst geschrieben (statt enableBlockingInSession der Bibliothek). Gleiche
// Entscheidungslogik, aber mit drei Zusätzen:
//   1. Skripte früh: die uBlock-Skripte (Scriptlets) werden über adblock-preload.js beim Dokumentstart eingesetzt
//      (die Bibliothek tut es erst nachträglich - zu spät z.B. für YouTube).
//   2. Ausnahmen: auf Seiten der Ausnahmeliste wird nichts blockiert, ausgeblendet oder eingesetzt.
//   3. Protokoll (Fehlersuche): blockierte/umgeleitete Anfragen samt Regel in adblocker-log.txt.
//   4. Ersatzdateien: Umleitungsregeln (uBlocks harmlose Ersatzdateien für Werbe-/Analyse-Skripte) laufen über eine
//      eigene Adresse (adblock-res://). Die Bibliothek leitet auf data:-Adressen um - das lehnt der Browser für
//      Skripte und fetch ab (Fehler), die Regel wirkte dadurch wie ein harter Block und brach Seiten, die die
//      Ersatzdatei voraussetzen.
// Dazu lassen sich Netzwerk, Header, Ausblenden und Skripte einzeln abschalten, um Seitenfehler einzugrenzen.
const { app, session, ipcMain, protocol } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ElectronBlocker, fromElectronDetails } = require('@ghostery/adblocker-electron');
const { readAdblockerSettings, adblockerEnginePath, adblockerEngineMetaPath, adblockerLogPath, normalizeAdblockerSettings } = require('./settings-store');
const { createUpdater, buildInWorker } = require('./adblock-updater');

let tldParse = null;
try {
  tldParse = require('tldts-experimental').parse; // Abhängigkeit der Bibliothek, genauere Domain-Bestimmung
} catch (err) {
  // ohne: einfache Näherung (letzte zwei Teile des Hostnamens)
}

// Eigene Adresse für die Ersatzdateien. Als privilegiertes Schema (wie die Adresse einer Erweiterung) darf sie von
// Seiten geladen werden, ohne an deren Content-Security-Policy zu scheitern. Muss VOR dem Start der App (ready)
// angemeldet werden und geht nur einmal - deshalb hier beim Laden des Moduls.
const RESOURCE_SCHEME = 'adblock-res';
try {
  if (protocol && typeof protocol.registerSchemesAsPrivileged === 'function') {
    protocol.registerSchemesAsPrivileged([{ scheme: RESOURCE_SCHEME, privileges: { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true, corsEnabled: true } }]);
  }
} catch (err) {
  console.error('Adresse für Ersatzdateien konnte nicht angemeldet werden:', err);
}

// uBlock-Skripte, die den AUFBAU der Seite umbauen (Text eingebetteter Skripte umschreiben, Timer verbiegen,
// Einfügen von Elementen abfangen). Alle anderen ändern nur Daten (Werbung aus Antworten entfernen).
// Einzeln abschaltbar (scriptsStructural), falls eine Seite daran scheitert.
const STRUCTURAL_SCRIPTS = ['replaceNodeText', 'removeNodeText', 'preventDomBypass', 'adjustSetTimeout'];

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_URL_MAX = 220;

let currentSettings = normalizeAdblockerSettings({});

function parseUrl(url) {
  if (tldParse) {
    const parsed = tldParse(url);
    return { hostname: parsed.hostname || '', domain: parsed.domain || '' };
  }
  try {
    const hostname = new URL(url).hostname;
    return { hostname, domain: hostname.split('.').slice(-2).join('.') };
  } catch (err) {
    return { hostname: '', domain: '' };
  }
}

// Zerlegt eine data:-Adresse der Engine in Typ und Inhalt (base64 oder Text). Null, wenn sie nicht lesbar ist.
function parseDataUrl(dataUrl) {
  const match = typeof dataUrl === 'string' ? /^data:([^,]*),([\s\S]*)$/.exec(dataUrl) : null;
  if (!match) return null;
  const isBase64 = /;base64$/i.test(match[1]);
  const contentType = match[1].replace(/;base64$/i, '') || 'text/plain';
  try {
    return { contentType, body: isBase64 ? Buffer.from(match[2], 'base64') : Buffer.from(decodeURIComponent(match[2])) };
  } catch (err) {
    return null;
  }
}

// Hält die Ersatzdateien und liefert sie unter adblock-res://r/<Kennung> aus
function createRedirectStore() {
  const resources = new Map();
  return {
    urlFor(redirect) {
      const parsed = parseDataUrl(redirect.dataUrl);
      if (!parsed) return redirect.dataUrl; // nicht lesbar: wie die Bibliothek (die Seite bekommt dann einen Fehler)
      const id = crypto.createHash('sha1').update(redirect.dataUrl).digest('hex').slice(0, 16);
      resources.set(id, parsed);
      return `${RESOURCE_SCHEME}://r/${id}`;
    },
    respond(request) {
      let id = '';
      try { id = new URL(request.url).pathname.replace(/^\//, ''); } catch (err) { /* ungültig */ }
      const resource = resources.get(id);
      if (!resource) return new Response('', { status: 404 });
      return new Response(resource.body, { headers: { 'Content-Type': resource.contentType, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
    }
  };
}

// Jedes uBlock-Skript bekommt seinen eigenen Gültigkeitsbereich. Mehrere Skripte deklarieren auf oberster Ebene
// dieselben Namen (z.B. class JSONPath); als getrennte Skripte im selben Fenster ausgeführt scheitert jedes weitere
// mit "Identifier has already been declared" und läuft gar nicht. uBlock kapselt sie ebenso.
function isolateScript(code) {
  return `try { (function () {\n${code}\n})(); } catch (err) { /* ein defektes Skript darf die Seite nicht stören */ }`;
}

// Bezeichnung eines uBlock-Skripts (für Protokoll und Ausschlussliste): meist steht der Name der Funktion im Code,
// die anonymen erkennt man an ihrem Aufbau
function scriptletName(code) {
  const start = code.lastIndexOf('(...[');
  const head = start >= 0 ? code.slice(Math.max(0, start - 160), start) : code.slice(-160);
  const named = [...head.matchAll(/\(function (\w+)\(/g)];
  if (named.length) return named[named.length - 1][1];
  if (/self\.fetch=new Proxy/.test(code)) return /Pruned/.test(code) ? 'jsonPruneFetchResponse' : 'fetchHook';
  if (/Pruned/.test(code)) return 'jsonPrune';
  if (/XMLHttpRequest/.test(code) && /open/.test(code)) return 'xhrHook';
  if (/bypass/i.test(code)) return 'preventDomBypass';
  if (/setTimeout/.test(code)) return 'adjustSetTimeout';
  return 'sonstiges';
}

function countNames(names) {
  const counts = {};
  names.forEach((n) => { counts[n] = (counts[n] || 0) + 1; });
  return Object.keys(counts).map((n) => `${n}x${counts[n]}`).join(', ');
}

function shorten(text, max = LOG_URL_MAX) {
  return text.length > max ? text.slice(0, max) + '...' : text;
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (err) { return ''; }
}

function isAllowlisted(host, settings) {
  if (!host) return false;
  return settings.allowlist.some((entry) => host === entry || host.endsWith('.' + entry));
}

// Auf welcher Seite spielt sich die Anfrage ab (Hostname der obersten Seite)? Ausnahmen gelten für die Seite, nicht
// für das Ziel der Anfrage: auf einer Ausnahme-Seite darf alles geladen werden, was sie braucht.
function topHost(details) {
  if (details.resourceType === 'mainFrame') return hostOf(details.url);
  try {
    if (details.frame && details.frame.top && details.frame.top.url) return hostOf(details.frame.top.url);
  } catch (err) {
    // Frame schon weg
  }
  const fromReferrer = hostOf(details.referrer);
  if (fromReferrer) return fromReferrer;
  try {
    if (details.webContents && !details.webContents.isDestroyed()) return hostOf(details.webContents.getURL());
  } catch (err) {
    // WebContents schon weg
  }
  return '';
}

// Protokoll: sammelt Zeilen und schreibt sie gebündelt; wird zu groß -> alte Datei als .old beiseite legen
function createLogger(filePath) {
  let buffer = [];
  let timer = null;
  function flush() {
    timer = null;
    if (!buffer.length) return;
    const data = buffer.join('');
    buffer = [];
    try {
      try {
        if (fs.statSync(filePath).size > LOG_MAX_BYTES) fs.renameSync(filePath, filePath + '.old');
      } catch (err) {
        // Datei gibt es noch nicht
      }
      fs.appendFileSync(filePath, data);
    } catch (err) {
      console.error('Adblocker-Protokoll konnte nicht geschrieben werden:', err);
    }
  }
  return {
    write(line) {
      buffer.push(new Date().toISOString() + ' ' + line + '\n');
      if (!timer) timer = setTimeout(flush, 500);
    },
    flush
  };
}

// Die Teile der Einbindung als einzelne Funktionen (gut einzeln prüfbar). getSettings liefert die aktuellen Einstellungen.
function createHandlers(blockerOrGetter, getSettings, logger, redirectUrlFor = (redirect) => redirect.dataUrl) {
  // Die Engine kann im Betrieb durch eine frisch aufgebaute ersetzt werden: jeder Handler fragt sie bei Gebrauch ab
  const getBlocker = typeof blockerOrGetter === 'function' ? blockerOrGetter : () => blockerOrGetter;
  const logLine = (line) => { if (getSettings().log && logger) logger.write(line); };

  function onBeforeRequest(details, callback) {
    const settings = getSettings();
    if (!settings.networkEnabled) { callback({}); return; }
    const host = topHost(details);
    if (isAllowlisted(host, settings)) { callback({}); return; }
    const blocker = getBlocker();
    const request = fromElectronDetails(details);
    if (blocker.config.guessRequestTypeFromUrl === true && request.type === 'other') request.guessTypeOfRequest();
    if (request.isMainFrame()) { callback({}); return; }
    const { redirect, match, filter } = blocker.match(request);
    if (redirect) {
      logLine(`UMLEITUNG ${details.resourceType} [${host}] ${shorten(details.url)} | Regel: ${filter ? filter.toString() : '?'}`);
      callback({ redirectURL: redirectUrlFor(redirect) });
    } else if (match) {
      logLine(`BLOCK ${details.resourceType} [${host}] ${shorten(details.url)} | Regel: ${filter ? filter.toString() : '?'}`);
      callback({ cancel: true });
    } else {
      callback({});
    }
  }

  function onHeadersReceived(details, callback) {
    const settings = getSettings();
    if (!settings.headersEnabled || isAllowlisted(topHost(details), settings)) { callback({}); return; }
    const blocker = getBlocker();
    if (settings.log && (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame')) {
      const csp = blocker.getCSPDirectives(fromElectronDetails(details));
      if (csp !== undefined) logLine(`CSP ${details.resourceType} [${topHost(details)}] ${shorten(details.url)} | ${csp}`);
    }
    blocker.onHeadersReceived(details, callback);
  }

  // Ausblend-CSS (zuerst für den Hostnamen, danach auf Meldung des Preloads für neue Elemente der Seite)
  async function onInjectCosmeticFilters(event, url, msg) {
    const settings = getSettings();
    if (!settings.stylesEnabled) return;
    let pageUrl = url;
    try { pageUrl = event.sender.getURL() || url; } catch (err) { /* WebContents schon weg */ }
    if (isAllowlisted(hostOf(pageUrl), settings)) return;
    const { hostname, domain } = parseUrl(url);
    const isFirstRun = msg === undefined;
    const { active, styles } = getBlocker().getCosmeticsFilters({
      domain,
      hostname,
      url,
      classes: msg && msg.classes,
      hrefs: msg && msg.hrefs,
      ids: msg && msg.ids,
      getBaseRules: isFirstRun,
      getInjectionRules: false, // die Skripte kommen früh über adblock-preload.js, nicht hier
      getExtendedRules: false,
      getRulesFromHostname: isFirstRun,
      getRulesFromDOM: !isFirstRun,
      callerContext: { frameId: event.frameId, processId: event.processId, lifecycle: msg && msg.lifecycle }
    });
    if (active === false) return;
    if (styles.length > 0) event.sender.insertCSS(styles, { cssOrigin: 'user' });
  }

  async function onIsMutationObserverEnabled() {
    return getBlocker().config.enableMutationObserver;
  }

  // Skripte für eine Seite, synchron beantwortet (siehe adblock-preload.js)
  function earlyScriptsFor(event, url) {
    const settings = getSettings();
    if (!settings.scriptsEnabled || typeof url !== 'string') return [];
    let pageUrl = url;
    try { pageUrl = event.sender.getURL() || url; } catch (err) { /* WebContents schon weg */ }
    if (isAllowlisted(hostOf(pageUrl), settings)) return [];
    const { hostname, domain } = parseUrl(url);
    const { scripts } = getBlocker().getCosmeticsFilters({
      domain,
      hostname,
      url,
      classes: [],
      hrefs: [],
      ids: [],
      getBaseRules: false,
      getInjectionRules: true,
      getExtendedRules: false,
      getRulesFromHostname: true,
      getRulesFromDOM: false
    });
    const named = (scripts || []).map((code) => ({ code, name: scriptletName(code) }));
    const isSkipped = (s) => settings.scriptsExclude.includes(s.name) || (settings.scriptsStructural === false && STRUCTURAL_SCRIPTS.includes(s.name));
    const used = named.filter((s) => !isSkipped(s));
    const skipped = named.filter(isSkipped);
    if (named.length) {
      logLine(`SKRIPTE [${hostname}] ${used.length} von ${named.length} frueh eingesetzt: ${countNames(used.map((s) => s.name)) || '-'}${skipped.length ? ' | ausgeschlossen: ' + countNames(skipped.map((s) => s.name)) : ''}`);
    }
    return used.map((s) => isolateScript(s.code));
  }

  return { onBeforeRequest, onHeadersReceived, onInjectCosmeticFilters, onIsMutationObserverEnabled, earlyScriptsFor };
}

// Die Kanäle der Seiten (Skripte beim Dokumentstart, Ausblend-Regeln) sind für die ganze App gemeinsam und gehören immer zu
// den Handlern der gerade benutzten Sitzung (aktives Profil): beim Profilwechsel werden sie neu gesetzt.
function registerAdblockIpc(handlers) {
  ipcMain.removeAllListeners('adblock-early-scripts');
  ipcMain.on('adblock-early-scripts', (event, url) => { event.returnValue = handlers.earlyScriptsFor(event, url); });
  ipcMain.removeHandler('@ghostery/adblocker/inject-cosmetic-filters');
  ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', handlers.onInjectCosmeticFilters);
  ipcMain.removeHandler('@ghostery/adblocker/is-mutation-observer-enabled');
  ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', handlers.onIsMutationObserverEnabled);
}

// Schaltet die Engine für eine Sitzung ein: Netzwerk, Header, Ausblenden und frühe Skripte.
function installAdblocking(blocker, targetSession, { getSettings = () => currentSettings, logger = null, earlyPreloadPath = path.join(__dirname, 'adblock-preload.js') } = {}) {
  // Ersatzdateien über die eigene Adresse ausliefern (ohne Sitzungs-Protokolle: wie die Bibliothek über data:)
  let redirectUrlFor;
  if (targetSession.protocol && typeof targetSession.protocol.handle === 'function') {
    const store = createRedirectStore();
    try { targetSession.protocol.unhandle(RESOURCE_SCHEME); } catch (err) { /* war nicht angemeldet */ }
    targetSession.protocol.handle(RESOURCE_SCHEME, (request) => store.respond(request));
    redirectUrlFor = (redirect) => store.urlFor(redirect);
  }
  const holder = { blocker };
  const handlers = createHandlers(() => holder.blocker, getSettings, logger, redirectUrlFor);
  handlers.setBlocker = (newBlocker) => { holder.blocker = newBlocker; }; // frisch aufgebaute Engine einsetzen, ohne Neustart

  if (blocker.config.loadCosmeticFilters === true) {
    targetSession.registerPreloadScript({ type: 'frame', filePath: earlyPreloadPath });  // Skripte beim Dokumentstart
    // Die Bibliothek meldet im Hintergrund neue Seitenelemente (für allgemeine Ausblend-Regeln)
    targetSession.registerPreloadScript({ type: 'frame', filePath: require.resolve('@ghostery/adblocker-electron-preload') });
    registerAdblockIpc(handlers);
  }
  if (blocker.config.loadNetworkFilters === true) {
    targetSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, handlers.onHeadersReceived);
    targetSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, handlers.onBeforeRequest);
  }
  return handlers;
}

// Fehlermeldungen aus den Seiten (Konsole) ins Protokoll - zeigt, woran z.B. YouTube hängt. Nur für http(s)-Seiten,
// nicht für die eigenen Seiten des Launchers, und nur solange das Protokoll an ist.
function attachPageLogging(logger, getSettings = () => currentSettings) {
  if (!logger || !app || typeof app.on !== 'function') return;
  app.on('web-contents-created', (event, contents) => {
    contents.on('console-message', (details) => {
      if (!details || (details.level !== 'error' && details.level !== 3) || !getSettings().log) return;
      let url = '';
      try { url = contents.getURL(); } catch (err) { return; }
      if (!/^https?:/.test(url)) return;
      logger.write(`SEITENFEHLER [${hostOf(url)}] ${shorten(String(details.message))} (${shorten(String(details.sourceId || ''), 80)}:${details.lineNumber})`);
    });
  });
}

// Einstellungen wurden geändert (Ausnahmen, Protokoll, Schichten): gilt sofort für alle weiteren Anfragen und Seiten
function updateAdblockerSettings(settings) {
  currentSettings = normalizeAdblockerSettings(settings);
}

let updater = null;

// Sitzungen (je Profil eine): die Engine wird in jede Sitzung einmal eingesetzt, sobald sie gebraucht wird
const adblockInstalls = new Map(); // Sitzung -> Handler
let adblockBlocker = null;         // aktuelle Engine (null, solange noch keine geladen ist)
let adblockLogger = null;
let adblockWantedSession = null;   // Sitzung des aktiven Profils

// Das aktive Profil hat gewechselt: die Engine auch in dessen Sitzung einsetzen (falls noch nicht geschehen) und die Kanäle
// der Seiten darauf umstellen. Ist die Engine noch nicht geladen, wird die Sitzung beim Laden benutzt.
function useAdblockSession(targetSession) {
  adblockWantedSession = targetSession;
  if (!adblockBlocker || !targetSession) return false;
  let handlers = adblockInstalls.get(targetSession);
  if (!handlers) {
    handlers = installAdblocking(adblockBlocker, targetSession, { logger: adblockLogger });
    adblockInstalls.set(targetSession, handlers);
  } else if (adblockBlocker.config.loadCosmeticFilters === true) {
    registerAdblockIpc(handlers);
  }
  return true;
}

// Lädt die Engine (Zwischenspeicher oder frisch aus den Listen) und aktiviert sie, sofern der Adblocker in den Einstellungen
// an ist. Wird nur einmal beim App-Start aufgerufen - Live-Umschalten von "an/aus" ist nicht zuverlässig, daher läuft das
// Umschalten über einen kurzen App-Neustart. Ob die Listen aktuell sind, prüft der Updater danach selbständig.
// deps.getSession: liefert die Sitzung des aktiven Profils (Standard: die Standardsitzung).
async function initAdblocker(deps = {}) {
  currentSettings = readAdblockerSettings();
  if (!currentSettings.enabled) {
    console.log('Adblocker ist deaktiviert.');
    return;
  }

  const logger = createLogger(adblockerLogPath);
  adblockLogger = logger;
  const getSession = deps.getSession || (() => session.defaultSession);
  let first = true;
  const onEngine = (blocker) => {
    adblockBlocker = blocker;
    if (!first) {                                               // spätere Erneuerung: nur austauschen
      adblockInstalls.forEach((handlers) => handlers.setBlocker(blocker));
      return;
    }
    first = false;
    useAdblockSession(adblockWantedSession || getSession());
    attachPageLogging(logger);
    if (currentSettings.log) logger.write(`START Adblocker aktiv | Ausnahmen: ${currentSettings.allowlist.join(', ') || '-'} | Netzwerk ${currentSettings.networkEnabled} Header ${currentSettings.headersEnabled} Ausblenden ${currentSettings.stylesEnabled} Skripte ${currentSettings.scriptsEnabled} Seitenumbau ${currentSettings.scriptsStructural}`);
    console.log('Adblocker aktiv.');
  };
  try {
    updater = createUpdater({
      fetchImpl: deps.fetchImpl || fetch,   // fetch ist in Electron/Node eingebaut
      buildEngine: deps.buildEngine || ((input) => buildInWorker(path.join(__dirname, 'adblock-build-worker.js'), input)),
      deserialize: (buffer) => ElectronBlocker.deserialize(buffer),
      fs: deps.fs || fs,
      enginePath: adblockerEnginePath,
      metaPath: adblockerEngineMetaPath,
      onEngine,
      log: (line) => { if (currentSettings.log) logger.write(line); },
      ...(deps.updaterOptions || {})
    });
    const installed = await updater.start();
    if (!installed) console.error('Adblocker konnte nicht initialisiert werden: ' + updater.state.lastError + '. Neuer Versuch folgt automatisch.');
  } catch (err) {
    console.error('Adblocker konnte nicht initialisiert werden:', err);
  }
}

// Für die Einstellungsseite: Stand der Filterlisten und sofortiges Erneuern
function getAdblockerListsInfo() {
  if (!updater) return { installed: false, refreshing: false, lastError: null, builtAt: null, ageHours: null, outdated: false, networkFilters: null, cosmeticFilters: null, sources: [], failed: [], active: false };
  return { ...updater.info(), active: true };
}

async function refreshAdblockerLists() {
  if (!updater) return { ok: false, error: 'Der Adblocker ist ausgeschaltet.', info: getAdblockerListsInfo() };
  const result = await updater.refresh('manuell');
  return { ok: result.ok, error: result.error || null, info: getAdblockerListsInfo() };
}

module.exports = { initAdblocker, useAdblockSession, getAdblockerListsInfo, refreshAdblockerLists, installAdblocking, updateAdblockerSettings, createLogger, createHandlers, createRedirectStore, parseDataUrl, isolateScript, scriptletName, attachPageLogging, STRUCTURAL_SCRIPTS, RESOURCE_SCHEME };
