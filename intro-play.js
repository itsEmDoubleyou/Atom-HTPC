// Intro-Ansicht: blendet das Video sanft ein (FADE_IN_MS), lässt es bis HOLD_MS nach dem Start stehen und blendet es dann
// sanft aus (FADE_OUT_MS); danach meldet sie 'intro-done'. Der Ablauf beginnt, sobald das Video wirklich läuft (nicht
// schon beim Laden der Seite), damit Ladezeit nicht von den 4 Sekunden abgeht. Der Ton wird mit dem Bild ein- und
// ausgeblendet. Ist das Video kürzer, bleibt sein letztes Bild bis zum Ausblenden stehen; ist es länger, wird es beim
// Ausblenden abgeschnitten.
const FADE_IN_MS = 1000;
const HOLD_MS = 4000;      // so lange nach dem Start beginnt das Ausblenden
const FADE_OUT_MS = 1000;
const START_TIMEOUT_MS = 4000; // läuft das Video bis dahin nicht, wird das Intro übersprungen

const params = new URLSearchParams(location.search);
const src = params.get('src') || '';
const stage = document.getElementById('stage');
const video = document.getElementById('video');

let finished = false;
let started = false;

function finish() {
  if (finished) return;
  finished = true;
  try { video.pause(); } catch (err) { /* egal */ }
  document.body.dataset.state = 'done';
  if (window.introAPI) window.introAPI.done();
}

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function level(elapsed) {
  if (elapsed < FADE_IN_MS) return easeInOut(elapsed / FADE_IN_MS);
  if (elapsed < HOLD_MS) return 1;
  if (elapsed < HOLD_MS + FADE_OUT_MS) return 1 - easeInOut((elapsed - HOLD_MS) / FADE_OUT_MS);
  return 0;
}

function run() {
  if (started) return;
  started = true;
  clearTimeout(startTimer);
  document.body.dataset.state = 'playing';
  const t0 = performance.now();
  const frame = (now) => {
    if (finished) return;
    const elapsed = now - t0;
    const l = level(elapsed);
    stage.style.opacity = String(l);
    video.volume = Math.max(0, Math.min(1, l));
    if (elapsed >= HOLD_MS + FADE_OUT_MS) { finish(); return; }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const startTimer = setTimeout(() => { if (!started) finish(); }, START_TIMEOUT_MS);
video.addEventListener('error', finish);
video.addEventListener('playing', run, { once: true });
video.volume = 0;
video.src = src; // relativ zu dieser Seite (videos/intro/intro.mp4)
const p = video.play();
if (p && p.catch) p.catch(finish);
