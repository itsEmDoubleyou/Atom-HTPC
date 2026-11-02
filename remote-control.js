// Fernbedienung per Handy: macht aus den Nachrichten der Handy-Seite Aktionen im Launcher. Die eigentlichen Aktionen
// (Taste an die Startseite schicken, App minimieren, Lautstärke setzen ...) liefert main.js als "deps"; hier steht nur,
// WAS auf welche Nachricht passiert. Dadurch lässt sich die Zuordnung ohne Electron testen.
//
// Nachrichten des Handys (alle mit Feld "t"):
//   nav {dir, g}         Fokus bewegen (up/down/left/right) - in Apps Pfeiltaste an die Seite; g = Nummer der Berührung (Schrittbegrenzung je Wisch)
//   select {long}        Auswählen (Enter bzw. in Apps mit Zeiger: Klick); lang (Halten auf der Startseite): App-Menü der gewählten App
//   click                Klick (Zeigermodus)
//   move {dx, dy}        Zeiger bewegen (nur in Apps mit eingeschaltetem Zeiger)
//   scroll {dy}          Scrollen in Apps
//   pointer {value}      Zeiger ein/aus (true/false/'toggle')
//   back {long}          Zurück (lang: App minimieren)
//   home {kind}          Home: 'single' Startseite, 'double' App-Umschalter, 'long' Schnellmenü
//   playpause            Wiedergabe der aktiven App umschalten
//   volume {value}       Gesamtlautstärke 0-100
//   edit {del, ins}      Text im fokussierten Feld: del Zeichen löschen, dann ins einfügen
//   key {key}            Return/Backspace im fokussierten Feld
//   ping                 Lebenszeichen
const DIRECTIONS = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
const MAX_MOVE_PX = 300;
const MAX_SCROLL_PX = 600;
const MAX_EDIT_DELETE = 500;
const MAX_EDIT_INSERT = 2000;
const TEXT_KEYS = new Set(['Return', 'Backspace']);

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp(value, limit) {
  return Math.max(-limit, Math.min(limit, value));
}

function createRemoteController(deps) {
  // Schritte je Wisch begrenzen: Das Handy numeriert jede Berührung (g) und hält sich selbst an die Grenze; hier wird sie zusätzlich
  // durchgesetzt (Nachläufer, ältere Handy-Seiten). In Ansichten mit "genau ein Element pro Wisch" (ctx.single) gilt immer 1.
  let gestureId = null;
  let gestureSteps = 0;
  function allowStep(msg, ctx) {
    if (!Number.isInteger(msg.g)) return true; // ohne Nummer (z. B. andere Quelle): nicht begrenzen
    if (msg.g !== gestureId) { gestureId = msg.g; gestureSteps = 0; }
    const limit = ctx.single ? 1 : (typeof deps.stepLimit === 'function' ? Math.max(1, deps.stepLimit()) : Infinity);
    if (gestureSteps >= limit) return false;
    gestureSteps += 1;
    return true;
  }

  // Wie geht es mit dem Bildschirmschoner? 'none' = läuft nicht, 'consume' = war eigenständig aktiv und wurde jetzt
  // beendet (die Eingabe weckt nur auf), 'embedded' = läuft als Ebene in der Startseite (sie wertet die Tasten selbst aus)
  function gate() {
    return typeof deps.screensaver === 'function' ? deps.screensaver() : 'none';
  }

  function handle(msg) {
    if (!msg || typeof msg.t !== 'string' || msg.t === 'ping') return;
    if (deps.isBlocked && deps.isBlocked()) return; // Intro, natives Programm o.ä.: nichts bedienbar
    if (deps.noteActivity) deps.noteActivity();
    if (deps.onInput) deps.onInput(); // Anzeige "Handy" im Eingabegerät-Symbol

    const screensaver = gate();
    if (screensaver === 'consume') return;
    const ctx = deps.context();

    if (screensaver === 'embedded') {
      // Bildschirmschoner in der Startseite: Richtungen blättern, Enter/Zurück/Schnellmenü wie am Controller, alles andere weckt auf
      if (msg.t === 'nav' && DIRECTIONS[msg.dir]) { if (allowStep(msg, { single: true })) deps.key(DIRECTIONS[msg.dir]); } // genau ein Bild pro Wisch
      else if (msg.t === 'select' || msg.t === 'click') deps.key('Enter');
      else if (msg.t === 'back') deps.key('Backspace');
      else if (msg.t === 'home' && msg.kind === 'long') deps.key('GamepadQuickMenu');
      else if (msg.t !== 'move' && msg.t !== 'scroll') deps.key('GamepadWake');
      return;
    }

    switch (msg.t) {
      case 'nav': {
        const code = DIRECTIONS[msg.dir];
        if (!code) return;
        if (!allowStep(msg, ctx)) return;
        if (ctx.isApp) deps.appKey(msg.dir); else deps.key(code);
        return;
      }
      case 'select':
      case 'click': {
        if (msg.t === 'select' && msg.long === true && !ctx.isApp) { // Halten auf der Startseite = langes Enter am Controller: App-Menü
          deps.key('GamepadAppMenu');
          return;
        }
        if (ctx.isApp) {
          if (ctx.pointer) deps.pointer.click(); else if (msg.t === 'select') deps.appKey('select');
        } else {
          deps.key('Enter');
        }
        return;
      }
      case 'move': {
        const dx = num(msg.dx), dy = num(msg.dy);
        if (dx === null || dy === null || !ctx.isApp || !ctx.pointer) return;
        deps.pointer.move(clamp(dx, MAX_MOVE_PX), clamp(dy, MAX_MOVE_PX));
        return;
      }
      case 'scroll': {
        const dy = num(msg.dy);
        if (dy === null || !ctx.isApp) return;
        deps.pointer.scroll(clamp(dy, MAX_SCROLL_PX));
        return;
      }
      case 'pointer': {
        if (!ctx.isApp) return;
        if (msg.value === 'toggle') deps.pointer.set(!ctx.pointer);
        else if (typeof msg.value === 'boolean') deps.pointer.set(msg.value);
        return;
      }
      case 'back': {
        if (msg.long === true && ctx.isApp) deps.home(); // lang = App minimieren, wie langes B
        else deps.key('Backspace');
        return;
      }
      case 'home': {
        if (msg.kind === 'double') deps.openSwitcher();
        else if (msg.kind === 'long') deps.openQuickMenu();
        else deps.home();
        return;
      }
      case 'playpause':
        deps.playPause();
        return;
      case 'volume': {
        const value = num(msg.value);
        if (value === null) return;
        deps.setVolume(Math.max(0, Math.min(100, Math.round(value))));
        return;
      }
      case 'edit': {
        const del = Number.isInteger(msg.del) ? Math.max(0, Math.min(MAX_EDIT_DELETE, msg.del)) : 0;
        const ins = typeof msg.ins === 'string' ? msg.ins.slice(0, MAX_EDIT_INSERT) : '';
        if (del === 0 && ins === '') return;
        deps.edit(del, ins);
        return;
      }
      case 'key': {
        if (TEXT_KEYS.has(msg.key)) deps.textKey(msg.key);
        return;
      }
      default:
    }
  }

  return { handle };
}

module.exports = { createRemoteController, DIRECTIONS };
