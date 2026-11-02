const { app, BrowserWindow, ipcMain, dialog, screen, session, WebContentsView, shell, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const {
  imagesDir,
  profiles,
  readApps, writeApps, readHomeItems, writeHomeItems,
  readBgSettings, writeBgSettings,
  readAdblockerSettings, writeAdblockerSettings, adblockerLogPath,
  readKeyboardSettings, writeKeyboardSettings,
  readControllerSettings, writeControllerSettings,
  readClockSettings, writeClockSettings,
  readTabsSettings, writeTabsSettings,
  readTaskbarSettings, writeTaskbarSettings, normalizeTaskbarSettings,
  readScreensaverSettings, writeScreensaverSettings,
  readMediaPlayerSettings, writeMediaPlayerSettings,
  readIntroSettings, writeIntroSettings, normalizeIntroSettings,
  readRemoteSettings, writeRemoteSettings, normalizeRemoteTouch,
  normalizeControllerSettings, normalizeScreensaverSettings, normalizeAdblockerSettings, mergeKeyboardSettings
} = require('./settings-store');
const { createScreensaver } = require('./screensaver-service');
const storageTools = require('./storage-tools');
const { createIntro } = require('./intro-service');
const { createRemoteService } = require('./remote-service');
const { createMediaPlayer } = require('./media-player-service');
const {
  TMDB_IMAGE_BASE, tmdbRequest, fetchTopshelfContent, fetchPopularMovieImages, fetchMovieLogo, validateTmdbKey, clearTmdbCaches,
} = require('./tmdb');
const { initAdblocker, useAdblockSession, updateAdblockerSettings, getAdblockerListsInfo, refreshAdblockerLists } = require('./adblock-engine');
const { createTaskbar } = require('./windows-desktop');
const { createDefaultNetworkStatus } = require('./network-status');
const controllerMapping = require('./controller-mapping');
const { initBrowserApps, watchDownloads, registerBrowserView, shortcutCommandFor, runBrowserCommand } = require('./browser-app');
const { createPointerHider } = require('./pointer-hider');

// Mauszeiger (Pfeil) überall ausblenden, solange Controller oder Handy benutzt werden; erst eine echte Mausbewegung bringt ihn zurück
const pointerHider = createPointerHider({ app, ipcMain, screen, webContents });
pointerHider.install();

// Windows-Taskleiste: wird nur ausgeblendet, wenn es in den Einstellungen (System > Taskleiste) eingeschaltet ist. Die Merkdatei sorgt dafür, dass
// eine nach einem Absturz noch ausgeblendete Taskleiste beim nächsten Start wieder erscheint, wenn die Option inzwischen aus ist.
const taskbar = createTaskbar({ markerFile: path.join(app.getPath('userData'), 'taskbar-hidden.flag') });
function applyTaskbarPreference() {
  return readTaskbarSettings().hideTaskbar ? taskbar.hide() : taskbar.recoverIfLeftHidden();
}

let mainWindow;
// Navigations-Status, wird für das kontextabhängige Backspace-Verhalten gebraucht
let currentView = 'launcher'; // 'launcher' | 'profile-select' | 'profiles' | 'loading' | 'app' | 'settings' | 'manage' | 'general' | 'system' | 'services' | 'remote' | 'adblocker' | 'switcher' | 'time' | 'tabs' | 'storage' | 'taskbar' | 'topshelf'
// true, solange ein Eingabefeld (Input/Textarea/Select) auf der aktuellen Seite
// fokussiert ist - verhindert, dass Backspace beim Tippen als "Zurück" greift
let isInputFocused = false;
// true, solange die aktuelle Seite Backspace selbst verarbeiten will (z.B. geöffnetes
// Formular in der App-Verwaltung, das per Backspace geschlossen wird)
let pageCapturesBackspace = false;
// Merkt sich pro Ansicht (z.B. 'settings', 'general'), welches Element dort zuletzt
// fokussiert war - für die Fokus-Wiederherstellung beim Zurücknavigieren
const lastFocusedElementByView = {};
// ID der zuletzt gestarteten/fortgesetzten Web-App - für die Fokus-Wiederherstellung
// auf die richtige Dock-/Grid-Kachel beim Zurückkehren zum Launcher
let lastLaunchedAppId = null;

// ---------- Netzwerkstatus (Schnellmenü): LAN / WLAN mit Signalstärke / keine Verbindung ----------
// Läuft dauerhaft im Hintergrund (siehe network-status.js); gemeldet wird nur eine Änderung der Anzeige. Die Startseite holt sich
// beim Laden den letzten bekannten Stand ('get-network-status'), damit beim Zurückkehren aus einer App nichts aufblitzt.
const networkStatus = createDefaultNetworkStatus({
  scriptDir: app.getPath('userData'),
  onChange: (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('network-status', status);
  }
});
ipcMain.handle('get-network-status', () => networkStatus.getStatus());

// ---------- Profile (siehe profiles.js) ----------
// Jedes Profil hat eigene Einstellungsdateien (Dock, Hintergrund, ...) und eine eigene Sitzung für die Web-Apps (Anmeldungen).
// Beim Wechsel werden alle laufenden Apps beendet, dann lädt die Startseite mit den Daten des neuen Profils.
function activeSession() {
  const partition = profiles.activePartition();
  return partition ? session.fromPartition(partition) : session.defaultSession;
}

// Sitzung des aktiven Profils vorbereiten: Download-Regel der Browser-Apps und Adblocker
function applyProfileSession() {
  const active = activeSession();
  watchDownloads(active);
  useAdblockSession(active);
}

let switchingProfile = false;

async function switchProfile(id) {
  if (switchingProfile || !profiles.get(id) || !mainWindow || mainWindow.isDestroyed()) return false;
  switchingProfile = true;
  try {
    if (id !== profiles.activeId()) {
      screensaver.stop();
      try { mediaPlayer.close(); } catch (err) { /* schon zu */ }
      if (cursorModeActive) {
        const entry = activeAppId ? runningApps.get(activeAppId) : null;
        if (entry) entry.view.webContents.send('force-deactivate-cursor');
        setCursorModeActive(false);
      }
      for (const appId of Array.from(runningApps.keys())) closeRunningApp(appId); // Apps des bisherigen Profils beenden
      activeAppId = null;
      returningToAppId = null;
      lastLaunchedAppId = null;
      profiles.setActive(id);
      applyProfileSession();
      screensaver.settingsChanged();
    }
    currentView = 'launcher';
    await mainWindow.loadFile('index.html');
    return true;
  } finally {
    switchingProfile = false;
  }
}

ipcMain.handle('get-profiles', () => profiles.getState());

// Aus dem Schnellmenü und der Profilauswahl: sanft ausblenden, dann wechseln
ipcMain.on('switch-profile', (event, id) => {
  if (typeof id !== 'string' || !profiles.get(id)) return;
  fadeOutLoadingThen(() => { switchProfile(id).catch((err) => console.error('Profilwechsel fehlgeschlagen:', err)); });
});

// Einstellungsseite: anlegen, ändern, löschen, Startverhalten
ipcMain.handle('create-profile', () => {
  const profile = profiles.create();
  return { ok: !!profile, profile, state: profiles.getState() };
});
ipcMain.handle('update-profile', (event, data) => {
  const d = data || {};
  const profile = profiles.update(d.id, { name: d.name, color: d.color });
  return { ok: !!profile, profile, state: profiles.getState() };
});
ipcMain.handle('delete-profile', async (event, id) => {
  const result = profiles.remove(id);
  if (result.ok) {
    // Anmeldungen und Daten dieses Profils entfernen (die Standardsitzung gehörte dem ersten Profil)
    try {
      const sess = result.legacySession ? session.defaultSession : session.fromPartition(result.partition);
      await sess.clearStorageData();
      await sess.clearCache();
    } catch (err) {
      console.error('Sitzungsdaten des Profils konnten nicht gelöscht werden:', err);
    }
  }
  return { ...result, state: profiles.getState() };
});
ipcMain.handle('set-profile-startup', (event, mode) => {
  const ok = profiles.setStartupMode(mode);
  return { ok, state: profiles.getState() };
});

// ---------- App-Umschalter: im Hintergrund laufende Apps ----------
// id -> { id, name, icon, url, view (WebContentsView), thumbnail (dataURL|null), lastActive }
const runningApps = new Map();
let activeAppId = null;       // id der aktuell sichtbaren App-View, oder null
let returningToAppId = null;  // merkt sich beim Öffnen des Umschalters, wohin Backspace zurückkehrt
let aKeyDown = false;
let aKeyTimer = null;
const A_HOLD_MS = 500; // so lange muss "A" gehalten werden, um den App-Umschalter zu öffnen

const MIN_LOADING_MS = 500;    // Mindestdauer, die der Ladebildschirm sichtbar bleibt
const NATIVE_MIN_LOADING_MS = Math.round(MIN_LOADING_MS * 1.25); // native Programme brauchen länger zum Starten als Web-Apps
const MAX_LOADING_MS = 3938;    // Notbremse, falls eine Seite nie wirklich zur Ruhe kommt (-25%, kumulativ -43.75%)
const SETTLE_BUFFER_MS = 281;   // so lange muss NACH dem letzten Lade-Ende Ruhe sein, bevor gewechselt wird (-25%, kumulativ -43.75%)
const LOADING_FADE_MS = 300;   // muss zur .fade-out CSS-Animation passen

// ---------- App-Umschalter: Hilfsfunktionen für persistente App-Views ----------

// Grundfarbe der App-Ansichten (die Standardfarbe einer WebContentsView wäre weiß und würde aufblitzen)
const APP_VIEW_BACKGROUND = '#000000';

// Electrons Standard-User-Agent enthält "Electron/X.X.X" - einige Seiten (u.a.
// Spotify Web Player) erkennen das und liefern eine reduzierte Oberfläche ohne
// Seitenleiste/Player-Leiste aus. Ein normaler Desktop-Chrome-UA umgeht das.
// Die Chrome-Version kommt aus dem tatsächlich eingebauten Chromium (nicht fest eingetragen): Eine feste, ältere Version
// passt nicht zu den übrigen Browser-Angaben (navigator.userAgentData, Client-Hints) und wird von Schutzschichten der Seiten
// (z.B. bei Paramount+: HTTP 403 auf Skripte/Stile -> graue Seite) als veralteter oder gefälschter Browser abgewiesen.
// Wie bei echtem Chrome ("User-Agent-Reduzierung") steht nur die Hauptversion drin: Chrome/142.0.0.0.
function buildDesktopChromeUserAgent(chromeVersion = process.versions.chrome) {
  const major = String(chromeVersion || '').split('.')[0];
  const version = /^\d+$/.test(major) ? `${major}.0.0.0` : '131.0.0.0';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}
const DESKTOP_CHROME_USER_AGENT = buildDesktopChromeUserAgent();

// YouTube TV (https://www.youtube.com/tv): die Oberfläche für Fernseher und Konsolen, bedienbar mit Controller (Steuerkreuz)
// und vom Handy aus (Anmeldung/Verknüpfung über den TV-Code in den YouTube-Einstellungen). YouTube liefert sie nur an
// Fernseher aus - deshalb gibt sich die Ansicht als Smart-TV aus (Kennung wie bei Samsung-Fernsehern).
const TV_USER_AGENT =
  'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36';
const TV_BACK_KEY = 'Escape';        // diese Taste schickt "zurück" an YouTube TV
const TV_BACK_LONG_MS = 500;         // B/Backspace so lange halten = App minimieren, kürzer = "zurück" an YouTube
const TV_BACK_SUPPRESS_MS = 2500;    // nach dem Minimieren per langem B startet B auf der Startseite den Bildschirmschoner nicht (B ist noch gedrückt)
const TV_KEYS = new Set(['Up', 'Down', 'Left', 'Right', 'Enter', 'MediaPlayPause']);

function isYoutubeTvUrl(url) {
  try {
    const u = new URL(url);
    return /^(www\.|m\.)?youtube\.com$/i.test(u.hostname) && /^\/tv(\/|$)/.test(u.pathname);
  } catch (err) {
    return false;
  }
}

// Erzeugt eine neue, dauerhaft laufende View für eine App. Läuft mit eigenem Preload
// (app-view-preload.js: Fokus-Tracking, Controller-Steuerung, Mauszeiger, Scrollen und
// Bildschirmtastatur), NICHT mit dem vollen preload.js - externe Seiten bekommen keinen
// Zugriff auf electronAPI.
function createAppView(url, { browser = false, tv = false } = {}) {
  const webPreferences = {
    preload: path.join(__dirname, 'app-view-preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    additionalArguments: tv ? ['--medialauncher-tv-app'] : [] // der Preload steuert dann YouTube TV mit dem Controller
  };
  const partition = profiles.activePartition(); // eigene Sitzung (Anmeldungen, Cookies) je Profil; das erste Profil behält die bisherige
  if (partition) webPreferences.partition = partition;
  const view = new WebContentsView({ webPreferences });
  view.setBackgroundColor(APP_VIEW_BACKGROUND); // WebContentsView ist standardmäßig weiß, verhindert Aufblitzen
  view.webContents.setUserAgent(tv ? TV_USER_AGENT : DESKTOP_CHROME_USER_AGENT);
  view.webContents.on('before-input-event', handleGlobalInput);
  // Neue Seite in der sichtbaren App: "Eingabefeld fokussiert" und "Seite nimmt Backspace" der alten Seite sind hinfällig. Beim Verlassen
  // einer Seite meldet der Browser kein Fokus-Ende - ohne diese Rücksetzung blieben B und der App-Umschalter (RB halten) gesperrt,
  // sobald man mit fokussiertem Textfeld (z.B. nach einer Suche) zu einer anderen Seite wechselt.
  view.webContents.on('did-start-navigation', (details) => {
    if (details && (details.isMainFrame === false || details.isSameDocument === true)) return;
    const active = activeAppId ? runningApps.get(activeAppId) : null;
    if (active && active.view === view) {
      isInputFocused = false;
      pageCapturesBackspace = false;
    }
  });
  // Lädt die Seite gar nicht (Fehlerseite) oder stürzt sie ab, gibt es keinen Zeiger mehr: Zustand im Hauptprozess zurücknehmen
  const dropCursorState = () => {
    const active = activeAppId ? runningApps.get(activeAppId) : null;
    if (!cursorModeActive || !active || active.view !== view) return;
    try { if (!view.webContents.isDestroyed()) view.webContents.send('force-deactivate-cursor'); } catch (err) { /* weg */ }
    setCursorModeActive(false);
    remote.pushState();
  };
  view.webContents.on('render-process-gone', dropCursorState);
  view.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) dropCursorState(); // -3 = abgebrochen (z.B. durch eine Weiterleitung), keine echte Störung
  });
  if (browser) registerBrowserView(view, url); // Typ "browser": Bedienleiste, Popups im selben Tab, Downloads abfangen
  view.webContents.loadURL(url);
  return view;
}

