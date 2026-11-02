// Browser-Apps (App-Typ "browser"): eine normale App-Ansicht, in die der Preload (app-view-preload.js) eine
// Bedienleiste mit Zurück/Vor/Neu laden/Startseite/Adressleiste setzt. Dieses Modul ist die Hauptprozess-Seite
// davon: Adresseingaben auswerten, Befehle der Leiste ausführen, den Zustand an die Leiste melden, Popups im
// selben Tab öffnen und Downloads abfangen. Alles hier greift nur für Ansichten, die über registerBrowserView()
// angemeldet wurden - andere Apps bleiben unberührt.
const { ipcMain, session } = require('electron');

const DEFAULT_HOME_URL = 'https://www.google.com/';
const SEARCH_URL = 'https://www.google.com/search?q=';
const MAX_INPUT_LENGTH = 2048;
const NOTICE_MS = 5000;          // so lange bleibt ein Hinweis (z.B. "Downloads nicht unterstützt") in der Leiste
const NOTICE_MAX_NAME = 60;

// Zustand je Browser-Ansicht (Schlüssel: webContents). Nur hier angemeldete Ansichten werden bedient.
const browserViews = new WeakMap();

// ---------- Adressen ----------

// Nur http und https. Alles andere (file:, javascript:, data:, chrome:, ...) wird nie geladen.
function isAllowedBrowserUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

// Schemata ohne "//", die in der Adressleiste nie geladen werden sollen (und nicht als Suchbegriff gelten)
const BLOCKED_COLON_SCHEMES = /^(javascript|data|mailto|tel|sms|about|blob|view-source|chrome|file|ftp)\s*:/i;
const IPV4_HOST = /^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?$/;
const IPV6_HOST = /^\[[0-9a-f:.]+\](:\d{1,5})?$/i;
const LOCAL_HOST = /^localhost(:\d{1,5})?$/i;
// Name mit Punkt, dessen letzter Teil mindestens zwei Zeichen hat und einen Buchstaben enthält ("3.50" und "v1.2.3" sind keine Adressen)
const DOMAIN_HOST = /^([\p{L}\p{N}-]+\.)+\p{L}[\p{L}\p{N}-]+(:\d{1,5})?$/u;

function searchUrl(query) {
  return SEARCH_URL + encodeURIComponent(query);
}

// Macht aus dem Text der Adressleiste eine Adresse: vollständige Adresse bleibt, "beispiel.de" wird zu
// https://beispiel.de, lokale Adressen und Adressen mit Port nutzen http, alles andere wird gesucht.
// Gibt null zurück, wenn der Text nicht geöffnet werden darf oder leer ist.
function normalizeBrowserInput(text) {
  if (typeof text !== 'string') return null;
  const input = text.trim();
  if (!input || input.length > MAX_INPUT_LENGTH) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    if (!isAllowedBrowserUrl(input)) return null;
    return new URL(input).href;
  }
  if (BLOCKED_COLON_SCHEMES.test(input)) return null;
  if (/\s/.test(input)) return searchUrl(input);

  const authority = input.split(/[/?#]/)[0];
  const isLocal = LOCAL_HOST.test(authority) || IPV4_HOST.test(authority) || IPV6_HOST.test(authority);
  if (!isLocal && !DOMAIN_HOST.test(authority)) return searchUrl(input);

  const hasPort = IPV6_HOST.test(authority) ? /\]:\d{1,5}$/.test(authority) : /:\d{1,5}$/.test(authority);
  const scheme = isLocal || hasPort ? 'http' : 'https';
  try {
    return new URL(scheme + '://' + input).href;
  } catch (err) {
    return searchUrl(input);
  }
}

// ---------- Tastenkürzel (Hauptprozess leitet sie in Browser-Apps an uns weiter) ----------

// Gibt den Befehl zu einer Taste zurück oder null. input = Eingabe-Objekt von before-input-event.
function shortcutCommandFor(input) {
  if (!input || input.type !== 'keyDown') return null;
  if (input.alt && !input.control && !input.meta && !input.shift) {
    if (input.code === 'ArrowLeft') return { type: 'back' };
    if (input.code === 'ArrowRight') return { type: 'forward' };
    if (input.code === 'Home') return { type: 'home' };
  }
  if (!input.alt && !input.meta) {
    if (input.code === 'F5') return { type: 'reload' };
    if (input.control && input.code === 'KeyR') return { type: 'reload' };
    if (input.control && !input.shift && input.code === 'KeyL') return { type: 'focus-address' };
  }
  return null;
}

// ---------- Zustand und Befehle ----------

function buildState(wc, info) {
  const history = wc.navigationHistory;
  return {
    url: wc.getURL() || info.homeUrl,
    title: wc.getTitle(),
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
    loading: wc.isLoading(),
    barVisible: info.barVisible,
    notice: info.notice
  };
}

