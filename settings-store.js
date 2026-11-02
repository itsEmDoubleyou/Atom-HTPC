// Einstellungen und App-Liste: JSON-Dateien im Datenordner der App (Standardwerte, Prüfung, Lesen, Schreiben).
// Dieses Modul hängt von nichts anderem im Projekt ab - main.js nutzt nur die unten exportierten Namen.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { createProfileStore } = require('./profiles');
const controllerMapping = require('./controller-mapping');

const userDataPath = app.getPath('userData');
const imagesDir = path.join(userDataPath, 'images'); // App-Symbole liegen für alle Profile gemeinsam hier (absolute Adressen)

// Profile (siehe profiles.js): Apps, Hintergrund, Bildschirmschoner, Uhr, Tabs und Musikplayer liegen im Ordner des aktiven
// Profils; Adblocker, Tastatur, Controller, Intro und der TMDb-Key gelten für alle Profile und bleiben im Datenordner selbst.
const profiles = createProfileStore({ userDataPath });
const profileFile = (name) => () => path.join(profiles.activeDir(), name);
const appsFilePath = profileFile('apps.json');
const bgSettingsFilePath = profileFile('background-settings.json');
const clockSettingsFilePath = profileFile('clock-settings.json');
const tabsSettingsFilePath = profileFile('tabs-settings.json');
const screensaverSettingsFilePath = profileFile('screensaver-settings.json');
const mediaPlayerSettingsFilePath = profileFile('media-player-settings.json');
const adblockerSettingsFilePath = path.join(userDataPath, 'adblocker-settings.json');
const keyboardSettingsFilePath = path.join(userDataPath, 'keyboard-settings.json');
const controllerSettingsFilePath = path.join(userDataPath, 'controller-settings.json');
const introSettingsFilePath = path.join(userDataPath, 'intro-settings.json');
const globalSettingsFilePath = path.join(userDataPath, 'global-settings.json'); // gilt für alle Profile (TMDb-Key)
const remoteSettingsFilePath = path.join(userDataPath, 'remote-settings.json'); // Fernbedienung per Handy: gilt für alle Profile
const taskbarSettingsFilePath = path.join(userDataPath, 'taskbar-settings.json'); // Windows-Taskleiste ausblenden: gilt für den Rechner, nicht je Profil
const adblockerEnginePath = path.join(userDataPath, 'adblocker-engine.bin');
const adblockerLogPath = path.join(userDataPath, 'adblocker-log.txt');
const adblockerEngineMetaPath = path.join(userDataPath, 'adblocker-engine.json'); // Stand der Filterlisten (wann, woher)

const defaultAdblockerSettings = {
  enabled: true, // Adblocker ist standardmäßig aktiv
  // Seiten, auf denen der Adblocker nichts blockiert (Hostname, gilt auch für Unterseiten und Subdomains)
  allowlist: ['disneyplus.com'],
  // Fehlersuche: blockierte und umgeleitete Anfragen in adblocker-log.txt im Datenordner protokollieren
  log: false,
  // Einzelne Schichten (zum Eingrenzen von Seitenfehlern abschaltbar): true = aktiv
  networkEnabled: true,  // Anfragen blockieren/umleiten
  headersEnabled: true,  // Content-Security-Policy-Regeln der Filterlisten
  stylesEnabled: true,   // Elemente ausblenden (CSS)
  scriptsEnabled: true,  // uBlock-Skripte (Scriptlets) in Seiten einsetzen
  scriptsStructural: true, // darunter die, die den Aufbau der Seite umbauen (Seitentext umschreiben, Timer verbiegen)
  // Einzelne Arten von uBlock-Skripten NICHT einsetzen (Namen stehen im Protokoll, z.B. "replaceNodeText")
  scriptsExclude: []
};
const SCRIPTS_EXCLUDE_MAX = 40;
const ALLOWLIST_MAX = 100;

