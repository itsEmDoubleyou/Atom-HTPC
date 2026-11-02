const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Navigation: Seiten öffnen (Reihenfolge wie LOADABLE_VIEWS in main.js), App starten, Programm beenden/neu starten
  loadApp: (payload) => ipcRenderer.send('load-app', payload), // payload: { id, name, url, icon, type, programPath, launchArgs, loadingStyle }
  launcherReady: (token) => ipcRenderer.send('launcher-ready', token), // Launcher meldet: Endzustand steht (siehe main.js, App verlassen)
  loadTopshelf: (appId) => ipcRenderer.send('load-topshelf', appId),
  loadSettings: () => ipcRenderer.send('load-settings'),
  loadManage: () => ipcRenderer.send('load-manage'),
  loadGeneral: () => ipcRenderer.send('load-general'),
  loadSystem: () => ipcRenderer.send('load-system'),
  loadServices: () => ipcRenderer.send('load-services'),
  loadRemote: () => ipcRenderer.send('load-remote'),
  // Fernbedienung per Handy (Einstellungsseite, Statussymbol der Startseite)
  getRemoteInfo: () => ipcRenderer.invoke('remote-get-info'),
  setRemoteEnabled: (enabled) => ipcRenderer.invoke('remote-set-enabled', enabled),
  setRemotePort: (port) => ipcRenderer.invoke('remote-set-port', port),
  renewRemoteToken: () => ipcRenderer.invoke('remote-renew-token'),
  getRemoteStatus: () => ipcRenderer.invoke('remote-get-status'),
  onRemoteStatus: (callback) => ipcRenderer.on('remote-status', (event, status) => callback(status)),
  setRemoteTouch: (touch) => ipcRenderer.invoke('remote-set-touch', touch),
  setTopshelfCardsActive: (active) => ipcRenderer.send('topshelf-cards-active', !!active),
  onRemoteInput: (callback) => ipcRenderer.on('remote-input', () => callback()),
  // Gesamtlautstärke (Gesamtregler im Mixer, Handy-Fernbedienung)
  getGlobalVolume: () => ipcRenderer.invoke('get-global-volume'),
  setGlobalVolume: (value) => ipcRenderer.send('set-global-volume', value),
  onGlobalVolumeChanged: (callback) => ipcRenderer.on('global-volume-changed', (event, value) => callback(value)),
  loadAdblocker: () => ipcRenderer.send('load-adblocker'),
  loadTime: () => ipcRenderer.send('load-time'),
  loadTabs: () => ipcRenderer.send('load-tabs'),
  loadStorage: () => ipcRenderer.send('load-storage'),
  loadTaskbar: () => ipcRenderer.send('load-taskbar'),
  getStorageInfo: () => ipcRenderer.invoke('storage-info'),
  clearStorageCache: () => ipcRenderer.invoke('storage-clear-cache'),
  clearStorageData: () => ipcRenderer.invoke('storage-clear-data'),
  resetStorageApp: (id) => ipcRenderer.invoke('storage-reset-app', id),
  reloadTmdbData: () => ipcRenderer.invoke('storage-reload-tmdb'),
  loadInputDevices: () => ipcRenderer.send('load-input-devices'),
  loadControllerSettings: () => ipcRenderer.send('load-controller-settings'),
  loadKeyboardSettings: () => ipcRenderer.send('load-keyboard-settings'),
  loadScreensaver: () => ipcRenderer.send('load-screensaver'),
  loadIntro: () => ipcRenderer.send('load-intro'),
  loadProfiles: () => ipcRenderer.send('load-profiles'),
  quitApp: () => ipcRenderer.send('quit-app'),
  restartApp: () => ipcRenderer.send('restart-app'),

  // Zurück-Taste und Fokus. Die Seite übernimmt Backspace selbst (z.B. geöffnetes Formular), statt "Zurück" auszulösen
  startScreensaver: () => ipcRenderer.send('screensaver-start-manual'),
  // Bildschirmschoner als Ebene in der Startseite (unter dem Schnellmenü): Startseite meldet sich als Gastgeber, bekommt Start/Ende
  // gemeldet, holt Bilder/Logos für den eingebetteten Rahmen und meldet das Aufwachen
  screensaverHostReady: () => ipcRenderer.send('screensaver-host-ready'),
  onScreensaverEmbedded: (callback) => ipcRenderer.on('screensaver-embedded', (event, state) => callback(state || {})),
  screensaverExit: () => ipcRenderer.send('screensaver-exit'),
  screensaverImages: () => ipcRenderer.invoke('screensaver-images'),
  screensaverLogo: (id) => ipcRenderer.invoke('screensaver-logo', id),
  setBackspaceCapture: (capture) => ipcRenderer.send('set-backspace-capture', !!capture),
  getLastFocusedElement: () => ipcRenderer.invoke('get-last-focused-element'),
  getLastLaunchedAppId: () => ipcRenderer.invoke('get-last-launched-app-id'),

  // Apps (Launcher und App-Verwaltung; Persistenz läuft über den Main-Prozess)
  getApps: () => ipcRenderer.invoke('get-apps'),
  saveApps: (apps) => ipcRenderer.invoke('save-apps', apps),
  getHomeItems: () => ipcRenderer.invoke('get-home-items'),
  saveHomeItems: (layout) => ipcRenderer.invoke('save-home-items', layout),
  deleteHomeApp: (appId) => ipcRenderer.invoke('delete-home-app', appId),
  selectImage: () => ipcRenderer.invoke('select-image'),
  selectProgram: () => ipcRenderer.invoke('select-program'),
  getTopshelfContent: (appId) => ipcRenderer.invoke('get-topshelf-content', appId),
  getDynamicAppBackground: (appId) => ipcRenderer.invoke('get-dynamic-app-background', appId),

  // App-Umschalter (Apps laufen minimiert im Hintergrund weiter)
  getRunningApps: () => ipcRenderer.invoke('get-running-apps'),
  switcherSelectApp: (id) => ipcRenderer.send('switcher-select-app', id),
  switcherCloseApp: (id) => ipcRenderer.send('switcher-close-app', id),
  switcherCancel: () => ipcRenderer.send('switcher-cancel'),

  // Lautstärkemixer
  setAppVolume: (id, volume) => ipcRenderer.send('set-app-volume', { id, volume }),
  setAppMuted: (id, muted) => ipcRenderer.send('set-app-muted', { id, muted }),
  getAppPlayingStates: () => ipcRenderer.invoke('get-app-playing-states'),
  toggleAppPlayback: (appId) => ipcRenderer.invoke('toggle-app-playback', appId),

  // Einstellungen: je Speicher get/save (Reihenfolge wie die Speicher in main.js)
  getBackgroundSettings: () => ipcRenderer.invoke('get-background-settings'),
  saveBackgroundSettings: (settings) => ipcRenderer.invoke('save-background-settings', settings),
  getAdblockerSettings: () => ipcRenderer.invoke('get-adblocker-settings'),
  saveAdblockerSettings: (settings) => ipcRenderer.invoke('save-adblocker-settings', settings),
  getAdblockerListsInfo: () => ipcRenderer.invoke('get-adblocker-lists-info'),
  refreshAdblockerLists: () => ipcRenderer.invoke('refresh-adblocker-lists'),
  getAdblockerLogPath: () => ipcRenderer.invoke('get-adblocker-log-path'),
  openAdblockerLogFolder: () => ipcRenderer.invoke('open-adblocker-log-folder'),
  getKeyboardSettings: () => ipcRenderer.invoke('get-keyboard-settings'),
  saveKeyboardSettings: (settings) => ipcRenderer.invoke('save-keyboard-settings', settings),
  getControllerSettings: () => ipcRenderer.invoke('get-controller-settings'),
  saveControllerSettings: (settings) => ipcRenderer.invoke('save-controller-settings', settings),
  // Tastenbelegung des Controllers (Einstellungen > Controller): Beschreibung, Taste zuweisen, zurücksetzen, Vorlage
  getControllerMappingInfo: () => ipcRenderer.invoke('get-controller-mapping-info'),
  setControllerButton: (action, button) => ipcRenderer.invoke('set-controller-button', { action, button }),
  resetControllerAction: (action) => ipcRenderer.invoke('reset-controller-action', action),
  applyControllerPreset: (id) => ipcRenderer.invoke('apply-controller-preset', id),
  // Beim Belegen soll die gedrückte Taste nichts auslösen (kein Zurück, kein Umschalter ...): die Seite liest den Controller dann selbst
  setControllerCapture: (on) => { padCapture = !!on; },
  getClockSettings: () => ipcRenderer.invoke('get-clock-settings'),
  saveClockSettings: (settings) => ipcRenderer.invoke('save-clock-settings', settings),
  getScreensaverSettings: () => ipcRenderer.invoke('get-screensaver-settings'),
  saveScreensaverSettings: (settings) => ipcRenderer.invoke('save-screensaver-settings', settings),
  startScreensaverPreview: () => ipcRenderer.send('screensaver-preview'),
  getIntroSettings: () => ipcRenderer.invoke('get-intro-settings'),
  saveIntroSettings: (settings) => ipcRenderer.invoke('save-intro-settings', settings),
  getIntroAvailable: () => ipcRenderer.invoke('get-intro-available'),
  startIntroPreview: () => ipcRenderer.send('intro-preview'),
  // Musikplayer (Schnellmenü): gibt es etwas zu steuern? / Player umschalten (liefert, ob er danach offen ist)
  // Schnellmenü, Medien-Modus: Stand der Wiedergabe abonnieren (solange das Menü offen ist) und steuern
  startMediaQuick: () => ipcRenderer.send('media-quick-start'),
  stopMediaQuick: () => ipcRenderer.send('media-quick-stop'),
  mediaQuickControl: (action, value) => ipcRenderer.send('media-quick-control', { action, value }), // 'toggle' | 'prev' | 'next' | 'seek'
  onMediaQuickState: (callback) => ipcRenderer.on('media-quick-state', (event, state) => callback(state)),
  getTaskbarSettings: () => ipcRenderer.invoke('get-taskbar-settings'),
  saveTaskbarSettings: (settings) => ipcRenderer.invoke('save-taskbar-settings', settings),
  getTabsSettings: () => ipcRenderer.invoke('get-tabs-settings'),
  saveTabsSettings: (settings) => ipcRenderer.invoke('save-tabs-settings', settings),

  // Hintergrundbild und TMDb
  searchTmdb: (query) => ipcRenderer.invoke('search-tmdb', query),
  saveTmdbKey: (key) => ipcRenderer.invoke('save-tmdb-key', key),

  // Ereignisse vom Hauptprozess: wird aufgerufen, wenn automatisch ein neues dynamisches Hintergrundbild geladen wurde

  // Profile: Liste und aktives Profil, wechseln (Schnellmenü, Profilauswahl), verwalten (Einstellungen)
  getProfiles: () => ipcRenderer.invoke('get-profiles'),
  switchProfile: (id) => ipcRenderer.send('switch-profile', id),
  createProfile: () => ipcRenderer.invoke('create-profile'),
  updateProfile: (data) => ipcRenderer.invoke('update-profile', data), // { id, name, color }
  deleteProfile: (id) => ipcRenderer.invoke('delete-profile', id),
  setProfileStartup: (mode) => ipcRenderer.invoke('set-profile-startup', mode), // 'last' | 'choose'

  // Netzwerkstatus für die Anzeige im Schnellmenü: { type: 'lan' | 'wifi' | 'none', level: 0-3 } oder null (noch unbekannt)
  getNetworkStatus: () => ipcRenderer.invoke('get-network-status'),
  onNetworkStatus: (callback) => ipcRenderer.on('network-status', (event, status) => callback(status))
});