// Blendet den aktuell sichtbaren Ladebildschirm sauber aus (nutzt dieselbe
// .fade-out-Animation wie der Rest der App), bevor der eigentliche Wechsel zur
// App passiert - sowohl für Web-Apps als auch für native Programme genutzt.
function fadeOutLoadingThen(callback) {
  mainWindow.webContents.executeJavaScript(`
    document.body.classList.remove('fade-in');
    document.body.classList.add('fade-out');
  `).catch(() => {});
  setTimeout(callback, LOADING_FADE_MS);
}

// ---------- Controller-Mauszeiger (nur innerhalb laufender Apps) ----------
// Das sichtbare Cursor-Symbol UND seine Positions-Verwaltung laufen komplett
// in app-view-preload.js (läuft im selben Kontext wie die Seite - kein IPC-
// Umweg für die reine Bewegung nötig, das war der verbleibende Ruckel-
// Verursacher). Der Hauptprozess merkt sich hier nur noch, ob der Modus aktiv
// ist, und löst sendInputEvent für die tatsächliche App-Interaktion (Hover/
// Klick) aus - Chromium behandelt das wie ein echtes Maus-Event (anders als
// simulierte Tastatur-Events, die als "nicht vertrauenswürdig" gelten).
let cursorModeActive = false;

// Eingaben über iFrames: webContents.sendInputEvent erreicht Inhalte in fremden iFrames (andere Website, z.B. Cookie-Banner von
// Sourcepoint) nicht - der Klick geht ins Leere. Über die Debug-Schnittstelle (Input.dispatchMouseEvent) kommen die Ereignisse dort an.
// Genutzt wird sie nur, wenn der Cursor gerade über einem iFrame steht (meldet die Seite mit "frame"); überall sonst bleibt es beim
// bewährten sendInputEvent. Die Verbindung wird erst bei Bedarf aufgebaut und mit dem Cursor-Modus wieder gelöst. Klappt sie nicht
// (z.B. schon von anderer Seite belegt), fällt es auf sendInputEvent zurück.
const debuggerViews = new Set();

function attachInputDebugger(wc) {
  try {
    if (wc.isDestroyed()) return false;
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    debuggerViews.add(wc);
    return true;
  } catch (err) {
    return false;
  }
}

function detachInputDebuggers() {
  for (const wc of debuggerViews) {
    try {
      if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
    } catch (err) { /* schon getrennt */ }
  }
  debuggerViews.clear();
}

// Schickt eine Maus-Ereignisfolge über die Debug-Schnittstelle. Gibt false zurück, wenn das nicht möglich ist (dann nimmt der Aufrufer
// den normalen Weg). Reihenfolge bleibt erhalten, weil alle Kommandos nacheinander auf derselben Kette laufen.
const debuggerChains = new WeakMap();
function sendViaDebugger(wc, events) {
  if (!attachInputDebugger(wc)) return false;
  const send = (params) => wc.debugger.sendCommand('Input.dispatchMouseEvent', params);
  const prev = debuggerChains.get(wc) || Promise.resolve();
  const next = prev.then(async () => {
    for (const params of events) await send(params);
  }).catch((err) => {
    console.error('Eingabe über die Debug-Schnittstelle fehlgeschlagen:', err && err.message);
  });
  debuggerChains.set(wc, next);
  return true;
}

function setCursorModeActive(active) {
  cursorModeActive = active;
  if (!active) detachInputDebuggers();
}

function sendCursorHover(x, y, overFrame) {
  if (!cursorModeActive || !activeAppId) return;
  const entry = runningApps.get(activeAppId);
  if (!entry) return;
  const wc = entry.view.webContents;
  if (overFrame && sendViaDebugger(wc, [{ type: 'mouseMoved', x, y, button: 'none', clickCount: 0 }])) return;
  wc.sendInputEvent({ type: 'mouseMove', x, y });
}

function clickAtCursor(x, y, overFrame) {
  if (!cursorModeActive || !activeAppId) return;
  const entry = runningApps.get(activeAppId);
  if (!entry) return;
  const wc = entry.view.webContents;
  if (overFrame && sendViaDebugger(wc, [
    { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 },
    { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 },
    { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }
  ])) return;
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

function fitViewToWindow(view) {
  const bounds = mainWindow.getContentBounds();
  view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
}

// Macht die App-View von id sichtbar (fügt sie dem contentView hinzu), blendet eine
// zuvor sichtbare andere App-View aus. Erwartet, dass die App bereits in runningApps steht.
function showAppView(id) {
  const entry = runningApps.get(id);
  if (!entry) return false;

  if (activeAppId && activeAppId !== id) {
    const prev = runningApps.get(activeAppId);
    if (prev) {
      if (cursorModeActive && !prev.view.webContents.isDestroyed()) prev.view.webContents.send('force-deactivate-cursor');
      mainWindow.contentView.removeChildView(prev.view);
    }
  }
  // Eine App, die sichtbar wird, beginnt immer mit ausgeschaltetem Zeiger (sonst bliebe ein Rest-Zustand der vorigen App stehen)
  if (cursorModeActive && activeAppId !== id) {
    setCursorModeActive(false);
    remote.pushState();
  }

  fitViewToWindow(entry.view);
  mainWindow.contentView.addChildView(entry.view);
  entry.lastActive = Date.now();
  activeAppId = id;
  currentView = 'app';
  return true;
}

// Blendet die aktuell sichtbare App-View aus (minimiert sie), OHNE sie zu beenden -
// sie läuft im Hintergrund weiter. Nimmt vorher einen Screenshot für den Umschalter.
// Überschreibt die Page-Visibility-API der Seite, damit sie sich selbst weiterhin
// als "sichtbar" wahrnimmt, obwohl sie gerade minimiert (aus dem contentView entfernt)
// ist - viele Seiten pausieren Video/Audio sonst von sich aus beim Verstecken.
const KEEP_PLAYING_SCRIPT = `
  (function() {
    if (window.__keepPlayingOverrideInstalled) return;
    window.__keepPlayingOverrideInstalled = true;
    try {
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    } catch (e) {}
  })();
`;

// Nimmt einen Screenshot der aktiven App auf (für die Umschalter-Vorschau) und
// wendet ggf. die "Weiterspielen"-Einstellung an - entfernt die Ansicht selbst
// NICHT. Getrennt von detachActiveAppView(), damit die Reihenfolge bei Bedarf
// anders gesteuert werden kann (siehe openSwitcher()).
async function captureActiveAppView() {
  if (!activeAppId) return;
  const entry = runningApps.get(activeAppId);
  if (!entry) return;

  try {
    const image = await entry.view.webContents.capturePage();
    entry.thumbnail = image.toDataURL();
  } catch (err) {
    console.error('Thumbnail-Aufnahme fehlgeschlagen:', err);
  }

  const tabsSettings = readTabsSettings();
  if (tabsSettings.keepPlayingInBackground) {
    entry.view.webContents.executeJavaScript(KEEP_PLAYING_SCRIPT).catch(() => {});
  }
}

function detachActiveAppView() {
  if (!activeAppId) return;
  const entry = runningApps.get(activeAppId);
  if (entry) {
    // Der App Bescheid sagen, damit z.B. ihre Bildschirmtastatur mit verschwindet
    // (laufende Seite bleibt sonst im Zustand "Tastatur offen", wenn sie später zurückkommt)
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.send('app-view-hidden');
    mainWindow.contentView.removeChildView(entry.view);
  }
  activeAppId = null;
}

// Blendet die aktive App aus. waitBeforeDetach (optional): Promise, auf die gewartet wird,
// solange die App-Ansicht noch alles bedeckt (z.B. bis der Launcher dahinter fertig ist).
async function hideActiveAppView(waitBeforeDetach) {
  if (cursorModeActive && activeAppId) {
    const entry = runningApps.get(activeAppId);
    if (entry) entry.view.webContents.send('force-deactivate-cursor');
  }
  setCursorModeActive(false);
  await captureActiveAppView();
  if (waitBeforeDetach) await waitBeforeDetach;
  detachActiveAppView();
}

// ---------- App verlassen: Launcher erst aufdecken, wenn er fertig aufgebaut ist ----------
// Der Launcher baut sich nach dem Laden noch asynchron auf (Apps, Hintergrund, Uhr, Icons). Würde
// die App-Ansicht sofort abgenommen, sähe man diesen Aufbau: schwarzer Hintergrund, ein Dock, das
// kurz zu hoch sitzt und dann springt. Deshalb wird der Launcher HINTER der noch sichtbaren App
// geladen (wie beim Umschalter, siehe openSwitcher) und meldet per 'launcher-ready', wenn alles im
// Endzustand steht. Erst dann wird die App-Ansicht abgenommen.
const LAUNCHER_READY_TIMEOUT_MS = 1500; // Sicherung: lieber unfertig aufdecken, als hängen zu bleiben
const APP_VIEW_BACKGROUND_WHILE_LEAVING = '#fe000000'; // Format #AARRGGBB: Alpha 254 von 255
let launcherReadyCounter = 0;
let pendingLauncherReady = null; // { token, resolve } - nur die Meldung mit passender Kennung zählt
let leavingApp = false;          // solange true: Zurück/Umschalter-Eingaben ignorieren (Wechsel läuft)

function loadLauncherBehindApp() {
  const token = String(++launcherReadyCounter);
  const ready = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingLauncherReady && pendingLauncherReady.token === token) pendingLauncherReady = null;
      resolve(false);
    }, LAUNCHER_READY_TIMEOUT_MS);
    pendingLauncherReady = { token, resolve: () => { clearTimeout(timer); pendingLauncherReady = null; resolve(true); } };
  });
  mainWindow.loadFile('index.html', { query: { noFadeIn: '1', ready: token } }).catch(() => {});
  return ready;
}

ipcMain.on('launcher-ready', (event, token) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  if (pendingLauncherReady && pendingLauncherReady.token === String(token)) pendingLauncherReady.resolve();
});

function leaveActiveAppToLauncher() {
  if (leavingApp) return;
  leavingApp = true;
  // Chromium zeichnet eine Seite nicht, solange sie vollständig von einer UNDURCHSICHTIGEN Ansicht
  // verdeckt ist (gilt als "hidden", kein requestAnimationFrame). Der Launcher soll hinter der App
  // aber fertig gezeichnet werden. Eine nicht ganz undurchsichtige Hintergrundfarbe (99,6 % Schwarz,
  // optisch gleich) reicht, damit die Seite dahinter als sichtbar gilt.
  const entry = activeAppId ? runningApps.get(activeAppId) : null;
  if (entry) entry.view.setBackgroundColor(APP_VIEW_BACKGROUND_WHILE_LEAVING);
  hideActiveAppView(loadLauncherBehindApp())
    .then(() => { currentView = 'launcher'; })
    .catch((err) => console.error('App konnte nicht sauber verlassen werden:', err))
    .finally(() => {
      leavingApp = false;
      // Die App ist inzwischen abgenommen - ihre normale Hintergrundfarbe wiederherstellen
      if (entry && !entry.view.webContents.isDestroyed()) entry.view.setBackgroundColor(APP_VIEW_BACKGROUND);
    });
}

