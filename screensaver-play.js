// Bildschirmschoner-Ansicht, drei Arten: Videos (video1, video2, ... der Reihe nach je einmal, kurz vor dem Ende weiche
// Überblendung zum nächsten, nach dem letzten wieder das erste; ein einzelnes Video läuft in Schleife), Bilder (Bilder
// aktuell beliebter Filme von TMDb in zufälliger Reihenfolge, alle IMAGE_MS weiche Überblendung) oder ein schwarzer
// Bildschirm. Pfeil links/rechts, Steuerkreuz links/rechts und der linke Stick nach links/rechts springen zum
// vorigen/nächsten Video bzw. Bild. Pfeil runter / Steuerkreuz runter blendet bei den Filmbildern die Zusatzinfo zum Film
// ein (Logo bzw. Titel und Beschreibung wie im Vollbild-Topshelf) und beim nächsten Druck wieder aus; Pfeil hoch / Steuerkreuz
// hoch tun nichts (wecken aber auch nicht auf). Solange die Info zu sehen ist, wechselt das Bild nicht von selbst. Jede andere Eingabe weckt auf (und wird verschluckt:
// diese Ansicht ist eine eigene Ansicht, darunter löst nichts aus). Beim Controller wird erst beendet, wenn alles
// losgelassen ist, sonst würde der Launcher die noch gedrückte Taste als Eingabe lesen.
// Eingebettet (?embedded=1, auf der Startseite): die Seite läuft als Ebene in einem Rahmen der Startseite, damit das Schnellmenü
// darüber bedienbar bleibt. Dann liest SIE keine Eingaben (Tastatur, Maus, Controller), sondern bekommt Befehle von der Startseite
// ({ ss: 'cmd', cmd: 'go' | 'info' | 'wake' }) und meldet das Ende per Nachricht ({ ss: 'exit' }); Bilder und Logos holt die
// Startseite beim Hauptprozess und reicht sie durch.
const FADE_MS = 1500;
const FADE_LEAD_S = FADE_MS / 1000 + 0.4; // so lange vor dem Ende beginnt die Überblendung (das alte Video läuft darunter weiter)
const IMAGE_MS = 15000;                   // so lange bleibt ein Bild stehen (Bildervariante)
const IMAGES_RETRY_MS = 30000;            // keine Bilder erhalten (kein Netz/Key): so lange bis zum nächsten Versuch
const WAKE_FADE_MS = 650;
const WAKE_RELEASE_TIMEOUT_MS = 3000; // nicht ewig auf ein klemmendes Gerät warten
const PAD_ARM_AFTER_MS = 1000;        // Chromium zeigt einer neuen Ansicht den Controller erst nach einer Weile: so lange nicht scharf werden
const IGNORE_MOUSE_MS = 1000;         // beim Erscheinen der Ansicht erzeugt Chromium unter dem Zeiger eine Mausbewegung
const MOUSE_WAKE_PX = 12;
const STICK_THRESHOLD = 0.5;
const PAD_LEFT = 14;
const PAD_RIGHT = 15;
const PAD_UP = 12;
const PAD_DOWN = 13;
const LOGO_WAIT_MS = 2000;            // so lange wird auf ein Logo gewartet, danach erscheint der Titel als Text

const params = new URLSearchParams(location.search);
const embedded = params.get('embedded') === '1' && window.parent !== window;
const mode = params.get('mode') === 'images' ? 'images' : 'videos'; // 'videos' ohne Videodateien = schwarzer Bildschirm
const scenes = mode === 'videos' ? (params.get('scenes') || '').split(',').filter(Boolean) : [];
// Eingebettet gibt es keine Brücke zum Hauptprozess: Anfragen laufen über die Startseite (Antwort per Nachricht mit Kennung)
if (embedded) {
  const pending = new Map();
  let nextId = 1;
  const ask = (ss, payload) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    window.parent.postMessage({ ss, id, ...payload }, '*');
    setTimeout(() => { if (pending.delete(id)) resolve(ss === 'images' ? [] : ''); }, 15000);
  });
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const d = e.data || {};
    if (d.ss === 'reply' && pending.has(d.id)) {
      const resolve = pending.get(d.id);
      pending.delete(d.id);
      resolve(d.value);
    } else if (d.ss === 'cmd') {
      handleCommand(d);
    }
  });
  window.screensaverAPI = {
    exit: () => window.parent.postMessage({ ss: 'exit' }, '*'),
    getImages: () => ask('images', {}),
    getLogo: (id) => ask('logo', { logoId: id })
  };
}
const stage = document.getElementById('stage');
const videos = [document.getElementById('v0'), document.getElementById('v1')];
const images = [document.getElementById('i0'), document.getElementById('i1')];
const startedAt = performance.now();