// Meldet dem Hauptprozess, ob gerade ein Eingabefeld fokussiert ist, damit die
// globale Backspace-Navigation ("zurück") beim Tippen/Löschen in Textfeldern
// nicht dazwischenfunkt. Läuft auf jeder Seite, da preload.js überall geladen wird.
// Nur Elemente, in denen Backspace Text löscht. Checkboxen, Buttons und Dropdowns
// zählen bewusst nicht dazu - dort soll Backspace weiterhin "Zurück" auslösen.
const TEXT_INPUT_TYPES = ['text', 'search', 'url', 'email', 'password', 'number', 'tel'];

function isEditableElement(el) {
  if (!el) return false;
  // Die eigene Bildschirmtastatur (virtual-keyboard.js) zählt mit: Solange der Fokus
  // auf einer ihrer Tasten liegt, soll B/Backspace nicht als "Seite zurück" wirken.
  if (el.closest && el.closest('#osk-container')) return true;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return TEXT_INPUT_TYPES.includes((el.type || 'text').toLowerCase());
  return false;
}

window.addEventListener('focusin', (e) => {
  if (isEditableElement(e.target)) {
    ipcRenderer.send('input-focus-changed', true);
  }
  if (e.target && e.target.id) {
    ipcRenderer.send('element-focus-changed', e.target.id);
  }
});