// Beendet eine im Hintergrund laufende App endgültig (nicht nur minimiert)
function closeRunningApp(id) {
  const entry = runningApps.get(id);
  if (!entry) return;

  if (activeAppId === id) {
    if (cursorModeActive) {
      entry.view.webContents.send('force-deactivate-cursor');
      setCursorModeActive(false);
    }
    mainWindow.contentView.removeChildView(entry.view);
    activeAppId = null;
  }
  try {
    entry.view.webContents.close();
  } catch (err) {
    console.error('App konnte nicht sauber geschlossen werden:', err);
  }
  runningApps.delete(id);
  cursorPositions.delete(id);
}

// ---------- Native Programme (installierte Windows-/Linux-Anwendungen) ----------
// Anders als Web-Apps laufen diese als eigener Betriebssystem-Prozess, NICHT in
// einer WebContentsView - kein Minimieren, kein Umschalter, kein PiP, kein
// Lautstärkemixer dafür möglich, das sind alles Web-App-Funktionen.
let nativeAppRunning = false;

// Zerlegt einen Startparameter-String in einzelne Argumente. Unterstützt
// einfache/doppelte Anführungszeichen für Argumente mit Leerzeichen darin,
// z.B. '-bigpicture' oder '--config "C:\Pfad mit Leerzeichen\datei.cfg"'.
function parseLaunchArgs(argString) {
  if (!argString) return [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const args = [];
  let match;
  while ((match = regex.exec(argString)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3]);
  }
  return args;
}

// Startet ein natives Programm, blendet währenddessen unser Kiosk-Fenster und die
// Taskleiste aus, und stellt beides automatisch wieder her, sobald das Programm
// beendet wird (oder gar nicht erst starten konnte).
function launchNativeApp(programPath, launchArgsString, name, loadingStyle, icon) {
  if (!programPath || nativeAppRunning) return;

  if (!fs.existsSync(programPath)) {
    console.error('Programmpfad existiert nicht:', programPath);
    return;
  }

  const launchArgs = parseLaunchArgs(launchArgsString);

  // Gleicher Ladebildschirm + Übergang wie bei Web-Apps, auch wenn es hier keine
  // "fertig geladen"-Rückmeldung gibt - nach MIN_LOADING_MS geht's einfach weiter.
  mainWindow.loadFile('loading.html', { query: { name: name || '', icon: icon || '', style: loadingStyle || 'bar', duration: String(NATIVE_MIN_LOADING_MS) } });
  currentView = 'loading';

  setTimeout(() => {
    fadeOutLoadingThen(() => {
      nativeAppRunning = true;
      if (readTaskbarSettings().hideTaskbar) taskbar.hide();
      if (mainWindow) mainWindow.hide();

      const child = spawn(programPath, launchArgs, {
        cwd: path.dirname(programPath),
        stdio: 'ignore'
      });

      function restoreKiosk() {
        if (!nativeAppRunning) return;
        nativeAppRunning = false;
        if (readTaskbarSettings().hideTaskbar) taskbar.hide(); // das Programm kann sie wieder eingeblendet haben
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadFile('index.html', { query: { noFadeIn: '1' } }); // Fenster stand noch auf loading.html
          currentView = 'launcher';
          mainWindow.show();
          mainWindow.focus();
        }
      }

      child.on('error', (err) => {
        console.error('Programm konnte nicht gestartet werden:', err);
        restoreKiosk();
      });

      child.on('exit', restoreKiosk);
    });
  }, NATIVE_MIN_LOADING_MS);
}


// Windows-eigene Bildschirmtastatur (osk.exe) ein-/ausschalten - kein eigener
// Tastatur-Code nötig, nur das vorhandene Systemwerkzeug starten/beenden.
// Nur unter Windows verfügbar.
async function toggleOnScreenKeyboard() {
  if (process.platform !== 'win32') {
    console.log('Bildschirmtastatur ist aktuell nur unter Windows verfügbar.');
    return;
  }

  const settings = readKeyboardSettings();
  if (!settings.osEnabled) return; // Windows-Tastatur ist optional und standardmäßig aus

  // shell.openPath() statt spawn(): osk.exe (und ähnliche Systemwerkzeuge)
  // lassen sich nicht per direktem Prozess-Start öffnen (EACCES - das hat der
  // Konsolen-Log bestätigt), sondern brauchen die Shell-Ausführung, genau wie
  // ein Doppelklick im Explorer. Funktioniert dadurch auch mit .lnk-
  // Verknüpfungen als Ziel. Trade-off: kein Prozess-Handle mehr, daher kein
  // gezieltes Schließen per Code mehr möglich - "K" öffnet nur noch.
  const errorMessage = await shell.openPath(settings.path || 'osk.exe');
  if (errorMessage) {
    console.error('Bildschirmtastatur konnte nicht geöffnet werden:', errorMessage);
  }
}

// Löst natives Bild-in-Bild für das Video der aktuell sichtbaren App aus (bzw.
// beendet es wieder, falls schon aktiv). Läuft direkt im Chromium der App-View -
// das eigentliche PiP-Fenster (frei verschiebbar, in der Größe änderbar, Steuerung
// beim Hovern) kommt komplett vom Browser selbst, dafür muss nichts eigenes gebaut werden.
function togglePictureInPicture() {
  if (!activeAppId) return;
  const entry = runningApps.get(activeAppId);
  if (!entry) return;

  const script = `
    (function() {
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
        return 'exited';
      }
      const video = document.querySelector('video');
      if (video && document.pictureInPictureEnabled && !video.disablePictureInPicture) {
        video.requestPictureInPicture().catch((err) => console.error('PiP fehlgeschlagen:', err));
        return 'entered';
      }
      return 'no-video';
    })();
  `;
  entry.view.webContents.executeJavaScript(script).catch((err) => {
    console.error('Bild-in-Bild konnte nicht ausgelöst werden:', err);
  });
}

// Baut ein Skript, das die Lautstärke aller Video-/Audio-Elemente auf der Seite setzt und
// danach auf dem Zielwert hält. Statt die ganze Seite auf jede Änderung zu beobachten (YouTube
// ändert seinen Seitenbaum ununterbrochen), hört es nur auf die Ereignisse der Medien selbst:
// ein Video wird geladen oder gestartet, oder die Seite verändert die Lautstärke selbst.
// Die Ereignisse werden in der Einfangphase am document abgefangen, weil sie nicht aufsteigen.
// Das Hören wird nur beim ersten Aufruf pro Seitenaufruf eingerichtet; spätere Aufrufe
// setzen nur den neuen Zielwert.
function buildVolumeScript(volumePercent) {
  const targetVolume = Math.max(0, Math.min(100, volumePercent)) / 100;
  return `
    (function() {
      window.__currentTargetVolume = ${targetVolume};
      function applyVolume(el) {
        try {
          if (Math.abs(el.volume - window.__currentTargetVolume) > 0.001) el.volume = window.__currentTargetVolume;
        } catch (e) {}
      }
      document.querySelectorAll('video, audio').forEach(applyVolume);

      if (window.__volumeListenersInstalled) return;
      window.__volumeListenersInstalled = true;

      // Setzt eine Seite die Lautstärke immer wieder zurück, würde das ein endloses Hin und Her
      // auslösen. Deshalb höchstens 20 Korrekturen pro Sekunde.
      let windowStart = 0;
      let corrections = 0;
      function onMediaEvent(event) {
        const el = event.target;
        if (!(el instanceof HTMLMediaElement)) return;
        if (event.type === 'volumechange') {
          if (Math.abs(el.volume - window.__currentTargetVolume) <= 0.001) return;
          const now = performance.now();
          if (now - windowStart > 1000) { windowStart = now; corrections = 0; }
          if (++corrections > 20) return;
        }
        applyVolume(el);
      }
      ['loadstart', 'loadedmetadata', 'play', 'playing', 'volumechange'].forEach((type) => {
        document.addEventListener(type, onMediaEvent, true);
      });
    })();
  `;
}