let front = 0;        // welches der beiden Videos gerade sichtbar ist
let sceneIndex = scenes.length ? 0 : -1; // immer mit dem ersten Video beginnen
let token = 0;        // macht Rückmeldungen einer abgelösten Szene wirkungslos
let waking = false;
let fadeDone = false;
let wakeStartedAt = 0;

document.body.dataset.state = 'active';
document.body.dataset.mode = mode === 'images' ? 'images' : (scenes.length ? 'videos' : 'black');
document.body.dataset.sceneCount = String(scenes.length); // Beobachtungspunkt für Tests: wie viele Szenen sind noch in der Liste

// ---------- Szenen ----------
function wrap(i) {
  return ((i % scenes.length) + scenes.length) % scenes.length;
}

// Das Video ist (fast) zu Ende: zum nächsten weiter, nach dem letzten wieder zum ersten (wrap)
function advance(my) {
  if (my !== token || waking) return;
  document.body.dataset.advances = String((Number(document.body.dataset.advances) || 0) + 1);
  showScene(sceneIndex + 1);
}

// Wartet auf das Ende des Videos. Die Überblendung beginnt schon FADE_LEAD_S vor dem Ende, damit das alte Video
// darunter noch läuft und es keinen Standbild- oder Schwarz-Moment gibt. Bei sehr kurzen Videos höchstens die halbe
// Länge, sonst würden sie gar nicht erst zu sehen sein. Als Rückfall gilt 'ended'.
function watchEnd(video, my) {
  const lead = () => Math.min(FADE_LEAD_S, (video.duration || 0) / 2);
  const check = (time) => {
    if (my !== token) return false;
    if (isFinite(video.duration) && video.duration > 0 && video.duration - time <= lead()) {
      advance(my);
      return true;
    }
    return false;
  };
  video.addEventListener('ended', () => advance(my), { once: true });
  if (video.requestVideoFrameCallback) {
    const onFrame = (now, meta) => {
      if (my !== token) return;
      if (!check(meta.mediaTime)) video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  } else {
    video.addEventListener('timeupdate', () => check(video.currentTime));
  }
}

// Eine Szene lässt sich nicht abspielen (Datei kaputt): aus der Liste streichen und mit der nächsten weitermachen.
// Nur für die aktuelle Szene (my === token), sonst würden Meldungen einer schon abgelösten Szene gültige streichen.
function skipBroken(my) {
  if (my !== token) return;
  scenes.splice(sceneIndex, 1);
  document.body.dataset.sceneCount = String(scenes.length);
  if (scenes.length) {
    showScene(sceneIndex);
  } else {
    videos.forEach((v) => v.classList.remove('visible'));
    document.body.dataset.mode = 'black';
  }
}

function showScene(index) {
  if (!scenes.length) return;
  const my = ++token;
  sceneIndex = wrap(index);
  const name = scenes[sceneIndex];
  document.body.dataset.scene = name;

  const incoming = videos[1 - front];
  const outgoing = videos[front];
  incoming.onerror = () => skipBroken(my);
  incoming.loop = scenes.length === 1; // nur ein Video: in Schleife; sonst einmal abspielen und weiter
  incoming.muted = true;
  incoming.src = 'videos/screensaver/' + encodeURIComponent(name);

  const reveal = () => {
    if (my !== token) return;
    incoming.classList.add('visible');
    outgoing.classList.remove('visible');
    front = 1 - front;
    if (scenes.length > 1) watchEnd(incoming, my);
    setTimeout(() => {                      // das abgelöste Video freigeben, sobald die Überblendung vorbei ist
      if (my !== token || outgoing.classList.contains('visible')) return;
      outgoing.pause();
      outgoing.removeAttribute('src');
      outgoing.load();
    }, FADE_MS + 150);
  };
  const playing = incoming.play();
  if (incoming.requestVideoFrameCallback) incoming.requestVideoFrameCallback(reveal);
  else incoming.addEventListener('playing', reveal, { once: true });
  // Ein abgebrochenes play() (AbortError) heißt nur "es wurde schon etwas anderes geladen" - kein Fehler der Datei
  if (playing && playing.catch) playing.catch((err) => { if (!err || err.name !== 'AbortError') skipBroken(my); });
}

// ---------- Bilder (aktuell beliebte Filme) ----------
let imageList = [];   // Adressen, in zufälliger Reihenfolge
let imageIndex = -1;
let imgFront = 0;     // welches der beiden Bilder gerade sichtbar ist
let imgToken = 0;     // macht Rückmeldungen eines abgelösten Bildes wirkungslos
let imgTimer = null;

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function wrapImage(i) {
  return ((i % imageList.length) + imageList.length) % imageList.length;
}

// Nächstes Bild nach IMAGE_MS - nicht solange die Zusatzinfo zu sehen ist (setInfo(false) startet die Zeit neu)
function armAdvance(my) {
  clearTimeout(imgTimer);
  if (imageList.length < 2 || infoVisible) return;
  imgTimer = setTimeout(() => { if (my === imgToken && !waking && !infoVisible) showImage(imageIndex + 1); }, IMAGE_MS);
}

// ---------- Zusatzinfo zum Film (nur Bildervariante) ----------
const infoScrim = document.getElementById('info-scrim');
const infoBox = document.getElementById('info');
const infoLogo = document.getElementById('info-logo');
const infoTitle = document.getElementById('info-title');
const infoOverview = document.getElementById('info-overview');
let infoVisible = false;
let infoToken = 0;

// Holt (einmal pro Film) und lädt das Logo vor; Ergebnis: Adresse oder '' (kein Logo / nicht ladbar)
function prepareLogo(item) {
  if (!item) return Promise.resolve('');
  if (!item.logoPromise) {
    item.logoPromise = (async () => {
      if (!item.id || !window.screensaverAPI || !window.screensaverAPI.getLogo) return '';
      let url = '';
      try { url = await window.screensaverAPI.getLogo(item.id); } catch (err) { url = ''; }
      if (typeof url !== 'string' || !url) return '';
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(url);
        img.onerror = () => resolve('');
        img.src = url;
      });
    })();
  }
  return item.logoPromise;
}