window.addEventListener('focusout', (e) => {
  if (isEditableElement(e.target)) {
    ipcRenderer.send('input-focus-changed', false);
  }
});

// Cursor ausblenden, sobald die Tastatur genutzt wird, und erst bei echter
// Mausbewegung wieder einblenden. Technik: ein unsichtbares Overlay über dem
// ganzen Bildschirm, das im Tastatur-Modus selbst den Mauszeiger "einfängt"
// (cursor:none + pointer-events:auto) - dadurch verschwindet der Zeiger
// zuverlässig überall, UND darunterliegende Elemente bekommen keine
// Maus-Events mehr ab, ohne dass "pointer-events:none" auf dem body nötig
// wäre (das würde sonst verhindern, dass überhaupt irgendein Element den
// Zeiger für cursor:none beanspruchen kann, und der System-Pfeil bliebe sichtbar).
// Listener hängen sofort (nicht erst nach DOMContentLoaded), damit auch ein
// sehr früher Tastendruck direkt nach dem Laden einer Seite sofort greift.
let cursorHidden = false;
let cursorOverlayEl = null;

function ensureCursorOverlay() {
  if (cursorOverlayEl || !document.body) return;
  cursorOverlayEl = document.createElement('div');
  cursorOverlayEl.id = 'keyboard-mode-cursor-overlay';
  Object.assign(cursorOverlayEl.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647', // maximal möglicher z-index, muss über allem anderen liegen
    cursor: 'none',
    pointerEvents: 'none',
    background: 'transparent'
  });
  document.body.appendChild(cursorOverlayEl);
}

