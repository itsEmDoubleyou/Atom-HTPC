if (window.NavHelper) window.NavHelper.enableLinearNav();

const toggle = document.getElementById('intro-toggle');
const hint = document.getElementById('intro-hint');
const previewBtn = document.getElementById('intro-preview');

async function renderHint() {
  const found = await window.electronAPI.getIntroAvailable();
  hint.textContent = found ? '' : 'Die Datei videos/intro/intro.mp4 wurde nicht gefunden. Solange sie fehlt, gibt es kein Intro.';
  previewBtn.disabled = !found;
}

window.addEventListener('DOMContentLoaded', async () => {
  const settings = await window.electronAPI.getIntroSettings();
  toggle.checked = !!settings.enabled;
  renderHint();
});

toggle.addEventListener('change', () => window.electronAPI.saveIntroSettings({ enabled: toggle.checked }));

// Vorschau: läuft auch bei ausgeschaltetem Intro
previewBtn.addEventListener('click', () => window.electronAPI.startIntroPreview());
