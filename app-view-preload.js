const { ipcRenderer, webFrame } = require('electron');

// YouTube TV (Ansicht mit --medialauncher-tv-app, siehe createAppView in main.js): Der Controller bedient die Seite hier über
// Tastendrücke (Steuerkreuz/linker Stick = Pfeile, A = Enter, X = Wiedergabe/Pause). Der Mauszeiger (L3) geht trotzdem: ist er an,
// bewegt der linke Stick ihn und A klickt (das Steuerkreuz und X bleiben Tasten). Damit nichts doppelt ankommt, sieht die Seite
// selbst keine Controller.
const TV_MODE = process.argv.includes('--medialauncher-tv-app');
if (TV_MODE) {
  try {
    webFrame.executeJavaScript("try { Object.defineProperty(Navigator.prototype, 'getGamepads', { value: function () { return []; }, configurable: true, writable: true }); } catch (e) {}");
  } catch (err) { /* ohne diese Sperre kann die Seite den Controller zusätzlich selbst lesen */ }
}

// ---------- Medien-Haken für den Musikplayer ----------
// Läuft beim Start jeder Seite im Seitenkontext, noch vor dem ersten Skript der Seite: merkt sich (1) das zuletzt
// gestartete Audio-/Video-Element (Ereignis 'play' bzw. Aufruf von play()) und (2) die Media-Session-Handler (Zurück/Weiter), die die Seite anmeldet. Beides
// liest media-player-service.js später über window.__launcherMediaHook. Spätere Anmeldungen der Seite sieht man nicht
// nachträglich, deshalb muss das hier ganz am Anfang passieren.
if (location.protocol === 'http:' || location.protocol === 'https:') {
  try {
    webFrame.executeJavaScript(`(function () {
      try {
        if (window.__launcherMediaHook) return;
        var S = { last: null, lastAt: 0, handlers: {} };
        Object.defineProperty(window, '__launcherMediaHook', { value: S, enumerable: false, configurable: false, writable: false });
        var note = function (e) {
          var t = e && e.target;
          if (t && t instanceof HTMLMediaElement && !t.muted) { S.last = t; S.lastAt = Date.now(); }
        };
        document.addEventListener('play', note, true);
        document.addEventListener('playing', note, true);
        // Audio-Objekte, die nicht im Dokument hängen (new Audio()), melden ihre Ereignisse nicht an document
        // weiter - deshalb zusätzlich play() selbst mitlesen
        var origPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
          try { if (!this.muted) { S.last = this; S.lastAt = Date.now(); } } catch (e) {}
          return origPlay.apply(this, arguments);
        };
        var ms = navigator.mediaSession;
        if (ms && typeof ms.setActionHandler === 'function') {
          var orig = ms.setActionHandler.bind(ms);
          ms.setActionHandler = function (action, handler) {
            try {
              if (typeof handler === 'function') S.handlers[action] = handler; else delete S.handlers[action];
            } catch (e) {}
            return orig(action, handler);
          };
        }
      } catch (e) {}
    })();`).catch(() => {});
  } catch (err) {
    // Seite ohne Haken laden: der Player kann dann nur Play/Pause und Springen
  }
}

// ---------- Musikplayer: Zustand und Eingaben ----------
// Solange der Player offen ist, gehören Steuerkreuz links/rechts und A ihm (nicht der App bzw. dem Cursor-Klick).
let mediaPlayerOpen = false;
ipcRenderer.on('media-player-open', (event, open) => { mediaPlayerOpen = !!open; });
ipcRenderer.invoke('media-player-is-open').then((open) => { mediaPlayerOpen = !!open; }).catch(() => {});


// Preload für App-Views (externe Seiten wie Netflix/YouTube). Bewusst NICHT das volle
// preload.js mit electronAPI: Die Seite bekommt keinen Zugriff auf unsere IPC-Kanäle -
// hier wird nichts per contextBridge freigegeben, alle Kanäle bleiben im Preload.
//
// Aufgaben (jeweils in einem eigenen Abschnitt, in dieser Reihenfolge):
//   1. Fokus-Tracking: meldet, ob gerade in einem Textfeld getippt wird, damit Backspace
//      dort ein Zeichen löscht, statt "Zurück" auszulösen bzw. die App zu minimieren.
//   2. Controller-Steuerung: gibt die für den Hauptprozess relevanten Tasten weiter:
//      B = Backspace (minimieren), rechte Schulter = Taste A (gehalten: Umschalter),
//      linke Schulter = Taste P (Bild-in-Bild).
//   3. Controller-Mauszeiger (L3 schaltet ihn ein/aus; in YouTube TV ist das Steuerkreuz zusätzlich Pfeiltasten).
//   4. Scrollen mit den Triggern (RT = runter, LT = hoch).
//   5. Bildschirmtastatur in Apps.
//   6. Browser-Leiste (nur in Apps vom Typ "browser", siehe Abschnitt am Dateiende).
//
// Alles steht bewusst in EINER Datei: Ein Preload in der Sandbox (Electron-Standard) kann
// keine eigenen Dateien per require laden. Deshalb sind auch isEditableElement &
// Layout-Tabelle hier und in preload.js bzw. virtual-keyboard.js doppelt vorhanden.
const TEXT_INPUT_TYPES = ['text', 'search', 'url', 'email', 'password', 'number', 'tel'];

// Browser-Leiste (Abschnitt am Dateiende): Host-Element und geschlossener Shadow-Bereich. Hier oben deklariert,
// weil deepActiveElement() und deepElementFromPoint() sie mitfragen.
let barHost = null;
let barRoot = null;

function isEditableElement(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return TEXT_INPUT_TYPES.includes((el.type || 'text').toLowerCase());
  return false;
}

// Bei Feldern innerhalb eines Shadow-DOMs zeigt e.target am Fenster nur den "Host" -
// das tatsächliche Feld steht vorne im composedPath().
function focusTargetOf(e) {
  const path = e.composedPath ? e.composedPath() : null;
  return (path && path[0]) || e.target;
}

window.addEventListener('focusin', (e) => {
  if (isEditableElement(focusTargetOf(e))) {
    ipcRenderer.send('input-focus-changed', true);
  }
});

window.addEventListener('focusout', (e) => {
  if (isEditableElement(focusTargetOf(e))) {
    ipcRenderer.send('input-focus-changed', false);
  }
});

// ---------- Controller-Steuerung (nur die Hauptprozess-relevanten Tasten) ----------
// Innerhalb einer App soll der Controller nicht die App-eigene Oberfläche
// steuern (das macht die App selbst) - aber Backspace (minimieren), "A"
// gehalten (Umschalter) und "P" (Bild-in-Bild) sollen trotzdem funktionieren,
// genau wie bei echter Tastatur.
// Tastenbelegung (Einstellungen > Controller): welche Taste welche Aktion auslöst. Sie kommt beim Laden synchron vom Hauptprozess
// (Standard = bisherige feste Belegung); Änderungen kommen über 'controller-settings-changed' (siehe applyControllerSettings).
const DEFAULT_PAD = { confirm: 0, back: 1, quickMenu: null, switcher: 5, pip: 4, musicPlayer: 11, cursor: 10, keyboard: 3, extra: 2 };
let PAD = DEFAULT_PAD;
try {
  const loaded = ipcRenderer.sendSync('get-controller-mapping');
  if (loaded && typeof loaded === 'object') PAD = { ...DEFAULT_PAD, ...loaded };
} catch (err) { /* ohne Antwort gilt der Standard */ }

function padPressed(gp, button) {
  return button !== null && button !== undefined && !!(gp && gp.buttons[button] && gp.buttons[button].pressed);
}

// Taste -> Button-Index (Rückwärts = Zurück, KeyA = Umschalter gehalten, KeyP = Bild-in-Bild, KeyM = Musikplayer)
function mainProcessKeyButtons() {
  return { Backspace: PAD.back, KeyA: PAD.switcher, KeyP: PAD.pip, KeyM: PAD.musicPlayer };
}
const gamepadKeyState = {};

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

function setGamepadKeyPressed(code, pressed) {
  const state = gamepadKeyState[code] || (gamepadKeyState[code] = { pressed: false });
  if (pressed === state.pressed) return;
  state.pressed = pressed;
  // B/Backspace: Zuerst Tastatur schließen bzw. Textfeld verlassen. Nur wenn nichts davon
  // zutrifft, geht B an den Hauptprozess (minimiert die App).
  if (code === 'Backspace' && pressed && oskHandleBack()) return;
  let inputFocused = false;
  try { inputFocused = isEditableElement(deepActiveElement()); } catch (err) { /* Seite im Umbau: dann gilt "nicht fokussiert" */ }
  ipcRenderer.send('gamepad-input', { code, type: pressed ? 'keyDown' : 'keyUp', inputFocused });
}