function hideInfoText() {
  infoToken++;
  infoBox.classList.remove('show');
}

// Zeigt die Info zum aktuellen Bild: Logo, sonst der Titel als Text; dazu die Beschreibung. Ohne beides bleibt sie leer.
async function presentInfo() {
  const my = ++infoToken;
  infoBox.classList.remove('show');
  const item = imageList[imageIndex];
  if (!item || !(item.title || item.overview)) { infoScrim.classList.remove('show'); return; }
  const logo = await Promise.race([prepareLogo(item), new Promise((resolve) => setTimeout(() => resolve(''), LOGO_WAIT_MS))]);
  if (my !== infoToken || !infoVisible || waking) return;
  infoScrim.classList.add('show');
  if (logo) {
    infoLogo.src = logo;
    infoLogo.style.display = 'block';
    infoTitle.style.display = 'none';
  } else {
    infoLogo.style.display = 'none';
    infoTitle.textContent = item.title;
    infoTitle.style.display = item.title ? 'block' : 'none';
  }
  infoOverview.textContent = item.overview;
  infoOverview.style.display = item.overview ? '-webkit-box' : 'none';
  infoBox.classList.add('show');
  document.body.dataset.info = item.title;
}

function setInfo(visible) {
  if (mode !== 'images' || !imageList.length || waking) return; // bei Video und Schwarz gibt es keine Info (und es weckt nicht auf)
  if (visible === infoVisible) return;
  infoVisible = visible;
  if (visible) {
    clearTimeout(imgTimer);
    presentInfo();
  } else {
    hideInfoText();
    infoScrim.classList.remove('show');
    document.body.dataset.info = '';
    armAdvance(imgToken); // wieder die volle Zeit bis zum nächsten Bild
  }
}