// Gesamtlautstärke: setzt alle laufenden Apps auf denselben Wert (der Gesamtregler im Mixer und die Handy-Fernbedienung) und gilt
// als Startwert für Apps, die danach starten. Bleibt bis zum Beenden des Launchers (danach wieder 100).
let globalVolume = 100;
function setGlobalVolume(volumePercent, { notifyLauncher = true } = {}) {
  globalVolume = Math.max(0, Math.min(100, Math.round(Number(volumePercent))));
  for (const id of runningApps.keys()) setAppVolume(id, globalVolume);
  // Die Startseite (Mixer im Schnellmenü) zeigt den neuen Wert; kam er von ihr selbst, braucht sie ihn nicht zurück (sonst springt der Regler)
  if (notifyLauncher && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('global-volume-changed', globalVolume);
  remote.pushState();
}
ipcMain.handle('get-global-volume', () => globalVolume);
ipcMain.on('set-global-volume', (event, value) => {
  if (!Number.isFinite(Number(value))) return;
  setGlobalVolume(value, { notifyLauncher: false });
});

// Lautstärke (0-100) einer im Hintergrund laufenden App setzen
function setAppVolume(id, volumePercent) {
  const entry = runningApps.get(id);
  if (!entry) return;
  entry.volume = Math.max(0, Math.min(100, volumePercent));
  entry.view.webContents.executeJavaScript(buildVolumeScript(entry.volume)).catch((err) => {
    console.error('Lautstärke konnte nicht gesetzt werden:', err);
  });
}

// Stummschaltung einer im Hintergrund laufenden App setzen - nutzt Chromiums
// eigene Audio-Stummschaltung (zuverlässiger als einzelne Elemente zu treffen,
// erfasst z.B. auch Werbe-/Benachrichtigungstöne)
function setAppMuted(id, muted) {
  const entry = runningApps.get(id);
  if (!entry) return;
  entry.muted = !!muted;
  entry.view.webContents.setAudioMuted(entry.muted);
}

// Öffnet den App-Umschalter: aktuelle App (falls offen) minimieren, Umschalter-Seite laden
async function openSwitcher() {
  if (runningApps.size === 0) return; // nichts im Hintergrund -> nichts zu zeigen
  if (leavingApp) return;             // die App wird gerade verlassen

  returningToAppId = activeAppId;
  await captureActiveAppView();

  // Umschalter-Seite im Hintergrund laden, WÄHREND die App-Ansicht noch alles
  // bedeckt - verhindert, dass die darunterliegende Launcher-Seite (inkl. Dock)
  // kurz aufblitzt, bevor die Umschalter-Seite fertig/sichtbar ist.
  await mainWindow.loadFile('switcher.html');
  detachActiveAppView();

  currentView = 'switcher';
}

// Backspace im Umschalter: zurück zu der App/dem Launcher, von der aus geöffnet wurde
function cancelSwitcher() {
  if (returningToAppId && runningApps.has(returningToAppId)) {
    showAppView(returningToAppId);
  } else {
    mainWindow.loadFile('index.html');
    currentView = 'launcher';
  }
  returningToAppId = null;
}

// "Zurück" (Backspace / B-Taste): von welcher Ansicht geht es wohin? Das ist der Seitenbaum der
// Einstellungen. Nicht hier stehen: 'app' und 'switcher' (eigene Logik in handleGlobalInput) und der
// Launcher selbst (dort behandelt die Seite Backspace, z.B. zum Schließen des Schnellmenüs).
const BACK_TARGETS = {
  manage: 'general',
  profiles: 'system',
  'keyboard-settings': 'input-devices',
  'controller-settings': 'input-devices',
  services: 'system',
  adblocker: 'system',
  time: 'general',
  tabs: 'general',
  storage: 'system',
  taskbar: 'system',
  intro: 'general',
  'input-devices': 'general',
  general: 'settings',
  system: 'settings',
  remote: 'input-devices',
  settings: 'launcher',
  screensaver: 'general',
  topshelf: 'launcher'
};

// Datei zu einer Ansicht: der Launcher ist index.html, alle anderen heißen <Ansicht>.html
function viewFile(view) {
  return view === 'launcher' ? 'index.html' : `${view}.html`;
}

// ---------- YouTube TV: Zurück-Taste und Steuerkreuz ----------
// Eine Taste an die Seite schicken (als echtes Tastaturereignis, die Seite hält nichts davon für unecht)
function sendTvKey(webContents, key, type = 'press', repeat = false) {
  if (!webContents || webContents.isDestroyed()) return;
  const modifiers = repeat ? ['isAutoRepeat'] : [];
  if (type === 'press' || type === 'down') webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
  if (type === 'press' || type === 'up') webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
}

let tvBackDown = false;
let tvBackTimer = null;
let suppressManualScreensaverUntil = 0;

// B (Controller, kommt als Backspace): kurzer Druck = "zurück" für YouTube, nach TV_BACK_LONG_MS
// Halten geht die App in den Hintergrund. Die Entscheidung fällt beim Loslassen bzw. nach Ablauf der Haltezeit.
function handleTvBack(event, input, entry) {
  event.preventDefault();
  if (input.type === 'keyDown') {
    if (input.isAutoRepeat || tvBackDown) return;
    tvBackDown = true;
    tvBackTimer = setTimeout(() => {
      tvBackTimer = null;
      tvBackDown = false; // das Loslassen danach braucht keine Aktion mehr (die App kann dann schon verdeckt sein)
      suppressManualScreensaverUntil = Date.now() + TV_BACK_SUPPRESS_MS;
      if (currentView === 'app') leaveActiveAppToLauncher();
    }, TV_BACK_LONG_MS);
  } else if (input.type === 'keyUp') {
    if (!tvBackDown) return;
    tvBackDown = false;
    if (tvBackTimer) {
      clearTimeout(tvBackTimer);
      tvBackTimer = null;
      sendTvKey(entry.view.webContents, TV_BACK_KEY);
    }
  }
}

// Gemeinsame Tasteneingabe-Behandlung für das Hauptfenster UND jede App-View:
// ESC beendet immer, "A" halten öffnet den Umschalter, Backspace navigiert kontextabhängig.
function handleGlobalInput(event, input) {
  // Während der Bildschirmschoner läuft, gehören alle Eingaben ihm (Aufwecken) - nichts davon darf den Launcher bedienen
  if (screensaver.isActive()) return;

  // F12: DevTools der aktiven App-Ansicht öffnen (eigenes, losgelöstes Fenster) -
  // zum Nachschauen von Fehlermeldungen/Konsolen-Ausgaben der jeweiligen App.
  if (input.code === 'F12' && input.type === 'keyDown') {
    const entry = activeAppId ? runningApps.get(activeAppId) : null;
    if (entry) entry.view.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  // Browser-Apps: Tastenkürzel (Alt+Links/Rechts/Pos1, F5, Strg+R, Strg+L). Esc gehört dort der Seite
  // (z.B. Vollbild beenden) und beendet den Launcher nicht.
  const activeEntry = activeAppId ? runningApps.get(activeAppId) : null;
  const inBrowserApp = !!(activeEntry && activeEntry.isBrowser);
  const inTvApp = !!(activeEntry && activeEntry.isTv && currentView === 'app');
  if (inBrowserApp) {
    const command = shortcutCommandFor(input);
    if (command) {
      event.preventDefault();
      runBrowserCommand(activeEntry.view.webContents, command);
      return;
    }
  }

  // "A" gedrückt halten -> App-Umschalter (funktioniert überall, aber nicht beim Tippen).
  // keyUp wird IMMER verarbeitet (auch wenn zwischendurch ein Eingabefeld fokussiert
  // wurde), damit der Halte-Status nie hängen bleibt.
  if (input.code === 'KeyA') {
    if (input.type === 'keyDown' && !isInputFocused) {
      if (!aKeyDown) {
        aKeyDown = true;
        aKeyTimer = setTimeout(() => {
          openSwitcher();
        }, A_HOLD_MS);
      }
    } else if (input.type === 'keyUp') {
      aKeyDown = false;
      if (aKeyTimer) { clearTimeout(aKeyTimer); aKeyTimer = null; }
    }
    return;
  }

  // YouTube TV, Controller-B (kommt als Backspace über 'gamepad-input'): kurz = "zurück" an YouTube, lang halten = App minimieren.
  // Die Tastatur-Backspace-Taste bleibt wie in jeder App (minimiert sofort) - bei ihr meldet Windows das Loslassen nicht zuverlässig;
  // "zurück" ist auf der Tastatur Esc (geht direkt an YouTube).
  if (inTvApp && input.fromGamepad && input.code === 'Backspace' && !isInputFocused && !pageCapturesBackspace) {
    handleTvBack(event, input, activeEntry);
    return;
  }

  if (input.type !== 'keyDown') return;

  if (input.code === 'KeyP' && input.type === 'keyDown' && !isInputFocused) {
    togglePictureInPicture();
    return;
  }

  // "M" (auch rechter Stick gedrückt) -> Musikplayer öffnen/schließen. Die Taste gehört dem Player, solange man nicht
  // tippt: die App bekommt sie nicht (z.B. YouTubes "M" für stumm). Gibt es nichts zu steuern, bleibt der Player zu.
  if (input.code === 'KeyM' && !isInputFocused && !nativeAppRunning) {
    if (!input.isAutoRepeat) mediaPlayer.toggle();
    event.preventDefault();
    return;
  }

  // "K" -> Windows-Bildschirmtastatur öffnen/schließen. Bewusst OHNE
  // !isInputFocused-Sperre: genau wenn ein Eingabefeld fokussiert ist, braucht
  // man die Tastatur - das wäre also der falsche Moment zum Blockieren.
  if (input.code === 'KeyK' && input.type === 'keyDown') {
    toggleOnScreenKeyboard();
    return;
  }

  if (input.code === 'Escape' && input.type === 'keyDown') {
    if (!inBrowserApp && !inTvApp) app.quit(); // in Browser-Apps und YouTube TV gehört Esc der Seite
    return;
  }

  if (input.code === 'Backspace' && input.type === 'keyDown' && !isInputFocused && !pageCapturesBackspace) {
    if (currentView === 'app') {
      event.preventDefault();
      leaveActiveAppToLauncher();
    } else if (currentView === 'switcher') {
      event.preventDefault();
      cancelSwitcher();
    } else if (Object.hasOwn(BACK_TARGETS, currentView)) {
      const target = BACK_TARGETS[currentView];
      mainWindow.loadFile(viewFile(target));
      currentView = target;
      event.preventDefault();
    }
    // im Launcher selbst: Backspace tut nichts
  }
}

function createWindow() {
  // Echte Bildschirmauflösung verwenden statt fest codierter 1920x1080 -
  // verhindert einen abgeschnittenen Rand, falls der Bildschirm eine
  // andere native Auflösung hat.
  const { width, height } = screen.getPrimaryDisplay().bounds;

  mainWindow = new BrowserWindow({
    width,
    height,
    kiosk: true,
    fullscreen: true,       // zusätzlich zu kiosk, manche Windows-Setups brauchen beides
    autoHideMenuBar: true,
    frame: false,
    backgroundColor: '#000000', // verhindert weißes Aufblitzen zwischen Seitenwechseln
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Beim Start: zuletzt benutztes Profil direkt (Standard) oder die Profilauswahl, falls so eingestellt und es mehrere Profile gibt
  if (profiles.startupMode() === 'choose' && profiles.getState().profiles.length > 1) {
    mainWindow.loadFile('profile-select.html');
    currentView = 'profile-select';
  } else {
    mainWindow.loadFile('index.html');
    currentView = 'launcher';
  }

  // Zusätzlich explizit erzwingen (hilft auf manchen Windows-Systemen, bei denen
  // die Taskleiste sonst trotz kiosk:true über dem Fenster sichtbar bleibt)
  mainWindow.setKiosk(true);
  mainWindow.setFullScreen(true);
  // Kein alwaysOnTop mehr: Auf Windows läuft jede Stufe offenbar auf dasselbe
  // "topmost"-Verhalten hinaus und verdrängt dabei zuverlässig das native
  // Bild-in-Bild-Fenster beim Zurückklicken - das wiegt schwerer als die kurz
  // aufblitzende Taskleiste beim Fokussieren des PiP-Fensters.

  // ESC/Backspace/"A" halten - gemeinsame Logik, auch für App-Views genutzt
  mainWindow.webContents.on('before-input-event', handleGlobalInput);

  mainWindow.on('closed', () => {
    try { mediaPlayer.close(); } catch (err) { /* schon geschlossen */ }
  });

  // Fokus-Status zurücksetzen, sobald eine neue Seite zu laden beginnt - sonst
  // könnte ein "Eingabefeld fokussiert"-Zustand von der vorherigen Seite fälschlich
  // weiterbestehen, bevor die neue Seite selbst etwas fokussiert.
  mainWindow.webContents.on('did-start-navigation', (details) => {
    // Rahmen in der Seite (der eingebettete Bildschirmschoner) und Sprünge innerhalb der Seite zählen nicht
    if (details && (details.isMainFrame === false || details.isSameDocument === true)) return;
    isInputFocused = false;
    pageCapturesBackspace = false;
    launcherHostsScreensaver = false;
    screensaver.hostNavigated(); // die Seite wird verlassen: ein als Ebene eingebetteter Bildschirmschoner endet mit ihr
  });
}

// IPC: meldet, ob gerade ein Eingabefeld fokussiert ist (siehe preload.js)
ipcMain.on('input-focus-changed', (event, focused) => {
  isInputFocused = focused;
  remote.noteInputFocus(); // Handy-Fernbedienung: Tastatur auf dem Handy ein-/ausblenden
});

// ---------- Bildschirmtastatur in Apps: Text/Tasten in die aktive App einfügen ----------
// Die Tastatur selbst läuft als Overlay in der App-Seite (app-view-preload.js). Getippt
// wird hier über echte Chromium-Eingaben: insertText verhält sich wie eine IME-Eingabe
// (Umlaute, €, contenteditable, Frameworks sehen normale input-Ereignisse),
// sendInputEvent liefert die Sondertasten.
function getActiveAppWebContents() {
  const entry = activeAppId ? runningApps.get(activeAppId) : null;
  return entry ? entry.view.webContents : null;
}

ipcMain.on('osk-insert-text', (event, text) => {
  const wc = getActiveAppWebContents();
  if (!wc || event.sender !== wc) return; // nur die gerade sichtbare App darf tippen lassen
  if (typeof text !== 'string' || text.length === 0 || text.length > 8) return;
  if (!wc.isFocused()) wc.focus();
  wc.insertText(text).catch(() => {});
});

const OSK_ALLOWED_KEYS = new Set(['Backspace', 'Return', 'Left', 'Right']);
ipcMain.on('osk-key', (event, key) => {
  const wc = getActiveAppWebContents();
  if (!wc || event.sender !== wc || !OSK_ALLOWED_KEYS.has(key)) return;
  if (!wc.isFocused()) wc.focus();
  wc.sendInputEvent({ type: 'keyDown', keyCode: key });
  wc.sendInputEvent({ type: 'keyUp', keyCode: key });
});

// ---------- Scrollen mit den Triggern (LT/RT) in Apps ----------
// Echte Mausrad-Ereignisse an der Cursor-Position: Es scrollt genau das, was auch ein Mausrad
// scrollen würde (innere Scroll-Bereiche, Seiten mit eigener Scroll-Logik). "Präzise" Werte
// scrollen pixelgenau und ohne Beschleunigung - passend zum analogen Trigger-Druck.
// Achtung, Vorzeichen: In Electron scrollt ein NEGATIVES deltaY nach unten (umgekehrt zum
// DOM-Wheel-Ereignis, das die Seite dann sieht). dy > 0 bedeutet hier "nach unten".
ipcMain.on('scroll-wheel', (event, data) => {
  const wc = getActiveAppWebContents();
  if (!wc || event.sender !== wc || !data) return;
  const { x, y, dy } = data;
  if (![x, y, dy].every(Number.isFinite)) return;
  const step = Math.max(-400, Math.min(400, dy));
  // Über einem iFrame: Mausrad über die Debug-Schnittstelle (dort positiv = nach unten), sonst wie bisher
  if (data.frame === true && cursorModeActive && sendViaDebugger(wc, [{ type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY: step }])) return;
  wc.sendInputEvent({
    type: 'mouseWheel',
    x: Math.round(x), y: Math.round(y),
    deltaX: 0, deltaY: -step,
    wheelTicksX: 0, wheelTicksY: 0,
    hasPreciseScrollingDeltas: true, canScroll: true
  });
});

// IPC: Controller-Mauszeiger innerhalb von Apps umschalten/Hover-Zustand/klicken
// Nur die gerade sichtbare App darf den Zeiger-Zustand setzen (eine Seite im Hintergrund oder eine, die gerade verlassen wird, nicht)
function isActiveAppSender(sender) {
  const entry = activeAppId ? runningApps.get(activeAppId) : null;
  return !!entry && !entry.view.webContents.isDestroyed() && entry.view.webContents === sender;
}

ipcMain.on('toggle-cursor-mode', (event, active) => {
  if (!isActiveAppSender(event.sender)) {
    if (active === true) { try { event.sender.send('force-deactivate-cursor'); } catch (err) { /* weg */ } }
    return;
  }
  setCursorModeActive(active === true);
  remote.pushState();
});

// Letzte Position des runden Cursors je App. Der Cursor lebt in der Seite und startet mit jedem neuen Dokument (Seitenwechsel,
// Neuladen) frisch; ohne diese Merkliste säße er danach immer in der Bildschirmmitte. Die Seite meldet die Position beim Bewegen,
// Klicken und beim Verlassen der Seite; eine neue Seite derselben App holt sie sich hier ab.
const cursorPositions = new Map(); // App-Id -> { x, y }
function appIdOfSender(sender) {
  for (const [id, entry] of runningApps) {
    if (entry.view.webContents === sender) return id;
  }
  return null;
}
function rememberCursorPos(sender, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const id = appIdOfSender(sender);
  if (id) cursorPositions.set(id, { x: Math.round(x), y: Math.round(y) });
}
ipcMain.on('cursor-pos', (event, pos) => {
  if (pos) rememberCursorPos(event.sender, pos.x, pos.y);
});
ipcMain.handle('get-cursor-pos', (event) => {
  const id = appIdOfSender(event.sender);
  return id ? (cursorPositions.get(id) || null) : null;
});

// Eine App-Seite ist neu geladen (Seitenwechsel, Neuladen, Weiterleitung): war der Zeiger an, schaltet sich die Seite ihn wieder ein
// (an der zuletzt gemerkten Stelle)
ipcMain.on('app-view-ready', (event) => {
  if (cursorModeActive && isActiveAppSender(event.sender)) event.sender.send('restore-cursor', cursorPositions.get(appIdOfSender(event.sender)) || null);
});
ipcMain.on('cursor-move', (event, { x, y, frame }) => {
  rememberCursorPos(event.sender, x, y);
  sendCursorHover(x, y, frame === true);
});
ipcMain.on('cursor-click', (event, { x, y, frame }) => {
  rememberCursorPos(event.sender, x, y);
  clickAtCursor(x, y, frame === true);
});

// IPC: Controller-Eingaben (Backspace/Escape/KeyA-halten/KeyP) direkt an die
// bestehende Tastatur-Logik weiterreichen - dieselbe Funktion, die auch echte
// Tastatur-Events verarbeitet, keine doppelte Logik nötig. Ein Stub-Event mit
// No-op preventDefault, da hier kein echtes Electron-Input-Event vorliegt.
ipcMain.on('gamepad-input', (event, input) => {
  // Die App-Ansicht meldet mit, ob in ihr jetzt wirklich ein Textfeld den Fokus hat: das ist verlässlicher als der gemerkte Stand
  // (der hängen bleibt, wenn die Seite das Feld ohne Fokus-Ende entfernt oder verlässt).
  if (input && typeof input.inputFocused === 'boolean' && activeAppId && runningApps.get(activeAppId) && event.sender === runningApps.get(activeAppId).view.webContents) {
    isInputFocused = input.inputFocused;
  }
  handleGlobalInput({ preventDefault: () => {} }, { ...input, fromGamepad: true });
});

// IPC: Steuerkreuz/A/X des Controllers in YouTube TV - der Preload der Ansicht meldet Richtungen, Auswahl und Wiedergabe-Taste,
// hier werden sie als Tastendruck an die Seite geschickt (nur von der gerade sichtbaren YouTube-TV-Ansicht angenommen)
ipcMain.on('tv-key', (event, msg) => {
  const entry = activeAppId ? runningApps.get(activeAppId) : null;
  if (!entry || !entry.isTv || currentView !== 'app' || event.sender !== entry.view.webContents) return;
  if (!msg || !TV_KEYS.has(msg.key) || !['down', 'up', 'press'].includes(msg.type)) return;
  sendTvKey(entry.view.webContents, msg.key, msg.type, !!msg.repeat);
});

// IPC: meldet, welches Element gerade fokussiert ist - merkt sich das pro aktueller
// Ansicht, damit beim Zurücknavigieren der Fokus wiederhergestellt werden kann
ipcMain.on('element-focus-changed', (event, elementId) => {
  if (currentView && elementId) {
    lastFocusedElementByView[currentView] = elementId;
  }
});

// IPC: zuletzt fokussiertes Element der aktuellen Ansicht abfragen
ipcMain.handle('get-last-focused-element', () => {
  return lastFocusedElementByView[currentView] || null;
});

// IPC: ID der zuletzt gestarteten/fortgesetzten Web-App abfragen (für die
// Fokus-Wiederherstellung auf die richtige Kachel nach dem Minimieren)
ipcMain.handle('get-last-launched-app-id', () => {
  return lastLaunchedAppId;
});

// IPC: die Seite übernimmt Backspace selbst (z.B. geöffnetes Formular), solange true
ipcMain.on('set-backspace-capture', (event, capture) => {
  pageCapturesBackspace = !!capture;
});

// IPC: Launcher -> App starten oder fortsetzen
// Läuft die App bereits im Hintergrund (runningApps), wird sie sofort ohne
// Ladebildschirm angezeigt - genau im Zustand, in dem sie verlassen wurde.
// Andernfalls: eigener Ladebildschirm (loading.html), Ziel-URL lädt währenddessen
// unsichtbar in einer neuen, dauerhaften View vor. Erst wenn mindestens
// MIN_LOADING_MS vergangen sind UND die Seite (weitgehend) fertig geladen ist,
// wird diese View sichtbar gemacht und bleibt danach dauerhaft im Hintergrund erhalten.
ipcMain.on('load-app', (event, payload) => {
  const { id, name, url, icon, type, programPath, launchArgs, loadingStyle } = payload;

  // Natives Programm: kompletter Sonderweg, kein WebContentsView/Umschalter/PiP/Mixer möglich
  if (type === 'native') {
    launchNativeApp(programPath, launchArgs, name, loadingStyle, icon);
    return;
  }

  if (runningApps.has(id)) {
    lastLaunchedAppId = id;
    showAppView(id);
    return;
  }

  lastLaunchedAppId = id;
  mainWindow.loadFile('loading.html', { query: { name: name || '', icon: icon || '', style: loadingStyle || 'bar', duration: String(MIN_LOADING_MS) } });
  currentView = 'loading';

  const startTime = Date.now();
  const isBrowser = type === 'browser';
  const isTv = !isBrowser && isYoutubeTvUrl(url);
  const view = createAppView(url, { browser: isBrowser, tv: isTv });

  let switched = false;
  let fallbackTimer = null;
  let settleTimer = null;

  function switchToApp() {
    if (switched) return;
    switched = true;
    if (fallbackTimer) clearTimeout(fallbackTimer);
    if (settleTimer) clearTimeout(settleTimer);

    fadeOutLoadingThen(() => {
      view.webContents.insertCSS(`
        ::-webkit-scrollbar { display: none !important; }
      `);

      runningApps.set(id, {
        id,
        name: name || '',
        icon: icon || '',
        url,
        view,
        isBrowser,
        isTv,
        thumbnail: null,
        lastActive: Date.now(),
        volume: globalVolume, // 0-100: startet mit der Gesamtlautstärke, danach individuell pro App über den Lautstärkemixer einstellbar
        muted: false
      });
      if (globalVolume !== 100) setAppVolume(id, globalVolume);
      // Lädt die App eine neue Seite, gilt die Lautstärke dort wieder (das Skript lebt nur bis zum nächsten Seitenaufruf)
      view.webContents.on('dom-ready', () => {
        const current = runningApps.get(id);
        if (current && current.view === view && current.volume !== 100) setAppVolume(id, current.volume);
      });

      showAppView(id);
    });
  }

  // Wird bei jedem Lade-Ende aufgerufen (kann bei modernen Seiten mehrfach
  // passieren: Hauptdokument fertig, dann lädt JS noch Daten/Bilder nach, dann
  // kurze Pause, dann geht's weiter). Erst wenn SETTLE_BUFFER_MS am Stück wirklich
  // nichts mehr passiert, gilt die Seite als tatsächlich fertig.
  function scheduleSettledSwitch() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(MIN_LOADING_MS - elapsed, 0);
      setTimeout(switchToApp, remaining);
    }, SETTLE_BUFFER_MS);
  }

  view.webContents.on('did-stop-loading', scheduleSettledSwitch);
  view.webContents.on('did-start-loading', () => {
    // Seite lädt wieder etwas nach - abgebrochenen Ruhe-Timer verwerfen und neu warten
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  });
  view.webContents.once('did-fail-load', () => switchToApp());

  // Notbremse: falls die Seite (z.B. wegen Dauer-Streams/ständiger Hintergrundaktivität)
  // nie für SETTLE_BUFFER_MS am Stück wirklich zur Ruhe kommt
  fallbackTimer = setTimeout(switchToApp, MAX_LOADING_MS);
});

// IPC: alle im Hintergrund laufenden Apps für den Umschalter abfragen
ipcMain.handle('get-running-apps', () => {
  return Array.from(runningApps.values())
    .sort((a, b) => b.lastActive - a.lastActive)
    .map(({ id, name, icon, thumbnail, volume, muted }) => ({ id, name, icon, thumbnail, volume, muted }));
});

// IPC: im Umschalter ausgewählte App wieder anzeigen
ipcMain.on('switcher-select-app', (event, id) => {
  lastLaunchedAppId = id;
  mainWindow.loadFile('index.html'); // Basis-Seite hinter der App-View, für spätere Backspace-Minimierung
  showAppView(id);
});

// IPC: App im Umschalter endgültig schließen
ipcMain.on('switcher-close-app', (event, id) => {
  closeRunningApp(id);
});

// IPC: Umschalter per Backspace verlassen, ohne eine App auszuwählen
ipcMain.on('switcher-cancel', () => {
  cancelSwitcher();
});

// IPC: Seiten öffnen. Für jede dieser Seiten gilt: Kanal 'load-<name>' (siehe preload.js), Datei
// <name>.html, und die aktuelle Ansicht heißt danach ebenfalls <name> (wichtig für die Zurück-Logik
// in handleGlobalInput). Seiten mit eigener Logik (load-app, load-topshelf) stehen separat.
const LOADABLE_VIEWS = [
  'settings',            // Einstellungsmenü
  'manage',              // App-Verwaltung
  'profiles',            // Profile verwalten
  'general',             // "Allgemein"-Untermenü
  'system',              // "System"-Untermenü (Adblocker, Dienste & Schlüssel, Profile, Speicher & Daten, Taskleiste)
  'services',            // Dienste & Schlüssel (TMDb-API-Key)
  'remote',              // Fernbedienung per Handy (QR-Code, Port)
  'adblocker',           // Adblocker-Einstellungen
  'time',                // Uhrzeit-Einstellungen
  'tabs',                // Tabs-Einstellungen (App-Umschalter)
  'storage',             // Speicher & Daten (Cache leeren, Anmeldungen löschen, ...)
  'taskbar',             // Taskleiste ausblenden (Windows)
  'input-devices',       // Eingabegeräte-Menü
  'controller-settings', // Controller-Einstellungen
  'keyboard-settings',   // Tastatur-Einstellungen
  'screensaver',         // Bildschirmschoner-Einstellungen
  'intro'                // Intro-Einstellungen
];
LOADABLE_VIEWS.forEach((name) => {
  ipcMain.on(`load-${name}`, () => {
    mainWindow.loadFile(`${name}.html`);
    currentView = name;
  });
});

// IPC: Topshelf-Vollbildmodus (Modus "fullscreen") öffnen
ipcMain.on('load-topshelf', (event, appId) => {
  lastLaunchedAppId = appId; // beim Zurückgehen (Backspace) auf dieser Kachel wieder einsteigen
  mainWindow.loadFile('topshelf.html', { query: { appId } });
  currentView = 'topshelf';
});

// IPC: Launcher über den Beenden-Button im Schnellmenü schließen
ipcMain.on('quit-app', () => {
  app.quit();
});

// IPC: Lautstärke einer App setzen (0-100)
ipcMain.on('set-app-volume', (event, { id, volume }) => {
  setAppVolume(id, volume);
});

// IPC: Stummschaltung einer App setzen
ipcMain.on('set-app-muted', (event, { id, muted }) => {
  setAppMuted(id, muted);
});

// Prüft, ob eine App gerade ein Video-/Audio-Element hat und ob es pausiert ist -
// für die Play/Pause-Anzeige im Lautstärkemixer.
const MEDIA_PLAYING_STATE_SCRIPT = `
  (function() {
    const el = document.querySelector('video, audio');
    if (!el) return null;
    return { paused: el.paused };
  })();
`;

// Schaltet das gefundene Video-/Audio-Element direkt um (play()/pause()) - das
// funktioniert unabhängig davon, ob die Seite die Media-Session-API unterstützt.
const MEDIA_TOGGLE_SCRIPT = `
  (function() {
    const el = document.querySelector('video, audio');
    if (!el) return null;
    if (el.paused) { el.play(); } else { el.pause(); }
    return { paused: el.paused };
  })();
`;

// IPC: Abspielzustand aller laufenden Apps auf einmal abfragen (ein Aufruf
// pro App parallel), für die Play/Pause-Anzeige im Mixer
ipcMain.handle('get-app-playing-states', async () => {
  const results = {};
  await Promise.all(Array.from(runningApps.entries()).map(async ([id, entry]) => {
    try {
      results[id] = await entry.view.webContents.executeJavaScript(MEDIA_PLAYING_STATE_SCRIPT);
    } catch (err) {
      results[id] = null;
    }
  }));
  return results;
});

// IPC: Wiedergabe einer bestimmten App umschalten
ipcMain.handle('toggle-app-playback', async (event, appId) => {
  const entry = runningApps.get(appId);
  if (!entry) return null;
  try {
    return await entry.view.webContents.executeJavaScript(MEDIA_TOGGLE_SCRIPT);
  } catch (err) {
    console.error('Wiedergabe konnte nicht umgeschaltet werden:', err);
    return null;
  }
});

// IPC: Hintergrund-Einstellungen lesen
ipcMain.handle('get-background-settings', () => {
  return readBgSettings();
});

// IPC: Hintergrund-Einstellungen speichern (mergt mit bestehenden Werten)
ipcMain.handle('save-background-settings', (event, newSettings) => {
  const { tmdbApiKey: ignoredKey, ...safeSettings } = newSettings || {}; // Key wird nur über 'save-tmdb-key' geändert
  const merged = { ...readBgSettings(), ...safeSettings };
  // Dynamischer Hintergrund ist nur mit hinterlegtem API-Key erlaubt
  if (merged.mode === 'dynamic' && !merged.tmdbApiKey) merged.mode = 'static';
  writeBgSettings(merged);
  return merged;
});

// IPC: Adblocker-Einstellungen lesen
ipcMain.handle('get-adblocker-settings', () => {
  return readAdblockerSettings();
});

// IPC: Adblocker-Einstellungen speichern. An/Aus gilt erst nach einem Neustart; Ausnahmen, Protokoll und die
// einzelnen Schichten gelten sofort für alle weiteren Anfragen.
ipcMain.handle('save-adblocker-settings', (event, newSettings) => {
  const merged = normalizeAdblockerSettings({ ...readAdblockerSettings(), ...newSettings });
  writeAdblockerSettings(merged);
  updateAdblockerSettings(merged);
  return merged;
});

// IPC: Stand der Filterlisten (wie alt, wie viele Regeln, woher) und sofortiges Erneuern
ipcMain.handle('get-adblocker-lists-info', () => getAdblockerListsInfo());
ipcMain.handle('refresh-adblocker-lists', () => refreshAdblockerLists());

// IPC: Pfad der Protokolldatei des Adblockers (für die Anzeige auf der Einstellungsseite)
ipcMain.handle('get-adblocker-log-path', () => adblockerLogPath);

// IPC: Ordner mit der Protokolldatei im Datei-Manager zeigen (die Datei markiert, falls es sie schon gibt)
ipcMain.handle('open-adblocker-log-folder', () => {
  try {
    if (fs.existsSync(adblockerLogPath)) shell.showItemInFolder(adblockerLogPath);
    else shell.openPath(path.dirname(adblockerLogPath));
  } catch (err) {
    console.error('Ordner mit dem Adblocker-Protokoll konnte nicht geöffnet werden:', err);
  }
  return adblockerLogPath;
});

// ---------- Bildschirmschoner ----------
// Startseite hat sich als Gastgeber gemeldet (screensaver-host-ready); gilt bis zur nächsten Navigation des Hauptfensters
let launcherHostsScreensaver = false;
ipcMain.on('screensaver-host-ready', (event) => {
  if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents) launcherHostsScreensaver = true;
});
// Er erscheint nur im Launcher und in den Einstellungen - nicht in einer laufenden App, nicht beim Laden einer App,
// nicht im Umschalter und nicht, solange ein natives Programm läuft oder die App gerade verlassen wird.
const screensaver = createScreensaver({
  getMainWindow: () => mainWindow,
  isViewAllowed: () => !['app', 'loading', 'switcher', 'profile-select'].includes(currentView) && !nativeAppRunning && !leavingApp && !mediaPlayer.isOpen() && !intro.isActive(),
  readSettings: readScreensaverSettings,
  getImages: fetchPopularMovieImages, // Bilder aktuell beliebter Filme (TMDb) für die Bildervariante
  getLogo: fetchMovieLogo,            // Logo eines Films für die Zusatzinfo (Pfeil runter)
  baseDir: __dirname,
  // Auf der Startseite läuft er als Ebene in ihr (unter dem Schnellmenü), sobald sie ihre Bereitschaft gemeldet hat
  canEmbed: () => currentView === 'launcher' && launcherHostsScreensaver && !!mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()
});