function setCursorHidden(hidden) {
  if (cursorHidden === hidden) return;
  cursorHidden = hidden;
  ensureCursorOverlay();
  if (cursorOverlayEl) {
    cursorOverlayEl.style.pointerEvents = hidden ? 'auto' : 'none';
  }
}

window.addEventListener('DOMContentLoaded', ensureCursorOverlay);

window.addEventListener('keydown', () => setCursorHidden(true), true);
window.addEventListener('mousemove', () => setCursorHidden(false), true);

// ---------- Controller-Steuerung ----------
// Übersetzt Gamepad-Eingaben in dieselben Signale, die die App schon für
// Tastatur verarbeitet - Pfeiltasten/Enter laufen als simulierte DOM-
// KeyboardEvents (werden von der jeweiligen Seite selbst verarbeitet, z.B.
// die Navigation in script.js), Backspace/Escape/"A" gehalten/"P" laufen
// ausschließlich im Hauptprozess und werden deshalb per IPC an die dortige
// (bereits vorhandene) Tastenlogik weitergereicht - keine doppelte Logik.
const GAMEPAD_REPEAT_DELAY_MS = 450;    // Zeit bis die Wiederholung einsetzt (wie Tastatur-Wiederholung des Systems)
const GAMEPAD_REPEAT_INTERVAL_MS = 120; // Wiederholungsrate währenddessen
const GAMEPAD_DEADZONE = 0.5;
const GAMEPAD_DOM_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Backspace', 'GamepadQuickMenu', 'GamepadAppMenu']);
const GAMEPAD_MAIN_PROCESS_KEYS = new Set(['Backspace', 'Escape', 'KeyA', 'KeyP', 'KeyM']);