// Macht aus einer Eingabe einen Hostnamen für die Ausnahmeliste: "https://www.DisneyPlus.com/home" -> "disneyplus.com".
// Gibt null zurück, wenn es keine brauchbare Adresse ist.
function normalizeAllowHost(input) {
  if (typeof input !== 'string') return null;
  let text = input.trim().toLowerCase();
  if (!text || text.length > 253) return null;
  if (text.includes('://')) {
    try { text = new URL(text).hostname; } catch (err) { return null; }
  }
  text = text.replace(/[/?#].*$/, '').replace(/:\d{1,5}$/, '').replace(/^www\./, '').replace(/\.$/, '');
  if (text === 'localhost') return text;
  return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(text) ? text : null;
}

// Bringt gelesene/übergebene Werte in einen gültigen Zustand. Alte Dateien (nur "enabled") bekommen die neuen
// Standardwerte; Schalter gelten nur als aus, wenn sie ausdrücklich false sind; die Ausnahmeliste wird bereinigt.
function normalizeAdblockerSettings(raw) {
  const s = { ...defaultAdblockerSettings, ...(raw || {}) };
  const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const list = Array.isArray(s.allowlist) ? s.allowlist : defaultAdblockerSettings.allowlist;
  const allowlist = [];
  for (const entry of list) {
    const host = normalizeAllowHost(entry);
    if (host && !allowlist.includes(host)) allowlist.push(host);
    if (allowlist.length >= ALLOWLIST_MAX) break;
  }
  const scriptsExclude = [];
  for (const name of Array.isArray(s.scriptsExclude) ? s.scriptsExclude : []) {
    if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,59}$/.test(name) && !scriptsExclude.includes(name)) scriptsExclude.push(name);
    if (scriptsExclude.length >= SCRIPTS_EXCLUDE_MAX) break;
  }
  return {
    enabled: flag(s.enabled, defaultAdblockerSettings.enabled),
    allowlist,
    scriptsExclude,
    log: flag(s.log, defaultAdblockerSettings.log),
    networkEnabled: flag(s.networkEnabled, true),
    headersEnabled: flag(s.headersEnabled, true),
    stylesEnabled: flag(s.stylesEnabled, true),
    scriptsEnabled: flag(s.scriptsEnabled, true),
    scriptsStructural: flag(s.scriptsStructural, true)
  };
}

const defaultKeyboardSettings = {
  ownEnabled: true,  // eigene Bildschirmtastatur (nur bei Controller-Nutzung), standardmäßig an
  osEnabled: false,  // Windows-Bildschirmtastatur per Taste "K" - optional, standardmäßig aus
  path: 'osk.exe'    // Pfad der Windows-Bildschirmtastatur (nur relevant, wenn osEnabled)
};

// Bringt gelesene Einstellungen in die aktuelle Form:
// - alte Dateien (nur "enabled") bekommen die neuen Standardwerte,
// - beide Tastaturen gleichzeitig sind nicht erlaubt (die eigene hat dann Vorrang).
function normalizeKeyboardSettings(raw) {
  const s = { ...defaultKeyboardSettings, ...(raw || {}) };
  delete s.enabled;
  s.ownEnabled = !!s.ownEnabled;
  s.osEnabled = !!s.osEnabled;
  if (s.ownEnabled && s.osEnabled) s.osEnabled = false;
  return s;
}

// Fernbedienung per Handy (remote-server.js): standardmäßig aus. Der Token steckt im QR-Code und wird beim ersten Einschalten erzeugt.
const REMOTE_PORT_DEFAULT = 8765;
const REMOTE_PORT_MIN = 1024;
const REMOTE_PORT_MAX = 65535;
// Touchfläche des Handys: Geschwindigkeiten in Prozent, Schwung (Nachlauf beim schnellen Wischen) mit Höchstzahl übersprungener Elemente
const REMOTE_TOUCH_DEFAULT = { pointerSpeed: 100, swipeSpeed: 100, momentum: true, momentumMax: 3 };
const REMOTE_TOUCH_LIMITS = { pointerSpeed: [30, 300], swipeSpeed: [50, 200], momentumMax: [1, 10] };
const defaultRemoteSettings = { enabled: false, port: REMOTE_PORT_DEFAULT, token: '', touch: { ...REMOTE_TOUCH_DEFAULT } };
function normalizeRemoteTouch(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const pick = (key) => {
    const [min, max] = REMOTE_TOUCH_LIMITS[key];
    const n = Math.round(Number(t[key]));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : REMOTE_TOUCH_DEFAULT[key];
  };
  return {
    pointerSpeed: pick('pointerSpeed'),
    swipeSpeed: pick('swipeSpeed'),
    momentum: typeof t.momentum === 'boolean' ? t.momentum : REMOTE_TOUCH_DEFAULT.momentum,
    momentumMax: pick('momentumMax')
  };
}
function normalizeRemotePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= REMOTE_PORT_MIN && port <= REMOTE_PORT_MAX ? port : null;
}
function normalizeRemoteSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: s.enabled === true,
    port: normalizeRemotePort(s.port) || REMOTE_PORT_DEFAULT,
    token: typeof s.token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(s.token) ? s.token : '',
    touch: normalizeRemoteTouch(s.touch)
  };
}