// Der erste angeschlossene Controller (oder undefined)
function firstGamepad() {
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  return Array.from(gamepads).find(g => g);
}

// Zustand beim Laden aus der tatsächlichen Controller-Stellung initialisieren
// (ohne Events auszulösen) - verhindert, dass eine schon gehaltene Taste als
// frischer Druck erkannt wird, falls dieses Preload neu ausgeführt wird.
function initGamepadState() {
  const gp = firstGamepad();
  Object.entries(mainProcessKeyButtons()).forEach(([code, buttonIndex]) => {
    gamepadKeyState[code] = { pressed: padPressed(gp, buttonIndex) };
  });
}

function pollGamepadForMainProcessKeys(gp) {
  if (gp) {
    Object.entries(mainProcessKeyButtons()).forEach(([code, buttonIndex]) => {
      setGamepadKeyPressed(code, padPressed(gp, buttonIndex));
    });
  } else {
    Object.keys(gamepadKeyState).forEach(code => setGamepadKeyPressed(code, false));
  }
}

initGamepadState();

// ---------- Controller-Mauszeiger ----------
// Linker Stick bewegt den Cursor, aber nur wenn der Modus aktiv ist (umgeschaltet
// per L3 - linken Stick hineindrücken). Kollidiert nicht mit der Navigation
// außerhalb von Apps, da der Cursor nur hier (innerhalb einer App) existiert.
// A klickt (hat innerhalb der App sonst keine Funktion, keine Kollision).
//
// Die SICHTBARE Bewegung passiert komplett LOKAL (dieses Preload läuft ja
// bereits im selben Kontext wie die Seite) - kein IPC-Umweg zum Hauptprozess
// und zurück nötig, das war der verbleibende Ruckel-Verursacher. Nur die
// tatsächliche App-Interaktion (Hover-Zustand/Klick) braucht noch IPC, da
// sendInputEvent eine reine Hauptprozess-Methode ist - das aber gedrosselt.
const CURSOR_DEADZONE = 0.15;
const CURSOR_BASE_SPEED = 14; // Pixel pro Frame bei vollem Stick-Ausschlag (= 100 %)
let cursorSpeedPercent = 100; // aus den Controller-Einstellungen (Einstellungen > Allgemein > Eingabegeräte > Controller)
let scrollSpeedPercent = 100; // ebenso: Geschwindigkeit des Scrollens mit LT/RT

function cursorSpeedPx() {
  return CURSOR_BASE_SPEED * cursorSpeedPercent / 100;
}

function applyControllerSettings(settings) {
  if (!settings) return;
  const nextPad = settings.mapping && typeof settings.mapping === 'object' ? { ...DEFAULT_PAD, ...settings.mapping } : null;
  if (nextPad && JSON.stringify(nextPad) !== JSON.stringify(PAD)) {
    PAD = nextPad;
    // eine dabei gehaltene Taste soll nichts auslösen: Stand der Tasten neu übernehmen
    initGamepadState();
    const gp = firstGamepad();
    yPressed = padPressed(gp, PAD.keyboard);
    l3Pressed = padPressed(gp, PAD.cursor);
    aPressedForClick = padPressed(gp, PAD.confirm);
    Object.keys(playerPadPrev).forEach((action) => { playerPadPrev[action] = padPressed(gp, padButtonForPlayer(action)); });
    Object.keys(tvPadPrev).forEach((key) => { tvPadPrev[key] = false; });
  }
  if (Number.isFinite(settings.cursorSpeed)) cursorSpeedPercent = settings.cursorSpeed;
  if (Number.isFinite(settings.scrollSpeed)) scrollSpeedPercent = settings.scrollSpeed;
}

ipcRenderer.invoke('get-controller-settings').then(applyControllerSettings).catch(() => {});
// Wird in den Einstellungen etwas geändert, erfährt es auch eine bereits laufende App sofort
ipcRenderer.on('controller-settings-changed', (event, settings) => applyControllerSettings(settings));
const CURSOR_SEND_INPUT_THROTTLE_MS = 100; // max. ~10/s an sendInputEvent - manche Seiten (z.B. YouTube) lösen dabei selbst teure Neuberechnungen aus

let cursorEl = null;
let cursorModeLocal = false;
let localCursorPos = { x: 0, y: 0 };
let cursorPosKnown = false; // false: noch nie benutzt - dann beginnt der Zeiger in der Bildschirmmitte, sonst dort, wo er zuletzt war
let l3Pressed = false;
let aPressedForClick = false;
let lastSendInputAt = 0;

// Runder Zielkreis mit Punkt in der Mitte (wie in vielen Konsolenspielen): groß genug, um ihn auf
// dem Fernseher mit dem Stick nie aus den Augen zu verlieren, der Punkt zeigt genau, was getroffen
// wird. Die Mitte des Kreises ist die Klickposition.
const CURSOR_SIZE_PX = 44;
const CURSOR_SCALE_HOVER = 0.8;   // zieht sich über klickbaren Elementen leicht zusammen
const CURSOR_SCALE_PRESS = 0.62;  // und beim Klick (A gedrückt) stärker
const CURSOR_HOVER_CHECK_INTERVAL_MS = 100; // Elementsuche unter dem Cursor höchstens 10x pro Sekunde

let cursorSvg = null;
let cursorHover = false;
let cursorPressed = false;
let hoverCheckTimer = null;
let cursorOverFrame = false; // Stand der letzten Prüfung (10x pro Sekunde): steht der Cursor über einem iFrame?

function createCursorElement() {
  if (cursorEl) return;
  const half = CURSOR_SIZE_PX / 2;
  cursorEl = document.createElement('div');
  cursorEl.id = '__controllerCursor';
  // Negativer Rand: Die Mitte des Elements (nicht die linke obere Ecke) sitzt auf der Cursor-Position
  cursorEl.style.cssText = 'position:fixed; top:0; left:0; width:' + CURSOR_SIZE_PX + 'px; height:' + CURSOR_SIZE_PX + 'px; margin:-' + half + 'px 0 0 -' + half + 'px; z-index:2147483647; pointer-events:none; will-change:transform;' +
    // Stil-Grundwerte, die das Popover-Attribut sonst setzt (Rahmen, Hintergrund, zentrierte Lage)
    ' right:auto; bottom:auto; border:0; padding:0; background:transparent; overflow:visible; color:inherit;';
  cursorEl.setAttribute('popover', 'manual'); // oberste Ebene (top layer): über der Browser-Leiste, Dialogfenstern und Vollbild

  // Per createElementNS/setAttribute statt innerHTML bauen - manche Seiten
  // (z.B. YouTube) erzwingen die Trusted-Types-API, die innerHTML mit
  // normalen Strings blockiert. Programmatische DOM-Erzeugung ist davon
  // nicht betroffen. (Stile ebenfalls per JS - eine strenge CSP blockiert <style>-Elemente.)
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', String(CURSOR_SIZE_PX));
  svg.setAttribute('height', String(CURSOR_SIZE_PX));
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.style.cssText = 'display:block; transform-origin:50% 50%; transition:transform 0.12s ease-out;';

  const circle = (r, attrs) => {
    const c = document.createElementNS(svgNS, 'circle');
    c.setAttribute('cx', '32');
    c.setAttribute('cy', '32');
    c.setAttribute('r', String(r));
    Object.keys(attrs).forEach(k => c.setAttribute(k, attrs[k]));
    svg.appendChild(c);
  };
  circle(27, { fill: 'rgba(0,0,0,0.18)', stroke: 'rgba(0,0,0,0.45)', 'stroke-width': '5.5' }); // dunkler Rand: Kontrast auf hellen Seiten
  circle(27, { fill: 'none', stroke: '#ffffff', 'stroke-width': '2.6' });                       // weißer Ring
  circle(5.2, { fill: '#f2f2f2', stroke: 'rgba(0,0,0,0.5)', 'stroke-width': '1.4' });           // Punkt in der Mitte
  cursorEl.appendChild(svg);
  cursorSvg = svg;

  // Direkt an <html> (wie die Browser-Leiste): Seiten tauschen den Body-Inhalt teils aus
  document.documentElement.appendChild(cursorEl);
  raiseCursor();
  if (!cursorRaiseTimer) cursorRaiseTimer = setInterval(checkCursorLayer, CURSOR_LAYER_CHECK_MS);
}

// ---------- Cursor immer ganz oben ----------
// Der Cursor liegt in der obersten Ebene des Browsers (Popover-API). Was dort zuletzt hinzukam, liegt oben: öffnet die Seite danach ein
// modales Dialogfenster (typisch bei Cookie-Bannern) oder geht ein Element in den Vollbildmodus, würde es den Cursor verdecken -
// dann wird der Cursor erneut nach oben geholt. Ohne Popover-Unterstützung bleibt es bei der höchsten z-index-Ebene.
const CURSOR_LAYER_CHECK_MS = 400;
let cursorRaiseTimer = null;
let cursorLayerKey = '';

