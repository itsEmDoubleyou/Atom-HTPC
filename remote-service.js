// Fernbedienung per Handy im Launcher: verbindet Server (remote-server.js), Zuordnung der Befehle (remote-control.js),
// Einstellungen (Ein/Aus, Port, Token) und die Meldung des Launcher-Zustands an das Handy. Die Aktionen selbst
// (Taste an die Startseite, App minimieren, Lautstärke ...) kommen aus main.js als "actions".
const os = require('os');
const { createRemoteServer, generateToken, listLanAddresses } = require('./remote-server');
const { createRemoteController } = require('./remote-control');

const STATE_POLL_MS = 400;        // Zustand für das Handy: so oft wird auf Änderungen geprüft (ohne Skriptaufruf)
const FOCUS_CHECK_DELAY_MS = 120; // nach einer Fokus-Änderung kurz warten, dann das Textfeld abfragen

// Fragt in der Seite nach dem fokussierten Textfeld (auch in Shadow-DOMs). null = kein Textfeld.
const FIELD_SCRIPT = `
  (function () {
    try {
      var el = document.activeElement;
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      if (!el) return null;
      var tag = el.tagName;
      var type = String(el.type || 'text').toLowerCase();
      var editable = el.isContentEditable || tag === 'TEXTAREA' ||
        (tag === 'INPUT' && ['text', 'search', 'url', 'email', 'password', 'number', 'tel'].indexOf(type) !== -1);
      if (!editable) return null;
      var password = type === 'password';
      var value = password ? '' : String((el.isContentEditable ? el.textContent : el.value) || '');
      return {
        kind: password ? 'password' : (type === 'url' || type === 'email' || type === 'tel' || type === 'number' ? type : 'text'),
        multiline: tag === 'TEXTAREA' || !!el.isContentEditable,
        value: value.slice(0, 2000),
        label: String(el.placeholder || el.getAttribute('aria-label') || '').slice(0, 80)
      };
    } catch (e) { return null; }
  })();
`;