// Controller-Einstellungen. Beide Geschwindigkeiten sind Prozentwerte der jeweiligen Standard-
// geschwindigkeit (100 = wie bisher): cursorSpeed = Cursor in Apps, scrollSpeed = Scrollen mit LT/RT.
const SPEED_PERCENT_MIN = 30;
const SPEED_PERCENT_MAX = 300;
const defaultControllerSettings = {
  cursorSpeed: 100,
  scrollSpeed: 100,
  mapping: { ...controllerMapping.DEFAULT_MAPPING } // Tastenbelegung (siehe controller-mapping.js); Standard = bisherige feste Belegung
};

const defaultScreensaverSettings = {
  enabled: false,      // Bildschirmschoner ist standardmäßig aus
  mode: 'videos',      // 'videos' = Videos, 'images' = Bilder beliebter Filme (TMDb), 'none' = schwarzer Bildschirm
  delayMinutes: 5      // so lange ohne Eingabe, bis er einsetzt
};
// Intro beim Start des Launchers (videos/intro/intro.mp4): standardmäßig an; ohne Videodatei passiert nichts
const defaultIntroSettings = {
  enabled: true
};
function normalizeIntroSettings(raw) {
  const s = { ...defaultIntroSettings, ...(raw || {}) };
  return { enabled: s.enabled !== false };
}
// Musikplayer (Bild-in-Bild-Fenster): zuletzt benutzte Position und Größe (gilt nur, wenn der Nutzer das Fenster selbst
// verschoben oder in der Größe geändert hat: moved = true; sonst Standard: unten rechts). Gespeichert wird immer die Größe
// ohne Bildanzeige; ob das Bild gezeigt wird, gilt nur, solange der Player offen ist.
const MEDIA_PLAYER_DEFAULT_WIDTH = 300;
const MEDIA_PLAYER_DEFAULT_HEIGHT = 150;
const MEDIA_PLAYER_MIN_WIDTH = 240;
const MEDIA_PLAYER_MIN_HEIGHT = 120;
// Feste Plätze des Players: Zeile (oben/mitte/unten) und Seite (links/rechts); null = frei platziert bzw. Standard (unten rechts)
const MEDIA_PLAYER_POSITIONS = ['top-left', 'middle-left', 'bottom-left', 'top-right', 'middle-right', 'bottom-right'];

const defaultMediaPlayerSettings = {
  x: null,
  y: null,
  width: MEDIA_PLAYER_DEFAULT_WIDTH,
  height: MEDIA_PLAYER_DEFAULT_HEIGHT,
  moved: false,
  position: null
};

// Zahlen ganzzahlig und in sinnvollen Grenzen; Position nur, wenn beide Werte Zahlen sind
function normalizeMediaPlayerSettings(raw) {
  const s = { ...defaultMediaPlayerSettings, ...(raw || {}) };
  const num = (v) => ((v === null || v === '' || typeof v === 'boolean') ? NaN : Number(v));
  let w = num(s.width);
  let h = num(s.height);
  if (!Number.isFinite(w)) w = MEDIA_PLAYER_DEFAULT_WIDTH;
  if (!Number.isFinite(h)) h = MEDIA_PLAYER_DEFAULT_HEIGHT;
  const x = num(s.x);
  const y = num(s.y);
  const hasPos = Number.isFinite(x) && Number.isFinite(y);
  return {
    x: hasPos ? Math.round(Math.max(-20000, Math.min(20000, x))) : null,
    y: hasPos ? Math.round(Math.max(-20000, Math.min(20000, y))) : null,
    width: Math.round(Math.max(MEDIA_PLAYER_MIN_WIDTH, Math.min(8000, w))),
    height: Math.round(Math.max(MEDIA_PLAYER_MIN_HEIGHT, Math.min(8000, h))),
    moved: s.moved === true && hasPos,
    position: MEDIA_PLAYER_POSITIONS.includes(s.position) ? s.position : null
  };
}

