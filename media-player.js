// Musikplayer-Fenster: zeigt Zeit, Fortschritt und die drei Tasten und meldet Bedienung an den Hauptprozess.
// Das Fenster nimmt keinen Tastaturfokus an (der Launcher behält ihn); verschoben und in der Größe geändert wird es
// über eigene Zieh-Ränder, weil die Fensterkanten bei durchsichtigen Fenstern unter Windows nicht greifbar sind.
const api = window.mediaPlayerAPI;

const player = document.getElementById('player');
const trackEl = document.getElementById('mp-track');
const fillEl = document.getElementById('mp-fill');
const thumbEl = document.getElementById('mp-thumb');
const currentEl = document.getElementById('mp-current');
const durationEl = document.getElementById('mp-duration');
const prevBtn = document.getElementById('mp-prev');
const playBtn = document.getElementById('mp-play');
const nextBtn = document.getElementById('mp-next');
const closeBtn = document.getElementById('mp-close');
const videoBtn = document.getElementById('mp-video');
const iconPlay = document.getElementById('mp-icon-play');
const iconPause = document.getElementById('mp-icon-pause');
const pictureEl = document.getElementById('mp-picture');
const imgEl = document.getElementById('mp-img');
const placeholderEl = document.getElementById('mp-placeholder');
const streamEl = document.getElementById('mp-stream');
const sizeBtns = Array.from(document.querySelectorAll('.mp-size'));
const titleMarquee = window.createTitleMarquee(document.getElementById('mp-title'));

const SEEK_SEND_INTERVAL_MS = 120;  // beim Ziehen am Balken höchstens so oft an die Seite melden
const SEEK_HOLD_MS = 900;           // nach dem Springen die Anzeige so lange nicht von einem älteren Stand überschreiben lassen

let state = {
  available: false, paused: true, current: 0, duration: 0, canPrev: false, canNext: false,
  kind: 'audio', showPicture: false, image: null, baseWidth: 300, title: ''
};
let imageFailed = false;  // das aktuelle Bild ließ sich nicht laden (z.B. Titelbild nicht erreichbar): Platzhalter zeigen
let shownImage = null;
let seeking = false;
let seekValue = 0;
let pendingSeek = null;   // { value, until }
let lastSeekSent = 0;

// Aktuelle Zeit wird abgerundet (wie bei jedem Player), die Gesamtlänge gerundet (19,98 s = 0:20)
function formatTime(seconds, round) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const total = round ? Math.round(seconds) : Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function usableDuration() {
  return state.available && isFinite(state.duration) && state.duration > 0 ? state.duration : 0;
}

function render() {
  const duration = usableDuration();
  const current = Math.max(0, Math.min(duration || Infinity, seeking ? seekValue : state.current));
  const pct = duration ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;
  fillEl.style.width = pct + '%';
  thumbEl.style.left = pct + '%';
  currentEl.textContent = formatTime(state.available ? current : 0);
  durationEl.textContent = formatTime(duration, true);
  titleMarquee.set(state.available ? state.title : '');

  player.dataset.state = state.available ? 'ready' : 'idle';
  player.classList.toggle('seeking', seeking);
  playBtn.disabled = !state.available;
  prevBtn.disabled = !(state.available && state.canPrev);
  nextBtn.disabled = !(state.available && state.canNext);
  // pausiert -> "Abspielen" zeigen, läuft -> "Pause" zeigen (SVG-Elemente haben keine hidden-Eigenschaft, nur das Attribut)
  iconPlay.toggleAttribute('hidden', !state.paused);
  iconPause.toggleAttribute('hidden', state.paused);
  videoBtn.classList.toggle('on', !!state.showPicture);
  videoBtn.setAttribute('aria-pressed', String(!!state.showPicture));
  const pictureLabel = state.showPicture ? 'Bild ausblenden' : 'Bild anzeigen';
  videoBtn.title = pictureLabel;
  videoBtn.setAttribute('aria-label', pictureLabel);
  trackEl.setAttribute('aria-valuemax', String(Math.round(duration)));
  trackEl.setAttribute('aria-valuenow', String(Math.round(current)));
  renderPicture();
  renderSizes();
}

// Größenwahl: die Taste, die zur aktuellen Fensterbreite passt, ist hell (frei gezogene Größen: keine)
function renderSizes() {
  const ratio = window.innerWidth / (state.baseWidth || 300);
  sizeBtns.forEach((btn) => btn.classList.toggle('on', Math.abs(ratio - Number(btn.dataset.scale)) < 0.04));
}
window.addEventListener('resize', renderSizes);

