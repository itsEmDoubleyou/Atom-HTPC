if (window.NavHelper) window.NavHelper.enableLinearNav();

const ownToggle = document.getElementById('own-toggle');
const osToggle = document.getElementById('os-toggle');
const pathSection = document.getElementById('path-section');
const pathInput = document.getElementById('keyboard-path-input');
const pathSaveBtn = document.getElementById('keyboard-path-save');
const pathHint = document.getElementById('keyboard-path-hint');

// Zeigt den gespeicherten Zustand an. Der Hauptprozess erzwingt, dass nie beide
// Tastaturen gleichzeitig an sind - deshalb immer den zurückgelieferten Stand
// übernehmen (schaltet die jeweils andere Tastatur sichtbar aus).
function applySettings(settings) {
  ownToggle.checked = !!settings.ownEnabled;
  osToggle.checked = !!settings.osEnabled;
  // Pfad ist nur relevant, solange die Windows-Tastatur aktiv ist
  pathSection.style.display = settings.osEnabled ? 'block' : 'none';
  // Eigene Tastatur auf dieser Seite sofort an den neuen Zustand anpassen
  window.dispatchEvent(new Event('osk-settings-changed'));
}

window.addEventListener('DOMContentLoaded', async () => {
  const settings = await window.electronAPI.getKeyboardSettings();
  pathInput.value = settings.path || '';
  ownToggle.checked = !!settings.ownEnabled;
  osToggle.checked = !!settings.osEnabled;
  pathSection.style.display = settings.osEnabled ? 'block' : 'none';
});

ownToggle.addEventListener('change', async () => {
  applySettings(await window.electronAPI.saveKeyboardSettings({ ownEnabled: ownToggle.checked }));
});

osToggle.addEventListener('change', async () => {
  applySettings(await window.electronAPI.saveKeyboardSettings({ osEnabled: osToggle.checked }));
});

async function savePath() {
  const value = pathInput.value.trim();
  await window.electronAPI.saveKeyboardSettings({ path: value || 'osk.exe' });
  pathHint.textContent = 'Gespeichert.';
  setTimeout(() => { pathHint.textContent = ''; }, 2000);
}

pathSaveBtn.addEventListener('click', savePath);
pathInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') savePath();
});