const SCREENSAVER_MODES = ['videos', 'images', 'none'];
const SCREENSAVER_LEGACY_MODES = { nature: 'videos', black: 'none' }; // Namen älterer Einstellungsdateien
const SCREENSAVER_DELAY_MIN = 0.05; // = 3 Sekunden (die Einstellungsseite bietet nur feste Stufen an, kleine Werte sind für Tests)
const SCREENSAVER_DELAY_MAX = 600;  // = 10 Stunden

// Bringt gelesene/übergebene Werte in einen gültigen Zustand: Schalter nur true/false, Modus nur videos/images/none
// (die alten Namen nature/black werden übernommen), Wartezeit eine Zahl im erlaubten Bereich (alles andere fällt
// auf den Standard zurück).
function normalizeScreensaverSettings(raw) {
  const s = { ...defaultScreensaverSettings, ...(raw || {}) };
  s.enabled = s.enabled === true;
  if (typeof s.mode === 'string' && Object.prototype.hasOwnProperty.call(SCREENSAVER_LEGACY_MODES, s.mode)) {
    s.mode = SCREENSAVER_LEGACY_MODES[s.mode];
  }
  if (!SCREENSAVER_MODES.includes(s.mode)) s.mode = defaultScreensaverSettings.mode;
  let delay = (s.delayMinutes === null || s.delayMinutes === '' || typeof s.delayMinutes === 'boolean') ? NaN : Number(s.delayMinutes);
  if (!Number.isFinite(delay)) delay = defaultScreensaverSettings.delayMinutes;
  s.delayMinutes = Math.max(SCREENSAVER_DELAY_MIN, Math.min(SCREENSAVER_DELAY_MAX, Math.round(delay * 1000) / 1000));
  return { enabled: s.enabled, mode: s.mode, delayMinutes: s.delayMinutes };
}

// Macht aus einem beliebigen Wert einen gültigen Prozentwert (Zahl, ganzzahlig, im Wertebereich)
function normalizeSpeedPercent(value, fallback) {
  // null, leerer Text und Wahrheitswerte sind keine Angabe (Number(null) wäre sonst 0 = Minimum)
  let v = (value === null || value === '' || typeof value === 'boolean') ? NaN : Number(value);
  if (!Number.isFinite(v)) v = fallback;
  return Math.max(SPEED_PERCENT_MIN, Math.min(SPEED_PERCENT_MAX, Math.round(v)));
}

// Bringt gelesene/übergebene Werte in einen gültigen Zustand. Ältere Dateien ohne scrollSpeed
// bekommen den Standard.
function normalizeControllerSettings(raw) {
  const s = { ...defaultControllerSettings, ...(raw || {}) };
  s.cursorSpeed = normalizeSpeedPercent(s.cursorSpeed, defaultControllerSettings.cursorSpeed);
  s.scrollSpeed = normalizeSpeedPercent(s.scrollSpeed, defaultControllerSettings.scrollSpeed);
  s.mapping = controllerMapping.normalizeMapping(s.mapping);
  return s;
}

// Übernimmt Änderungen. Wer gerade eingeschaltet wird, schaltet die andere Tastatur aus.
function mergeKeyboardSettings(current, incoming) {
  const merged = { ...current, ...incoming };
  if (incoming && incoming.ownEnabled === true) merged.osEnabled = false;
  else if (incoming && incoming.osEnabled === true) merged.ownEnabled = false;
  return normalizeKeyboardSettings(merged);
}

const defaultClockSettings = {
  format: '24h',        // '24h' | '12h'
  timezone: 'auto',     // 'auto' (Systemzeitzone) oder IANA-Zeitzonenname, z.B. 'Europe/Berlin'
  showWeekday: true,
  weekdayFormat: 'long' // 'long' (Donnerstag) | 'short' (Do)
};