// Ein Bild lässt sich nicht laden: aus der Liste streichen und mit dem nächsten weitermachen (Liste leer = schwarz)
function skipBrokenImage(my) {
  if (my !== imgToken) return;
  imageList.splice(imageIndex, 1);
  document.body.dataset.imageCount = String(imageList.length);
  if (imageList.length) {
    showImage(imageIndex);
  } else {
    images.forEach((img) => img.classList.remove('visible'));
    loadImageList(IMAGES_RETRY_MS);
  }
}

function showImage(index) {
  if (!imageList.length) return;
  const my = ++imgToken;
  clearTimeout(imgTimer);
  imageIndex = wrapImage(index);
  const url = imageList[imageIndex].url;
  document.body.dataset.image = url;
  if (infoVisible) hideInfoText(); // die Info des alten Bildes verschwindet, die des neuen kommt mit dem Bild

  const incoming = images[1 - imgFront];
  const outgoing = images[imgFront];
  incoming.onerror = () => skipBrokenImage(my);
  // Das neue Bild wird erst gezeigt, wenn es ganz geladen ist - bis dahin bleibt das alte stehen (kein schwarzer Moment)
  incoming.onload = () => {
    if (my !== imgToken) return;
    incoming.classList.add('visible');
    outgoing.classList.remove('visible');
    imgFront = 1 - imgFront;
    document.body.dataset.shown = String((Number(document.body.dataset.shown) || 0) + 1);
    setTimeout(() => {                      // das abgelöste Bild freigeben, sobald die Überblendung vorbei ist
      if (my !== imgToken || outgoing.classList.contains('visible')) return;
      outgoing.removeAttribute('src');
    }, FADE_MS + 150);
    armAdvance(my);
    if (imageList.length > 1) new Image().src = imageList[wrapImage(imageIndex + 1)].url; // das nächste schon laden
    if (infoVisible) presentInfo(); else prepareLogo(imageList[imageIndex]); // das Logo schon holen, damit die Info sofort da ist
  };
  incoming.removeAttribute('src');
  incoming.src = url;
}

// Holt die Bild-Adressen vom Hauptprozess. Kommt nichts (kein Key, kein Netz), bleibt der Bildschirm schwarz und es
// wird nach einer Weile erneut versucht.
function loadImageList(delayMs) {
  setTimeout(async () => {
    if (waking || !window.screensaverAPI || !window.screensaverAPI.getImages) return;
    let urls = [];
    try { urls = await window.screensaverAPI.getImages(); } catch (err) { urls = []; }
    if (waking) return;
    if (Array.isArray(urls) && urls.length) {
      imageList = shuffle(urls.map((u) => (typeof u === 'string' ? { url: u } : { ...u })));
      document.body.dataset.imageCount = String(imageList.length);
      showImage(0);
    } else {
      loadImageList(IMAGES_RETRY_MS);
    }
  }, delayMs);
}

function go(delta) {
  if (waking) return;
  if (mode === 'images') {
    if (imageList.length) showImage(imageIndex + delta);
    return;
  }
  if (!scenes.length) return;
  showScene(sceneIndex + delta);
}

// Befehle der Startseite (nur eingebettet): vorheriges/nächstes, Zusatzinfo ein/aus/umschalten, aufwecken
function handleCommand(d) {
  if (waking) return;
  if (d.cmd === 'go') go(d.dir < 0 ? -1 : 1);
  else if (d.cmd === 'info') setInfo(d.value === 'toggle' ? !infoVisible : !!d.value);
  else if (d.cmd === 'wake') wake();
}

// ---------- Aufwecken ----------
let exited = false;
function exit() {
  if (exited) return; // maybeExit läuft in jedem Bild - das Beenden nur ein einziges Mal melden
  exited = true;
  if (window.screensaverAPI) window.screensaverAPI.exit();
}

function wake() {
  if (waking) return;
  waking = true;
  wakeStartedAt = performance.now();
  document.body.dataset.state = 'waking';
  stage.classList.remove('on');
  stage.classList.add('off');
  setTimeout(() => { fadeDone = true; maybeExit(); }, WAKE_FADE_MS);
}

let padHeld = false; // irgendeine Controller-Taste oder ein Stick ist gerade gedrückt
function maybeExit() {
  if (!waking || !fadeDone) return;
  if (padHeld && performance.now() - wakeStartedAt < WAKE_RELEASE_TIMEOUT_MS) return;
  exit();
}