function createRemoteService({
  ipcMain, publicDir, readSettings, writeSettings, getMainWindow,
  actions,            // siehe main.js: key, appKey, home, openSwitcher, openQuickMenu, playPause, setVolume, pointer, getTarget, ...
  getSnapshot,        // () => { isApp, pointer, isBrowser, volume, viewKey } - billig, ohne Skriptaufruf
  networkInterfaces = () => os.networkInterfaces(),
  normalizeTouch = (touch) => touch, // prüft/begrenzt die Touch-Einstellungen (main.js reicht settings-store.js hinein)
  log = () => {}
}) {
  let settings = readSettings();
  let lastError = '';
  let connected = false;
  let pollTimer = null;
  let lastSent = '';
  let lastViewKey = '';
  let keyboard = { open: false };     // zuletzt gemeldeter Zustand der Tastatur auf dem Handy
  let focusTimer = null;
  let editQueue = Promise.resolve();
  let autoPointerFor = '';            // für welche App der Zeigermodus schon automatisch eingeschaltet wurde

  const controller = createRemoteController({
    isBlocked: actions.isBlocked,
    noteActivity: actions.noteActivity,
    onInput: actions.onInput,
    screensaver: actions.screensaver,
    context: () => {
      const snap = getSnapshot();
      return { isApp: snap.isApp, pointer: snap.pointer, isBrowser: snap.isBrowser, single: !!snap.single };
    },
    // Wie viele Fokusschritte ein einzelner Wisch auslösen darf: ohne Schwung (oder in Ansichten, die immer nur ein Element weiterschalten) 1,
    // sonst das erste Element plus die erlaubten übersprungenen
    stepLimit: () => {
      const touch = settings.touch || {};
      return touch.momentum === false ? 1 : 1 + Math.max(0, Number(touch.momentumMax) || 0);
    },
    key: actions.key,
    appKey: actions.appKey,
    pointer: actions.pointer,
    home: actions.home,
    openSwitcher: actions.openSwitcher,
    openQuickMenu: actions.openQuickMenu,
    playPause: actions.playPause,
    setVolume: actions.setVolume,
    edit: (del, ins) => { editQueue = editQueue.then(() => applyEdit(del, ins)).catch(() => {}); },
    textKey: (name) => { editQueue = editQueue.then(() => applyTextKey(name)).catch(() => {}); }
  });

  const server = createRemoteServer({
    publicDir,
    onMessage: (msg) => controller.handle(msg),
    onConnectionChange: (isConnected) => {
      connected = isConnected;
      lastSent = '';
      keyboard = { open: false };
      if (isConnected) { sendConfig(); pushState(true); checkFocus(); applyAutoPointer(); }
      notifyStatus();
    },
    log
  });

  // ---------- Textfeld: Tastatur auf dem Handy ----------
  async function readField() {
    const wc = actions.getTarget();
    if (!wc || wc.isDestroyed()) return null;
    try { return await wc.executeJavaScript(FIELD_SCRIPT); } catch (err) { return null; }
  }

  async function checkFocus() {
    if (!connected) return;
    const field = await readField();
    const next = field ? { open: true, kind: field.kind, multiline: field.multiline, value: field.value, label: field.label } : { open: false };
    if (JSON.stringify(next) === JSON.stringify(keyboard)) return;
    keyboard = next;
    server.send({ t: 'keyboard', ...next });
  }

  function noteInputFocus() {
    if (!connected) return;
    if (focusTimer) clearTimeout(focusTimer);
    focusTimer = setTimeout(() => { focusTimer = null; checkFocus(); }, FOCUS_CHECK_DELAY_MS);
  }

  async function applyEdit(del, ins) {
    const field = await readField();
    if (!field) return;                   // kein Textfeld mehr: nichts tippen (ein Backspace dürfte hier die App verlassen)
    await actions.typeText(del, ins, field.multiline);
  }

  async function applyTextKey(name) {
    const field = await readField();
    if (!field) return;
    actions.textKey(name);
  }

  // ---------- Zeigermodus automatisch in der Browser-App ----------
  function applyAutoPointer() {
    const snap = getSnapshot();
    if (!connected || !snap.isApp || !snap.isBrowser) { if (!snap.isApp) autoPointerFor = ''; return; }
    if (autoPointerFor === snap.appId) return;
    autoPointerFor = snap.appId;
    if (!snap.pointer) setTimeout(() => { if (connected) actions.pointer.set(true); }, 500); // der Preload der Seite ist dann bereit
  }

  // ---------- Zustand für das Handy ----------
  function phoneState() {
    const snap = getSnapshot();
    return { t: 'state', app: snap.isApp, pointer: snap.pointer, browser: snap.isBrowser, volume: snap.volume, single: !!snap.single };
  }

  function sendConfig() {
    if (!connected) return;
    const touch = settings.touch || {};
    server.send({ t: 'config', pointerSpeed: touch.pointerSpeed, swipeSpeed: touch.swipeSpeed, momentum: touch.momentum !== false, momentumMax: touch.momentumMax });
  }

  function pushState(force) {
    if (!connected) return;
    const state = phoneState();
    const text = JSON.stringify(state);
    if (!force && text === lastSent) return;
    lastSent = text;
    server.send(state);
  }

  function poll() {
    if (!connected) return;
    const snap = getSnapshot();
    if (snap.viewKey !== lastViewKey) { // andere Ansicht/App: Tastatur-Zustand und automatischer Zeiger neu prüfen
      lastViewKey = snap.viewKey;
      noteInputFocus();
      applyAutoPointer();
    }
    pushState(false);
  }

  function startPolling() { if (!pollTimer) pollTimer = setInterval(poll, STATE_POLL_MS); }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  // ---------- Einstellungen ----------
  function addresses() {
    return listLanAddresses(networkInterfaces());
  }

  function info() {
    const port = settings.port;
    return {
      enabled: settings.enabled,
      port,
      listening: server.isListening(),
      connected,
      error: lastError,
      touch: { ...(settings.touch || {}) },
      urls: settings.token
        ? addresses().map((a) => ({ name: a.name, address: a.address, virtual: a.virtual, url: `http://${a.address}:${port}/?t=${settings.token}` }))
        : []
    };
  }

  function notifyStatus() {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('remote-status', { connected, listening: server.isListening() }); } catch (err) { /* Seite wechselt gerade */ }
    }
  }

  async function start() {
    if (server.isListening()) return;
    lastError = '';
    if (!settings.token) { settings = { ...settings, token: generateToken() }; writeSettings(settings); }
    try {
      await server.start({ port: settings.port, token: settings.token });
      startPolling();
    } catch (err) {
      lastError = err && err.code === 'EADDRINUSE'
        ? `Port ${settings.port} ist schon belegt. Bitte einen anderen Port wählen.`
        : `Die Smartphone-Steuerung konnte nicht gestartet werden (${(err && err.message) || 'unbekannter Fehler'}).`;
      log(lastError);
    }
    notifyStatus();
  }

  async function stop() {
    stopPolling();
    connected = false;
    await server.stop();
    notifyStatus();
  }

  function fromMainWindow(event) {
    const win = getMainWindow();
    return !!(win && !win.isDestroyed() && event.sender === win.webContents);
  }

  function registerIpc() {
    ipcMain.handle('remote-get-info', (event) => (fromMainWindow(event) ? info() : null));

    ipcMain.handle('remote-set-enabled', async (event, enabled) => {
      if (!fromMainWindow(event)) return null;
      settings = { ...settings, enabled: enabled === true };
      writeSettings(settings);
      if (settings.enabled) await start(); else { lastError = ''; await stop(); }
      return info();
    });

    ipcMain.handle('remote-set-port', async (event, value) => {
      if (!fromMainWindow(event)) return null;
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        lastError = 'Der Port muss zwischen 1024 und 65535 liegen.';
        return info();
      }
      const previous = settings.port;
      if (port === previous) { lastError = ''; return info(); }
      settings = { ...settings, port };
      if (settings.enabled) {
        await stop();
        await start();
        if (lastError) { // neuer Port klappt nicht: beim alten bleiben
          const failure = lastError;
          settings = { ...settings, port: previous };
          await start();
          lastError = failure;
          return info();
        }
      }
      writeSettings(settings);
      return info();
    });

    ipcMain.handle('remote-set-touch', (event, touch) => {
      if (!fromMainWindow(event)) return null;
      settings = { ...settings, touch: normalizeTouch({ ...(settings.touch || {}), ...(touch && typeof touch === 'object' ? touch : {}) }) };
      writeSettings(settings);
      sendConfig(); // das verbundene Handy übernimmt die Werte sofort
      return info();
    });

    ipcMain.handle('remote-renew-token', async (event) => {
      if (!fromMainWindow(event)) return null;
      settings = { ...settings, token: generateToken() };
      writeSettings(settings);
      server.setToken(settings.token); // das verbundene Handy wird dabei getrennt
      lastError = '';
      return info();
    });
  }

  return {
    registerIpc,
    start: () => (settings.enabled ? start() : Promise.resolve()),
    stop,
    info,
    isConnected: () => connected,
    noteInputFocus,
    pushState: () => pushState(false),
    // Aufgabe des Schnellmenü-Symbols: aktueller Stand für eine frisch geladene Startseite
    status: () => ({ connected, listening: server.isListening() })
  };
}

module.exports = { createRemoteService, FIELD_SCRIPT };