// Musikplayer: solange er offen ist, gehören Steuerkreuz/Stick und A ihm statt der Seite
let mediaPlayerOpen = false;
ipcRenderer.on('media-player-open', (event, open) => { mediaPlayerOpen = !!open; });
ipcRenderer.invoke('media-player-is-open').then((open) => { mediaPlayerOpen = !!open; }).catch(() => {});
let padXHeld = false; // X-Taste gehalten: Steuerkreuz verschiebt den offenen Musikplayer (feste Plätze) statt ihn zu bedienen
const MEDIA_PLAYER_PAD_KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'activate' };

const GAMEPAD_REPEATABLE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

// Tastenbelegung (Einstellungen > Controller): welche Taste welche Aktion auslöst. Sie kommt beim Laden synchron vom Hauptprozess
// (Standard = bisherige feste Belegung); Änderungen kommen über 'controller-settings-changed'.
const DEFAULT_PAD = { confirm: 0, back: 1, quickMenu: null, switcher: 5, pip: 4, musicPlayer: 11, cursor: 10, keyboard: 3, extra: 2 };
let PAD = DEFAULT_PAD;
try {
  const loaded = ipcRenderer.sendSync('get-controller-mapping');
  if (loaded && typeof loaded === 'object') PAD = { ...DEFAULT_PAD, ...loaded };
} catch (err) { /* ohne Antwort gilt der Standard */ }
let padCapture = false; // die Einstellungsseite liest die Taste beim Belegen selbst: hier solange nichts auslösen

function padPressed(gp, button) {
  return button !== null && button !== undefined && !!(gp && gp.buttons[button] && gp.buttons[button].pressed);
}

// Notausstieg: Select + Start 3 Sekunden gehalten setzt die Belegung auf Standard zurück
const PAD_RESET_HOLD_MS = 3000;
let padResetSince = 0;
let padResetDone = false;
function checkPadResetCombo(gp) {
  if (padPressed(gp, 8) && padPressed(gp, 9)) {
    const now = Date.now();
    if (!padResetSince) padResetSince = now;
    if (!padResetDone && now - padResetSince >= PAD_RESET_HOLD_MS) {
      padResetDone = true;
      ipcRenderer.send('controller-mapping-reset');
    }
  } else {
    padResetSince = 0;
    padResetDone = false;
  }
}

// Alle simulierten Tasten (Taste -> gedrückt) aus dem Zustand des Controllers
function readPadKeys(gp) {
  const stickX = gp.axes[0] || 0;
  const stickY = gp.axes[1] || 0;
  return {
    ArrowUp: padPressed(gp, 12) || stickY < -GAMEPAD_DEADZONE,
    ArrowDown: padPressed(gp, 13) || stickY > GAMEPAD_DEADZONE,
    ArrowLeft: padPressed(gp, 14) || stickX < -GAMEPAD_DEADZONE,
    ArrowRight: padPressed(gp, 15) || stickX > GAMEPAD_DEADZONE,
    Enter: padPressed(gp, PAD.confirm),                 // auswählen, gehalten -> App-Menü (Logik in script.js/home-folders.js)
    Backspace: padPressed(gp, PAD.back),                // zurück
    KeyA: padPressed(gp, PAD.switcher),                 // gehalten -> Umschalter
    KeyP: padPressed(gp, PAD.pip),                      // Bild-in-Bild
    KeyM: padPressed(gp, PAD.musicPlayer),              // Musikplayer
    GamepadQuickMenu: padPressed(gp, PAD.quickMenu)     // Schnellmenü direkt (nur wenn belegt)
  };
}