// Bildfläche: Video-Bilder bzw. Titelbild; ohne Bild (kein Titelbild, nichts spielt) ein Platzhalter
function renderPicture() {
  const on = !!state.showPicture;
  if (on && !document.documentElement.classList.contains('with-picture')) wake();
  document.documentElement.classList.toggle('with-picture', on);
  pictureEl.hidden = !on;
  if (!on) {
    if (shownImage) { imgEl.removeAttribute('src'); shownImage = null; }
    closeStream();
    return;
  }
  // Live-Video hat Vorrang vor Standbild/Titelbild
  const live = streamLive && state.available;
  streamEl.hidden = !live;
  const image = state.available ? state.image : null;
  if (image !== shownImage) {
    shownImage = image;
    imageFailed = false;
    if (image) imgEl.src = image; else imgEl.removeAttribute('src');
  }
  const visible = !live && !!image && !imageFailed;
  imgEl.hidden = !visible;
  placeholderEl.hidden = live || visible;
}
imgEl.addEventListener('error', () => { imageFailed = true; renderPicture(); });

// ---------- Live-Video ----------
// Die App-Seite schickt ihr Video-Element als Videostrom (lokale WebRTC-Verbindung, vom Hauptprozess vermittelt).
// Kommt innerhalb von 3 s Wiedergabe kein brauchbares (nicht schwarzes) Bild an, meldet der Player das, und der
// Hauptprozess schaltet für dieses Video auf Standbilder um.
const STREAM_GRACE_MS = 3000;
let pc = null;
let streamLive = false;
let streamWatch = null;
const probeCanvas = document.createElement('canvas');
probeCanvas.width = 8;
probeCanvas.height = 8;
const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });

function closeStream() {
  if (streamWatch) { clearInterval(streamWatch); streamWatch = null; }
  if (pc) { try { pc.close(); } catch (err) { /* schon geschlossen */ } pc = null; }
  if (streamEl.srcObject) streamEl.srcObject = null;
  if (streamLive) { streamLive = false; renderPicture(); }
}

function streamHasPicture() {
  if (!(streamEl.videoWidth > 0)) return false;
  try {
    probeCtx.drawImage(streamEl, 0, 0, 8, 8);
    const px = probeCtx.getImageData(0, 0, 8, 8).data;
    let bright = 0;
    for (let i = 0; i < px.length; i += 4) bright = Math.max(bright, px[i], px[i + 1], px[i + 2]);
    return bright >= 6;
  } catch (err) {
    return true; // nicht prüfbar: das Bild gilt als brauchbar
  }
}

function watchStream(mine) {
  let playingMs = 0;
  if (streamWatch) clearInterval(streamWatch);
  streamWatch = setInterval(() => {
    if (pc !== mine) return;
    if (streamHasPicture()) {
      clearInterval(streamWatch);
      streamWatch = null;
      if (!streamLive) { streamLive = true; renderPicture(); }
      return;
    }
    if (!state.paused) playingMs += 250; // nur zählen, solange das Video wirklich läuft (pausiert kommt kein neues Bild)
    if (playingMs >= STREAM_GRACE_MS) {
      closeStream();
      api.rtcFailed();
    }
  }, 250);
}

