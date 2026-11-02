const params = new URLSearchParams(window.location.search);
const appId = params.get('appId');

const bgA = document.getElementById('topshelf-backdrop-a');
const bgB = document.getElementById('topshelf-backdrop-b');
const infoEl = document.getElementById('topshelf-info');
const logoEl = document.getElementById('topshelf-logo');
const titleEl = document.getElementById('topshelf-title');
const overviewEl = document.getElementById('topshelf-overview');
const dotsEl = document.getElementById('topshelf-dots');

const SLIDE_MS = 950; // muss zur CSS-Transition der Backdrops passen
const PARALLAX_EASING = 'cubic-bezier(0.33, 1, 0.68, 1)'; // sanfter/organischer als vorher, weiterhin erst schnell dann langsamer

let items = [];
let currentIndex = 0;
let frontIsA = true; // welche der beiden Backdrop-Ebenen gerade "vorne" liegt
let appData = null;
let animating = false;

async function init() {
  const apps = await window.electronAPI.getApps();
  appData = apps.find(a => a.id === appId) || null;
  if (!appData) return;

  items = await window.electronAPI.getTopshelfContent(appId);
  if (items.length === 0) return;

  // Ersten Eintrag ohne Animation direkt zeigen
  bgA.style.zIndex = '1';
  bgB.style.zIndex = '1';
  bgA.style.backgroundImage = `url('${items[0].backdropUrl}')`;
  bgA.style.transform = 'translateX(0)';
  bgA.style.opacity = '1';
  bgB.style.opacity = '0';

  renderInfo(items[0]);
  renderDots();
}

function renderInfo(item) {
  titleEl.textContent = item.title;
  overviewEl.textContent = item.overview;
  if (item.logoUrl) {
    logoEl.src = item.logoUrl;
    logoEl.style.display = 'block';
    titleEl.style.display = 'none';
  } else {
    logoEl.style.display = 'none';
    titleEl.style.display = 'block';
  }
}

function renderDots() {
  dotsEl.innerHTML = '';
  items.forEach((_, i) => {
    const dot = document.createElement('div');
    dot.className = 'topshelf-dot' + (i === currentIndex ? ' active' : '');
    dotsEl.appendChild(dot);
  });
}

// direction: 'next' (nach rechts weiter) oder 'prev' (nach links zurück)
function goTo(index, direction) {
  if (animating || index < 0 || index >= items.length || index === currentIndex) return;
  animating = true;

  const front = frontIsA ? bgA : bgB;
  const back = frontIsA ? bgB : bgA;
  const offscreenSide = direction === 'next' ? 100 : -100;

  // Neues Bild erst OHNE Übergang außerhalb des Bildschirms positionieren,
  // dann erzwungenes Reflow, damit der Browser diese Startposition wirklich
  // rendert, bevor die eigentliche (animierte) Zielposition gesetzt wird.
  // z-index sorgt dafür, dass sich das neue Bild sichtbar ÜBER das alte schiebt -
  // das alte bleibt dabei unbewegt stehen, statt selbst mit rauszugleiten.
  back.style.zIndex = '2';
  front.style.zIndex = '1';
  back.style.transition = 'none';
  back.style.backgroundImage = `url('${items[index].backdropUrl}')`;
  back.style.transform = `translateX(${offscreenSide}%)`;
  back.style.opacity = '1';
  void back.offsetWidth;

  back.style.transition = `transform ${SLIDE_MS}ms ${PARALLAX_EASING}`;
  back.style.transform = 'translateX(0)';
  // front bleibt bewusst unverändert stehen

  // Info-Panel (Logo/Text) als eigene, leicht versetzte Ebene - erzeugt den
  // Eindruck von Tiefe (Parallax), statt dass alles exakt synchron läuft.
  infoEl.style.transition = 'opacity 0.3s ease, transform 0.55s ' + PARALLAX_EASING;
  infoEl.style.opacity = '0';
  infoEl.style.transform = `translateX(${offscreenSide / 4}px)`;

  setTimeout(() => {
    renderInfo(items[index]);
    infoEl.style.transform = 'translateX(0)';
    infoEl.style.opacity = '1';
  }, 280);

  setTimeout(() => {
    frontIsA = !frontIsA;
    currentIndex = index;
    renderDots();
    animating = false;
  }, SLIDE_MS);
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'ArrowRight') {
    e.preventDefault();
    goTo(currentIndex + 1, 'next');
  } else if (e.code === 'ArrowLeft') {
    e.preventDefault();
    goTo(currentIndex - 1, 'prev');
  } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
    e.preventDefault();
    if (appData) window.electronAPI.loadApp(appData);
  }
  // Backspace wird zentral im Hauptprozess behandelt (führt zurück zum Launcher)
});

window.addEventListener('DOMContentLoaded', init);