ipcMain.handle('get-screensaver-settings', () => readScreensaverSettings());

ipcMain.handle('save-screensaver-settings', (event, newSettings) => {
  const merged = normalizeScreensaverSettings({ ...readScreensaverSettings(), ...newSettings });
  writeScreensaverSettings(merged);
  screensaver.settingsChanged();
  return merged;
});

// ---------- Intro beim Start des Launchers (videos/intro/intro.mp4) ----------
// Solange es läuft, nehmen die Launcher-Seiten keine Controller-Eingaben an (dieselbe Sperre wie beim Bildschirmschoner)
const intro = createIntro({
  getMainWindow: () => mainWindow,
  readSettings: readIntroSettings,
  onActiveChanged: (active) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('screensaver-state', !!active); } catch (err) { /* Seite wechselt gerade */ }
    }
  },
  baseDir: __dirname
});

ipcMain.handle('get-intro-settings', () => readIntroSettings());
ipcMain.handle('save-intro-settings', (event, newSettings) => {
  const merged = normalizeIntroSettings({ ...readIntroSettings(), ...newSettings });
  writeIntroSettings(merged);
  return merged;
});
ipcMain.handle('get-intro-available', () => !!intro.findVideo());
ipcMain.handle('intro-is-active', () => intro.isActive());
// Vorschau auf der Einstellungsseite: auch bei ausgeschaltetem Intro
ipcMain.on('intro-preview', () => intro.start({ preview: true }));