// Windows-Taskleiste: ausgeblendet wird sie nur, wenn der Nutzer es einschaltet (Einstellungen > System > Taskleiste)
const defaultTaskbarSettings = { hideTaskbar: false };
function normalizeTaskbarSettings(raw) {
  return { hideTaskbar: !!(raw && raw.hideTaskbar === true) };
}

const defaultTabsSettings = {
  keepPlayingInBackground: false, // Video im minimierten Zustand aktiv weiterlaufen lassen (statt natürlich zu pausieren)
  cardSize: 'large',              // 'large' | 'small'
  showLabel: true                 // Name zusätzlich zum Logo über der Karte anzeigen
};

const defaultBgSettings = {
  mode: 'static',              // 'static' | 'dynamic'
  staticImage: '',              // URL, file:// Pfad oder relativer Pfad - leer = einfacher schwarzer Hintergrund
  tmdbApiKey: '',              // eigener TMDb-API-Key (v3), Voraussetzung für dynamischen Hintergrund und TMDb-Suche
  dynamicFrequency: '6h',      // Schlüssel aus FREQUENCY_MS
  currentDynamicImage: null,   // zuletzt geladenes TMDb-Bild
  lastChanged: 0                // Zeitstempel des letzten Wechsels
};

// Diese Apps werden nur beim allerersten Start angelegt (apps.json existiert noch nicht).
// Danach übernimmt ausschließlich apps.json die Verwaltung.
const defaultApps = [
  { id: 'netflix', name: 'Netflix', url: 'https://www.netflix.com/de/', icon: 'img/icon/netflix.svg', bg: '', topshelf: 'cards', topshelfProvider: '8', dynamicBg: true, loadingStyle: 'bar' },
  { id: 'disney', name: 'Disney+', url: 'https://www.disneyplus.com/de-de', icon: 'img/icon/disney.svg', bg: '', topshelf: 'cards', topshelfProvider: '337', dynamicBg: true, loadingStyle: 'bar' },
  { id: 'paramount', name: 'Paramount+', url: 'https://www.paramountplus.com/de/', icon: 'img/icon/paramount.svg', bg: '', topshelf: 'cards', topshelfProvider: '531', dynamicBg: true, loadingStyle: 'bar' },
  { id: 'appletv', name: 'AppleTV', url: 'https://tv.apple.com/de', icon: 'img/icon/appletv.svg', bg: '', topshelf: 'cards', topshelfProvider: '350', dynamicBg: true, loadingStyle: 'bar' },
  { id: 'prime', name: 'Amazon Prime', url: 'https://www.primevideo.com/', icon: 'img/icon/prime.svg', bg: '', topshelf: 'cards', topshelfProvider: '119', dynamicBg: true, loadingStyle: 'bar' },
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/tv', tvMigrated: true, icon: 'img/icon/youtube.svg', bg: '', topshelf: 'off', topshelfProvider: '', dynamicBg: false, loadingStyle: 'bar' },
  { id: 'spotify', name: 'Spotify', url: 'https://open.spotify.com/', icon: 'img/icon/spotify.svg', bg: '', topshelf: 'off', topshelfProvider: '', dynamicBg: false, loadingStyle: 'bar' },
  { id: 'discord', name: 'Discord', url: 'https://discord.com/app', icon: 'img/icon/discord.svg', bg: '', topshelf: 'off', topshelfProvider: '', dynamicBg: false, loadingStyle: 'bar' },
  { id: 'browser', name: 'Browser', type: 'browser', url: 'https://www.google.com/', icon: 'img/icon/browser.svg', bg: '', topshelf: 'off', topshelfProvider: '', dynamicBg: false, loadingStyle: 'bar' }
];

function ensureStorage() {
  if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
  if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
  const appsFile = appsFilePath();
  if (!fs.existsSync(appsFile)) {
    fs.writeFileSync(appsFile, JSON.stringify(defaultApps, null, 2), 'utf-8');
  }
}

// Einmalige Umstellung: Der vorhandene YouTube-Eintrag (Adresse https://www.youtube.com/) zeigt jetzt auf YouTube TV
// (https://www.youtube.com/tv, Steuerung mit Controller und Handy). Die Markierung tvMigrated sorgt dafür, dass es nur einmal
// passiert - wer die normale Adresse später wieder einträgt, behält sie.
function migrateYoutubeTv(apps) {
  if (!Array.isArray(apps)) return false;
  let changed = false;
  for (const app of apps) {
    if (!app || app.id !== 'youtube' || app.tvMigrated) continue;
    app.tvMigrated = true;
    if (/^https:\/\/(www\.)?youtube\.com\/?$/i.test(String(app.url || '').trim())) app.url = 'https://www.youtube.com/tv';
    changed = true;
  }
  return changed;
}