function topLayerKey() {
  try {
    const modals = document.querySelectorAll('dialog:modal').length;
    const popovers = Math.max(0, document.querySelectorAll(':popover-open').length - 1); // ohne den Cursor selbst
    return modals + '/' + popovers + '/' + (document.fullscreenElement ? 1 : 0);
  } catch (err) {
    return '';
  }
}

function raiseCursor() {
  if (!cursorEl || typeof cursorEl.showPopover !== 'function') return;
  try {
    if (cursorEl.matches(':popover-open')) cursorEl.hidePopover();
    cursorEl.showPopover();
  } catch (err) { /* nicht im Dokument o.ä.: dann bleibt der z-index */ }
  cursorLayerKey = topLayerKey();
}

function checkCursorLayer() {
  if (!cursorEl) return;
  if (!cursorEl.isConnected) { // die Seite hat <html> ausgetauscht
    document.documentElement.appendChild(cursorEl);
    raiseCursor();
    return;
  }
  if (topLayerKey() !== cursorLayerKey) raiseCursor();
}
document.addEventListener('fullscreenchange', () => { if (cursorEl) raiseCursor(); });

function removeCursorElement() {
  if (cursorRaiseTimer) {
    clearInterval(cursorRaiseTimer);
    cursorRaiseTimer = null;
  }
  if (cursorEl) {
    cursorEl.remove();
    cursorEl = null;
  }
  cursorSvg = null;
  cursorHover = false;
  cursorPressed = false;
  cursorOverFrame = false;
  if (hoverCheckTimer) {
    clearTimeout(hoverCheckTimer);
    hoverCheckTimer = null;
  }
}

function applyCursorScale() {
  if (!cursorSvg) return;
  const scale = cursorPressed ? CURSOR_SCALE_PRESS : (cursorHover ? CURSOR_SCALE_HOVER : 1);
  cursorSvg.style.transform = 'scale(' + scale + ')';
}

function setCursorPressed(pressed) {
  if (pressed === cursorPressed) return;
  cursorPressed = pressed;
  applyCursorScale();
}