// Die Launcher-Seiten melden Eingaben (Tastatur, Maus, Controller): damit beginnt die Wartezeit von vorn
ipcMain.on('user-activity', () => screensaver.noteActivity());

// Backspace/B auf der Startseite (wenn nichts mehr zurückzugehen ist): Bildschirmschoner sofort starten
ipcMain.on('screensaver-start-manual', (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || currentView !== 'launcher') return;
  if (Date.now() < suppressManualScreensaverUntil) return; // B wurde in YouTube TV zum Minimieren gehalten und ist evtl. noch gedrückt
  screensaver.startManual();
});

// Vorschau auf der Einstellungsseite: sofort starten, auch wenn der Bildschirmschoner ausgeschaltet ist
ipcMain.on('screensaver-preview', () => screensaver.start({ preview: true }));

// ---------- Musikplayer (Bild-in-Bild-Fenster für die Wiedergabe der Apps) ----------
// Live-Video im Player läuft über eine lokale WebRTC-Verbindung zwischen App-Seite und Player (media-player-service.js).
// Chromium versteckt Rechneradressen dabei standardmäßig hinter mDNS-Namen und nimmt Loopback nicht als Kandidaten -
// beides würde die Verbindung auf dem eigenen Rechner (oder ohne Netzwerk) verhindern.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('allow-loopback-in-peer-connection');

// Auslöser: Taste M, rechter Stick gedrückt (R3, kommt als "KeyM" über 'gamepad-input') und der Knopf im Schnellmenü. Solange er offen ist, bedienen Steuerkreuz und A ihn (die Seiten leiten das hier her).
function broadcastMediaPlayerOpen(open) {
  const targets = [];
  if (mainWindow && !mainWindow.isDestroyed()) targets.push(mainWindow.webContents);
  runningApps.forEach((entry) => targets.push(entry.view.webContents));
  targets.forEach((wc) => {
    try { if (!wc.isDestroyed()) wc.send('media-player-open', !!open); } catch (err) { /* Seite wechselt gerade */ }
  });
}

const mediaPlayer = createMediaPlayer({
  getApps: () => Array.from(runningApps.values()).map((entry) => ({ id: entry.id, webContents: entry.view.webContents, lastActive: entry.lastActive })),
  readSettings: readMediaPlayerSettings,
  writeSettings: writeMediaPlayerSettings,
  onOpenChanged: broadcastMediaPlayerOpen,
  baseDir: __dirname
});

// Controller bei offenem Player: Steuerkreuz bewegt den Fokus im Player (Video-Knopf, Fortschrittsbalken, Zurück,
// Play/Pause, Weiter, Schließen), links/rechts springt auf dem Balken, A löst den fokussierten Knopf aus.
// Das Player-Fenster hat keinen Tastaturfokus und wertet die Eingaben selbst aus ('media-player-nav').
ipcMain.on('media-player-pad', (event, data) => {
  if (!data || !mediaPlayer.isOpen()) return;
  // X gehalten + Steuerkreuz: fester Platz des Players ('place-left' usw.), sonst Bedienung im Player
  if (typeof data.action === 'string' && data.action.startsWith('place-')) {
    mediaPlayer.place(data.action.slice('place-'.length));
    return;
  }
  mediaPlayer.navigate(data.action, data.repeat === true);
});

ipcMain.handle('media-player-is-open', () => mediaPlayer.isOpen());
// IPC: Controller-Einstellungen lesen
ipcMain.handle('get-controller-settings', () => {
  return readControllerSettings();
});

// Neue Controller-Einstellungen (Geschwindigkeiten, Tastenbelegung) an alle Seiten melden, die sie nutzen: laufende Apps (Cursor,
// Scrollen, Tasten) und die Startseite bzw. Einstellungsseite im Hauptfenster (deren Tasten folgen der Belegung sofort)
function broadcastControllerSettings(settings) {
  const targets = [];
  runningApps.forEach((entry) => targets.push(entry.view.webContents));
  if (mainWindow && !mainWindow.isDestroyed()) targets.push(mainWindow.webContents);
  targets.forEach((wc) => {
    try {
      if (!wc.isDestroyed()) wc.send('controller-settings-changed', settings);
    } catch (err) {
      // eine nicht erreichbare Seite soll das Speichern nicht verhindern
    }
  });
}

// IPC: Controller-Einstellungen speichern und laufende Apps sofort informieren
// (deren Cursor-Geschwindigkeit hängt daran - sonst gälte der neue Wert erst nach einem Neustart)
ipcMain.handle('save-controller-settings', (event, newSettings) => {
  const { mapping: ignored, ...rest } = newSettings || {}; // die Tastenbelegung ändern nur die Belegungs-Aufrufe unten
  const merged = normalizeControllerSettings({ ...readControllerSettings(), ...rest });
  writeControllerSettings(merged);
  broadcastControllerSettings(merged);
  return merged;
});

// ---------- Tastenbelegung des Controllers (siehe controller-mapping.js) ----------
// Die Seiten bekommen beim Laden die fertige Belegung (synchron, damit keine Taste kurz falsch gedeutet wird) und danach jede Änderung
// über 'controller-settings-changed'. Die Einstellungsseite fragt die Beschreibung ab und ändert über die Aufrufe darunter.
ipcMain.on('get-controller-mapping', (event) => {
  event.returnValue = readControllerSettings().mapping;
});

function saveControllerMapping(mapping) {
  const merged = normalizeControllerSettings({ ...readControllerSettings(), mapping });
  writeControllerSettings(merged);
  broadcastControllerSettings(merged);
  return merged;
}

ipcMain.handle('get-controller-mapping-info', () => controllerMapping.describe(readControllerSettings().mapping));

// Einer Aktion eine Taste geben (belegte Taste: die beiden Aktionen tauschen); button = null leert das Schnellmenü
ipcMain.handle('set-controller-button', (event, data) => {
  const d = data || {};
  const result = controllerMapping.assignButton(readControllerSettings().mapping, d.action, d.button === null ? null : Number(d.button));
  if (!result.ok) return { ok: false, error: result.error, other: result.other || null, info: controllerMapping.describe(readControllerSettings().mapping) };
  return { ok: true, swapped: result.swapped, info: controllerMapping.describe(saveControllerMapping(result.mapping).mapping) };
});