window.addEventListener('keydown', (e) => {
  if (embedded) return;                 // eingebettet liest die Startseite die Eingaben
  if (waking || e.repeat) return;       // gehaltene Tasten (z.B. die der Vorschau) wecken nicht
  if (e.code === 'ArrowLeft') { go(-1); return; }
  if (e.code === 'ArrowRight') { go(1); return; }
  if (e.code === 'ArrowDown') { setInfo(!infoVisible); return; }   // runter schaltet die Info ein und wieder aus
  if (e.code === 'ArrowUp') return;                                  // hoch: ohne Funktion, weckt aber nicht auf
  wake();
}, true);

['mousedown', 'wheel', 'touchstart', 'contextmenu'].forEach((type) => {
  window.addEventListener(type, () => { if (!embedded && performance.now() - startedAt > 600) wake(); }, true);
});

let mouseOrigin = null;
window.addEventListener('mousemove', (e) => {
  if (embedded || performance.now() - startedAt < IGNORE_MOUSE_MS) return;
  if (!mouseOrigin) { mouseOrigin = { x: e.screenX, y: e.screenY }; return; }
  if (Math.hypot(e.screenX - mouseOrigin.x, e.screenY - mouseOrigin.y) > MOUSE_WAKE_PX) wake();
}, true);

// ---------- Controller ----------
let armed = false;        // erst scharf, wenn nichts mehr gedrückt ist (z.B. die A-Taste der Vorschau oder das B der Startseite) und die Anlaufzeit um ist
let padLeft = false;
let padRight = false;
let padUp = false;
let padDown = false;
let lastPadUsed = -1000;

function pollPad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let held = false;
  let left = false;
  let right = false;
  let up = false;
  let down = false;
  let wakeInput = false;
  for (const gp of pads) {
    if (!gp) continue;
    gp.buttons.forEach((b, i) => {
      if (!b.pressed) return;
      held = true;
      if (i === PAD_LEFT) left = true;
      else if (i === PAD_RIGHT) right = true;
      else if (i === PAD_UP) up = true;
      else if (i === PAD_DOWN) down = true;
      else wakeInput = true;
    });
    const x = gp.axes[0] || 0;
    if (x < -STICK_THRESHOLD) { left = true; held = true; }
    else if (x > STICK_THRESHOLD) { right = true; held = true; }
    // alle anderen Stick-Richtungen (links hoch/runter, rechter Stick) wecken
    if (Math.abs(gp.axes[1] || 0) > STICK_THRESHOLD || Math.abs(gp.axes[2] || 0) > STICK_THRESHOLD || Math.abs(gp.axes[3] || 0) > STICK_THRESHOLD) {
      wakeInput = true;
      held = true;
    }
  }
  padHeld = held;
  if (held && !embedded && window.screensaverAPI && window.screensaverAPI.padUsed) {
    const now = performance.now();
    if (now - lastPadUsed > 300) { lastPadUsed = now; window.screensaverAPI.padUsed(); }
  }

  if (!armed) {
    // Erst scharf, wenn nichts gedrückt ist UND die Anlaufzeit um ist: Wird der Bildschirmschoner mit einer Controller-Taste
    // gestartet (B auf der Startseite), ist sie noch gehalten, die Ansicht sieht den Controller aber zuerst gar nicht ("nichts
    // gedrückt") und würde sonst beim Erscheinen der gehaltenen Taste sofort aufwachen.
    if (!held && performance.now() - startedAt > PAD_ARM_AFTER_MS) armed = true;
  } else if (!waking) {
    if (wakeInput) wake();
    else {
      if (left && !padLeft) go(-1);   // nur beim Drücken, nicht dauernd
      if (right && !padRight) go(1);
      if (down && !padDown) setInfo(!infoVisible);   // Steuerkreuz runter: Info ein, beim nächsten Druck wieder aus
      // Steuerkreuz hoch: ohne Funktion (weckt aber nicht auf)
    }
  }
  padLeft = left;
  padRight = right;
  padUp = up;
  padDown = down;
  maybeExit();
  requestAnimationFrame(pollPad);
}
if (!embedded) requestAnimationFrame(pollPad);

// ---------- Start ----------
requestAnimationFrame(() => stage.classList.add('on'));
if (mode === 'images') loadImageList(0);
else if (scenes.length) showScene(sceneIndex);
