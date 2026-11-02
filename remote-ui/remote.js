// Fernbedienung (Handy-Seite): Touchfläche, Zurück, Play/Pause, Home, Lautstärke und Tastatur-Blatt.
// Sendet kleine JSON-Nachrichten über WebSocket an den Launcher (siehe remote-control.js) und zeigt dessen Zustand an.
(function () {
  'use strict';

  // ---------- Einstellungen ----------
  const STEP_PX = 44;               // so weit wischen = ein Schritt (Fokus eine Kachel weiter)
  const TAP_MAX_MS = 320;           // kürzer und kaum bewegt = Tippen
  const TAP_MAX_MOVE_PX = 10;
  const LONG_PRESS_MS = 550;        // Halten auf der Touchfläche: Zeigermodus umschalten
  const BTN_LONG_MS = 500;          // Halten von Zurück/Home
  const HOME_DOUBLE_MS = 260;       // zweiter Druck innerhalb dieser Zeit = Doppeltippen
  const INERTIA_MIN_SPEED = 0.55;   // px/ms beim Loslassen: ab hier läuft der Wisch nach
  const INERTIA_STEP_MS = 85;
  const INERTIA_MAX_STEPS = 10;
  const FLICK_MIN_PX = 16;          // ein kurzes Wischen ab dieser Strecke zählt als ein Schritt
  const POINTER_GAIN = 1.5;         // Zeigerbewegung: Grundverstärkung
  const POINTER_ACCEL = 0.9;        // zusätzlich je px/ms (schnelle Bewegungen laufen weiter)
  const SCROLL_GAIN = 2.2;
  const PING_MS = 4000;
  const DEAD_MS = 10000;            // so lange keine Antwort = Verbindung gilt als tot

  const $ = (id) => document.getElementById(id);
  const remote = $('remote'), pad = $('pad'), glow = $('glow'), chip = $('chip'), hint = $('hint');
  const overlayText = $('overlay-text'), overlayBtn = $('overlay-btn'), topTitle = $('top-title');
  const volume = $('volume'), volFill = $('vol-fill'), volLabel = $('vol-label');
  const btnPlay = $('btn-play'), btnBack = $('btn-back'), btnHome = $('btn-home');
  const kbBtn = $('kb-btn'), sheet = $('sheet'), sheetInput = $('sheet-input'), sheetLabel = $('sheet-label'), sheetDone = $('sheet-done');

  const params = new URLSearchParams(location.search);
  const token = params.get('t') || '';

  const state = { app: false, pointer: false, browser: false, volume: 100, single: false };
  // Einstellungen vom Fernseher (Einstellungen > Eingabegeräte > Smartphone); bis sie ankommen gelten die Standardwerte
  const config = { pointerSpeed: 100, swipeSpeed: 100, momentum: true, momentumMax: 3 };
  let keyboard = { open: false };
  let ws = null;
  let conn = 'connecting';           // 'connecting' | 'open' | 'closed' | 'replaced' | 'badtoken' | 'stopped'
  let retry = 0;
  let retryTimer = null;
  let pingTimer = null;
  let lastHeard = 0;

  // ---------- Verbindung ----------
  function setConn(next, text, buttonText) {
    conn = next;
    remote.dataset.conn = next === 'open' ? 'open' : (next === 'connecting' ? 'connecting' : 'closed');
    overlayText.textContent = text || '';
    overlayBtn.hidden = !buttonText;
    if (buttonText) overlayBtn.textContent = buttonText;
    topTitle.textContent = next === 'open' ? 'Verbunden' : 'Medialauncher';
    if (next !== 'open') { closeSheet(); }
  }

  function send(message) {
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(message)); return true; } catch (err) { return false; } }
    return false;
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    const wait = Math.min(5000, 800 * Math.pow(1.7, retry++));
    retryTimer = setTimeout(connect, wait);
  }

  function connect() {
    clearTimeout(retryTimer);
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    setConn('connecting', 'Verbinde mit dem Launcher …');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket;
    try {
      socket = new WebSocket(`${proto}//${location.host}/ws${token ? '?t=' + encodeURIComponent(token) : ''}`);
    } catch (err) {
      setConn('closed', 'Keine Verbindung zum Launcher.', 'Verbinden');
      scheduleRetry();
      return;
    }
    ws = socket;
    socket.onopen = () => {
      if (ws !== socket) return;
      retry = 0;
      lastHeard = Date.now();
      setConn('open');
      startPing();
    };
    socket.onmessage = (event) => {
      if (ws !== socket) return;
      lastHeard = Date.now();
      let msg;
      try { msg = JSON.parse(event.data); } catch (err) { return; }
      handleHost(msg);
    };
    socket.onclose = (event) => {
      if (ws !== socket) return;
      ws = null;
      stopPing();
      if (event.code === 4001) { setConn('replaced', 'Der Launcher wird gerade von einem anderen Smartphone gesteuert.', 'Hier verwenden'); return; }
      if (event.code === 4003) { setConn('badtoken', 'Der Code ist ungültig oder wurde erneuert. Bitte den QR-Code am Fernseher noch einmal scannen.'); return; }
      if (event.code === 4000) { setConn('stopped', 'Die Fernbedienung wurde am Launcher ausgeschaltet oder der Code erneuert.', 'Verbinden'); return; }
      setConn('closed', 'Keine Verbindung zum Launcher.', 'Verbinden');
      scheduleRetry();
    };
    socket.onerror = () => { /* onclose folgt */ };
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
      if (Date.now() - lastHeard > DEAD_MS) { // keine Antwort: Verbindung ist weg
        try { ws && ws.close(); } catch (err) { /* schon zu */ }
        return;
      }
      send({ t: 'ping' });
    }, PING_MS);
  }
  function stopPing() { clearInterval(pingTimer); pingTimer = null; }

  overlayBtn.addEventListener('click', () => { retry = 0; try { ws && ws.close(); } catch (err) { /* */ } ws = null; connect(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && conn !== 'open' && conn !== 'badtoken') { retry = 0; connect(); } });
  window.addEventListener('online', () => { if (conn !== 'open' && conn !== 'badtoken') { retry = 0; connect(); } });

  // ---------- Nachrichten vom Launcher ----------
  function handleHost(msg) {
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'state') {
      state.app = !!msg.app; state.pointer = !!msg.pointer; state.browser = !!msg.browser; state.single = !!msg.single;
      if (Number.isFinite(msg.volume) && !volumeDrag) setVolumeView(msg.volume);
      state.volume = Number.isFinite(msg.volume) ? msg.volume : state.volume;
      chip.hidden = !(state.pointer && state.app);
      showHint();
    } else if (msg.t === 'config') {
      if (Number.isFinite(msg.pointerSpeed)) config.pointerSpeed = Math.max(30, Math.min(300, msg.pointerSpeed));
      if (Number.isFinite(msg.swipeSpeed)) config.swipeSpeed = Math.max(50, Math.min(200, msg.swipeSpeed));
      config.momentum = msg.momentum !== false;
      if (Number.isFinite(msg.momentumMax)) config.momentumMax = Math.max(1, Math.min(10, Math.round(msg.momentumMax)));
    } else if (msg.t === 'keyboard') {
      keyboard = msg.open ? { open: true, kind: msg.kind || 'text', value: String(msg.value || ''), label: msg.label || '', multiline: !!msg.multiline } : { open: false };
      applyKeyboard();
    }
  }

  let hintTimer = null;
  function showHint() {
    const text = state.pointer && state.app ? 'Bewegen · Tippen = Klick · Zwei Finger = Scrollen · Halten = Zeiger aus'
      : (state.app ? 'Wischen · Tippen = OK · Halten = Zeiger' : 'Wischen · Tippen = OK · Halten = App-Menü');
    hint.textContent = text;
    hint.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.remove('show'), 3500);
  }

  // ---------- Touchfläche ----------
  const touches = new Map(); // pointerId -> { x, y, sx, sy, st, samples: [[t,x,y]] }
  let gesture = null;        // { mode, ... } für den ersten Finger
  let moveQueue = { dx: 0, dy: 0 };
  let scrollQueue = 0;
  let rafId = 0;
  let inertiaTimers = [];
  let gestureCounter = 0;    // jede Berührung bekommt eine Nummer (der Launcher begrenzt die Schritte je Berührung)

  function placeGlow(x, y) {
    const rect = pad.getBoundingClientRect();
    glow.style.transform = `translate(${x - rect.left}px, ${y - rect.top}px)`;
  }

  function flushQueues() {
    rafId = 0;
    if (moveQueue.dx || moveQueue.dy) {
      send({ t: 'move', dx: Math.round(moveQueue.dx * 10) / 10, dy: Math.round(moveQueue.dy * 10) / 10 });
      moveQueue = { dx: 0, dy: 0 };
    }
    if (scrollQueue) {
      send({ t: 'scroll', dy: Math.round(scrollQueue) });
      scrollQueue = 0;
    }
  }
  function queueFlush() { if (!rafId) rafId = requestAnimationFrame(flushQueues); }

  function cancelInertia() { inertiaTimers.forEach(clearTimeout); inertiaTimers = []; }

  function directionOf(dx, dy) {
    return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
  }

  function velocity(samples) {
    const now = samples[samples.length - 1];
    let first = samples[0];
    for (let i = samples.length - 1; i >= 0; i--) { if (now[0] - samples[i][0] <= 110) first = samples[i]; else break; }
    const dt = Math.max(1, now[0] - first[0]);
    return { vx: (now[1] - first[1]) / dt, vy: (now[2] - first[2]) / dt };
  }

  // Wie viele Fokusschritte ein einzelner Wisch auslösen darf: ohne Schwung oder in Ansichten mit "genau ein Element pro Wisch"
  // (Bildschirmschoner, Topshelf) eines, sonst das erste plus die erlaubten übersprungenen
  function stepLimit() {
    return state.single || !config.momentum ? 1 : 1 + config.momentumMax;
  }

  function sendNav(g, dir) {
    if (g.steps >= stepLimit()) return false;
    g.steps += 1;
    send({ t: 'nav', dir, g: g.no });
    return true;
  }

  // Fokusmodus: je Wischstrecke (STEP_PX, bei höherer Geschwindigkeit kürzer) ein Schritt in die vorherrschende Richtung
  function stepFocus(g) {
    const stepPx = STEP_PX * 100 / config.swipeSpeed;
    while (Math.abs(g.accX) >= stepPx || Math.abs(g.accY) >= stepPx) {
      const dir = directionOf(g.accX, g.accY);
      if (!sendNav(g, dir)) { g.accX = 0; g.accY = 0; return; } // Grenze erreicht: der Rest dieses Wischs zählt nicht mehr
      if (dir === 'left' || dir === 'right') { g.accX -= Math.sign(g.accX) * stepPx; g.accY = 0; }
      else { g.accY -= Math.sign(g.accY) * stepPx; g.accX = 0; }
    }
  }

  pad.addEventListener('pointerdown', (e) => {
    if (conn !== 'open') return;
    if (e.target && e.target.closest && e.target.closest('.a2hs')) return; // Tipp-Karte: normales Tippen (sonst würde die Touchfläche den Klick abfangen)
    e.preventDefault();
    try { pad.setPointerCapture(e.pointerId); } catch (err) { /* nicht möglich */ }
    cancelInertia();
    const now = performance.now();
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, st: now, samples: [[now, e.clientX, e.clientY]] });
    pad.classList.add('touching');
    placeGlow(e.clientX, e.clientY);

    if (touches.size === 1) {
      gesture = { mode: 'single', no: ++gestureCounter, steps: 0, accX: 0, accY: 0, moved: false, long: false, longTimer: null, id: e.pointerId };
      gesture.longTimer = setTimeout(() => {
        if (!gesture || gesture.moved || gesture.mode !== 'single' || touches.size !== 1) return;
        gesture.long = true;
        if (state.app) send({ t: 'pointer', value: 'toggle' });
        else send({ t: 'select', long: true }); // Startseite: App-Menü (wie langes Enter am Controller)
      }, LONG_PRESS_MS);
    } else if (gesture) { // zweiter Finger: Scrollen
      clearTimeout(gesture.longTimer);
      gesture.mode = 'scroll';
      gesture.moved = true;
    }
  });

  pad.addEventListener('pointermove', (e) => {
    const t = touches.get(e.pointerId);
    if (!t || !gesture) return;
    e.preventDefault();
    const now = performance.now();
    const dx = e.clientX - t.x, dy = e.clientY - t.y;
    t.x = e.clientX; t.y = e.clientY;
    t.samples.push([now, e.clientX, e.clientY]);
    if (t.samples.length > 12) t.samples.shift();
    placeGlow(e.clientX, e.clientY);

    if (gesture.mode === 'scroll') {
      // Beide Finger: Mittelwert der Bewegung; Finger nach oben = Inhalt nach unten (natürliches Scrollen)
      scrollQueue += (-dy / touches.size) * SCROLL_GAIN * (config.pointerSpeed / 100);
      queueFlush();
      return;
    }
    if (gesture.id !== e.pointerId) return;

    const dist = Math.hypot(e.clientX - t.sx, e.clientY - t.sy);
    if (!gesture.moved && dist > TAP_MAX_MOVE_PX) {
      gesture.moved = true;
      clearTimeout(gesture.longTimer);
      gesture.accX = e.clientX - t.sx; gesture.accY = e.clientY - t.sy; // die Strecke bis hierher zählt mit
      if (!(state.pointer && state.app)) { // Fokusmodus: das erste Stück wurde schon in die Summe übernommen
        stepFocus(gesture);
        return;
      }
    }
    if (!gesture.moved) return;

    if (state.pointer && state.app) {
      // Zeigermodus: Bewegung mit leichter Beschleunigung weitergeben
      const dt = Math.max(1, now - (t.samples.length > 1 ? t.samples[t.samples.length - 2][0] : now - 16));
      const speed = Math.hypot(dx, dy) / dt;
      const gain = (POINTER_GAIN + POINTER_ACCEL * Math.min(speed, 3)) * (config.pointerSpeed / 100);
      moveQueue.dx += dx * gain;
      moveQueue.dy += dy * gain;
      queueFlush();
    } else {
      // Fokusmodus: je STEP_PX Wischen ein Schritt in die vorherrschende Richtung
      gesture.accX += dx; gesture.accY += dy;
      stepFocus(gesture);
    }
  });

  function endTouch(e) {
    const t = touches.get(e.pointerId);
    if (!t) return;
    touches.delete(e.pointerId);
    try { pad.releasePointerCapture(e.pointerId); } catch (err) { /* schon frei */ }
    if (touches.size === 0) pad.classList.remove('touching');
    if (!gesture) return;
    const g = gesture;
    const duration = performance.now() - t.st;

    if (g.mode === 'single' && g.id === e.pointerId) {
      clearTimeout(g.longTimer);
      if (e.type === 'pointerup' && !g.moved && !g.long && duration <= TAP_MAX_MS) {
        send({ t: state.pointer && state.app ? 'click' : 'select' });
      } else if (e.type === 'pointerup' && g.moved && !(state.pointer && state.app)) {
        const dxAll = t.x - t.sx, dyAll = t.y - t.sy;
        // Kurzes, schnelles Wischen (Flick), das die Strecke für einen Schritt nicht erreicht hat: trotzdem ein Element weiter
        if (g.steps === 0 && Math.hypot(dxAll, dyAll) >= FLICK_MIN_PX) sendNav(g, directionOf(dxAll, dyAll));
        // Schwung: noch ein paar Schritte hinterher, höchstens bis zur erlaubten Zahl
        const room = stepLimit() - g.steps;
        const v = velocity(t.samples);
        const speed = Math.hypot(v.vx, v.vy);
        if (room > 0 && speed >= INERTIA_MIN_SPEED) {
          const dir = directionOf(v.vx, v.vy);
          const steps = Math.min(INERTIA_MAX_STEPS, Math.floor(speed * 3), room);
          for (let i = 1; i <= steps; i++) inertiaTimers.push(setTimeout(() => sendNav(g, dir), i * INERTIA_STEP_MS * (1 + i * 0.25)));
        }
      }
      gesture = null;
    } else if (g.mode === 'scroll' && touches.size === 0) {
      gesture = null;
    }
    if (touches.size === 0 && g.mode === 'scroll') gesture = null;
  }
  pad.addEventListener('pointerup', endTouch);
  pad.addEventListener('pointercancel', endTouch);
  pad.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------- Kein Zoomen (iOS Safari) ----------
  // Safari ignoriert "user-scalable=no" und zoomt bei schnellem Doppeltippen und beim Spreizen mit zwei Fingern. Das Doppeltippen kommt
  // auf der Touchfläche ständig vor (zwei schnelle Tipps), deshalb wird hier alles abgefangen, was Safari dafür auswertet.
  // Ausgenommen sind nur Elemente, die über "click" arbeiten: dort würde das Verschlucken des zweiten Tipps den Klick verhindern.
  (function blockZoom() {
    const CLICK_ELEMENTS = '.vol-btn, .kb-btn, .sheet, .overlay, .a2hs';
    const DOUBLE_TAP_MS = 400;
    let lastTouchEnd = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      const target = e.target;
      const needsClick = !!(target && target.closest && target.closest(CLICK_ELEMENTS));
      if (now - lastTouchEnd < DOUBLE_TAP_MS && !needsClick && e.cancelable) e.preventDefault(); // zweiter Tipp: Zoom-Geste unterdrücken
      lastTouchEnd = now;
    }, { passive: false });
    document.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches.length > 1 && !(e.target && e.target.closest && e.target.closest('.sheet')) && e.cancelable) e.preventDefault(); // Spreizen mit zwei Fingern
    }, { passive: false });
    for (const name of ['gesturestart', 'gesturechange', 'gestureend']) { // Safari-eigene Zoom-Gesten
      document.addEventListener(name, (e) => e.preventDefault(), { passive: false });
    }
    document.addEventListener('dblclick', (e) => e.preventDefault());
  })();

  // ---------- Tasten unten ----------
  function pressable(button, handlers) {
    let timer = null;
    let longDone = false;
    let id = null;
    button.addEventListener('pointerdown', (e) => {
      if (conn !== 'open') return;
      e.preventDefault();
      id = e.pointerId;
      try { button.setPointerCapture(id); } catch (err) { /* nicht möglich */ }
      button.classList.add('down');
      longDone = false;
      if (handlers.long) timer = setTimeout(() => { longDone = true; button.classList.remove('down'); handlers.long(); }, BTN_LONG_MS);
    });
    const release = (e, cancel) => {
      if (id !== e.pointerId) return;
      id = null;
      clearTimeout(timer);
      button.classList.remove('down');
      if (!cancel && !longDone) handlers.tap();
    };
    button.addEventListener('pointerup', (e) => release(e, false));
    button.addEventListener('pointercancel', (e) => release(e, true));
    button.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  pressable(btnPlay, { tap: () => send({ t: 'playpause' }) });
  pressable(btnBack, { tap: () => send({ t: 'back' }), long: () => send({ t: 'back', long: true }) });

  // Home: einmal = Startseite, zweimal = App-Umschalter, lang = Schnellmenü. Die Startseite wartet kurz auf einen zweiten Druck.
  let homeTimer = null;
  pressable(btnHome, {
    tap: () => {
      if (homeTimer) { clearTimeout(homeTimer); homeTimer = null; send({ t: 'home', kind: 'double' }); return; }
      homeTimer = setTimeout(() => { homeTimer = null; send({ t: 'home', kind: 'single' }); }, HOME_DOUBLE_MS);
    },
    long: () => { clearTimeout(homeTimer); homeTimer = null; send({ t: 'home', kind: 'long' }); }
  });

  // ---------- Lautstärke ----------
  let volumeDrag = null;
  let volumeHideTimer = null;
  let lastVolumeSent = -1;
  let lastVolumeAt = 0;

  function setVolumeView(value) {
    const v = Math.max(0, Math.min(100, Math.round(value)));
    volFill.style.height = v + '%';
    volLabel.textContent = String(v);
    volume.setAttribute('aria-valuenow', String(v));
    volume.dataset.value = String(v);
  }
  setVolumeView(100);

  // Lautstärke-Symbol oben links: Regler ein-/ausblenden (gegen versehentliches Verstellen). Beim Öffnen der Seite ist der Regler ausgeblendet
  // (Anfangszustand in index.html: Klasse "hidden", aria-pressed="false"); die Wahl wird nicht gemerkt
  const volBtn = $('vol-btn');
  volBtn.addEventListener('click', () => {
    const on = volume.classList.contains('hidden'); // war aus -> jetzt an
    volume.classList.toggle('hidden', !on);
    volBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (!on && volumeDrag) { volumeDrag = null; volume.classList.remove('active'); }
  });

  function sendVolume(v, force) {
    const now = performance.now();
    if (v === lastVolumeSent) return;
    if (!force && now - lastVolumeAt < 60) return;
    lastVolumeAt = now;
    lastVolumeSent = v;
    send({ t: 'volume', value: v });
  }

  volume.addEventListener('pointerdown', (e) => {
    if (conn !== 'open') return;
    e.preventDefault();
    try { volume.setPointerCapture(e.pointerId); } catch (err) { /* nicht möglich */ }
    const track = volume.querySelector('.vol-track').getBoundingClientRect();
    volumeDrag = { id: e.pointerId, startY: e.clientY, startValue: Number(volume.dataset.value || state.volume), height: Math.max(80, track.height) };
    volume.classList.add('active');
    clearTimeout(volumeHideTimer);
  });
  volume.addEventListener('pointermove', (e) => {
    if (!volumeDrag || volumeDrag.id !== e.pointerId) return;
    e.preventDefault();
    const v = Math.max(0, Math.min(100, Math.round(volumeDrag.startValue + (volumeDrag.startY - e.clientY) / volumeDrag.height * 100)));
    setVolumeView(v);
    sendVolume(v, false);
  });
  function endVolume(e) {
    if (!volumeDrag || volumeDrag.id !== e.pointerId) return;
    const v = Number(volume.dataset.value);
    sendVolume(v, true);
    volumeDrag = null;
    volume.classList.remove('active');
    volume.classList.add('recent');
    volumeHideTimer = setTimeout(() => volume.classList.remove('recent'), 1200);
  }
  volume.addEventListener('pointerup', endVolume);
  volume.addEventListener('pointercancel', endVolume);

  // ---------- Tastatur-Blatt ----------
  // Der Text des Handys wird mit dem zuletzt gesendeten verglichen: gemeinsamer Anfang bleibt, der Rest wird am Fernseher
  // gelöscht und neu getippt (das Textfeld am Fernseher hat den Cursor am Ende). So funktionieren Autokorrektur und Einfügen.
  let mirror = '';
  let dismissed = false;     // "Fertig" gedrückt: nicht von selbst wieder öffnen, bis am Fernseher ein neues Feld Fokus bekommt
  let composing = false;
  let lastEditAt = 0;

  function codepoints(text) { return Array.from(text); }

  function diffAndSend(next) {
    const a = codepoints(mirror), b = codepoints(next);
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    const del = a.length - p;
    const ins = b.slice(p).join('');
    mirror = next;
    if (del || ins) { lastEditAt = Date.now(); send({ t: 'edit', del, ins }); }
  }

  sheetInput.addEventListener('compositionstart', () => { composing = true; });
  sheetInput.addEventListener('compositionend', () => { composing = false; diffAndSend(sheetInput.value); });
  sheetInput.addEventListener('input', () => { if (!composing) diffAndSend(sheetInput.value); });
  sheetInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send({ t: 'key', key: 'Return' }); return; }
    if (e.key === 'Backspace' && sheetInput.value === '' && mirror === '') send({ t: 'key', key: 'Backspace' }); // leeres Feld: trotzdem ein Zeichen am Fernseher löschen
  });
  sheetDone.addEventListener('click', () => { dismissed = true; closeSheet(); });

  function closeSheet() {
    sheet.hidden = true;
    try { sheetInput.blur(); } catch (err) { /* */ }
    updateKbButton();
  }

  function openSheet(focus) {
    sheet.hidden = false;
    adjustSheet();
    if (focus) { try { sheetInput.focus(); const n = sheetInput.value.length; sheetInput.setSelectionRange(n, n); } catch (err) { /* */ } }
    updateKbButton();
  }

  function applyKeyboard() {
    if (!keyboard.open) { dismissed = false; closeSheet(); return; }
    const kind = keyboard.kind;
    sheetInput.type = kind === 'password' ? 'password' : (kind === 'email' ? 'email' : (kind === 'url' ? 'url' : (kind === 'tel' ? 'tel' : 'text')));
    sheetInput.enterKeyHint = keyboard.multiline ? 'enter' : 'go';
    sheetLabel.textContent = keyboard.label || (kind === 'password' ? 'Passwort eingeben' : 'Text eingeben');
    // Beim ersten Öffnen mit dem aktuellen Text des Feldes starten (Passwörter kommen nie vom Fernseher)
    // Danach gilt der Text am Fernseher (z. B. wenn die Seite das Feld nach dem Absenden leert) - außer kurz nach eigenem Tippen
    const settled = Date.now() - lastEditAt > 500 && !composing;
    if (kind !== 'password' && (sheet.hidden || sheetInput.value !== mirror || (settled && (keyboard.value || '') !== mirror))) {
      sheetInput.value = keyboard.value || '';
      mirror = sheetInput.value;
    } else if (sheet.hidden) {
      sheetInput.value = '';
      mirror = '';
    }
    if (!dismissed) openSheet(true); else updateKbButton();
  }

  function updateKbButton() { kbBtn.hidden = !(conn === 'open' && keyboard.open && sheet.hidden); }
  kbBtn.addEventListener('click', () => { dismissed = false; openSheet(true); });

  // Tastatur öffnet sich unten: das Blatt bleibt direkt darüber (iOS verschiebt feste Elemente nicht selbst)
  function adjustSheet() {
    const vv = window.visualViewport;
    if (!vv) return;
    const shift = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
    sheet.style.setProperty('--kb-shift', `${-shift}px`);
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', adjustSheet);
    window.visualViewport.addEventListener('scroll', adjustSheet);
  }

  // ---------- Tipp: Zum Home-Bildschirm (nur iPhone/iPad in Safari, einmalig) ----------
  const a2hs = $('a2hs');
  const A2HS_KEY = 'ml_remote_a2hs_done';
  function a2hsNeeded() {
    const ua = navigator.userAgent || '';
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const standalone = navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    if (!ios || standalone) return false;
    try { return localStorage.getItem(A2HS_KEY) !== '1'; } catch (err) { return true; }
  }
  function showA2hs() {
    if (!a2hs || !a2hsNeeded()) return;
    a2hs.hidden = false;
  }
  $('a2hs-close').addEventListener('click', () => {
    a2hs.hidden = true;
    try { localStorage.setItem(A2HS_KEY, '1'); } catch (err) { /* ohne Speicher: kommt beim nächsten Mal wieder */ }
  });
  setTimeout(showA2hs, 2500);

  // ---------- Start ----------
  showHint();
  connect();
})();