// Element unter dem Cursor, auch innerhalb von Shadow-DOMs
function deepElementFromPoint(x, y) {
  let el = document.elementFromPoint(x, y);
  if (barHost && el === barHost) { // Browser-Leiste (geschlossener Shadow-Bereich)
    const inner = barRoot.elementFromPoint(x, y);
    if (inner) return inner;
  }
  while (el && el.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

// Liegt unter dem Cursor ein iFrame (oder eingebettetes Objekt)? Dann müssen Klick, Hover und Mausrad über die Debug-Schnittstelle
// laufen, weil sendInputEvent fremde iFrames nicht erreicht (siehe main.js).
function isFrameElement(el) {
  const tag = el && el.tagName;
  return tag === 'IFRAME' || tag === 'FRAME' || tag === 'EMBED' || tag === 'OBJECT';
}

function isOverFrame(x, y) {
  try {
    return isFrameElement(deepElementFromPoint(x, y));
  } catch (err) {
    return false;
  }
}

function isClickableElement(el) {
  if (!el) return false;
  if (el.closest && el.closest('button, [role="button"], summary, select')) return true;
  try {
    const c = getComputedStyle(el).cursor;
    return c === 'pointer' || c === 'text' || c === 'grab';
  } catch (err) {
    return false;
  }
}

// Gedrosselt UND nachlaufend: höchstens eine Prüfung pro Intervall, aber nach dem Ende einer
// Bewegung (oder wenn die Seite unter dem stehenden Cursor scrollt) wird die Endposition immer
// noch einmal geprüft - sonst bliebe der Zustand veraltet.
function scheduleHoverCheck() {
  if (hoverCheckTimer) return;
  hoverCheckTimer = setTimeout(() => {
    hoverCheckTimer = null;
    updateCursorHover();
  }, CURSOR_HOVER_CHECK_INTERVAL_MS);
}

function updateCursorHover() {
  if (!cursorSvg) return;
  const under = deepElementFromPoint(localCursorPos.x, localCursorPos.y);
  cursorOverFrame = isFrameElement(under);
  const hover = isClickableElement(under);
  if (hover === cursorHover) return;
  cursorHover = hover;
  applyCursorScale();
}

function renderCursorPosition() {
  if (cursorEl) cursorEl.style.transform = 'translate(' + localCursorPos.x + 'px,' + localCursorPos.y + 'px)';
}

function activateCursor() {
  createCursorElement();
  if (!cursorPosKnown) {
    localCursorPos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    cursorPosKnown = true;
  } else { // zuletzt benutzte Stelle (auch aus dem Hauptprozess nach einem Seitenwechsel), ins Fenster geklemmt
    localCursorPos = {
      x: Math.max(0, Math.min(window.innerWidth, localCursorPos.x)),
      y: Math.max(0, Math.min(window.innerHeight, localCursorPos.y))
    };
  }
  renderCursorPosition();
  updateCursorHover();
}

function deactivateCursor() {
  removeCursorElement();
}

// Die zuletzt benutzte Stelle übernehmen (aus dem Hauptprozess), solange hier noch keine bekannt ist
function adoptCursorPos(pos) {
  if (cursorPosKnown || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
  localCursorPos = { x: pos.x, y: pos.y };
  cursorPosKnown = true;
}

function moveCursorBy(dx, dy) {
  localCursorPos.x = Math.max(0, Math.min(window.innerWidth, localCursorPos.x + dx));
  localCursorPos.y = Math.max(0, Math.min(window.innerHeight, localCursorPos.y + dy));
  renderCursorPosition(); // sofort, rein lokal, kein IPC - bleibt dadurch flüssig

  const x = Math.round(localCursorPos.x);
  const y = Math.round(localCursorPos.y);
  const now = Date.now();
  scheduleHoverCheck(); // gedrosselt: höchstens ein Nachschlagen pro Intervall, kein Layout-Dauerfeuer
  if (now - lastSendInputAt < CURSOR_SEND_INPUT_THROTTLE_MS) return;
  lastSendInputAt = now;
  ipcRenderer.send('cursor-move', { x, y, frame: cursorOverFrame });
}

// ---------- Scrollen mit den Triggern: RT = runter, LT = hoch ----------
// Standard-Belegung: Button 6 = LT, Button 7 = RT (analog, value 0..1). Je stärker gedrückt,
// desto schneller. Der Hauptprozess macht daraus echte Mausrad-Ereignisse an der Cursor-
// Position (ohne Cursor-Modus: Fenstermitte).
const SCROLL_TRIGGER_DEADZONE = 0.1;
const SCROLL_MAX_PX_PER_SEC = 1800;   // bei voll durchgedrücktem Trigger und 100 % (Einstellung: Controller > Scroll-Geschwindigkeit)
const SCROLL_SEND_INTERVAL_MS = 33;   // max. ~30 Mausrad-Ereignisse pro Sekunde (gesammelt statt jedes Frame)
let scrollAccum = 0;
let lastScrollFrameAt = 0;
let lastScrollSendAt = 0;

function triggerValue(gp, index) {
  const b = gp.buttons[index];
  if (!b) return 0;
  const v = typeof b.value === 'number' ? b.value : (b.pressed ? 1 : 0);
  return v > SCROLL_TRIGGER_DEADZONE ? (v - SCROLL_TRIGGER_DEADZONE) / (1 - SCROLL_TRIGGER_DEADZONE) : 0;
}

function handleTriggerScroll(gp) {
  const now = performance.now();
  const net = Math.pow(triggerValue(gp, 7), 1.5) - Math.pow(triggerValue(gp, 6), 1.5); // > 0 = nach unten
  if (net === 0) {
    scrollAccum = 0;
    lastScrollFrameAt = 0;
    return;
  }
  const dt = lastScrollFrameAt ? Math.min(now - lastScrollFrameAt, 50) : 16;
  lastScrollFrameAt = now;
  scrollAccum += net * SCROLL_MAX_PX_PER_SEC * (scrollSpeedPercent / 100) * dt / 1000;

  if (now - lastScrollSendAt >= SCROLL_SEND_INTERVAL_MS && Math.abs(scrollAccum) >= 1) {
    const step = Math.round(scrollAccum);
    scrollAccum -= step;
    lastScrollSendAt = now;
    const pos = cursorModeLocal ? localCursorPos : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    ipcRenderer.send('scroll-wheel', { x: pos.x, y: pos.y, dy: step, frame: cursorModeLocal && cursorOverFrame });
    if (cursorModeLocal) scheduleHoverCheck(); // Inhalt wandert unter dem Cursor durch
  }
}

let yPressed = false;
let gpAHeld = false;
let lastGamepadActivityAt = 0; // wann der Controller zuletzt benutzt wurde (für das automatische Öffnen der Tastatur)

function pollCursorControl(gp) {
  if (gp) {
    const l3Now = padPressed(gp, PAD.cursor);
    const aNow = !(mediaPlayerOpen && !oskVisible) && padPressed(gp, PAD.confirm); // bei offenem Player gehört die Bestätigen-Taste ihm
    const yNow = padPressed(gp, PAD.keyboard);
    gpAHeld = aNow;

    if (gp.buttons.some(b => b && b.pressed) || Math.abs(gp.axes[0] || 0) > 0.5 || Math.abs(gp.axes[1] || 0) > 0.5) {
      lastGamepadActivityAt = Date.now();
    }

    handleTriggerScroll(gp);

    // Y: Bildschirmtastatur manuell ein-/ausblenden (für das gerade fokussierte Textfeld)
    if (yNow && !yPressed) {
      if (oskVisible) oskClose(); else oskTryOpen();
    }
    yPressed = yNow;

    if (oskVisible) {
      // Tastatur offen: Steuerkreuz, Stick und A gehören ihr, der Cursor ruht.
      oskHandleGamepad(gp);
      l3Pressed = l3Now;
      aPressedForClick = aNow; // sonst würde ein beim Schließen noch gehaltenes A als Klick zählen
      setCursorPressed(false);
      return;
    }

    // L3 (linker Stick gedrückt) - Flankenerkennung, damit ein einzelner
    // Druck auch nur einmal umschaltet
    if (l3Now && !l3Pressed) {
      cursorModeLocal = !cursorModeLocal;
      if (cursorModeLocal) activateCursor(); else deactivateCursor();
      ipcRenderer.send('toggle-cursor-mode', cursorModeLocal);
    }
    l3Pressed = l3Now;

    if (cursorModeLocal) {
      const stickX = gp.axes[0] || 0;
      const stickY = gp.axes[1] || 0;
      const speed = cursorSpeedPx();
      const dx = Math.abs(stickX) > CURSOR_DEADZONE ? stickX * speed : 0;
      const dy = Math.abs(stickY) > CURSOR_DEADZONE ? stickY * speed : 0;
      if (dx !== 0 || dy !== 0) {
        moveCursorBy(dx, dy);
      }

      setCursorPressed(aNow); // Kreis zieht sich zusammen, solange A gedrückt ist
      if (aNow && !aPressedForClick) {
        const cx = Math.round(localCursorPos.x), cy = Math.round(localCursorPos.y);
        ipcRenderer.send('cursor-click', { x: cx, y: cy, frame: isOverFrame(cx, cy) }); // frisch geprüft: der Klick darf nicht auf einem veralteten Stand beruhen
        // Klick auf ein Textfeld: nach kurzer Wartezeit (Fokus setzt die Seite selbst) Tastatur öffnen
        setTimeout(() => { if (controllerInUse()) oskTryOpen(); }, 220);
      }
      aPressedForClick = aNow;
    }
  }
}

// ---------- Gemeinsame Controller-Abfrage: ein Durchlauf pro Bild ----------
// Die Reihenfolge ist fest und wichtig: erst die Tasten für den Hauptprozess (dabei schließt B zuerst
// eine offene Bildschirmtastatur, siehe oskHandleBack), danach Cursor, Scrollen und Tastatur.
// Beide Teile laufen einzeln abgesichert: Ein Fehler im einen darf den anderen nicht lahmlegen
// (z.B. soll B die App auch dann minimieren, wenn im Cursor-Teil etwas schiefgeht).
const reportedTickErrors = new Set();

function runTickPart(name, part, gp) {
  try {
    part(gp);
  } catch (err) {
    const key = name + ':' + (err && err.message);
    if (reportedTickErrors.has(key)) return; // jeden Fehler nur einmal melden, nicht 60-mal pro Sekunde
    reportedTickErrors.add(key);
    console.error('Controller-Abfrage (' + name + ') fehlgeschlagen:', err);
  }
}

// Offener Musikplayer: Steuerkreuz bewegt den Fokus im Player, A löst aus. Richtungen wiederholen sich beim Halten
// (nach 450 ms, dann alle 120 ms - wie im Launcher), A nur beim Drücken. Ist die Bildschirmtastatur offen, gehören
// diese Tasten ihr.
const PLAYER_PAD_BUTTONS = { up: 12, down: 13, left: 14, right: 15, activate: null }; // activate = die Bestätigen-Taste (siehe padButtonForPlayer)
function padButtonForPlayer(action) {
  return action === 'activate' ? PAD.confirm : PLAYER_PAD_BUTTONS[action];
}
const PLAYER_PAD_REPEAT_DELAY_MS = 450;
const PLAYER_PAD_REPEAT_INTERVAL_MS = 120;
const playerPadPrev = {};   // action -> gedrückt im letzten Durchlauf
const playerPadNextRepeat = {}; // action -> Zeitpunkt der nächsten Wiederholung
function pollMediaPlayerPad(gp) {
  const active = mediaPlayerOpen && !oskVisible;
  const nowMs = Date.now();
  const xHeld = padPressed(gp, PAD.extra); // Zusatztaste (X) gehalten: Steuerkreuz wählt den Platz des Players
  Object.keys(PLAYER_PAD_BUTTONS).forEach((action) => {
    const pressed = padPressed(gp, padButtonForPlayer(action));
    if (active && pressed) {
      if (!playerPadPrev[action]) {
        if (xHeld) {
          if (action !== 'activate') ipcRenderer.send('media-player-pad', { action: 'place-' + action, repeat: false });
        } else {
          ipcRenderer.send('media-player-pad', { action, repeat: false });
        }
        playerPadNextRepeat[action] = nowMs + PLAYER_PAD_REPEAT_DELAY_MS;
      } else if (xHeld) {
        // keine Wiederholung beim Wählen des Platzes
      } else if (action !== 'activate' && nowMs >= playerPadNextRepeat[action]) {
        ipcRenderer.send('media-player-pad', { action, repeat: true });
        playerPadNextRepeat[action] = nowMs + PLAYER_PAD_REPEAT_INTERVAL_MS;
      }
    }
    playerPadPrev[action] = pressed; // auch außerhalb des Players mitführen: eine schon gehaltene Taste löst beim Öffnen nichts aus
  });
}

// YouTube TV: Steuerkreuz und linker Stick -> Pfeiltasten (beim Halten wiederholt: nach 450 ms, dann alle 120 ms), A -> Enter,
// X -> Wiedergabe/Pause. Bei offenem Musikplayer oder Bildschirmtastatur gehören die Tasten diesen; bei eingeschaltetem
// Mauszeiger gehören linker Stick und A ihm (Bewegen/Klicken).
const TV_PAD_REPEAT_DELAY_MS = 450;
const TV_PAD_REPEAT_INTERVAL_MS = 120;
const TV_STICK_THRESHOLD = 0.5;
const tvPadPrev = {};        // Taste -> gedrückt im letzten Durchlauf
const tvPadNextRepeat = {};  // Richtung -> Zeitpunkt der nächsten Wiederholung
let tvPadInitialized = false;
function pollTvPad(gp) {
  if (!TV_MODE) return;
  const pressedBtn = (i) => padPressed(gp, i);
  const ax = (gp && gp.axes[0]) || 0;
  const ay = (gp && gp.axes[1]) || 0;
  const stick = !cursorModeLocal; // bei eingeschaltetem Mauszeiger bewegt der Stick ihn, und A klickt
  const current = {
    Up: pressedBtn(12) || (stick && ay < -TV_STICK_THRESHOLD),
    Down: pressedBtn(13) || (stick && ay > TV_STICK_THRESHOLD),
    Left: pressedBtn(14) || (stick && ax < -TV_STICK_THRESHOLD),
    Right: pressedBtn(15) || (stick && ax > TV_STICK_THRESHOLD),
    Enter: stick && pressedBtn(PAD.confirm),
    MediaPlayPause: pressedBtn(PAD.extra)
  };
  const blocked = mediaPlayerOpen || oskVisible;
  const nowMs = Date.now();
  const directional = ['Up', 'Down', 'Left', 'Right'];
  Object.keys(current).forEach((key) => {
    const pressed = current[key] && !blocked;
    const was = !!tvPadPrev[key];
    if (!tvPadInitialized) {
      // Beim ersten Durchlauf nur den Stand merken: eine schon gehaltene Taste löst nichts aus
    } else if (pressed && !was) {
      if (key === 'MediaPlayPause') ipcRenderer.send('tv-key', { key, type: 'press' });
      else ipcRenderer.send('tv-key', { key, type: 'down' });
      tvPadNextRepeat[key] = nowMs + TV_PAD_REPEAT_DELAY_MS;
    } else if (pressed && was && directional.includes(key) && nowMs >= tvPadNextRepeat[key]) {
      ipcRenderer.send('tv-key', { key, type: 'down', repeat: true });
      tvPadNextRepeat[key] = nowMs + TV_PAD_REPEAT_INTERVAL_MS;
    } else if (!pressed && was && key !== 'MediaPlayPause') {
      ipcRenderer.send('tv-key', { key, type: 'up' });
    }
    tvPadPrev[key] = pressed || (tvPadInitialized ? false : current[key]);
  });
  tvPadInitialized = true;
}

// Controller benutzt (Taste gedrückt oder Stick bewegt): der Hauptprozess blendet den Mauszeiger (Pfeil) überall aus, bis die echte Maus
// bewegt wird (pointer-hider.js). Gemeldet wird höchstens alle 300 ms.
const PAD_USE_DEADZONE = 0.5;
let lastPadUseReport = 0;
function notePadUse(gp) {
  if (!gp) return;
  const used = gp.buttons.some((b) => b && b.pressed) || gp.axes.some((a) => Math.abs(a) > PAD_USE_DEADZONE);
  if (!used) return;
  const now = Date.now();
  if (now - lastPadUseReport < 300) return;
  lastPadUseReport = now;
  ipcRenderer.send('pad-used');
}

function controllerTick() {
  requestAnimationFrame(controllerTick); // zuerst neu anmelden: Ein Fehler darf die Abfrage nicht beenden
  const gp = firstGamepad();
  runTickPart('Mauszeiger', notePadUse, gp);
  runTickPart('Notausstieg', checkPadResetCombo, gp);
  runTickPart('Tasten', pollGamepadForMainProcessKeys, gp);
  runTickPart('Player', pollMediaPlayerPad, gp);
  runTickPart('YouTube TV', pollTvPad, gp);
  runTickPart('Cursor', pollCursorControl, gp);
}
requestAnimationFrame(controllerTick);

// Falls der Hauptprozess den Cursor-Modus von außen beendet (z.B. beim
// Minimieren/Schließen der App), auch hier lokal sauber aufräumen.
ipcRenderer.on('force-deactivate-cursor', () => {
  cursorModeLocal = false;
  deactivateCursor();
});

// Seitenwechsel in der App (Anmeldung, Weiterleitung, Neuladen ...): dieser Preload startet mit jedem neuen Dokument frisch, der Zeiger
// wäre dann aus - der Hauptprozess hat sich aber gemerkt, dass er an war, und das Handy zeigt "an". Deshalb meldet sich jede neue Seite
// beim Hauptprozess; war der Zeiger an, bekommt sie den Auftrag, ihn wieder einzuschalten, und meldet den echten Stand zurück.
ipcRenderer.on('restore-cursor', (event, pos) => {
  adoptCursorPos(pos);
  const go = () => {
    try {
      if (!cursorModeLocal) {
        activateCursor();
        cursorModeLocal = true;
      }
    } catch (err) { /* Seite im Umbau */ }
    ipcRenderer.send('toggle-cursor-mode', cursorModeLocal);
  };
  if (document.documentElement) go();
  else document.addEventListener('DOMContentLoaded', go, { once: true });
});
ipcRenderer.send('app-view-ready');
// Die zuletzt benutzte Stelle dieser App holen (für den Fall, dass der Zeiger erst später, z.B. mit L3, eingeschaltet wird) und beim
// Verlassen der Seite melden - die gedrosselte Meldung beim Bewegen lässt die allerletzte Position sonst aus
ipcRenderer.invoke('get-cursor-pos').then(adoptCursorPos).catch(() => {});
window.addEventListener('pagehide', () => {
  if (cursorPosKnown) ipcRenderer.send('cursor-pos', { x: localCursorPos.x, y: localCursorPos.y });
});

// ---------- Handy-Fernbedienung (siehe remote-service.js in main.js) ----------
// Zurück vom Handy: wie B am Controller (schließt zuerst die Bildschirmtastatur bzw. verlässt das Textfeld, sonst minimiert es die App).
ipcRenderer.on('remote-key', (event, msg) => {
  if (!msg || msg.code !== 'Backspace' || (msg.type !== 'down' && msg.type !== 'up')) return;
  try { setGamepadKeyPressed('Backspace', msg.type === 'down'); } catch (err) { /* Seite im Umbau */ }
});

// Zeiger vom Handy: Touchfläche = Maus. Nutzt dieselben Wege wie der Controller-Zeiger (Bewegung lokal, Klick/Hover über den Hauptprozess).
ipcRenderer.on('remote-cursor', (event, msg) => {
  if (!msg || typeof msg.type !== 'string') return;
  try {
    if (msg.type === 'set') {
      const want = msg.value === true;
      if (want !== cursorModeLocal) {
        if (want) activateCursor(); else deactivateCursor();
        cursorModeLocal = want;
      } else if (want && !cursorEl) {
        activateCursor(); // Zustand sagt "an", das Zeiger-Element fehlt aber (Seite hat es entfernt): neu aufbauen
      }
      ipcRenderer.send('toggle-cursor-mode', cursorModeLocal); // immer den wahren Stand melden, damit Hauptprozess und Handy nicht auseinanderlaufen
    } else if (msg.type === 'move') {
      if (cursorModeLocal && Number.isFinite(msg.dx) && Number.isFinite(msg.dy)) moveCursorBy(msg.dx, msg.dy);
    } else if (msg.type === 'click') {
      if (!cursorModeLocal) return;
      const cx = Math.round(localCursorPos.x), cy = Math.round(localCursorPos.y);
      setCursorPressed(true);
      setTimeout(() => setCursorPressed(false), 140);
      ipcRenderer.send('cursor-click', { x: cx, y: cy, frame: isOverFrame(cx, cy) });
    } else if (msg.type === 'scroll') {
      if (!Number.isFinite(msg.dy)) return;
      const pos = cursorModeLocal ? localCursorPos : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      ipcRenderer.send('scroll-wheel', { x: pos.x, y: pos.y, dy: msg.dy, frame: cursorModeLocal && cursorOverFrame });
      if (cursorModeLocal) scheduleHoverCheck();
    }
  } catch (err) { /* Seite im Umbau: dann gilt die Eingabe nicht */ }
});

// ---------- Bildschirmtastatur in Apps ----------
// Zeichnet eine Tastatur als Overlay in die App-Seite (z.B. YouTube-Suche). Entscheidende
// Punkte, die sich beim Ausprobieren auf Seiten mit strenger Sicherheitsrichtlinie ergeben haben:
//   - Aufbau NUR per createElement/textContent: innerHTML ist auf solchen Seiten (Trusted Types)
//     auch im Preload blockiert.
//   - Shadow-DOM, damit die Stile der Seite (z.B. "button { ... !important }") unsere Tasten
//     nicht zerstören, und Stile über ein konstruiertes Stylesheet (adoptedStyleSheets): eine
//     strenge CSP blockiert eingefügte <style>-Elemente, aber nicht dieses.
//   - Die Tasten bekommen KEINEN DOM-Fokus. Die Auswahl wird intern geführt, der Fokus bleibt
//     im Textfeld der Seite (Cursor, Framework-Logik, "Suche bleibt offen" usw. bleiben intakt).
//   - Getippt wird über den Hauptprozess (webContents.insertText / sendInputEvent): die Seite
//     sieht echte input-Ereignisse, auch bei Frameworks, contenteditable und Feldern im Shadow-DOM.
// Bedienung: Steuerkreuz/linker Stick wählt die Taste, A tippt, B schließt (erneut B: Feld verlassen),
// Y öffnet/schließt manuell. Öffnet automatisch, wenn per Controller ein Textfeld angeklickt wurde.
const OSK_LAYOUTS = {
  default: [
    '1 2 3 4 5 6 7 8 9 0 ß {bksp}',
    'q w e r t z u i o p ü',
    'a s d f g h j k l ö ä',
    '{shift} y x c v b n m , . -',
    '{numbers} {left} {space} {right} {enter}'
  ],
  shift: [
    '! " § $ % & / ( ) = ? {bksp}',
    'Q W E R T Z U I O P Ü',
    'A S D F G H J K L Ö Ä',
    '{shift} Y X C V B N M ; : _',
    '{numbers} {left} {space} {right} {enter}'
  ],
  numbers: [
    '1 2 3 4 5 6 7 8 9 0 + {bksp}',
    '@ # € _ & - ( ) = / *',
    ': ; " \' ! ? ~ % ^ \\ |',
    '< > [ ] $ , . ` ´ § ß',
    '{abc} {left} {space} {right} {enter}'
  ]
};
const OSK_LABELS = {
  '{bksp}': '⌫', '{enter}': 'Enter ⏎', '{shift}': '⇧', '{space}': 'Leertaste',
  '{numbers}': '123', '{abc}': 'ABC', '{left}': '◀', '{right}': '▶'
};
const OSK_WEIGHTS = { '{bksp}': 1.7, '{shift}': 1.7, '{numbers}': 1.7, '{abc}': 1.7, '{enter}': 2.2, '{space}': 6 };
const OSK_DIR_REPEAT_DELAY_MS = 450;
const OSK_DIR_REPEAT_INTERVAL_MS = 120;
const OSK_AUTO_OPEN_WINDOW_MS = 8000; // so lange nach der letzten Controller-Eingabe öffnet ein Textfeld-Fokus die Tastatur

const OSK_CSS = `
:host { all: initial; }
.panel {
  position: fixed; left: 50%; bottom: 3vh; width: min(70vw, 1280px); box-sizing: border-box;
  padding: 14px; border-radius: 24px; font-family: Arial, sans-serif; user-select: none;
  background: rgba(40, 40, 40, 0.78);
  -webkit-backdrop-filter: blur(18px) saturate(140%); backdrop-filter: blur(18px) saturate(140%);
  border: 1.5px solid rgba(200, 200, 200, 0.14);
  visibility: hidden; opacity: 0; transform: translateX(-50%) translateY(24px);
  transition: opacity 0.2s ease, transform 0.2s ease, visibility 0s linear 0.2s;
}
.panel.visible {
  visibility: visible; opacity: 1; transform: translateX(-50%) translateY(0);
  transition: opacity 0.2s ease, transform 0.2s ease, visibility 0s linear 0s;
}
.preview {
  display: flex; justify-content: flex-end; align-items: center; box-sizing: border-box;
  min-height: 52px; margin-bottom: 12px; padding: 0 18px; overflow: hidden; white-space: pre;
  color: #fff; font-size: 22px; font-weight: 600; border-radius: 14px; background: rgba(0, 0, 0, 0.4);
}
.preview.empty { justify-content: flex-start; color: rgba(255, 255, 255, 0.4); font-weight: 400; }
.row { display: flex; gap: 8px; margin-bottom: 8px; }
.row:last-child { margin-bottom: 0; }
.key {
  flex: 1 1 0; box-sizing: border-box; height: clamp(46px, 6vh, 66px);
  display: flex; align-items: center; justify-content: center;
  border-radius: 12px; background: rgba(255, 255, 255, 0.12); color: #fff;
  font-size: clamp(17px, 2.3vh, 23px); font-weight: 600; cursor: pointer;
  transition: background 0.12s ease, transform 0.12s ease;
}
.key.sel, .key:hover { background: rgba(255, 255, 255, 0.34); transform: scale(1.06); }
.panel.shifted .key[data-key="{shift}"] { background: rgba(255, 255, 255, 0.4); }
`;

let oskHost = null;
let oskPanel = null;
let oskPreview = null;
let oskRowsEl = null;
let oskKeyEls = [];            // Zeilen mit Tasten-Elementen, für die Auswahl per Steuerkreuz
let oskVisible = false;
let oskOpening = false;
let oskTarget = null;          // das Feld der Seite, in das getippt wird
let oskLayout = 'default';
let oskSel = { row: 1, col: 5 };
let oskAPrev = false;
const oskDir = { up: null, down: null, left: null, right: null }; // null = nicht gedrückt, sonst { since, last }

function deepActiveElement() {
  let el = document.activeElement;
  // Browser-Leiste: liegt in einem geschlossenen Shadow-Bereich, el.shadowRoot ist dort null
  if (barHost && el === barHost && barRoot.activeElement) return barRoot.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

// Kürzliche Controller-Eingabe genügt (der A-Klick auf das Feld ist selbst eine). Ein bloß
// eingeschalteter Cursor-Modus zählt bewusst nicht: wer ihn angelassen hat und zur Maus
// greift, soll beim Klick auf ein Textfeld keine Bildschirmtastatur bekommen.
function controllerInUse() {
  return Date.now() - lastGamepadActivityAt < OSK_AUTO_OPEN_WINDOW_MS;
}

function oskTargetText() {
  if (!oskTarget) return '';
  const t = oskTarget.value !== undefined ? oskTarget.value : oskTarget.textContent;
  return oskTarget.type === 'password' ? '•'.repeat((t || '').length) : (t || '');
}

function oskUpdatePreview() {
  if (!oskPreview) return;
  const text = oskTargetText();
  oskPreview.classList.toggle('empty', !text);
  oskPreview.textContent = text || (oskTarget && oskTarget.placeholder) || '';
}

function oskBuild() {
  if (oskHost) return;
  oskHost = document.createElement('div');
  oskHost.id = '__oskHost';
  oskHost.style.cssText = 'position:fixed; left:0; top:0; width:0; height:0; z-index:2147483647; right:auto; bottom:auto; margin:0; border:0; padding:0; background:transparent; overflow:visible;';
  oskHost.setAttribute('popover', 'manual'); // wird beim Öffnen in die oberste Ebene geholt (über Dialogfenstern, auch über dem Cursor)
  const root = oskHost.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(OSK_CSS);
  root.adoptedStyleSheets = [sheet];

  oskPanel = document.createElement('div');
  oskPanel.className = 'panel';
  oskPreview = document.createElement('div');
  oskPreview.className = 'preview';
  oskRowsEl = document.createElement('div');
  oskPanel.appendChild(oskPreview);
  oskPanel.appendChild(oskRowsEl);
  // Klicks auf die Tastatur dürfen den Fokus nicht aus dem Textfeld der Seite holen
  oskPanel.addEventListener('mousedown', (e) => e.preventDefault());
  root.appendChild(oskPanel);

  // Direkt an <html> hängen (nicht an <body>): Seiten tauschen den Body-Inhalt teils aus
  document.documentElement.appendChild(oskHost);
}

function oskRender() {
  while (oskRowsEl.firstChild) oskRowsEl.removeChild(oskRowsEl.firstChild);
  oskKeyEls = OSK_LAYOUTS[oskLayout].map((rowStr, r) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    const keys = rowStr.split(' ').map((token, c) => {
      const keyEl = document.createElement('div');
      keyEl.className = 'key';
      keyEl.setAttribute('data-key', token);
      keyEl.textContent = OSK_LABELS[token] || token;
      if (OSK_WEIGHTS[token]) keyEl.style.flexGrow = String(OSK_WEIGHTS[token]);
      keyEl.addEventListener('click', () => {
        oskSel = { row: r, col: c };
        oskUpdateSel();
        oskPress(token);
      });
      rowEl.appendChild(keyEl);
      return keyEl;
    });
    oskRowsEl.appendChild(rowEl);
    return keys;
  });
  oskPanel.classList.toggle('shifted', oskLayout === 'shift');
  oskSel.row = Math.min(oskSel.row, oskKeyEls.length - 1);
  oskSel.col = Math.min(oskSel.col, oskKeyEls[oskSel.row].length - 1);
  oskUpdateSel();
}

function oskUpdateSel() {
  oskKeyEls.forEach(row => row.forEach(k => k.classList.remove('sel')));
  const cur = oskKeyEls[oskSel.row] && oskKeyEls[oskSel.row][oskSel.col];
  if (cur) cur.classList.add('sel');
}

function oskSetLayout(name) {
  oskLayout = name;
  oskRender();
}

function oskCenterX(el) {
  const r = el.getBoundingClientRect();
  return r.left + r.width / 2;
}

function oskMoveSel(dir) {
  let { row, col } = oskSel;
  if (dir === 'left') {
    col = Math.max(0, col - 1);
  } else if (dir === 'right') {
    col = Math.min(oskKeyEls[row].length - 1, col + 1);
  } else {
    const nr = row + (dir === 'down' ? 1 : -1);
    if (nr < 0 || nr >= oskKeyEls.length) return;
    const cx = oskCenterX(oskKeyEls[row][col]);
    let best = 0;
    let bestDist = Infinity;
    oskKeyEls[nr].forEach((k, i) => {
      const d = Math.abs(oskCenterX(k) - cx);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    row = nr;
    col = best;
  }
  oskSel = { row, col };
  oskUpdateSel();
}

function oskPress(token) {
  switch (token) {
    case '{shift}':   oskSetLayout(oskLayout === 'shift' ? 'default' : 'shift'); return;
    case '{numbers}': oskSetLayout('numbers'); return;
    case '{abc}':     oskSetLayout('default'); return;
    case '{left}':    ipcRenderer.send('osk-key', 'Left'); return;
    case '{right}':   ipcRenderer.send('osk-key', 'Right'); return;
    case '{bksp}':    ipcRenderer.send('osk-key', 'Backspace'); return;
    case '{enter}': {
      ipcRenderer.send('osk-key', 'Return'); // z.B. Suche abschicken
      // Einzeilige Felder: fertig, Tastatur zu. Mehrzeilige Felder bekommen nur einen Zeilenumbruch.
      if (oskTarget && oskTarget.tagName === 'INPUT') oskClose();
      return;
    }
    case '{space}':   ipcRenderer.send('osk-insert-text', ' '); break;
    default:          ipcRenderer.send('osk-insert-text', token);
  }
  if (oskLayout === 'shift') oskSetLayout('default'); // Shift gilt nur für den nächsten Buchstaben
}

function setCursorHidden(hidden) {
  if (cursorEl) cursorEl.style.visibility = hidden ? 'hidden' : 'visible';
}

function oskOnTargetInput() {
  oskUpdatePreview();
}

function oskOpen(el) {
  oskBuild();
  oskTarget = el;
  el.addEventListener('input', oskOnTargetInput, true);
  oskLayout = 'default';
  oskSel = { row: 1, col: 5 };
  oskRender();
  oskUpdatePreview();
  oskPanel.classList.add('visible');
  oskVisible = true;
  try { if (typeof oskHost.showPopover === 'function' && !oskHost.matches(':popover-open')) oskHost.showPopover(); } catch (err) { /* bleibt auf z-index */ }
  setCursorHidden(true);
  // Eingaben, die gerade noch gehalten werden, dürfen nicht sofort etwas auslösen
  oskAPrev = gpAHeld;
  Object.keys(oskDir).forEach(k => { oskDir[k] = { since: Infinity, last: Infinity }; });
  // Liegt das Feld hinter der Tastatur, in den sichtbaren Bereich scrollen
  const kbTop = oskPanel.getBoundingClientRect().top;
  if (el.getBoundingClientRect().bottom > kbTop - 12) el.scrollIntoView({ block: 'center' });
}

function oskClose() {
  if (!oskVisible) return;
  oskVisible = false;
  if (oskPanel) oskPanel.classList.remove('visible');
  try { if (oskHost && oskHost.matches(':popover-open')) oskHost.hidePopover(); } catch (err) { /* schon zu */ }
  if (oskTarget) oskTarget.removeEventListener('input', oskOnTargetInput, true);
  oskTarget = null;
  setCursorHidden(false);
}

// Öffnet die Tastatur für das aktuell fokussierte Textfeld (sofern die Funktion in den
// Einstellungen eingeschaltet ist).
async function oskTryOpen() {
  if (oskVisible || oskOpening) return;
  const el = deepActiveElement();
  if (!isEditableElement(el) || el.readOnly || el.disabled) return;
  oskOpening = true;
  try {
    const settings = await ipcRenderer.invoke('get-keyboard-settings');
    if (!settings || !settings.ownEnabled) return;
    if (oskVisible || deepActiveElement() !== el) return; // Fokus hat sich inzwischen geändert
    oskOpen(el);
  } catch (err) {
    // Einstellungen nicht lesbar: lieber keine Tastatur als eine kaputte
  } finally {
    oskOpening = false;
  }
}

// B/Backspace: Tastatur schließen; ist sie zu und ein Textfeld fokussiert, das Feld verlassen.
// Gibt true zurück, wenn B hier verbraucht wurde (dann darf die App nicht minimiert werden).
function oskHandleBack() {
  if (oskVisible) {
    oskClose();
    return true;
  }
  const el = deepActiveElement();
  if (isEditableElement(el)) {
    el.blur();
    return true;
  }
  return false;
}

// Steuerkreuz/Stick: ein Schritt beim Drücken, bei längerem Halten Wiederholung
function oskHandleGamepad(gp) {
  const now = Date.now();
  const btn = (i) => padPressed(gp, i);
  const ax = gp.axes[0] || 0;
  const ay = gp.axes[1] || 0;
  const down = {
    up: btn(12) || ay < -0.5,
    down: btn(13) || ay > 0.5,
    left: btn(14) || ax < -0.5,
    right: btn(15) || ax > 0.5
  };
  Object.keys(down).forEach((dir) => {
    const st = oskDir[dir];
    if (!down[dir]) { oskDir[dir] = null; return; }
    if (st === null) {
      oskDir[dir] = { since: now, last: now };
      oskMoveSel(dir);
    } else if (now - st.since > OSK_DIR_REPEAT_DELAY_MS && now - st.last >= OSK_DIR_REPEAT_INTERVAL_MS) {
      st.last = now;
      oskMoveSel(dir);
    }
  });

  const aNow = btn(PAD.confirm);
  if (aNow && !oskAPrev) {
    const cur = oskKeyEls[oskSel.row] && oskKeyEls[oskSel.row][oskSel.col];
    if (cur) oskPress(cur.getAttribute('data-key'));
  }
  oskAPrev = aNow;

  // Ziel verschwunden (Seite hat das Feld entfernt)? Dann Tastatur schließen
  if (oskTarget && !oskTarget.isConnected) oskClose();
}

// Automatisch öffnen, wenn per Controller ein Textfeld fokussiert wird
document.addEventListener('focusin', (e) => {
  const t = focusTargetOf(e);
  if (isEditableElement(t) && controllerInUse()) oskTryOpen();
}, true);

// Verliert das Ziel-Feld den Fokus: auf ein anderes Textfeld umziehen oder schließen
document.addEventListener('focusout', (e) => {
  if (!oskVisible || focusTargetOf(e) !== oskTarget) return;
  setTimeout(() => {
    if (!oskVisible) return;
    const cur = deepActiveElement();
    if (cur === oskTarget) return;
    oskClose();
    if (isEditableElement(cur) && controllerInUse()) oskTryOpen();
  }, 60);
}, true);

// App wird ausgeblendet (minimiert, Umschalter, ...): Tastatur schließen
ipcRenderer.on('app-view-hidden', () => {
  oskClose();
});


// ---------- Browser-Leiste (nur in Apps vom Typ "browser") ----------
// Eine Leiste am oberen Rand mit Zurück, Vor, Neu laden/Stopp, Startseite und Adressleiste. Ob diese App eine
// Browser-App ist, entscheidet der Hauptprozess (browser-get-state liefert sonst null) - dann bleibt hier alles aus.
//   - Die Leiste liegt in einem GESCHLOSSENEN Shadow-DOM: Die besuchte Seite kann sie weder auslesen noch verändern
//     (sonst könnte sie z.B. eine falsche Adresse vortäuschen).
//   - Deshalb sieht die Fokus-Erkennung des Dokuments das Adressfeld nicht. Die Leiste meldet Fokus und
//     Bildschirmtastatur selbst (barOnAddressFocus/-Blur); deepActiveElement() und deepElementFromPoint() fragen sie mit.
//   - Mausklicks, Tasten und Mausrad in der Leiste erreichen die Seite nicht (sonst würden z.B. YouTube-Tastenkürzel
//     beim Tippen einer Adresse auslösen).
//   - Aufbau NUR per createElement/createElementNS/textContent, Stile per konstruiertem Stylesheet (wie bei der
//     Bildschirmtastatur: strenge Seitenrichtlinien blockieren innerHTML und eingefügte <style>-Elemente).
//   - Klicks zählen nur als echte Eingaben (isTrusted). Befehle gehen als 'browser-command' an den Hauptprozess,
//     der den Absender prüft.
const BAR_CSS = `
:host { all: initial; }
.wrap { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647; font-family: Arial, sans-serif; user-select: none; pointer-events: none; }
.bar {
  pointer-events: auto; display: flex; align-items: center; gap: 10px; box-sizing: border-box; height: 64px; padding: 10px 16px;
  background: rgba(30, 30, 32, 0.92); -webkit-backdrop-filter: blur(18px) saturate(140%); backdrop-filter: blur(18px) saturate(140%);
  border-bottom: 1.5px solid rgba(200, 200, 200, 0.14); transition: transform 0.2s ease, opacity 0.2s ease;
}
.wrap.hidden .bar { transform: translateY(-100%); opacity: 0; pointer-events: none; }
button {
  all: unset; box-sizing: border-box; width: 44px; height: 44px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
  border-radius: 12px; background: rgba(255, 255, 255, 0.12); color: #fff; cursor: pointer; transition: background 0.12s ease, transform 0.12s ease;
}
button:hover { background: rgba(255, 255, 255, 0.3); transform: scale(1.06); }
button[disabled] { opacity: 0.35; cursor: default; pointer-events: none; }
svg { width: 24px; height: 24px; stroke: currentColor; fill: none; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
.reload .stop-icon, .reload.loading .reload-icon { display: none; }
.reload.loading .stop-icon { display: block; }
.addr {
  flex: 1 1 auto; min-width: 0; height: 44px; box-sizing: border-box; padding: 0 16px; border-radius: 12px; border: 1.5px solid transparent;
  background: rgba(0, 0, 0, 0.45); color: #fff; font-size: 18px; font-family: inherit; outline: none; user-select: text;
}
.addr::placeholder { color: rgba(255, 255, 255, 0.4); }
.addr:focus { border-color: rgba(120, 170, 255, 0.9); background: rgba(0, 0, 0, 0.6); }
.handle {
  display: none; pointer-events: auto; position: absolute; top: 0; left: 50%; width: 76px; height: 24px; margin-left: -38px;
  border-radius: 0 0 12px 12px; background: rgba(30, 30, 32, 0.8);
}
.handle svg { width: 20px; height: 20px; }
.wrap.hidden .handle { display: flex; }
.notice {
  position: absolute; top: 76px; left: 50%; transform: translateX(-50%); max-width: 70vw; box-sizing: border-box; padding: 10px 18px; border-radius: 12px;
  background: rgba(30, 30, 32, 0.94); border: 1.5px solid rgba(200, 200, 200, 0.14); color: #fff; font-size: 16px; opacity: 0; transition: opacity 0.2s ease;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.notice.visible { opacity: 1; }
`;

const BAR_ICONS = {
  back: ['M15 5l-7 7 7 7'],
  forward: ['M9 5l7 7-7 7'],
  reload: ['M20 12a8 8 0 1 1-2.6-5.9', 'M20 4v5h-5'],
  stop: ['M6 6l12 12', 'M18 6L6 18'],
  home: ['M4 11l8-7 8 7', 'M6 10v10h4v-6h4v6h4V10'],
  up: ['M6 15l6-6 6 6'],
  down: ['M6 9l6 6 6-6']
};

let barState = null;        // letzter Zustand vom Hauptprozess
let barEls = {};
let barSubmitted = false;   // Adresse wurde mit Enter abgeschickt: beim Verlassen des Feldes den Text stehen lassen
let barFocusPending = false;

function barIcon(name, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  if (className) svg.setAttribute('class', className);
  BAR_ICONS[name].forEach((d) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  });
  return svg;
}

function barButton(command, label, icons) {
  const btn = document.createElement('button');
  btn.setAttribute('data-cmd', command);
  btn.setAttribute('aria-label', label);
  btn.title = label;
  icons.forEach((icon) => btn.appendChild(icon));
  return btn;
}

function barSend(command) {
  ipcRenderer.send('browser-command', command);
}

function barRenderAddress() {
  if (!barHost || !barState || barRoot.activeElement === barEls.input) return; // beim Tippen nichts überschreiben
  barEls.input.value = barState.url || '';
}

function barRender() {
  if (!barHost || !barState) return;
  const s = barState;
  barEls.wrap.classList.toggle('hidden', !s.barVisible);
  barEls.back.disabled = !s.canGoBack;
  barEls.forward.disabled = !s.canGoForward;
  barEls.reload.classList.toggle('loading', !!s.loading);
  barEls.reload.setAttribute('data-mode', s.loading ? 'stop' : 'reload');
  const label = s.loading ? 'Stopp' : 'Neu laden';
  barEls.reload.setAttribute('aria-label', label);
  barEls.reload.title = label;
  barRenderAddress();
  barEls.notice.textContent = s.notice || '';
  barEls.notice.classList.toggle('visible', !!s.notice);
}

// Das Adressfeld liegt im geschlossenen Bereich - Fokus und Tastatur deshalb selbst melden
function barOnAddressFocus() {
  ipcRenderer.send('input-focus-changed', true);
  setTimeout(() => { if (barRoot.activeElement === barEls.input) barEls.input.select(); }, 0);
  if (controllerInUse()) oskTryOpen();
}

function barOnAddressBlur() {
  ipcRenderer.send('input-focus-changed', false);
  if (!barSubmitted) barRenderAddress(); // nicht abgeschickte Eingabe verwerfen
  barSubmitted = false;
  if (oskVisible && oskTarget === barEls.input) {
    setTimeout(() => { if (oskVisible && deepActiveElement() !== oskTarget) oskClose(); }, 60);
  }
}

function barFocusAddress() {
  if (!barHost) { barFocusPending = true; return; }
  barEls.input.focus();
}

function barSubmitAddress() {
  const text = barEls.input.value;
  barSubmitted = true;
  barEls.input.blur();
  barSend({ type: 'navigate', text });
}

// Tasten, die im Adressfeld landen, sehen Seitenskripte nicht - auch nicht solche, die in der Einfangphase am
// window/document lauschen (so arbeiten z.B. die Tastenkürzel von Streamingseiten). Dazu muss sie als erster Hörer
// am window angemeldet sein (siehe initBrowserBar). Die Standardaktion (Zeichen einfügen) bleibt erhalten;
// weil die Taste das Adressfeld selbst nicht mehr erreicht, werden Enter und Esc hier behandelt.
function barKeyShield(e) {
  if (!barHost || document.activeElement !== barHost || barRoot.activeElement !== barEls.input) return;
  if (e.type === 'keydown' && e.isTrusted) {
    if (e.key === 'Enter') barSubmitAddress();
    else if (e.key === 'Escape') barEls.input.blur();
  }
  e.stopImmediatePropagation();
}

function barBuild() {
  if (barHost) return;
  barHost = document.createElement('div');
  barHost.style.cssText = 'position:fixed; left:0; top:0; width:0; height:0; z-index:2147483647;';
  barRoot = barHost.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(BAR_CSS);
  barRoot.adoptedStyleSheets = [sheet];

  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  const bar = document.createElement('div');
  bar.className = 'bar';

  const back = barButton('back', 'Zurück', [barIcon('back')]);
  const forward = barButton('forward', 'Vor', [barIcon('forward')]);
  const reload = barButton('reload', 'Neu laden', [barIcon('reload', 'reload-icon'), barIcon('stop', 'stop-icon')]);
  reload.classList.add('reload');
  const home = barButton('home', 'Startseite', [barIcon('home')]);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'addr';
  input.spellcheck = false;
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('aria-label', 'Adresse oder Suchbegriff');
  input.placeholder = 'Adresse oder Suchbegriff eingeben';
  const hide = barButton('hide', 'Leiste ausblenden', [barIcon('up')]);
  [back, forward, reload, home, input, hide].forEach((el) => bar.appendChild(el));

  const handle = barButton('show', 'Leiste einblenden', [barIcon('down')]);
  handle.classList.add('handle');
  const notice = document.createElement('div');
  notice.className = 'notice';
  wrap.appendChild(bar);
  wrap.appendChild(handle);
  wrap.appendChild(notice);
  barRoot.appendChild(wrap);
  barEls = { wrap, bar, back, forward, reload, home, input, hide, handle, notice };

  // Die Seite darf von Eingaben in der Leiste nichts mitbekommen
  ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup', 'keypress'].forEach((type) => {
    wrap.addEventListener(type, (e) => e.stopPropagation());
  });
  // Knöpfe nehmen den Fokus nicht aus dem Textfeld der Seite - nur das Adressfeld darf ihn bekommen
  wrap.addEventListener('mousedown', (e) => { if (e.target !== input) e.preventDefault(); });

  wrap.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const btn = e.target.closest ? e.target.closest('button[data-cmd]') : null;
    if (!btn || btn.disabled) return;
    const cmd = btn.getAttribute('data-cmd');
    if (cmd === 'reload') barSend({ type: barState && barState.loading ? 'stop' : 'reload' });
    else if (cmd === 'hide') barSend({ type: 'bar-visible', visible: false });
    else if (cmd === 'show') barSend({ type: 'bar-visible', visible: true });
    else barSend({ type: cmd });
  });

  input.addEventListener('focus', barOnAddressFocus);
  input.addEventListener('blur', barOnAddressBlur);

  document.documentElement.appendChild(barHost); // direkt an <html>, nicht an <body> (Seiten tauschen den Body-Inhalt teils aus)
  barRender();
  if (barFocusPending) { barFocusPending = false; barEls.input.focus(); }
}

function initBrowserBar() {
  // Gleich beim Start anmelden, nicht erst beim Aufbau der Leiste: Nur so ist die Abschirmung der erste Hörer am
  // window, noch vor den Skripten der Seite (die sich sonst vorher anmelden und vor uns drankommen). In Apps ohne
  // Leiste kehrt sie sofort zurück.
  ['keydown', 'keyup', 'keypress'].forEach((type) => window.addEventListener(type, barKeyShield, true));
  ipcRenderer.on('browser-state', (event, state) => {
    barState = state;
    barRender();
  });
  ipcRenderer.on('browser-focus-address', barFocusAddress);
  ipcRenderer.invoke('browser-get-state').then((state) => {
    if (!state) return; // keine Browser-App
    barState = state;
    if (document.documentElement) barBuild();
    else document.addEventListener('DOMContentLoaded', barBuild, { once: true });
  }).catch(() => {});
}

initBrowserBar();
