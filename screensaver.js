if (window.NavHelper) window.NavHelper.enableLinearNav();

// Wartezeit in Minuten, als feste Stufen: der Regler läuft über diese Liste (jeder Druck = eine Stufe)
const DELAY_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180];

const toggle = document.getElementById('screensaver-toggle');
const modeButtons = {
  videos: document.getElementById('screensaver-mode-videos'),
  images: document.getElementById('screensaver-mode-images'),
  none: document.getElementById('screensaver-mode-none')
};
const modeHint = document.getElementById('screensaver-mode-hint');
const MODE_HINTS = {
  videos: 'Spielt die Videos video1, video2, ... aus dem Ordner videos/screensaver der Reihe nach ab.',
  images: 'Zeigt Bilder aktuell beliebter Filme von TMDb. Braucht den TMDb API-Key (Einstellungen > Hintergrund) und eine Internetverbindung, sonst bleibt der Bildschirm schwarz.',
  none: 'Der Bildschirm wird schwarz.'
};
let currentMode = 'videos';
const delaySlider = document.getElementById('screensaver-delay');
const delayValue = document.getElementById('screensaver-delay-value');
const previewBtn = document.getElementById('screensaver-preview');

let saveTimer = null;

function delayLabel(minutes) {
  if (minutes < 60) return minutes + (minutes === 1 ? ' Minute' : ' Minuten');
  const hours = minutes / 60;
  return hours + (hours === 1 ? ' Stunde' : ' Stunden');
}

// Nächstliegende Stufe zu einer gespeicherten Wartezeit (auch bei Werten, die nicht in der Liste stehen)
function nearestStepIndex(minutes) {
  let best = 0;
  DELAY_STEPS.forEach((m, i) => {
    if (Math.abs(m - minutes) < Math.abs(DELAY_STEPS[best] - minutes)) best = i;
  });
  return best;
}

function setMode(mode) {
  if (!modeButtons[mode]) mode = 'videos';
  currentMode = mode;
  Object.keys(modeButtons).forEach((key) => {
    modeButtons[key].classList.toggle('active', key === mode);
    modeButtons[key].setAttribute('aria-pressed', String(key === mode));
  });
  modeHint.textContent = MODE_HINTS[mode];
}

function renderDelay() {
  delayValue.textContent = delayLabel(DELAY_STEPS[Number(delaySlider.value)]);
}

function currentSettings() {
  return {
    enabled: toggle.checked,
    mode: currentMode,
    delayMinutes: DELAY_STEPS[Number(delaySlider.value)]
  };
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  return window.electronAPI.saveScreensaverSettings(currentSettings());
}

// Beim Verstellen (Halten der Pfeiltaste) nicht jeden Zwischenwert speichern
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}

window.addEventListener('DOMContentLoaded', async () => {
  const settings = await window.electronAPI.getScreensaverSettings();
  toggle.checked = !!settings.enabled;
  setMode(settings.mode);
  delaySlider.value = String(nearestStepIndex(settings.delayMinutes));
  renderDelay();
});

toggle.addEventListener('change', saveNow);
Object.keys(modeButtons).forEach((key) => {
  modeButtons[key].addEventListener('click', () => { setMode(key); saveNow(); });
});
delaySlider.addEventListener('input', () => { renderDelay(); scheduleSave(); });

// Vorschau: erst speichern (die Auswahl "Videos/Bilder/Keiner" gilt sofort), dann starten
previewBtn.addEventListener('click', async () => {
  await saveNow();
  window.electronAPI.startScreensaverPreview();
});

window.addEventListener('pagehide', () => { if (saveTimer) saveNow(); });