// ---- Startseite: Apps und Ordner ----
// apps.json enthält die Einträge der Startseite in ihrer Reihenfolge: Apps und Ordner { type: 'folder', id, name, apps: [...] }.
// Ältere Dateien (nur Apps) sind damit gültig. Alle bisherigen Nutzer (Verwaltungsseite, Topshelf, Hintergründe ...) arbeiten mit
// der FLACHEN Liste aller Apps (readApps); nur die Startseite kennt die Ordner (readHomeItems).
const MAX_FOLDER_APPS = 9;

function isFolder(item) {
  return !!item && typeof item === 'object' && item.type === 'folder';
}

// Alle Apps in Anzeigereihenfolge, Ordner aufgelöst
function flattenItems(items) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (isFolder(item)) {
      for (const app of Array.isArray(item.apps) ? item.apps : []) if (app && typeof app === 'object' && !isFolder(app)) out.push(app);
    } else if (item && typeof item === 'object') {
      out.push(item);
    }
  }
  return out;
}

function newFolderId(taken) {
  let id;
  do { id = 'folder-' + Math.random().toString(36).slice(2, 8); } while (taken.has(id));
  return id;
}

// Bereinigt eine gelesene/gelieferte Liste: doppelte Ids entfernen, verschachtelte Ordner auflösen, leere Ordner entfernen,
// Ordner ohne Namen bekommen "Ordner", zu volle Ordner werden hinter dem Ordner fortgesetzt (Daten gehen nie verloren).
function normalizeItems(items) {
  const seenApps = new Set();
  const seenFolders = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (isFolder(item)) {
      const apps = [];
      for (const app of Array.isArray(item.apps) ? item.apps : []) {
        if (!app || typeof app !== 'object' || isFolder(app) || !app.id || seenApps.has(app.id)) continue;
        seenApps.add(app.id);
        apps.push(app);
      }
      if (!apps.length) continue;
      let id = typeof item.id === 'string' && item.id && !seenFolders.has(item.id) ? item.id : newFolderId(seenFolders);
      seenFolders.add(id);
      const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 40) : 'Ordner';
      out.push({ type: 'folder', id, name, apps: apps.slice(0, MAX_FOLDER_APPS) });
      for (const rest of apps.slice(MAX_FOLDER_APPS)) out.push(rest);
    } else if (item && typeof item === 'object' && item.id && !seenApps.has(item.id)) {
      seenApps.add(item.id);
      out.push(item);
    }
  }
  return out;
}

// Eine geänderte FLACHE Liste (Verwaltungsseite) in die bestehende Ordnerstruktur einarbeiten: Apps bleiben in ihrem Ordner,
// ein Ordner steht dort, wo seine erste App jetzt steht; neue Apps kommen als einzelne Einträge dazu, gelöschte verschwinden
// (leere Ordner ebenfalls).
function mergeFlatIntoItems(oldItems, flat) {
  const folderOf = new Map();
  const folderInfo = new Map();
  for (const item of Array.isArray(oldItems) ? oldItems : []) {
    if (!isFolder(item)) continue;
    folderInfo.set(item.id, item);
    for (const app of item.apps || []) if (app && app.id) folderOf.set(app.id, item.id);
  }
  const out = [];
  const created = new Map();
  for (const app of Array.isArray(flat) ? flat : []) {
    if (!app || typeof app !== 'object' || !app.id) continue;
    const fid = folderOf.get(app.id);
    if (!fid) { out.push(app); continue; }
    let folder = created.get(fid);
    if (!folder) {
      folder = { type: 'folder', id: fid, name: folderInfo.get(fid).name, apps: [] };
      created.set(fid, folder);
      out.push(folder);
    }
    folder.apps.push(app);
  }
  return normalizeItems(out);
}