// Eine Aktion auf ihre Standardtaste zurück (bei belegter Standardtaste tauschen die beiden)
ipcMain.handle('reset-controller-action', (event, actionId) => {
  const def = controllerMapping.DEFAULT_MAPPING[actionId];
  if (def === undefined) return { ok: false, error: 'unknown', info: controllerMapping.describe(readControllerSettings().mapping) };
  const result = controllerMapping.assignButton(readControllerSettings().mapping, actionId, def);
  if (!result.ok) return { ok: false, error: result.error, info: controllerMapping.describe(readControllerSettings().mapping) };
  return { ok: true, swapped: result.swapped, info: controllerMapping.describe(saveControllerMapping(result.mapping).mapping) };
});

// Vorlage übernehmen ('standard' = alles auf Standard)
ipcMain.handle('apply-controller-preset', (event, id) => {
  const mapping = controllerMapping.presetMapping(id);
  if (!mapping) return { ok: false, error: 'unknown', info: controllerMapping.describe(readControllerSettings().mapping) };
  return { ok: true, info: controllerMapping.describe(saveControllerMapping(mapping).mapping) };
});

// Notausstieg: Select + Start 3 Sekunden gehalten (die Seiten erkennen das) setzt die Belegung auf Standard zurück
ipcMain.on('controller-mapping-reset', () => {
  saveControllerMapping(controllerMapping.presetMapping('standard'));
});

// IPC: Tastatur-Einstellungen lesen
ipcMain.handle('get-keyboard-settings', () => {
  return readKeyboardSettings();
});

// IPC: Tastatur-Einstellungen speichern
ipcMain.handle('save-keyboard-settings', (event, newSettings) => {
  const merged = mergeKeyboardSettings(readKeyboardSettings(), newSettings);
  writeKeyboardSettings(merged);
  return merged;
});

// IPC: Uhrzeit-Einstellungen lesen
ipcMain.handle('get-clock-settings', () => {
  return readClockSettings();
});

// IPC: Uhrzeit-Einstellungen speichern
ipcMain.handle('save-clock-settings', (event, newSettings) => {
  const merged = { ...readClockSettings(), ...newSettings };
  writeClockSettings(merged);
  return merged;
});

// IPC: Tabs-Einstellungen (App-Umschalter) lesen
ipcMain.handle('get-tabs-settings', () => {
  return readTabsSettings();
});

// IPC: Tabs-Einstellungen speichern
ipcMain.handle('save-tabs-settings', (event, newSettings) => {
  const merged = { ...readTabsSettings(), ...newSettings };
  writeTabsSettings(merged);
  return merged;
});

// IPC: Taskleisten-Einstellung (Einstellungen > System > Taskleiste) lesen
ipcMain.handle('get-taskbar-settings', () => ({ ...readTaskbarSettings(), available: process.platform === 'win32' }));

// IPC: Taskleisten-Einstellung speichern; sie gilt sofort (aus -> die vom Launcher ausgeblendete Taskleiste erscheint wieder)
ipcMain.handle('save-taskbar-settings', async (event, newSettings) => {
  const merged = normalizeTaskbarSettings({ ...readTaskbarSettings(), ...newSettings });
  writeTaskbarSettings(merged);
  if (merged.hideTaskbar) await taskbar.hide();
  else await taskbar.restore();
  return { ...merged, available: process.platform === 'win32' };
});

// IPC: App sauber neu starten (nötig, damit Adblocker-Änderungen zuverlässig greifen)
ipcMain.on('restart-app', () => {
  app.relaunch();
  app.exit();
});

// IPC: TMDb-API-Key speichern (leerer Key = entfernen). Ein von TMDb abgelehnter Key wird nicht gespeichert.
ipcMain.handle('save-tmdb-key', async (event, rawKey) => {
  const key = (rawKey || '').trim();
  const settings = readBgSettings();

  if (!key) {
    settings.tmdbApiKey = '';
    settings.mode = 'static'; // ohne Key kein dynamischer Hintergrund
    writeBgSettings(settings);
    return { status: 'removed', settings };
  }

  const check = await validateTmdbKey(key);
  if (check === 'invalid') {
    return { status: 'invalid', settings };
  }

  settings.tmdbApiKey = key;
  writeBgSettings(settings);
  return { status: check === 'valid' ? 'saved' : 'saved-unverified', settings };
});

// IPC: TMDb nach Filmen/Serien durchsuchen (für die statische Auswahl)
// Rückgabe: { status: 'ok' | 'no-key' | 'invalid-key' | 'error', results: [...] }
ipcMain.handle('search-tmdb', async (event, query) => {
  const trimmed = (query || '').trim();
  if (!trimmed) return { status: 'ok', results: [] };

  const { tmdbApiKey } = readBgSettings();
  if (!tmdbApiKey) return { status: 'no-key', results: [] };

  try {
    const result = await tmdbRequest(`/search/multi?query=${encodeURIComponent(trimmed)}`, tmdbApiKey);
    if (result.status_code === 7) return { status: 'invalid-key', results: [] };
    if (result.success === false) return { status: 'error', results: [] };

    const results = (result.results || [])
      .filter(item => (item.media_type === 'movie' || item.media_type === 'tv') && item.backdrop_path)
      .map(item => ({
        id: item.id,
        mediaType: item.media_type,
        title: item.title || item.name,
        year: (item.release_date || item.first_air_date || '').slice(0, 4),
        backdropUrl: `${TMDB_IMAGE_BASE}${item.backdrop_path}`
      }));
    return { status: 'ok', results };
  } catch (err) {
    console.error('TMDb-Suche fehlgeschlagen:', err);
    return { status: 'error', results: [] };
  }
});

// IPC: gespeicherte Apps lesen
ipcMain.handle('get-apps', () => {
  return readApps();
});

// IPC: Startseite mit Ordnern (Apps und Ordner { type: 'folder', id, name, apps: [...] } in Anzeigereihenfolge)
ipcMain.handle('get-home-items', () => {
  return readHomeItems();
});

// IPC: Anordnung der Startseite speichern. Die Startseite schickt nur Ids: eine Id = App, { type: 'folder', id, name, apps: [Ids] } = Ordner.
// Die App-Daten kommen aus apps.json (nichts Fremdes wird gespeichert); Apps, die in der Anordnung fehlen, werden hinten angehängt.
ipcMain.handle('save-home-items', (event, layout) => {
  if (!fromMainWindow(event) || !Array.isArray(layout)) return { ok: false };
  const byId = new Map(readApps().map((a) => [a.id, a]));
  const used = new Set();
  const take = (id) => {
    if (typeof id !== 'string' || used.has(id) || !byId.has(id)) return null;
    used.add(id);
    return byId.get(id);
  };
  const items = [];
  for (const entry of layout) {
    if (typeof entry === 'string') {
      const appData = take(entry);
      if (appData) items.push(appData);
    } else if (entry && entry.type === 'folder' && Array.isArray(entry.apps)) {
      const apps = entry.apps.map(take).filter(Boolean);
      if (apps.length) items.push({ type: 'folder', id: String(entry.id || ''), name: String(entry.name || ''), apps });
    }
  }
  for (const [id, appData] of byId) if (!used.has(id)) items.push(appData);
  writeHomeItems(items);
  dynamicBgChoiceCache.clear();
  return { ok: true, items: readHomeItems() };
});

// IPC: App von der Startseite löschen (laufende App wird beendet; Anmeldungen/Cookies bleiben - die löscht man unter Speicher & Daten)
ipcMain.handle('delete-home-app', (event, appId) => {
  if (!fromMainWindow(event) || typeof appId !== 'string') return { ok: false };
  const apps = readApps();
  if (!apps.some((a) => a.id === appId)) return { ok: false, error: 'unknown' };
  closeRunningApp(appId);
  if (lastLaunchedAppId === appId) lastLaunchedAppId = null;
  writeApps(apps.filter((a) => a.id !== appId));
  dynamicBgChoiceCache.clear();
  return { ok: true, items: readHomeItems() };
});

// IPC: Topshelf-Inhalte (aktuell beliebt) einer App abfragen
ipcMain.handle('get-topshelf-content', async (event, appId) => {
  const apps = readApps();
  const appData = apps.find(a => a.id === appId);
  if (!appData || appData.topshelf === 'off' || !appData.topshelfProvider) return [];
  return fetchTopshelfContent(appData.topshelfProvider);
});

// IPC: dynamischen App-Hintergrund abfragen - nutzt dieselbe TMDb-Anbieter-Abfrage
// wie Topshelf (inkl. deren 1h-Cache), wählt daraus zufällig ein Hintergrundbild
// Merkt sich pro App das einmal gewürfelte Hintergrundbild für die laufende
// Sitzung (bis zum nächsten App-Neustart) - wird NICHT bei jedem Hover neu
// gewürfelt, sondern bleibt innerhalb einer Sitzung konsistent.
const dynamicBgChoiceCache = new Map(); // appId -> backdropUrl

ipcMain.handle('get-dynamic-app-background', async (event, appId) => {
  if (dynamicBgChoiceCache.has(appId)) {
    return dynamicBgChoiceCache.get(appId);
  }

  const apps = readApps();
  const appData = apps.find(a => a.id === appId);
  if (!appData || !appData.dynamicBg || !appData.topshelfProvider) return null;

  const items = await fetchTopshelfContent(appData.topshelfProvider);
  if (items.length === 0) return null;

  const pick = items[Math.floor(Math.random() * items.length)];
  dynamicBgChoiceCache.set(appId, pick.backdropUrl);
  return pick.backdropUrl;
});

// ---------- Speicher & Daten (Einstellungen > Allgemein > Speicher & Daten) ----------
// Gilt immer für das aktive Profil (eigene Sitzung mit Cache, Cookies und Anmeldungen). Aufgerufen nur von den eigenen Seiten im Hauptfenster.
function fromMainWindow(event) {
  return !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
}

ipcMain.handle('storage-info', async (event) => {
  if (!fromMainWindow(event)) return null;
  const sizes = await storageTools.measure(activeSession());
  const profile = profiles.active();
  const apps = readApps().filter((a) => a && a.type !== 'native' && a.url).map((a) => ({ id: a.id, name: a.name || a.id }));
  return { profileName: profile ? profile.name : '', cacheBytes: sizes.cacheBytes, dataBytes: sizes.dataBytes, apps };
});

ipcMain.handle('storage-clear-cache', async (event) => {
  if (!fromMainWindow(event)) return { ok: false };
  return storageTools.clearCache(activeSession());
});

// Cookies und Anmeldungen: alle Apps des Profils werden vorher beendet (sie würden sonst mit gelöschten Anmeldungen weiterlaufen)
function closeAllRunningApps() {
  for (const appId of Array.from(runningApps.keys())) closeRunningApp(appId);
  activeAppId = null;
  returningToAppId = null;
  lastLaunchedAppId = null;
}

ipcMain.handle('storage-clear-data', async (event) => {
  if (!fromMainWindow(event)) return { ok: false };
  closeAllRunningApps();
  return storageTools.clearAll(activeSession());
});

ipcMain.handle('storage-reset-app', async (event, appId) => {
  if (!fromMainWindow(event) || typeof appId !== 'string') return { ok: false };
  const appData = readApps().find((a) => a && a.id === appId && a.type !== 'native' && a.url);
  if (!appData) return { ok: false, error: 'unknown' };
  closeRunningApp(appId);
  if (lastLaunchedAppId === appId) lastLaunchedAppId = null;
  const result = await storageTools.resetSite(activeSession(), appData.url);
  return { ...result, name: appData.name || appId };
});

ipcMain.handle('storage-reload-tmdb', (event) => {
  if (!fromMainWindow(event)) return { ok: false };
  clearTmdbCaches();
  dynamicBgChoiceCache.clear();
  return { ok: true };
});

// IPC: komplette App-Liste speichern (überschreibt apps.json)
ipcMain.handle('save-apps', (event, apps) => {
  writeApps(apps);
  dynamicBgChoiceCache.clear(); // Einstellungen könnten sich geändert haben - neu würfeln lassen
  return true;
});

// IPC: Bilddatei über System-Dialog auswählen und dauerhaft in userData/images kopieren
ipcMain.handle('select-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Bild auswählen',
    properties: ['openFile'],
    filters: [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const sourcePath = result.filePaths[0];
  const ext = path.extname(sourcePath);
  const destName = `${crypto.randomUUID()}${ext}`;
  const destPath = path.join(imagesDir, destName);

  fs.copyFileSync(sourcePath, destPath);

  // Als file:// URL zurückgeben, damit img-Tags im Renderer direkt darauf zugreifen können
  return `file://${destPath.replace(/\\/g, '/')}`;
});

// IPC: Pfad zu einer lokal installierten Programmdatei auswählen (für native Apps).
// Anders als bei Bildern wird die Datei NICHT kopiert - der Pfad muss auf das
// tatsächlich installierte Programm zeigen, damit es sich später starten lässt.
ipcMain.handle('select-program', async () => {
  const filters = process.platform === 'win32'
    ? [{ name: 'Programme', extensions: ['exe'] }]
    : [{ name: 'Alle Dateien', extensions: ['*'] }];

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Programm auswählen',
    properties: ['openFile'],
    filters
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});


