// Musikplayer (Hauptprozess): ein kleines, immer obenliegendes Glas-Fenster (media-player.html), das die Wiedergabe der
// laufenden Apps steuert - Zurück, Play/Pause, Weiter und den Fortschritt. Es ist ein Fernbedienungs-Fenster, kein
// eigener Dateiplayer: die Medien laufen weiter in der App.
//
// Wie die Steuerung funktioniert (alles im normalen Seitenkontext der App, über executeJavaScript):
//   - Abspielen/Pause/Springen: direkt am Audio-/Video-Element der Seite (unabhängig von der Media-Session-Schnittstelle).
//   - Zurück/Weiter: über die Media-Session-Handler, die die Seite selbst anmeldet (Spotify, YouTube Music u.ä.).
//     Dafür merkt sich app-view-preload.js beim Start jeder Seite diese Handler und das zuletzt gestartete Medium
//     (window.__launcherMediaHook). Bietet eine Seite keine Handler an, sind die beiden Tasten ausgegraut.
//   - Gesteuert wird die App, die gerade etwas abspielt, sonst die, die zuletzt etwas abgespielt hat.
//   - Audio und Video werden gleich behandelt. Der Knopf oben links blendet nur das Bild im Player ein: bei Video die
//     laufenden Bilder, bei Audio das Titelbild (Cover) aus den Media-Session-Metadaten der Seite.
//   - Bild bei Video: ein Standbild der Seite (Canvas, JPEG). Liefert die Seite kein lesbares Bild (geschützte oder
//     fremde Quelle, schwarzes Bild), wird stattdessen der Bereich des Videos aus der App-Ansicht abgelichtet.
// Dieselbe Abfrage und Steuerung nutzt das Schnellmenü des Launchers (Medien-Modus, ohne Fenster): die Launcher-Seite meldet
// sich mit 'media-quick-start' an, bekommt dann alle 400 ms 'media-quick-state' und steuert über 'media-quick-control'.
// Das Fenster nimmt keinen Tastaturfokus an (focusable: false): der Launcher behält Tastatur und Controller; die
// Bedienung per Controller kommt als 'media-player-nav' vom Hauptprozess und wird im Player-Fenster ausgewertet.
const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const {
  MEDIA_PLAYER_DEFAULT_WIDTH, MEDIA_PLAYER_DEFAULT_HEIGHT, MEDIA_PLAYER_MIN_WIDTH, MEDIA_PLAYER_MIN_HEIGHT, MEDIA_PLAYER_POSITIONS
} = require('./settings-store');