function gatheringComplete(connection) {
  return new Promise((resolve) => {
    if (connection.iceGatheringState === 'complete') { resolve(); return; }
    const timer = setTimeout(resolve, 2000);
    connection.addEventListener('icegatheringstatechange', () => {
      if (connection.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
    });
  });
}

api.onRtcOffer(async (offer) => {
  if (!offer || !offer.sdp) return;
  closeStream();
  const mine = new RTCPeerConnection({ iceServers: [] });
  pc = mine;
  mine.ontrack = (event) => {
    if (pc !== mine) return;
    streamEl.srcObject = event.streams[0] || new MediaStream([event.track]);
    const started = streamEl.play();
    if (started && started.catch) started.catch(() => {});
    watchStream(mine);
  };
  try {
    await mine.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    const answer = await mine.createAnswer();
    await mine.setLocalDescription(answer);
    await gatheringComplete(mine);
    if (pc === mine) api.rtcAnswer(mine.localDescription.sdp);
  } catch (err) {
    if (pc === mine) { closeStream(); api.rtcFailed(); }
  }
});
api.onRtcStop(() => closeStream());

api.onState((next) => {
  if (!next) return;
  const incoming = { ...state, ...next };
  // Gerade gesprungen: ein noch älterer Stand der Seite soll die Anzeige nicht zurückspringen lassen
  if (pendingSeek) {
    if (Date.now() > pendingSeek.until || Math.abs(incoming.current - pendingSeek.value) <= 2) pendingSeek = null;
    else incoming.current = pendingSeek.value;
  }
  state = incoming;
  if (!seeking) render();
});

// ---------- Tasten ----------
prevBtn.addEventListener('click', () => { if (!prevBtn.disabled) api.control('prev'); });
nextBtn.addEventListener('click', () => { if (!nextBtn.disabled) api.control('next'); });
playBtn.addEventListener('click', () => { if (!playBtn.disabled) api.control('toggle'); });
closeBtn.addEventListener('click', () => api.close());
sizeBtns.forEach((btn) => btn.addEventListener('click', () => api.setScale(Number(btn.dataset.scale))));
// Bild-Schalter: die Anzeige folgt dem Stand, den der Hauptprozess zurückmeldet (er ändert auch die Fenstergröße)
videoBtn.addEventListener('click', () => api.setPicture(!state.showPicture));

// Der Zeiger soll auch außerhalb des Elements weiter gemeldet werden; schlägt das fehl, geht es trotzdem weiter
function capturePointer(element, event) {
  try { element.setPointerCapture(event.pointerId); } catch (err) { /* kein aktiver Zeiger: ohne Aufnahme weitermachen */ }
}

// ---------- Balken: anklicken oder ziehen zum Springen ----------
function timeFromPointer(event) {
  const rect = trackEl.getBoundingClientRect();
  const fraction = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
  return Math.max(0, Math.min(1, fraction)) * usableDuration();
}

function sendSeek(value, force) {
  const now = performance.now();
  if (!force && now - lastSeekSent < SEEK_SEND_INTERVAL_MS) return;
  lastSeekSent = now;
  api.control('seek', value);
}

trackEl.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !usableDuration()) return;
  event.stopPropagation();
  seeking = true;
  seekValue = timeFromPointer(event);
  capturePointer(trackEl, event);
  render();
  sendSeek(seekValue, true);
});

trackEl.addEventListener('pointermove', (event) => {
  if (!seeking) return;
  seekValue = timeFromPointer(event);
  render();
  sendSeek(seekValue, false);
});

function endSeek() {
  if (!seeking) return;
  seeking = false;
  pendingSeek = { value: seekValue, until: Date.now() + SEEK_HOLD_MS };
  sendSeek(seekValue, true);
  state = { ...state, current: seekValue };
  render();
}
trackEl.addEventListener('pointerup', endSeek);
trackEl.addEventListener('pointercancel', endSeek);

// ---------- Verschieben und Größe ändern ----------
let dragging = false;
let dragFrame = 0;

player.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || dragging) return;
  const noDrag = event.target.closest('[data-nodrag]');
  let mode = 'move';
  if (noDrag) {
    if (!noDrag.dataset.edge) return; // Tasten, Balken und Schließen verschieben nichts
    mode = noDrag.dataset.edge;
  }
  dragging = true;
  capturePointer(player, event);
  api.dragStart(mode);
});

player.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  if (event.buttons === 0) { endDrag(); return; } // Taste wurde irgendwo losgelassen, ohne dass wir es mitbekamen
  if (dragFrame) return;
  dragFrame = requestAnimationFrame(() => {
    dragFrame = 0;
    if (dragging) api.dragMove();
  });
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  if (dragFrame) { cancelAnimationFrame(dragFrame); dragFrame = 0; }
  api.dragEnd();
}
player.addEventListener('pointerup', endDrag);
player.addEventListener('pointercancel', endDrag);
player.addEventListener('lostpointercapture', endDrag);

// Rechtsklick/Kontextmenü gibt es nicht
window.addEventListener('contextmenu', (event) => event.preventDefault());

// ---------- Controller ----------
// Das Fenster hat keinen Tastaturfokus; Steuerkreuz und A kommen als 'media-player-nav' vom Hauptprozess. Der Fokus
// wird hier selbst geführt: oben Bild-Knopf und Schließen, dann der Fortschrittsbalken, Zurück/Play/Weiter und ganz unten 1x/2x/3x.
// Links/Rechts springt auf dem Balken (5 s, bei langen Inhalten 10 s; gehalten wiederholt es sich), A löst den
// fokussierten Knopf aus (auf dem Balken: Play/Pause). Sobald die Maus bewegt wird, verschwindet der Fokus wieder.
const NAV_ROWS = [[videoBtn, closeBtn], [trackEl], [prevBtn, playBtn, nextBtn], sizeBtns];
let padFocus = null;
let seekFlushTimer = null;