function readHomeItems() {
  ensureStorage();
  try {
    const raw = fs.readFileSync(appsFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('apps.json ist keine Liste');
    const items = normalizeItems(parsed);
    if (migrateYoutubeTv(flattenItems(items))) {
      try { fs.writeFileSync(appsFilePath(), JSON.stringify(items, null, 2), 'utf-8'); } catch (err) { /* Umstellung gilt trotzdem für diesen Lauf */ }
    }
    return items;
  } catch (err) {
    console.error('Fehler beim Lesen von apps.json:', err);
    return defaultApps.map((a) => ({ ...a }));
  }
}

function writeHomeItems(items) {
  ensureStorage();
  fs.writeFileSync(appsFilePath(), JSON.stringify(normalizeItems(items), null, 2), 'utf-8');
}

// Flache Liste aller Apps (Ordner aufgelöst) - für alles außer der Startseite
function readApps() {
  return flattenItems(readHomeItems());
}

// Speichert eine FLACHE Liste (Verwaltungsseite); die Ordner der Startseite bleiben dabei erhalten
function writeApps(apps) {
  let old = [];
  try { old = readHomeItems(); } catch (err) { old = []; }
  writeHomeItems(mergeFlatIntoItems(old, apps));
}

// Gemeinsames Gerüst aller Einstellungsdateien (JSON im Datenordner):
//  - Fehlt die Datei, wird sie mit den Standardwerten angelegt.
//  - Gelesene Werte laufen durch normalize (Standardwerte ergänzen, ggf. prüfen/korrigieren).
//  - Ist die Datei kaputt, gelten die Standardwerte (normalize({})); die Datei bleibt dabei unverändert.
// Ohne eigenes normalize werden die Standardwerte einfach mit den gelesenen Werten zusammengeführt.
function createSettingsStore(filePathOrGetter, defaults, normalize = (raw) => ({ ...defaults, ...raw })) {
  // Der Pfad darf eine Funktion sein (Dateien des aktiven Profils: ändert sich beim Profilwechsel)
  const pathOf = typeof filePathOrGetter === 'function' ? filePathOrGetter : () => filePathOrGetter;
  return {
    read() {
      ensureStorage();
      const filePath = pathOf();
      const fileName = path.basename(filePath);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2), 'utf-8');
      }
      try {
        return normalize(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
      } catch (err) {
        console.error(`Fehler beim Lesen von ${fileName}:`, err);
        return normalize({});
      }
    },
    write(settings) {
      ensureStorage();
      fs.writeFileSync(pathOf(), JSON.stringify(settings, null, 2), 'utf-8');
    }
  };
}

// Der dynamische Hintergrund braucht einen hinterlegten API-Key - ohne Key gilt der statische Modus
function normalizeBgSettings(raw) {
  const merged = { ...defaultBgSettings, ...raw };
  if (merged.mode === 'dynamic' && !merged.tmdbApiKey) merged.mode = 'static';
  return merged;
}

// Der TMDb-Key gilt für alle Profile (Datei global-settings.json); der Rest der Hintergrund-Einstellungen gehört zum Profil.
// Nach außen bleibt es ein Objekt mit tmdbApiKey: lesen setzt den Key ein, schreiben legt ihn getrennt ab.
const globalStore = createSettingsStore(globalSettingsFilePath, { tmdbApiKey: '' });
const bgProfileStore = createSettingsStore(bgSettingsFilePath, { ...defaultBgSettings, tmdbApiKey: undefined }, (raw) => {
  const { tmdbApiKey: ignored, ...rest } = { ...defaultBgSettings, ...raw };
  return rest;
});

// Einmalig: ein bisher in der Hintergrund-Datei gespeicherter Key wird zum gemeinsamen Key (nur wenn noch keiner da ist)
function migrateGlobalKey() {
  try {
    const globalFile = globalSettingsFilePath;
    if (fs.existsSync(globalFile)) return;
    const legacy = path.join(userDataPath, 'background-settings.json');
    let key = '';
    if (fs.existsSync(legacy)) key = String(JSON.parse(fs.readFileSync(legacy, 'utf-8')).tmdbApiKey || '');
    fs.writeFileSync(globalFile, JSON.stringify({ tmdbApiKey: key }, null, 2), 'utf-8');
  } catch (err) {
    console.error('TMDb-Key konnte nicht übernommen werden:', err);
  }
}
migrateGlobalKey();