const gamepadKeyState = {};

// Bildschirmschoner in der Startseite: jede Taste und jeder Stick, die sonst nichts Eigenes bedeuten (alles außer Steuerkreuz und den
// Tasten, die als eigene simulierte Taste ankommen; dazu der rechte Stick), melden sich als 'GamepadWake' und wecken ihn auf.
let embeddedWakePressed = false;
function updateEmbeddedWakeKey(gp) {
  let pressed = false;
  if (screensaverEmbedded && !screensaverActive && gp && !padCapture) {
    gp.buttons.forEach((b, i) => {
      if (!b || !b.pressed) return;
      if (i >= 12 && i <= 15) return;               // Steuerkreuz: vor/zurück, Info
      // Belegte Tasten melden sich über ihre eigene simulierte Taste (Bestätigen: Halten öffnet das App-Menü; Zurück, Umschalter,
      // Bild-in-Bild, Musikplayer wecken über ihre Taste, aber nicht mehr, wenn sie gerade das Menü schließen)
      if (i === PAD.confirm || i === PAD.back || i === PAD.quickMenu || i === PAD.switcher || i === PAD.pip || i === PAD.musicPlayer) return;
      pressed = true;
    });
    if (Math.abs(gp.axes[2] || 0) > GAMEPAD_DEADZONE || Math.abs(gp.axes[3] || 0) > GAMEPAD_DEADZONE) pressed = true; // rechter Stick
  }
  if (pressed === embeddedWakePressed) return;
  embeddedWakePressed = pressed;
  dispatchSyntheticKey(pressed ? 'keydown' : 'keyup', 'GamepadWake');
}

// ---------- Aktivität melden (für den Bildschirmschoner) ----------
// Der Hauptprozess startet den Bildschirmschoner nach einer Weile ohne Aktivität. Gemeldet werden Tastatur, Maus
// und jede Controller-Taste bzw. jeder bewegte Stick - höchstens einmal pro Sekunde. Eine neu geladene Seite zählt
// ebenfalls (Seitenwechsel, Rückkehr aus einer App). Während der Bildschirmschoner läuft, ist diese Seite stumm.
let screensaverActive = false;
let lastActivityReport = 0;
ipcRenderer.on('screensaver-state', (event, active) => { screensaverActive = !!active; });
// Läuft der Bildschirmschoner als Ebene IN der Startseite (siehe script.js), gehören ihr die Eingaben nicht per Sperre: die Seite
// bekommt alle Controller-Tasten als simulierte Tasten (Aufwecken, Schnellmenü, vor/zurück) - an den Hauptprozess geht nichts
let screensaverEmbedded = false;
ipcRenderer.on('screensaver-embedded', (event, state) => { screensaverEmbedded = !!(state && state.active); });
// Das Intro beim Start liegt wie der Bildschirmschoner über dem Launcher und sperrt dessen Eingaben (Controller); die Seite
// lädt meist erst, nachdem es begonnen hat, und fragt deshalb einmal nach
ipcRenderer.invoke('intro-is-active').then((active) => { if (active) screensaverActive = true; }).catch(() => {});

function noteUserActivity(force) {
  if (screensaverActive) return;
  const now = Date.now();
  if (!force && now - lastActivityReport < 1000) return;
  lastActivityReport = now;
  ipcRenderer.send('user-activity');
}
['keydown', 'mousedown', 'mousemove', 'wheel', 'touchstart'].forEach((type) => {
  window.addEventListener(type, () => noteUserActivity(false), { capture: true, passive: true });
});
noteUserActivity(true);