function navItems(row) {
  return NAV_ROWS[row].filter((el) => !el.disabled);
}

function setPadFocus(el) {
  if (padFocus) padFocus.classList.remove('pad-focus');
  padFocus = el;
  player.classList.toggle('pad-active', !!el);
  if (el) el.classList.add('pad-focus');
}

function clearPadFocus() {
  if (padFocus || player.classList.contains('pad-active')) setPadFocus(null);
}

function seekBy(delta) {
  const duration = usableDuration();
  if (!duration) return;
  const base = pendingSeek ? pendingSeek.value : state.current;
  const value = Math.max(0, Math.min(duration, base + delta));
  pendingSeek = { value, until: Date.now() + SEEK_HOLD_MS };
  state = { ...state, current: value };
  render();
  sendSeek(value, false);
  clearTimeout(seekFlushTimer);
  seekFlushTimer = setTimeout(() => sendSeek(value, true), SEEK_SEND_INTERVAL_MS + 30); // der letzte Stand kommt auf jeden Fall an
}

function activate(el) {
  if (el === videoBtn) api.setPicture(!state.showPicture);
  else if (el === closeBtn) api.close();
  else if (el === trackEl) { if (!playBtn.disabled) api.control('toggle'); }
  else if (el && !el.disabled) el.click();
}

function handleNav(nav) {
  if (!nav) return;
  wake();
  if (!padFocus || !navItems(NAV_ROWS.findIndex((r) => r.includes(padFocus))).includes(padFocus)) {
    // Erste Eingabe (oder der Fokus ist inzwischen ausgegraut): Fokus auf Play/Pause setzen und die Eingabe gleich ausführen
    setPadFocus(playBtn.disabled ? trackEl : playBtn);
  }
  const row = NAV_ROWS.findIndex((r) => r.includes(padFocus));
  const items = navItems(row);
  const index = items.indexOf(padFocus);

  switch (nav.action) {
    case 'left':
    case 'right': {
      const dir = nav.action === 'left' ? -1 : 1;
      if (padFocus === trackEl) {
        seekBy(dir * (usableDuration() > 1200 ? 10 : 5));
      } else {
        const next = items[index + dir];
        if (next) setPadFocus(next);
      }
      break;
    }
    case 'up':
    case 'down': {
      const target = Math.max(0, Math.min(NAV_ROWS.length - 1, row + (nav.action === 'up' ? -1 : 1)));
      if (target === row) break;
      const candidates = navItems(target);
      if (!candidates.length) break;
      // Von unten kommend auf den Balken, von oben auf die große Play-Taste (sonst die erste verfügbare)
      if (target === 2 && candidates.includes(playBtn)) setPadFocus(playBtn);
      else if (target === 3) setPadFocus(candidates.find((el) => el.classList.contains('on')) || candidates[0]);
      else setPadFocus(candidates[0]);
      break;
    }
    case 'activate':
      if (!nav.repeat) activate(padFocus);
      break;
    default:
  }
}
api.onNav(handleNav);

// ---------- Bedienelemente ausblenden ----------
// Mit Bild liegen die Bedienelemente über dem Video und sind nur nach einer Eingabe (Maus bewegt/geklickt, Controller)
// sichtbar; nach 2,5 s Ruhe blenden sie sich aus. Ohne Bild sind sie immer da (die Klasse hat dort keine Wirkung).
const AWAKE_MS = 2500;
let awakeTimer = null;
function wake() {
  player.classList.add('awake');
  clearTimeout(awakeTimer);
  awakeTimer = setTimeout(() => { if (!seeking && !dragging) player.classList.remove('awake'); else wake(); }, AWAKE_MS);
}

let lastMouse = null;
window.addEventListener('pointermove', (event) => {
  if (event.pointerType === 'touch') return;
  const moved = !lastMouse || Math.hypot(event.clientX - lastMouse.x, event.clientY - lastMouse.y) > 3;
  lastMouse = { x: event.clientX, y: event.clientY };
  if (moved) { clearPadFocus(); wake(); }
});
window.addEventListener('pointerdown', () => { clearPadFocus(); wake(); });

render();
api.ready();