function readBgSettings() {
  const profileSettings = bgProfileStore.read();
  const { tmdbApiKey } = globalStore.read();
  return normalizeBgSettings({ ...profileSettings, tmdbApiKey: typeof tmdbApiKey === 'string' ? tmdbApiKey : '' });
}

function writeBgSettings(settings) {
  const { tmdbApiKey, ...rest } = settings || {};
  if (typeof tmdbApiKey === 'string') globalStore.write({ ...globalStore.read(), tmdbApiKey });
  bgProfileStore.write(rest);
}

const { read: readAdblockerSettings, write: writeAdblockerSettings } = createSettingsStore(adblockerSettingsFilePath, defaultAdblockerSettings, normalizeAdblockerSettings);
const { read: readKeyboardSettings, write: writeKeyboardSettings } = createSettingsStore(keyboardSettingsFilePath, defaultKeyboardSettings, normalizeKeyboardSettings);
const { read: readControllerSettings, write: writeControllerSettings } = createSettingsStore(controllerSettingsFilePath, defaultControllerSettings, normalizeControllerSettings);
const { read: readClockSettings, write: writeClockSettings } = createSettingsStore(clockSettingsFilePath, defaultClockSettings);
const { read: readTabsSettings, write: writeTabsSettings } = createSettingsStore(tabsSettingsFilePath, defaultTabsSettings);
const { read: readScreensaverSettings, write: writeScreensaverSettings } = createSettingsStore(screensaverSettingsFilePath, defaultScreensaverSettings, normalizeScreensaverSettings);
const { read: readTaskbarSettings, write: writeTaskbarSettings } = createSettingsStore(taskbarSettingsFilePath, defaultTaskbarSettings, normalizeTaskbarSettings);
const { read: readRemoteSettings, write: writeRemoteSettings } = createSettingsStore(remoteSettingsFilePath, defaultRemoteSettings, normalizeRemoteSettings);
const { read: readIntroSettings, write: writeIntroSettings } = createSettingsStore(introSettingsFilePath, defaultIntroSettings, normalizeIntroSettings);
const { read: readMediaPlayerSettings, write: writeMediaPlayerSettings } = createSettingsStore(mediaPlayerSettingsFilePath, defaultMediaPlayerSettings, normalizeMediaPlayerSettings);

module.exports = {
  // Profile (Ordner, Sitzungen, Wechsel): siehe profiles.js
  profiles,
  // Pfade
  imagesDir,
  adblockerEnginePath,
  // App-Liste
  readApps,
  writeApps,
  readHomeItems, writeHomeItems,
  flattenItems, normalizeItems, mergeFlatIntoItems, isFolder, MAX_FOLDER_APPS,
  // Einstellungen: je Speicher lesen/schreiben
  readBgSettings, writeBgSettings,
  readAdblockerSettings, writeAdblockerSettings,
  readKeyboardSettings, writeKeyboardSettings,
  readControllerSettings, writeControllerSettings,
  readClockSettings, writeClockSettings,
  readTabsSettings, writeTabsSettings,
  readTaskbarSettings, writeTaskbarSettings, normalizeTaskbarSettings,
  readScreensaverSettings, writeScreensaverSettings,
  readMediaPlayerSettings, writeMediaPlayerSettings,
  readIntroSettings, writeIntroSettings,
  readRemoteSettings, writeRemoteSettings, normalizeRemoteSettings, normalizeRemoteTouch, normalizeRemotePort, REMOTE_PORT_DEFAULT,
  // Prüf-/Zusammenführ-Funktionen, die auch die IPC-Handler in main.js brauchen
  normalizeControllerSettings,
  normalizeScreensaverSettings,
  normalizeMediaPlayerSettings,
  MEDIA_PLAYER_POSITIONS,
  normalizeIntroSettings,
  MEDIA_PLAYER_DEFAULT_WIDTH, MEDIA_PLAYER_DEFAULT_HEIGHT, MEDIA_PLAYER_MIN_WIDTH, MEDIA_PLAYER_MIN_HEIGHT,
  normalizeAdblockerSettings,
  normalizeAllowHost,
  adblockerLogPath,
  adblockerEngineMetaPath,
  mergeKeyboardSettings
};