function dispatchSyntheticKey(type, code, isRepeat) {
  try {
    // Wiederholungen nur für den eingebetteten Bildschirmschoner kennzeichnen (dort löst nur der erste Druck etwas aus);
    // sonst bleibt alles wie es war
    window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true, repeat: screensaverEmbedded && !!isRepeat }));
  } catch (err) {
    // ignorieren
  }
}

function fireGamepadKeyEvent(code, type, isRepeat) {
  if (screensaverActive) return; // hinter dem Bildschirmschoner löst der Controller nichts aus
  if (screensaverEmbedded) {
    // Bildschirmschoner in der Startseite: alle Tasten gehen als simulierte Tasten an die Seite (auch die, die sonst an den
    // Hauptprozess gingen: für die Seite sind sie "irgendeine Taste = aufwecken")
    dispatchSyntheticKey(type, code, isRepeat);
    return;
  }
  if (mediaPlayerOpen && MEDIA_PLAYER_PAD_KEYS[code]) {
    // Offener Player: die Seite bekommt nichts davon; Richtungen wiederholen sich beim Halten (Springen auf dem Balken)
    if (padXHeld) { // X gehalten: Platz des Players wählen (nur beim Drücken, ohne Wiederholung; A tut dabei nichts)
      if (type === 'keydown' && !isRepeat && code !== 'Enter') ipcRenderer.send('media-player-pad', { action: 'place-' + MEDIA_PLAYER_PAD_KEYS[code], repeat: false });
      return;
    }
    if (type === 'keydown') ipcRenderer.send('media-player-pad', { action: MEDIA_PLAYER_PAD_KEYS[code], repeat: !!isRepeat });
    return;
  }
  if (GAMEPAD_DOM_KEYS.has(code)) dispatchSyntheticKey(type, code);
  if (GAMEPAD_MAIN_PROCESS_KEYS.has(code)) {
    ipcRenderer.send('gamepad-input', { code, type: type === 'keydown' ? 'keyDown' : 'keyUp' });
  }
}

// Handy-Fernbedienung: Tasten des Handys kommen wie Controller-Tasten an (gleiche Behandlung: Seite bekommt die simulierte Taste,
// Zurück usw. gehen zusätzlich an den Hauptprozess). Nur eine feste Auswahl; Tasten-Wiederholung gibt es nicht (jeder Wisch ist ein Druck).
const REMOTE_PAD_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Backspace', 'GamepadQuickMenu', 'GamepadWake', 'GamepadAppMenu']);
ipcRenderer.on('remote-key', (event, msg) => {
  if (!msg || !REMOTE_PAD_KEYS.has(msg.code) || (msg.type !== 'down' && msg.type !== 'up')) return;
  noteUserActivity(true);
  fireGamepadKeyEvent(msg.code, msg.type === 'down' ? 'keydown' : 'keyup');
});

function setGamepadKeyPressed(code, pressed) {
  const state = gamepadKeyState[code] || (gamepadKeyState[code] = { pressed: false, initialTimer: null, repeatTimer: null });
  if (pressed === state.pressed) return;
  state.pressed = pressed;

  if (pressed) {
    fireGamepadKeyEvent(code, 'keydown');
    if (GAMEPAD_REPEATABLE_KEYS.has(code)) {
      state.initialTimer = setTimeout(() => {
        state.repeatTimer = setInterval(() => fireGamepadKeyEvent(code, 'keydown', true), GAMEPAD_REPEAT_INTERVAL_MS);
      }, GAMEPAD_REPEAT_DELAY_MS);
    }
  } else {
    if (state.initialTimer) clearTimeout(state.initialTimer);
    if (state.repeatTimer) clearInterval(state.repeatTimer);
    fireGamepadKeyEvent(code, 'keyup');
  }
}