function pushState(wc) {
  const info = browserViews.get(wc);
  if (!info || wc.isDestroyed()) return;
  try {
    wc.send('browser-state', buildState(wc, info));
  } catch (err) {
    // Seite wird gerade gewechselt: die nächste Zustandsmeldung oder die Abfrage beim Start holt es nach
  }
}

function setNotice(wc, text) {
  const info = browserViews.get(wc);
  if (!info) return;
  if (info.noticeTimer) clearTimeout(info.noticeTimer);
  info.notice = text;
  pushState(wc);
  info.noticeTimer = setTimeout(() => {
    info.noticeTimer = null;
    info.notice = '';
    pushState(wc);
  }, NOTICE_MS);
}

function loadUrl(wc, url) {
  // Abgebrochene oder fehlgeschlagene Ladevorgänge zeigt Chromium als Fehlerseite - die Leiste bleibt dort erhalten
  wc.loadURL(url).catch(() => {});
}

// Führt einen Befehl der Leiste (oder eines Tastenkürzels) aus
function runBrowserCommand(wc, command) {
  const info = browserViews.get(wc);
  if (!info || !command || typeof command.type !== 'string' || wc.isDestroyed()) return;
  const history = wc.navigationHistory;
  switch (command.type) {
    case 'back':
      if (history.canGoBack()) history.goBack();
      break;
    case 'forward':
      if (history.canGoForward()) history.goForward();
      break;
    case 'reload':
      wc.reload();
      break;
    case 'stop':
      wc.stop();
      break;
    case 'home':
      loadUrl(wc, info.homeUrl);
      break;
    case 'navigate': {
      const url = normalizeBrowserInput(command.text);
      if (url) loadUrl(wc, url);
      else setNotice(wc, 'Diese Adresse kann nicht geöffnet werden.');
      break;
    }
    case 'bar-visible':
      info.barVisible = command.visible === true;
      pushState(wc);
      break;
    case 'focus-address':
      info.barVisible = true;
      pushState(wc);
      wc.send('browser-focus-address');
      break;
    default:
      break;
  }
}

function isBrowserView(wc) {
  return !!wc && browserViews.has(wc);
}

// Meldet eine App-Ansicht als Browser an. homeUrl ist die Startseite der App (Knopf "Startseite").
function registerBrowserView(view, homeUrl) {
  const wc = view.webContents;
  const info = {
    homeUrl: isAllowedBrowserUrl(homeUrl) ? homeUrl : DEFAULT_HOME_URL,
    barVisible: true,
    notice: '',
    noticeTimer: null
  };
  browserViews.set(wc, info);

  // Links mit target=_blank und window.open: im selben Tab öffnen statt ein neues Fenster aufzumachen
  wc.setWindowOpenHandler(({ url }) => {
    if (isAllowedBrowserUrl(url)) loadUrl(wc, url);
    return { action: 'deny' };
  });

  ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-fail-load']
    .forEach((eventName) => wc.on(eventName, () => pushState(wc)));
  wc.once('destroyed', () => {
    if (info.noticeTimer) clearTimeout(info.noticeTimer);
  });
}

// Einmal beim Start (nach app.whenReady): Kanäle der Leiste und Download-Regel
function initBrowserApps() {
  // Die Leiste fragt beim Start einer Seite ihren Zustand ab; Antwort null = keine Browser-App, dann baut sie nichts auf
  ipcMain.handle('browser-get-state', (event) => {
    const info = browserViews.get(event.sender);
    return info ? buildState(event.sender, info) : null;
  });
  // Befehle werden nur von angemeldeten Browser-Ansichten angenommen
  ipcMain.on('browser-command', (event, command) => {
    if (browserViews.has(event.sender)) runBrowserCommand(event.sender, command);
  });
  // Downloads in Browser-Apps abbrechen (kein Speichern-Dialog im Kiosk) und in der Leiste darauf hinweisen.
  // Andere Apps behalten ihr bisheriges Verhalten.
  watchDownloads(session.defaultSession);
}

// Download-Regel für eine Sitzung (die Standardsitzung und die Sitzungen der Profile); je Sitzung nur einmal
const watchedSessions = new WeakSet();
function watchDownloads(targetSession) {
  if (!targetSession || watchedSessions.has(targetSession)) return;
  watchedSessions.add(targetSession);
  targetSession.on('will-download', (event, item, wc) => {
    if (!isBrowserView(wc)) return;
    const name = String(item.getFilename() || '').slice(0, NOTICE_MAX_NAME);
    event.preventDefault();
    setNotice(wc, 'Downloads werden nicht unterstützt' + (name ? ': ' + name : ''));
  });
}

module.exports = {
  normalizeBrowserInput,
  isAllowedBrowserUrl,
  shortcutCommandFor,
  initBrowserApps,
  watchDownloads,
  registerBrowserView,
  isBrowserView,
  runBrowserCommand
};