const POLL_MS = 400;              // so oft wird der Stand der Wiedergabe abgefragt, solange der Player offen ist
const QUICK_MISS_LIMIT = 3;      // so viele erfolglose Abfragen in Folge, bis das Schnellmenü "nicht verfügbar" meldet
const POLL_VIDEO_MS = 200;        // bei laufendem Video mit Bildanzeige: ca. 5 Bilder pro Sekunde
const QUERY_TIMEOUT_MS = 1500;    // eine hängende Seite darf die Abfrage nicht blockieren
const RTC_RETRY_MS = 60000;       // nach gescheitertem Live-Strom so lange bei Standbildern bleiben, dann neu versuchen
const PICTURE_WIDTH = 480;       // Bilder werden auf diese Breite verkleinert, bevor sie ans Player-Fenster gehen
const PICTURE_MIN_OPEN_WIDTH = 400; // mit Bild öffnet das Fenster mindestens so breit (die Höhe folgt dem Seitenverhältnis des Bildes)
const PICTURE_MIN_HEIGHT = 60;      // Mindesthöhe mit Bild (die Mindestbreite bestimmt über das Seitenverhältnis die Höhe)
const EDGE_MARGIN = Math.round(2 * 96 / 2.54); // Abstand der Standardposition zu Bildschirmrand unten/rechts: 2 cm, wie das Schnellmenü
const DRAG_MODES = new Set(['move', 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
const ACTIONS = new Set(['toggle', 'prev', 'next', 'seek']);
const NAV_ACTIONS = new Set(['up', 'down', 'left', 'right', 'activate']);
const PLACE_DIRS = new Set(['up', 'down', 'left', 'right']); // X + Steuerkreuz: fester Platz
const PLACE_ROWS = ['top', 'middle', 'bottom'];
const PLACE_ANIM_MS = 200;        // so lange gleitet der Player an den neuen Platz

// ---------- Skripte, die in der Seite der App laufen ----------
// Gemeinsamer Teil: wählt das Medium. Ein gerade laufendes (nicht stummes) hat Vorrang, sonst das zuletzt gestartete,
// sonst eines mit bekannter Länge. Stumme Elemente (Vorschau-Kacheln, Hintergrundvideos) zählen nicht.
const pickMedia = () => `
  var S = window.__launcherMediaHook || null;
  function isPicture(m) { return m.tagName === 'VIDEO' && m.videoWidth > 0; }
  function usable(m) { return !!m && m.readyState > 0 && !m.error; }
  function idOf(m) {
    if (!m.__mpId) { window.__launcherMediaSeq = (window.__launcherMediaSeq || 0) + 1; m.__mpId = window.__launcherMediaSeq; }
    return m.__mpId;
  }
  function pick() {
    var cands = [];
    var all = document.querySelectorAll('audio, video');
    for (var i = 0; i < all.length; i++) cands.push(all[i]);
    if (S && S.last && cands.indexOf(S.last) < 0) cands.push(S.last); // auch ein nicht im Dokument hängendes Audio-Objekt
    var playing = null, last = null, known = null;
    for (var j = 0; j < cands.length; j++) {
      var m = cands[j];
      if (!usable(m)) continue;
      if (!m.paused && !m.ended && !m.muted) {
        if (!playing || m === (S && S.last)) playing = m;
      }
      if (S && m === S.last) last = m;
      if (!known && !m.muted && isFinite(m.duration) && m.duration > 0) known = m;
    }
    return playing || last || known;
  }
`;

const buildQueryScript = () => `(function () {
  ${pickMedia()}
  var el = pick();
  if (!el) return null;
  var d = el.duration;
  var st = window.__launcherStream;
  // Titel: "Titel – Interpret" aus den Mediendaten der Seite, sonst der Seitentitel
  var heading = '';
  try {
    var meta = navigator.mediaSession && navigator.mediaSession.metadata;
    if (meta && meta.title) heading = meta.artist ? meta.title + ' \\u2013 ' + meta.artist : meta.title;
    else heading = document.title || '';
  } catch (e) { heading = ''; }
  heading = String(heading).replace(/\\s+/g, ' ').trim().slice(0, 300);
  return {
    title: heading,
    playing: !el.paused && !el.ended,
    kind: isPicture(el) ? 'video' : 'audio',
    elId: idOf(el),
    aspect: isPicture(el) ? el.videoWidth / el.videoHeight : 0,
    stream: st ? { elId: st.el.__mpId || 0, state: st.pc.connectionState } : null,
    current: el.currentTime || 0,
    duration: isFinite(d) && d > 0 ? d : 0,
    at: (S && S.lastAt) || 0,
    canPrev: !!(S && S.handlers && S.handlers.previoustrack),
    canNext: !!(S && S.handlers && S.handlers.nexttrack)
  };
})()`;
const MEDIA_QUERY_SCRIPT = buildQueryScript();

// Bild des gewählten Mediums (nur für die eine ausgewählte App und nur bei eingeblendeter Bildanzeige):
//   Video  -> { kind: 'video', image: 'data:image/jpeg;...' }; ist das Bild nicht lesbar (Canvas "tainted", DRM, rein
//             schwarz), { kind: 'video', blocked: true, rect } mit dem Bereich des Videos in der Seite (für capturePage)
//   Audio  -> { kind: 'audio', cover: URL oder data:-URL } aus navigator.mediaSession.metadata.artwork (größtes Bild);
//             blob:-Adressen gelten nur in der Seite und werden dort in eine data:-URL umgewandelt (Ergebnis wird gemerkt)
const buildPictureScript = () => `(async function () {
  ${pickMedia()}
  var el = pick();
  if (!el) return null;
  var out = { kind: isPicture(el) ? 'video' : 'audio' };
  if (out.kind === 'video') {
    try {
      var vw = el.videoWidth, vh = el.videoHeight;
      var scale = Math.min(1, ${PICTURE_WIDTH} / vw);
      var cw = Math.max(1, Math.round(vw * scale)), ch = Math.max(1, Math.round(vh * scale));
      var c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      c.getContext('2d').drawImage(el, 0, 0, cw, ch);
      // Probe auf einem winzigen Bild: wirft bei fremden Quellen (Canvas "tainted") und erkennt rein schwarze Bilder (geschütztes Video)
      var p = document.createElement('canvas');
      p.width = 8; p.height = 8;
      var pc = p.getContext('2d', { willReadFrequently: true });
      pc.drawImage(c, 0, 0, 8, 8);
      var px = pc.getImageData(0, 0, 8, 8).data, bright = 0;
      for (var i = 0; i < px.length; i += 4) bright = Math.max(bright, px[i], px[i + 1], px[i + 2]);
      if (bright < 6) out.blocked = true; else out.image = c.toDataURL('image/jpeg', 0.6);
    } catch (e) {
      out.blocked = true;
    }
    if (out.blocked) {
      var r = el.getBoundingClientRect();
      var x0 = Math.max(0, r.left), y0 = Math.max(0, r.top);
      var x1 = Math.min(window.innerWidth, r.right), y1 = Math.min(window.innerHeight, r.bottom);
      out.rect = { x: Math.round(x0), y: Math.round(y0), width: Math.max(0, Math.round(x1 - x0)), height: Math.max(0, Math.round(y1 - y0)) };
    }
    return out;
  }
  try {
    var md = navigator.mediaSession && navigator.mediaSession.metadata;
    var art = md && md.artwork;
    if (art && art.length) {
      var best = null, bestArea = -1;
      for (var k = 0; k < art.length; k++) {
        if (!art[k] || !art[k].src) continue;
        var m = /(\\d+)\\s*x\\s*(\\d+)/.exec(art[k].sizes || '');
        var area = m ? Number(m[1]) * Number(m[2]) : 0;
        if (area >= bestArea) { best = art[k]; bestArea = area; }
      }
      if (best) {
        var src = new URL(best.src, location.href).href;
        if (/^blob:/i.test(src)) {
          var cache = window.__launcherCoverCache || (window.__launcherCoverCache = {});
          if (!cache[src]) {
            var blob = await (await fetch(src)).blob();
            cache[src] = await new Promise(function (resolve, reject) {
              var fr = new FileReader();
              fr.onload = function () { resolve(fr.result); };
              fr.onerror = reject;
              fr.readAsDataURL(blob);
            });
          }
          src = cache[src];
        }
        out.cover = src;
      }
    }
  } catch (e) { /* kein Titelbild verfügbar */ }
  return out;
})()`;

// Live-Bild für Video: das Video-Element der Seite wird mit captureStream() abgegriffen und über eine lokale
// WebRTC-Verbindung (ohne Netzwerk, nur Rechner-Adressen) an das Player-Fenster geschickt. Dasselbe Verfahren, das
// Chromium selbst für flüssiges Video nutzt: kein Umweg über Standbilder. Der Hauptprozess vermittelt nur Angebot und
// Antwort (SDP) zwischen Seite und Player. op: 'offer' (Verbindung aufbauen, liefert { sdp, elId } oder { error }),
// 'answer' (Antwort des Players einsetzen), 'stop' (abbauen).
const buildStreamScript = (op, arg) => `(async function () {
  ${pickMedia()}
  var op = ${JSON.stringify(op)};
  function stop() {
    var st = window.__launcherStream;
    window.__launcherStream = null;
    if (st) { try { st.pc.close(); } catch (e) {} }
  }
  try {
    if (op === 'stop') { stop(); return true; }
    if (op === 'answer') {
      var cur = window.__launcherStream;
      if (!cur) return false;
      await cur.pc.setRemoteDescription({ type: 'answer', sdp: ${JSON.stringify(String(arg || ''))} });
      try { // klein halten: höchstens ca. 640 Pixel Breite, 30 Bilder/s, 1,5 MBit/s
        var sender = cur.pc.getSenders()[0];
        var p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = 1500000;
        p.encodings[0].maxFramerate = 30;
        p.encodings[0].scaleResolutionDownBy = Math.max(1, (cur.el.videoWidth || 640) / 640);
        await sender.setParameters(p);
      } catch (e) { /* bleibt bei den Standardwerten */ }
      return true;
    }
    stop();
    var el = pick();
    if (!el || !isPicture(el)) return { error: 'kein Video' };
    var cs = typeof el.captureStream === 'function' ? el.captureStream() : null;
    var vt = cs && cs.getVideoTracks()[0];
    if (!vt) return { error: 'keine Videospur' };
    var pc = new RTCPeerConnection({ iceServers: [] });
    pc.addTrack(vt, cs);
    window.__launcherStream = { pc: pc, el: el };
    idOf(el);
    var offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise(function (resolve) {
      if (pc.iceGatheringState === 'complete') { resolve(); return; }
      var timer = setTimeout(resolve, 2000);
      pc.addEventListener('icegatheringstatechange', function () {
        if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
      });
    });
    return { sdp: pc.localDescription.sdp, elId: el.__mpId };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
})()`;

function buildControlScript(action, value) {
  const seconds = Number.isFinite(value) ? value : 0;
  return `(function () {
    ${pickMedia()}
    var action = ${JSON.stringify(action)};
    var el = pick();
    try {
      if (action === 'toggle') {
        if (!el) return false;
        if (el.paused) { var p = el.play(); if (p && p.catch) p.catch(function () {}); } else { el.pause(); }
        return true;
      }
      if (action === 'seek') {
        if (!el) return false;
        var d = el.duration;
        var t = ${seconds};
        if (isFinite(d) && d > 0) t = Math.min(t, d);
        el.currentTime = Math.max(0, t);
        return true;
      }
      var name = action === 'prev' ? 'previoustrack' : 'nexttrack';
      var h = S && S.handlers && S.handlers[name];
      if (typeof h !== 'function') return false;
      h({ action: name });
      return true;
    } catch (e) { return false; }
  })()`;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Zeitüberschreitung')), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

const IDLE_STATE = {
  available: false, paused: true, current: 0, duration: 0, canPrev: false, canNext: false,
  kind: 'audio', showPicture: false, image: null, title: ''
};

// getApps: liefert die laufenden Apps als [{ id, webContents, lastActive }]
// readSettings/writeSettings: gespeicherte Position und Größe; onOpenChanged(open): Rückruf beim Öffnen/Schließen
function createMediaPlayer({ getApps, readSettings, writeSettings, onOpenChanged, baseDir }) {
  let win = null;
  let opening = false;
  let pollTimer = null;
  let refreshing = false;
  let lastTarget = null;          // { id, webContents } der zuletzt gesteuerten App
  let lastState = IDLE_STATE;
  let dragState = null;
  let placement = null;           // fester Platz ('top-left' ... 'bottom-right') oder null = frei verschoben
  let animTimer = null;           // laufendes Gleiten an einen neuen Platz
  let compactSize = null;         // { width, height } des Players ohne Bild, solange das Bild eingeblendet ist
  let pictureWidth = 0;           // zuletzt benutzte Breite mit Bild (gilt, solange der Player offen ist)
  let showPicture = false;        // Bildanzeige im Player (gilt nur, solange er offen ist)
  let sentImage;                  // zuletzt ans Fenster gesendetes Bild (Titelbilder werden nur bei Änderung gesendet)
  let quickSub = null;            // WebContents der Launcher-Seite, die den Stand fürs Schnellmenü abonniert hat
  let quickTimer = null;
  let quickRefreshing = false;
  let quickMisses = 0;
  let quickWasAvailable = false;
  let quickNavHandler = null;
  let rtc = null;                 // laufender Live-Strom: { app, key, answered }
  let rtcStarting = false;
  let usingStills = false;        // Video gerade über Standbilder statt Live-Strom (Rückfall)
  const rtcFailed = new Map();    // Video-Schlüssel -> Zeitpunkt, an dem der Live-Strom dafür scheiterte (nach einer Minute neuer Versuch)

  function isPlayerSender(event) {
    return !!win && !win.isDestroyed() && event.sender === win.webContents;
  }

  // ---------- Medium finden ----------
  async function findTarget() {
    const query = buildQueryScript();
    const apps = (getApps() || []).filter((a) => a && a.webContents && !a.webContents.isDestroyed());
    const results = await Promise.all(apps.map(async (app) => {
      try {
        const state = await withTimeout(app.webContents.executeJavaScript(query), QUERY_TIMEOUT_MS);
        return state ? { app, state } : null;
      } catch (err) {
        return null;
      }
    }));
    const found = results.filter(Boolean);
    if (!found.length) return null;
    found.sort((a, b) =>
      (Number(b.state.playing) - Number(a.state.playing)) ||
      (b.state.at - a.state.at) ||
      ((b.app.lastActive || 0) - (a.app.lastActive || 0)));
    return found[0];
  }

  // Gesendet wird ein Teilstand: fehlt "image", bleibt das Bild im Fenster unverändert (so wird ein Titelbild nicht
  // alle 400 ms neu übertragen). lastState hält immer den vollständigen Stand für ein neu geladenes Fenster.
  function send(next, full) {
    const state = { ...next, showPicture, baseWidth: showPicture ? PICTURE_MIN_OPEN_WIDTH : MEDIA_PLAYER_DEFAULT_WIDTH };
    lastState = { ...lastState, ...state };
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('media-player-state', full ? lastState : state);
    }
  }

  // Bild für die Anzeige holen: Video = Standbild (oder Ablichtung der App-Ansicht), Audio = Titelbild
  async function captureRect(app, rect) {
    if (!rect || rect.width < 8 || rect.height < 8) return null;
    try {
      const img = await withTimeout(app.webContents.capturePage(rect), QUERY_TIMEOUT_MS);
      if (!img || img.isEmpty()) return null;
      const small = img.getSize().width > PICTURE_WIDTH ? img.resize({ width: PICTURE_WIDTH, quality: 'good' }) : img;
      return 'data:image/jpeg;base64,' + small.toJPEG(60).toString('base64');
    } catch (err) {
      return null;
    }
  }

  async function fetchPicture(app) {
    try {
      const pic = await withTimeout(app.webContents.executeJavaScript(buildPictureScript()), QUERY_TIMEOUT_MS);
      if (!pic) return null;
      if (pic.kind === 'video') return pic.image || (pic.blocked ? await captureRect(app, pic.rect) : null);
      return pic.cover || null;
    } catch (err) {
      return null;
    }
  }

  // ---------- Schnellmenü des Launchers (Medien-Modus) ----------
  // Gleicher Stand wie im Player-Fenster (ohne Bild): läuft, solange die Launcher-Seite abonniert hat, und endet mit dem
  // Schließen des Menüs, dem Verlassen der Seite oder dem Zerstören der Seite.
  function quickAlive() {
    return !!quickSub && !quickSub.isDestroyed();
  }

  async function quickRefresh() {
    if (!quickAlive() || quickRefreshing) return;
    quickRefreshing = true;
    try {
      const found = await findTarget();
      if (!quickAlive()) return;
      // Beim Titelwechsel fehlt die Wiedergabe kurz: erst nach mehreren Fehlversuchen in Folge "nicht verfügbar" melden,
      // sonst flackern die Knöpfe im Schnellmenü
      if (found) quickMisses = 0;
      else if (quickWasAvailable && ++quickMisses < QUICK_MISS_LIMIT) return;
      quickWasAvailable = !!found;
      lastTarget = found ? found.app : null;
      quickSub.send('media-quick-state', found ? {
        available: true,
        paused: !found.state.playing,
        current: found.state.current,
        duration: found.state.duration,
        canPrev: found.state.canPrev,
        canNext: found.state.canNext,
        title: found.state.title || ''
      } : { available: false, paused: true, current: 0, duration: 0, canPrev: false, canNext: false, title: '' });
    } finally {
      quickRefreshing = false;
    }
  }

  async function quickLoop() {
    quickTimer = null;
    if (!quickAlive()) return;
    await quickRefresh();
    if (quickAlive() && !quickTimer) quickTimer = setTimeout(quickLoop, POLL_MS);
  }

  function quickStop() {
    if (quickTimer) clearTimeout(quickTimer);
    quickTimer = null;
    if (quickSub && quickNavHandler && !quickSub.isDestroyed()) quickSub.removeListener('did-start-navigation', quickNavHandler);
    quickSub = null;
    quickNavHandler = null;
    if (!win) lastTarget = null;
  }

  function quickStart(sender) {
    quickStop();
    quickSub = sender;
    quickMisses = 0;
    quickWasAvailable = false;
    // Wechselt die Launcher-Seite (Einstellungen, App ...), endet das Abonnement von selbst
    quickNavHandler = (event) => { if (event.isMainFrame !== false) quickStop(); };
    sender.on('did-start-navigation', quickNavHandler);
    quickLoop();
  }

  // ---------- Live-Strom (flüssiges Video) ----------
  const streamKey = (app, elId) => `${app.webContents.id}:${elId}`;
  const streamFailed = (key) => {
    const at = rtcFailed.get(key);
    if (at === undefined) return false;
    if (Date.now() - at > RTC_RETRY_MS) { rtcFailed.delete(key); return false; }
    return true;
  };

  function stopStream() {
    const cur = rtc;
    rtc = null;
    if (cur && cur.app.webContents && !cur.app.webContents.isDestroyed()) {
      cur.app.webContents.executeJavaScript(buildStreamScript('stop')).catch(() => {});
    }
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('media-player-rtc-stop');
  }

  function markStreamFailed(cur) {
    if (!cur) return;
    rtcFailed.set(cur.key, Date.now());
    if (rtc === cur) stopStream();
  }

  // Scheitert schon der Aufbau (Seite bietet captureStream nicht an, Fehler, keine Antwort), bleibt es für diese Minute bei Standbildern
  async function startStream(app, key) {
    if (rtcStarting) return;
    rtcStarting = true;
    try {
      stopStream();
      const res = await withTimeout(app.webContents.executeJavaScript(buildStreamScript('offer')), 4000);
      if (!win) return;
      if (!res || res.error || !res.sdp) { rtcFailed.set(key, Date.now()); return; }
      rtc = { app, key, answered: false };
      win.webContents.send('media-player-rtc-offer', { sdp: res.sdp });
    } catch (err) {
      rtcFailed.set(key, Date.now());
    } finally {
      rtcStarting = false;
    }
  }

  async function refresh() {
    if (!win || refreshing) return;
    refreshing = true;
    try {
      const found = await findTarget();
      if (!win) return; // während der Abfrage geschlossen
      lastTarget = found ? found.app : null;
      if (!found) {
        sentImage = null;
        usingStills = false;
        if (rtc) stopStream();
        send(IDLE_STATE);
        return;
      }
      const next = {
        available: true,
        paused: !found.state.playing,
        kind: found.state.kind,
        aspect: found.state.aspect,
        current: found.state.current,
        duration: found.state.duration,
        canPrev: found.state.canPrev,
        canNext: found.state.canNext,
        title: found.state.title || ''
      };
      // Video mit Bildanzeige: erst der Live-Strom, bei Scheitern (fremde/geschützte Quelle) Standbilder
      let stills = false;
      if (showPicture && found.state.kind === 'video') {
        const key = streamKey(found.app, found.state.elId);
        const st = found.state.stream;
        if (rtc && rtc.key === key && st && (st.state === 'failed' || st.state === 'closed')) markStreamFailed(rtc);
        if (streamFailed(key)) {
          stills = true;
        } else if (!rtcStarting && !(rtc && rtc.key === key && st && st.elId === found.state.elId)) {
          startStream(found.app, key);
        }
      } else if (rtc) {
        stopStream(); // Audio, Bild aus oder anderes Medium
      }
      usingStills = stills;
      if (showPicture && (stills || found.state.kind !== 'video')) {
        const image = await fetchPicture(found.app);
        if (!win) return;
        // Standbilder immer senden (misslingt eines kurz, bleibt das letzte stehen), ein Titelbild nur bei Änderung
        if (found.state.kind === 'video') {
          if (image) { next.image = image; sentImage = image; }
        } else if (image !== sentImage) {
          next.image = image;
          sentImage = image;
        }
      }
      send(next);
      fitAspect();
    } finally {
      refreshing = false;
    }
  }

  // Abfrageschleife: bei laufendem Video mit Bildanzeige öfter, sonst gemächlich
  async function loop() {
    pollTimer = null;
    if (!win) return;
    await refresh();
    if (!win || pollTimer) return;
    const fast = usingStills && lastState.available && !lastState.paused;
    pollTimer = setTimeout(loop, fast ? POLL_VIDEO_MS : POLL_MS);
  }

  async function control(action, value) {
    if ((!win && !quickAlive()) || !ACTIONS.has(action)) return false;
    let app = lastTarget && lastTarget.webContents && !lastTarget.webContents.isDestroyed() ? lastTarget : null;
    if (!app) {
      const found = await findTarget();
      app = found ? found.app : null;
    }
    if (!app) return false;
    let ok = false;
    try {
      // userGesture: true - play() nach einer Pause durch uns soll nicht an der Autoplay-Sperre der Seite scheitern
      ok = await app.webContents.executeJavaScript(buildControlScript(action, Number(value)), true);
    } catch (err) {
      ok = false;
    }
    refresh();
    quickRefresh();
    return !!ok;
  }

  // ---------- Fenster ----------
  // Feste Plätze: 2 cm vom Rand der Seite, vertikal oben/unten 2 cm vom Rand bzw. mittig; bleibt auf dem Bildschirm.
  // Bildschirmgrenzen statt Arbeitsbereich: die Taskleiste ist im Launcher ausgeblendet.
  function anchorBounds(position, width, height, area) {
    const [row, side] = position.split('-');
    let x = side === 'left' ? area.x + EDGE_MARGIN : area.x + area.width - width - EDGE_MARGIN;
    let y;
    if (row === 'top') y = area.y + EDGE_MARGIN;
    else if (row === 'bottom') y = area.y + area.height - height - EDGE_MARGIN;
    else y = area.y + Math.round((area.height - height) / 2);
    x = Math.max(area.x, Math.min(x, area.x + area.width - width));
    y = Math.max(area.y, Math.min(y, area.y + area.height - height));
    return { x: Math.round(x), y: Math.round(y), width, height };
  }

  // Der Platz laut Einstellungen: ein gewählter fester Platz; sonst (nie verschoben) der Standard unten rechts; null = frei verschoben
  function placementFor(s) {
    if (MEDIA_PLAYER_POSITIONS.includes(s.position)) return s.position;
    return s.moved ? null : 'bottom-right';
  }

  // Der feste Platz, der einer Fensterlage am nächsten liegt (Seite nach der Mitte, Zeile nach Dritteln des Bildschirms)
  function nearestPlacement(b, area) {
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const side = cx < area.x + area.width / 2 ? 'left' : 'right';
    const row = cy < area.y + area.height / 3 ? 'top' : (cy > area.y + area.height * 2 / 3 ? 'bottom' : 'middle');
    return `${row}-${side}`;
  }

  // Neue Größe am festen Platz (Anker bleibt stehen); ohne festen Platz gilt der alte Anker, den der Aufrufer liefert
  function placedXY(width, height, area, fallback) {
    if (placement) {
      const p = anchorBounds(placement, width, height, area);
      return { x: p.x, y: p.y };
    }
    return fallback;
  }

  function displayContaining(x, y) {
    const d = screen.getAllDisplays().find((disp) => {
      const b = disp.bounds;
      return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
    });
    return d ? d.bounds : null;
  }

  // Gespeicherte Position nur verwenden, wenn der Nutzer das Fenster selbst verschoben/vergrößert hat und die Mitte
  // noch auf einem vorhandenen Bildschirm liegt (z.B. nach dem Abstecken eines zweiten Monitors sonst unsichtbar)
  function resolveBounds() {
    const s = readSettings();
    const width = s.moved ? (s.width || MEDIA_PLAYER_DEFAULT_WIDTH) : MEDIA_PLAYER_DEFAULT_WIDTH;
    const height = s.moved ? (s.height || MEDIA_PLAYER_DEFAULT_HEIGHT) : MEDIA_PLAYER_DEFAULT_HEIGHT;
    const place = placementFor(s);
    if (place) {
      // fester Platz: auf dem Bildschirm, auf dem der Player zuletzt lag, sonst auf dem Hauptbildschirm
      const saved = s.moved && Number.isFinite(s.x) && Number.isFinite(s.y) ? displayContaining(s.x + width / 2, s.y + height / 2) : null;
      return anchorBounds(place, width, height, saved || screen.getPrimaryDisplay().bounds);
    }
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      const cx = s.x + width / 2;
      const cy = s.y + height / 2;
      if (displayContaining(cx, cy)) return { x: s.x, y: s.y, width, height };
    }
    return anchorBounds('bottom-right', width, height, screen.getPrimaryDisplay().bounds);
  }

  // Gespeichert wird immer die Größe ohne Bildanzeige: so öffnet der Player beim nächsten Mal wieder schlank, auch wenn
  // er zuletzt mit Bild verschoben oder vergrößert wurde. Mit Bild zählt die untere rechte Ecke als Anker.
  function compactBounds(b) {
    if (!showPicture || !compactSize) return b;
    return { x: b.x + b.width - compactSize.width, y: b.y + b.height - compactSize.height, width: compactSize.width, height: compactSize.height };
  }

  function saveBounds() {
    if (!win || win.isDestroyed()) return;
    try {
      const b = compactBounds(win.getBounds());
      writeSettings({ ...readSettings(), x: b.x, y: b.y, width: b.width, height: b.height, moved: true, position: placement });
    } catch (err) {
      console.error('Position des Musikplayers konnte nicht gespeichert werden:', err);
    }
  }

  function createWindow() {
    placement = placementFor(readSettings());
    const bounds = resolveBounds();
    win = new BrowserWindow({
      ...bounds,
      minWidth: MEDIA_PLAYER_MIN_WIDTH,
      minHeight: MEDIA_PLAYER_MIN_HEIGHT,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      resizable: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,        // kein Tastaturfokus: der Launcher behält Tastatur und Controller
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: path.join(baseDir, 'media-player-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });
    win.setAlwaysOnTop(true, 'screen-saver'); // über dem Vollbild-Launcher und den App-Ansichten
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.once('ready-to-show', () => { if (win && !win.isDestroyed()) win.showInactive(); });
    win.on('closed', () => {
      stopStream(); // baut die Verbindung in der Seite ab (das Fenster ist schon zerstört, es geht nichts mehr an den Player)
      win = null;
      dragState = null;
      stopAnim();
      lastTarget = null;
      lastState = IDLE_STATE;
      showPicture = false;
      compactSize = null;
      pictureWidth = 0;
      sentImage = undefined;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      try { onOpenChanged(false); } catch (err) { /* Fenster schließt gerade */ }
    });
    win.loadFile(path.join(baseDir, 'media-player.html')).catch(() => {});
    try { onOpenChanged(true); } catch (err) { /* Fenster schließt gerade */ }
  }

  // Öffnet den Player - nur, wenn es etwas zu steuern gibt. Gibt zurück, ob er jetzt offen ist.
  async function open() {
    if (win) return true;
    if (opening) return false;
    opening = true;
    try {
      const found = await findTarget();
      if (!found) return false;
      showPicture = false;
      sentImage = undefined;
      lastTarget = found.app;
      createWindow();
      return true;
    } finally {
      opening = false;
    }
  }

  function close() {
    if (!win || win.isDestroyed()) return;
    win.close(); // Position/Größe sind schon beim Loslassen nach dem Ziehen gespeichert worden
  }

  async function toggle() {
    if (win) { close(); return false; }
    return open();
  }

  // ---------- Bildanzeige ----------
  // Mit Bild füllt das Video/Titelbild das ganze Fenster; das Fenster hat das Seitenverhältnis des Bildes (Video: dessen
  // Format, Titelbild: quadratisch, sonst 16:9) und behält es beim Ändern der Größe. Die Bedienelemente liegen darüber.
  function pictureAspect() {
    const st = lastState;
    if (st.available && st.kind === 'video' && st.aspect > 0) return Math.max(0.5, Math.min(3, st.aspect));
    if (st.available && st.kind === 'audio') return 1;
    return 16 / 9;
  }

  function displayAreaFor(b) {
    return screen.getDisplayNearestPoint({ x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) }).bounds;
  }

  // Passt das Fenster mit Bild an ein neues Seitenverhältnis an (anderes Video): Breite bleibt, untere Kante bleibt
  function fitAspect() {
    if (!win || win.isDestroyed() || !showPicture || dragState || !lastState.available) return;
    const b = win.getBounds();
    const aspect = pictureAspect();
    if (Math.abs(b.width / b.height - aspect) / aspect < 0.03) return;
    const area = displayAreaFor(b);
    const height = Math.min(area.height, Math.round(b.width / aspect));
    const yKeep = Math.max(area.y, Math.min(b.y + b.height - height, area.y + area.height - height));
    const at = placedXY(b.width, height, area, { x: b.x, y: yKeep });
    stopAnim();
    try { win.setBounds({ x: at.x, y: at.y, width: b.width, height }); } catch (err) { /* Fenster schließt gerade */ }
  }

  // Ein: größer mit dem Seitenverhältnis des Bildes, untere rechte Ecke bleibt; aus: zurück auf die schlanke Größe
  function setPicture(on) {
    on = on === true;
    if (!win || win.isDestroyed() || on === showPicture) return showPicture;
    if (!on) stopStream();
    const b = win.getBounds();
    const area = displayAreaFor(b);
    const right = b.x + b.width;
    const bottom = b.y + b.height;
    let next;
    if (on) {
      compactSize = { width: b.width, height: b.height };
      const aspect = pictureAspect();
      let width = Math.max(pictureWidth || 0, PICTURE_MIN_OPEN_WIDTH, b.width);
      width = Math.min(width, area.width, Math.round(area.height * aspect));
      const height = Math.round(width / aspect);
      next = { width, height };
    } else {
      pictureWidth = b.width;
      next = compactSize || { width: MEDIA_PLAYER_DEFAULT_WIDTH, height: MEDIA_PLAYER_DEFAULT_HEIGHT };
      compactSize = null;
    }
    const at = placedXY(next.width, next.height, area, {
      x: Math.max(area.x, Math.min(right - next.width, area.x + area.width - next.width)),
      y: Math.max(area.y, Math.min(bottom - next.height, area.y + area.height - next.height))
    });
    next.x = at.x;
    next.y = at.y;
    stopAnim();
    showPicture = on;
    sentImage = undefined;
    try {
      win.setMinimumSize(MEDIA_PLAYER_MIN_WIDTH, on ? PICTURE_MIN_HEIGHT : MEDIA_PLAYER_MIN_HEIGHT);
      win.setBounds(next);
    } catch (err) { /* Fenster schließt gerade */ }
    // Beim Ausblenden Bild sofort verwerfen, beim Einblenden gleich neu holen
    send(on ? {} : { image: null });
    if (on) refresh();
    return showPicture;
  }

  // Größenwahl 1x/2x/3x: Vielfaches der Standardgröße (ohne Bild 300x150, mit Bild 400 Breite im Seitenverhältnis des
  // Bildes); die untere rechte Ecke bleibt, das Fenster bleibt auf dem Bildschirm. Ohne Bild wird die Größe gemerkt.
  function setScale(n) {
    n = Number(n);
    if (!win || win.isDestroyed() || ![1, 2, 3].includes(n)) return false;
    const b = win.getBounds();
    const area = displayAreaFor(b);
    const base = showPicture ? PICTURE_MIN_OPEN_WIDTH : MEDIA_PLAYER_DEFAULT_WIDTH;
    const aspect = showPicture ? pictureAspect() : MEDIA_PLAYER_DEFAULT_WIDTH / MEDIA_PLAYER_DEFAULT_HEIGHT;
    const width = Math.max(MEDIA_PLAYER_MIN_WIDTH, Math.min(base * n, area.width, Math.floor(area.height * aspect)));
    const height = Math.round(width / aspect);
    const at = placedXY(Math.round(width), height, area, {
      x: Math.max(area.x, Math.min(b.x + b.width - width, area.x + area.width - width)),
      y: Math.max(area.y, Math.min(b.y + b.height - height, area.y + area.height - height))
    });
    stopAnim();
    try { win.setBounds({ x: at.x, y: at.y, width: Math.round(width), height }); } catch (err) { return false; }
    if (showPicture) pictureWidth = Math.round(width); else saveBounds();
    return true;
  }

  // ---------- Fester Platz (X halten + Steuerkreuz) ----------
  function stopAnim() {
    if (animTimer) clearInterval(animTimer);
    animTimer = null;
  }

  // Gleitet das Fenster (gleiche Größe) in PLACE_ANIM_MS an die neue Stelle; ein neuer Aufruf löst das Laufende ab
  function animateTo(target) {
    stopAnim();
    if (!win || win.isDestroyed()) return;
    const from = win.getBounds();
    if (from.x === target.x && from.y === target.y) return;
    const startedAt = Date.now();
    animTimer = setInterval(() => {
      if (!win || win.isDestroyed()) { stopAnim(); return; }
      const t = Math.min(1, (Date.now() - startedAt) / PLACE_ANIM_MS);
      const e = 1 - Math.pow(1 - t, 3); // zum Ende hin langsamer
      const x = t >= 1 ? target.x : Math.round(from.x + (target.x - from.x) * e);
      const y = t >= 1 ? target.y : Math.round(from.y + (target.y - from.y) * e);
      try { win.setBounds({ x, y, width: from.width, height: from.height }); } catch (err) { stopAnim(); return; }
      if (t >= 1) stopAnim();
    }, 15);
  }

  // dir: 'left'/'right' wählt die Seite, 'up'/'down' geht eine Zeile weiter (oben - mitte - unten, am Rand ist Schluss).
  // Liegt der Player frei, gilt zuerst der nächstgelegene feste Platz als Ausgangspunkt.
  function place(dir) {
    if (!PLACE_DIRS.has(dir) || !win || win.isDestroyed() || dragState) return false;
    const b = win.getBounds();
    const area = displayAreaFor(b);
    const current = placement || nearestPlacement(b, area);
    let [row, side] = current.split('-');
    if (dir === 'left' || dir === 'right') side = dir;
    else row = PLACE_ROWS[Math.max(0, Math.min(PLACE_ROWS.length - 1, PLACE_ROWS.indexOf(row) + (dir === 'up' ? -1 : 1)))];
    const next = `${row}-${side}`;
    if (placement === next) return true;
    placement = next;
    const target = anchorBounds(next, b.width, b.height, area);
    animateTo(target);
    try {
      const size = showPicture && compactSize ? compactSize : b;
      writeSettings({ ...readSettings(), x: target.x, y: target.y, width: size.width, height: size.height, moved: true, position: next });
    } catch (err) {
      console.error('Platz des Musikplayers konnte nicht gespeichert werden:', err);
    }
    return true;
  }

  // Controller-Bedienung: der Hauptprozess leitet Steuerkreuz und A hierher, das Fenster wertet sie auf seinem Fokus aus
  function navigate(action, repeat) {
    if (!NAV_ACTIONS.has(action) || !win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
    win.webContents.send('media-player-nav', { action, repeat: repeat === true });
    return true;
  }

  // ---------- Verschieben / Größe ändern (über die Zieh-Ränder des Fensters) ----------
  // aspect (Breite/Höhe, 0 = frei): mit Bild bleibt das Seitenverhältnis erhalten, die gegenüberliegende Kante/Ecke bleibt stehen
  function computeBounds(mode, start, dx, dy, display, aspect) {
    const area = display.bounds;
    const maxW = area.width;
    const maxH = area.height;
    let { x, y, width, height } = start;
    if (mode === 'move') {
      x = Math.max(area.x, Math.min(area.x + area.width - width, start.x + dx));
      y = Math.max(area.y, Math.min(area.y + area.height - height, start.y + dy));
      return { x: Math.round(x), y: Math.round(y), width, height };
    }
    if (aspect > 0) {
      const horiz = mode.includes('e') || mode.includes('w');
      const vert = mode.includes('n') || mode.includes('s');
      const fromX = start.width + (mode.includes('e') ? dx : -dx);
      const fromY = (start.height + (mode.includes('s') ? dy : -dy)) * aspect;
      let w = horiz && vert ? Math.max(fromX, fromY) : (horiz ? fromX : fromY);
      w = Math.max(MEDIA_PLAYER_MIN_WIDTH, Math.min(maxW, maxH * aspect, w));
      const h = w / aspect;
      x = mode.includes('w') ? start.x + start.width - w : start.x;
      y = mode.includes('n') ? start.y + start.height - h : start.y;
      return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
    }
    if (mode.includes('e')) width = start.width + dx;
    if (mode.includes('w')) width = start.width - dx;
    if (mode.includes('s')) height = start.height + dy;
    if (mode.includes('n')) height = start.height - dy;
    width = Math.max(MEDIA_PLAYER_MIN_WIDTH, Math.min(maxW, width));
    height = Math.max(MEDIA_PLAYER_MIN_HEIGHT, Math.min(maxH, height));
    if (mode.includes('w')) x = start.x + start.width - width; // die gegenüberliegende Kante bleibt stehen
    if (mode.includes('n')) y = start.y + start.height - height;
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  }

  ipcMain.on('media-player-drag-start', (event, mode) => {
    if (!isPlayerSender(event) || !DRAG_MODES.has(mode)) return;
    stopAnim();
    placement = null; // von Hand verschoben/vergrößert: kein fester Platz mehr
    dragState = { mode, start: win.getBounds(), cursor: screen.getCursorScreenPoint() };
  });

  ipcMain.on('media-player-drag-move', (event) => {
    if (!isPlayerSender(event) || !dragState) return;
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    win.setBounds(computeBounds(dragState.mode, dragState.start, cursor.x - dragState.cursor.x, cursor.y - dragState.cursor.y, display, showPicture ? pictureAspect() : 0));
  });

  ipcMain.on('media-player-drag-end', (event) => {
    if (!isPlayerSender(event) || !dragState) return;
    dragState = null;
    saveBounds();
  });

  // ---------- Meldungen des Player-Fensters ----------
  ipcMain.on('media-player-ready', (event) => {
    if (!isPlayerSender(event)) return;
    send({}, true);
    if (!pollTimer) loop();
  });

  ipcMain.on('media-player-control', (event, data) => {
    if (!isPlayerSender(event) || !data) return;
    control(data.action, data.value);
  });

  ipcMain.on('media-player-close', (event) => {
    if (isPlayerSender(event)) close();
  });

  // Live-Strom: Antwort des Players an die Seite weiterreichen; meldet der Player, dass nichts Brauchbares ankommt
  // (fremde/geschützte Quelle, schwarzes Bild), wird für dieses Video auf Standbilder umgestellt
  ipcMain.on('media-player-rtc-answer', async (event, sdp) => {
    if (!isPlayerSender(event) || !rtc || rtc.answered || typeof sdp !== 'string') return;
    const cur = rtc;
    cur.answered = true;
    try {
      const ok = await withTimeout(cur.app.webContents.executeJavaScript(buildStreamScript('answer', sdp)), 4000);
      if (!ok) markStreamFailed(cur);
    } catch (err) {
      markStreamFailed(cur);
    }
  });

  ipcMain.on('media-player-rtc-failed', (event) => {
    if (isPlayerSender(event)) markStreamFailed(rtc);
  });

  ipcMain.on('media-player-set-scale', (event, n) => {
    if (isPlayerSender(event)) setScale(n);
  });

  ipcMain.on('media-quick-start', (event) => quickStart(event.sender));
  ipcMain.on('media-quick-stop', (event) => { if (event.sender === quickSub) quickStop(); });
  ipcMain.on('media-quick-control', (event, data) => {
    if (event.sender !== quickSub || !data) return;
    control(data.action, data.value);
  });

  // Knopf oben links: Bild im Player ein-/ausblenden
  ipcMain.on('media-player-set-picture', (event, on) => {
    if (isPlayerSender(event)) setPicture(on);
  });

  return {
    toggle,
    open,
    close,
    isOpen() { return !!win; },
    hasMedia: async () => !!(await findTarget()),
    control,
    navigate,
    place,
    setPicture,
    setScale,
    quickStop,
    // Für Tests
    computeBounds
  };
}

module.exports = { createMediaPlayer, MEDIA_QUERY_SCRIPT, buildQueryScript, buildPictureScript, buildStreamScript, buildControlScript, pickMedia };