// Controller benutzt (Taste gedrückt oder Stick bewegt): der Hauptprozess blendet den Mauszeiger (Pfeil) überall aus, bis die echte Maus
// bewegt wird (pointer-hider.js). Gemeldet wird höchstens alle 300 ms.
let lastPadUseReport = 0;
function notePadUse(gp) {
  if (!gp) return;
  const used = gp.buttons.some((b) => b && b.pressed) || gp.axes.some((a) => Math.abs(a) > GAMEPAD_DEADZONE);
  if (!used) return;
  const now = Date.now();
  if (now - lastPadUseReport < 300) return;
  lastPadUseReport = now;
  ipcRenderer.send('pad-used');
}

function pollGamepadForInput() {
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = Array.from(gamepads).find(g => g);
  notePadUse(gp);

  if (padCapture) {
    // Tasten werden gerade belegt: nichts auslösen, aber den Stand mitführen (die zuletzt gedrückte Taste löst danach nichts aus)
    syncGamepadStateSilently();
    padXHeld = false;
    requestAnimationFrame(pollGamepadForInput);
    return;
  }

  padXHeld = padPressed(gp, PAD.extra);
  if (gp) {
    if (gp.buttons.some(b => b && b.pressed) || gp.axes.some(a => Math.abs(a) > 0.3)) noteUserActivity(false);
    checkPadResetCombo(gp);
    const keys = readPadKeys(gp);
    Object.keys(keys).forEach((code) => setGamepadKeyPressed(code, keys[code]));
    updateEmbeddedWakeKey(gp);
  } else {
    updateEmbeddedWakeKey(null);
    // Kein Controller (mehr) verbunden - alle noch "gedrückten" simulierten Tasten sauber loslassen
    Object.keys(gamepadKeyState).forEach(code => setGamepadKeyPressed(code, false));
  }

  requestAnimationFrame(pollGamepadForInput);
}

// Liest den aktuellen Controller-Zustand aus und schreibt ihn DIREKT in
// gamepadKeyState, OHNE über setGamepadKeyPressed zu gehen (löst also keine
// Events aus).
function syncGamepadStateSilently() {
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = Array.from(gamepads).find(g => g);
  if (!gp) return;

  const current = readPadKeys(gp);
  Object.keys(current).forEach(code => {
    gamepadKeyState[code] = { pressed: current[code], initialTimer: null, repeatTimer: null };
  });
}

// Ändert sich die Belegung (Einstellungsseite, Notausstieg), gilt sie sofort; eine dabei gehaltene Taste löst nichts aus
ipcRenderer.on('controller-settings-changed', (event, settings) => {
  if (!settings || !settings.mapping) return;
  PAD = { ...DEFAULT_PAD, ...settings.mapping };
  syncGamepadStateSilently();
});

// Beim Laden einer neuen Seite den Zustand aus der tatsächlichen Controller-
// Stellung übernehmen, OHNE dabei Events auszulösen - sonst würde eine beim
// Seitenwechsel noch gehaltene Taste auf der neu geladenen Seite fälschlich
// wie ein frischer Tastendruck aussehen. Eine einzelne Prüfung direkt beim
// Laden reicht dafür nicht zuverlässig: Chromes Gamepad-API liefert auf einer
// brandneuen Seite teils noch veraltete/leere Daten, bis mindestens ein Frame
// vergangen ist - deshalb eine kurze "Aufwärmphase" (mehrere Frames lang nur
// synchronisieren, nicht auslösen), bevor die normale Abfrage startet.
const GAMEPAD_WARMUP_FRAMES = 10;
let warmupFramesLeft = GAMEPAD_WARMUP_FRAMES;

function warmupThenPoll() {
  syncGamepadStateSilently();
  warmupFramesLeft--;
  if (warmupFramesLeft > 0) {
    requestAnimationFrame(warmupThenPoll);
  } else {
    requestAnimationFrame(pollGamepadForInput);
  }
}

warmupThenPoll();