// ---------- Fernbedienung per Handy (siehe remote-service.js / remote-server.js / remote-ui/) ----------
// Das Handy bedient den Launcher wie ein virtueller Controller: Tasten gehen als 'remote-key' an die Seite (Startseite bzw. App-Ansicht),
// die sie wie Controller-Tasten behandelt (preload.js / app-view-preload.js); in Apps bewegt es den Zeiger ('remote-cursor') oder schickt Pfeiltasten.
const REMOTE_KEY_TAP_MS = 45;

function remoteActiveEntry() {
  if (currentView !== 'app' || !activeAppId) return null;
  const entry = runningApps.get(activeAppId);
  return entry && !entry.view.webContents.isDestroyed() ? entry : null;
}

// Die Seite, die gerade Eingaben bekommt: die sichtbare App oder die Startseite/Einstellungen im Hauptfenster
function remoteTarget() {
  const entry = remoteActiveEntry();
  if (entry) return entry.view.webContents;
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
}

function remoteKey(code) {
  const wc = remoteTarget();
  if (!wc) return;
  wc.send('remote-key', { code, type: 'down' });
  setTimeout(() => { if (!wc.isDestroyed()) wc.send('remote-key', { code, type: 'up' }); }, REMOTE_KEY_TAP_MS);
}

const REMOTE_APP_KEYS = { up: 'Up', down: 'Down', left: 'Left', right: 'Right', select: 'Return' };
function remoteAppKey(name) {
  const entry = remoteActiveEntry();
  if (!entry || !REMOTE_APP_KEYS[name]) return;
  if (mediaPlayer.isOpen()) { // der offene Musikplayer gehört den Richtungen und OK (wie am Controller)
    mediaPlayer.navigate(name === 'select' ? 'activate' : name, false);
    return;
  }
  const wc = entry.view.webContents;
  if (!wc.isFocused()) wc.focus();
  if (entry.isTv) { // YouTube TV: eigene Tastenübergabe (siehe sendTvKey)
    sendTvKey(wc, name === 'select' ? 'Enter' : REMOTE_APP_KEYS[name], 'press');
    return;
  }
  wc.sendInputEvent({ type: 'keyDown', keyCode: REMOTE_APP_KEYS[name] });
  wc.sendInputEvent({ type: 'keyUp', keyCode: REMOTE_APP_KEYS[name] });
}

function remoteCursor(msg) {
  const entry = remoteActiveEntry();
  if (entry) entry.view.webContents.send('remote-cursor', msg);
}

// Wartet, bis die Startseite fertig dasteht (nach dem Verlassen einer App/Einstellungsseite), dann Aktion
function whenLauncherReady(callback) {
  const started = Date.now();
  const timer = setInterval(() => {
    const ready = currentView === 'launcher' && !leavingApp && mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading();
    if (ready) {
      clearInterval(timer);
      setTimeout(callback, 350); // die Seite braucht einen Moment, bis ihre Tastenbehandlung steht
    } else if (Date.now() - started > 4000) {
      clearInterval(timer);
    }
  }, 100);
}

// Home: zurück zur Startseite (App minimieren, Einstellungen/Umschalter verlassen). Auf der Startseite selbst bleibt es dabei.
function remoteHome() {
  if (currentView === 'app') { leaveActiveAppToLauncher(); return; }
  if (['launcher', 'loading', 'profile-select'].includes(currentView) || leavingApp) return;
  returningToAppId = null;
  mainWindow.loadFile('index.html');
  currentView = 'launcher';
}

function remoteOpenQuickMenu() {
  if (currentView === 'launcher') { remoteKey('GamepadQuickMenu'); return; }
  remoteHome();
  whenLauncherReady(() => remoteKey('GamepadQuickMenu'));
}

async function remotePlayPause() {
  let entry = remoteActiveEntry();
  if (!entry) { // keine App im Vordergrund: die App, die gerade spielt (sonst die zuletzt benutzte)
    const list = Array.from(runningApps.values()).sort((a, b) => b.lastActive - a.lastActive);
    for (const candidate of list) {
      try {
        const state = await candidate.view.webContents.executeJavaScript(MEDIA_PLAYING_STATE_SCRIPT);
        if (state && !state.paused) { entry = candidate; break; }
      } catch (err) { /* App antwortet nicht */ }
    }
    if (!entry) entry = list[0];
  }
  if (!entry) return;
  try { await entry.view.webContents.executeJavaScript(MEDIA_TOGGLE_SCRIPT); } catch (err) { console.error('Wiedergabe (Fernbedienung):', err); }
}

// Text aus dem Handy ins fokussierte Textfeld: erst löschen, dann einfügen. Wie die Bildschirmtastatur über echte Chromium-Eingaben.
// Return mit "char"-Ereignis: nur so fügt ein mehrzeiliges Feld wirklich einen Zeilenumbruch ein
function sendReturnKey(wc) {
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  wc.sendInputEvent({ type: 'char', keyCode: '\r' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
}

async function remoteTypeText(del, ins, multiline) {
  const wc = remoteTarget();
  if (!wc || wc.isDestroyed()) return;
  isInputFocused = true; // sicher: das Feld ist gerade geprüft - Backspace darf hier nichts minimieren/verlassen
  if (!wc.isFocused()) wc.focus();
  for (let i = 0; i < del; i++) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
  }
  // Zeilenumbrüche gehören in einem Rutsch zum Text (so bleibt die Reihenfolge sicher); einzeilige Felder bekommen keine
  const text = multiline ? ins.replace(/\r\n?/g, '\n') : ins.replace(/\r?\n/g, '');
  if (text) await wc.insertText(text).catch(() => {});
}

function remoteTextKey(name) {
  const wc = remoteTarget();
  if (!wc || wc.isDestroyed() || !['Return', 'Backspace'].includes(name)) return;
  isInputFocused = true;
  if (!wc.isFocused()) wc.focus();
  if (name === 'Return') { sendReturnKey(wc); return; }
  wc.sendInputEvent({ type: 'keyDown', keyCode: name });
  wc.sendInputEvent({ type: 'keyUp', keyCode: name });
}

// Eingabegerät-Symbol der Startseite: "Handy" bei jeder Eingabe (höchstens alle 250 ms gemeldet, Zeigerbewegungen kommen oft)
let lastRemoteInputSent = 0;
let remoteInputTimer = null;
function sendRemoteInput() {
  lastRemoteInputSent = Date.now();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('remote-input'); } catch (err) { /* Seite wechselt gerade */ }
  }
}
function remoteNoteInput() {
  pointerHider.padUsed(); // Handy benutzt: Mauszeiger überall aus
  const wait = 250 - (Date.now() - lastRemoteInputSent);
  if (wait <= 0) { sendRemoteInput(); return; }
  if (remoteInputTimer) return; // ein Nachzügler ist schon geplant: die letzte Eingabe geht auf jeden Fall noch raus
  remoteInputTimer = setTimeout(() => { remoteInputTimer = null; sendRemoteInput(); }, wait);
}

// Karten-Vorschau (Topshelf) im Dock der Startseite: meldet die Startseite (script.js), solange man durch die Karten blättert
let topshelfCardsActive = false;
ipcMain.on('topshelf-cards-active', (event, active) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  topshelfCardsActive = active === true;
});

// Ansichten, in denen ein Wisch am Handy immer nur ein Element weiterschaltet: Bildschirmschoner (als Ebene in der Startseite),
// die Topshelf-Seite und das Blättern durch die Topshelf-Karten im Dock
function remoteSingleStep() {
  if (currentView === 'topshelf') return true;
  if (screensaver.isActive() && screensaver.isEmbedded()) return true;
  return currentView === 'launcher' && topshelfCardsActive;
}

function remoteSnapshot() {
  const entry = remoteActiveEntry();
  return {
    isApp: !!entry,
    appId: entry ? entry.id : '',
    isBrowser: !!(entry && entry.isBrowser),
    pointer: !!(entry && cursorModeActive),
    volume: globalVolume,
    single: remoteSingleStep(),
    viewKey: `${currentView}:${entry ? entry.id : ''}`
  };
}

const remote = createRemoteService({
  ipcMain,
  publicDir: path.join(__dirname, 'remote-ui'),
  readSettings: readRemoteSettings,
  writeSettings: writeRemoteSettings,
  getMainWindow: () => mainWindow,
  getSnapshot: remoteSnapshot,
  networkInterfaces: () => os.networkInterfaces(),
  normalizeTouch: normalizeRemoteTouch,
  actions: {
    isBlocked: () => intro.isActive() || nativeAppRunning || currentView === 'loading',
    noteActivity: () => screensaver.noteActivity(),
    onInput: remoteNoteInput,
    // läuft der Bildschirmschoner eigenständig, weckt die erste Eingabe nur auf; als Ebene in der Startseite wertet sie die Tasten selbst aus
    screensaver: () => {
      if (!screensaver.isActive()) return 'none';
      if (screensaver.isEmbedded()) return 'embedded';
      screensaver.stop();
      return 'consume';
    },
    getTarget: remoteTarget,
    key: remoteKey,
    appKey: remoteAppKey,
    pointer: {
      set: (value) => remoteCursor({ type: 'set', value: !!value }),
      move: (dx, dy) => remoteCursor({ type: 'move', dx, dy }),
      click: () => remoteCursor({ type: 'click' }),
      scroll: (dy) => remoteCursor({ type: 'scroll', dy })
    },
    home: remoteHome,
    openSwitcher: () => { if (currentView !== 'switcher') openSwitcher().catch((err) => console.error('Umschalter (Fernbedienung):', err)); },
    openQuickMenu: remoteOpenQuickMenu,
    playPause: remotePlayPause,
    setVolume: setGlobalVolume,
    typeText: remoteTypeText,
    textKey: remoteTextKey
  },
  log: (text) => console.log('Fernbedienung:', text)
});
ipcMain.handle('remote-get-status', () => remote.status());

// DRM (Widevine): Nur im Electron-Fork von castLabs gibt es 'components'. Dort wird das Widevine-Modul beim ersten Start von Google geladen
// und muss vor dem ersten Fenster bereit sein, sonst spielen geschützte Inhalte (Netflix, Disney+ ...) nicht ab. Im normalen Electron fehlt
// 'components' - dann passiert hier nichts. Die Wartezeit ist begrenzt, damit der Launcher ohne Internet trotzdem startet (DRM geht dann erst
// nach einem späteren Start, wenn das Modul geladen ist).
const WIDEVINE_WAIT_MS = 30000;
function waitForWidevine() {
  const { components } = require('electron');
  if (!components || typeof components.whenReady !== 'function') return null; // normales Electron: nichts abzuwarten, der Start bleibt unverändert
  return waitForWidevineComponent(components);
}
async function waitForWidevineComponent(components) {
  let timer = null;
  try {
    await Promise.race([
      components.whenReady(),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Zeitüberschreitung nach ' + WIDEVINE_WAIT_MS / 1000 + ' s')), WIDEVINE_WAIT_MS); })
    ]);
    console.log('Widevine bereit.');
  } catch (err) {
    const text = Array.isArray(err) ? err.map((e) => (e && e.message) || String(e)).join('; ') : ((err && err.message) || String(err));
    console.error('Widevine nicht bereit (DRM-Inhalte gehen evtl. erst nach einem späteren Start):', text);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

app.whenReady().then(() => {
  initBrowserApps();
  applyTaskbarPreference();
  const widevine = waitForWidevine();
  if (widevine) widevine.then(startLauncher); else startLauncher();
});

function startLauncher() {
  createWindow();
  intro.start(); // Intro beim Start des Launchers (nur, wenn eingeschaltet und die Videodatei vorhanden ist)
  applyProfileSession();
  initAdblocker({ getSession: activeSession });
  networkStatus.start();
  remote.registerIpc();
  remote.start(); // nur, wenn die Fernbedienung in den Einstellungen eingeschaltet ist
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Eine vom Launcher ausgeblendete Taskleiste wird vor dem tatsächlichen Beenden wieder eingeblendet -
// 'before-quit' wird dafür einmal abgefangen (preventDefault) und das Beenden erst danach erneut
// angestoßen, damit das Einblenden nicht durch das Prozessende abgeschnitten wird.
let quitCleanupDone = false;

app.on('before-quit', (event) => {
  if (quitCleanupDone) return;
  event.preventDefault();
  networkStatus.stop();
  remote.stop().catch(() => {});

  const cleanup = taskbar.restore(); // tut nichts, wenn der Launcher die Taskleiste nicht ausgeblendet hat
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000)); // Notbremse

  Promise.race([cleanup, timeout]).finally(() => {
    quitCleanupDone = true;
    app.quit();
  });
});
