if (window.NavHelper) window.NavHelper.enableLinearNav();

const toggle = document.getElementById('adblocker-toggle');
const restartNote = document.getElementById('adblocker-restart-note');

const allowInput = document.getElementById('adblock-allow-input');
const allowAddBtn = document.getElementById('adblock-allow-add');
const allowHint = document.getElementById('adblock-allow-hint');
const allowListEl = document.getElementById('adblock-allow-list');
const logToggle = document.getElementById('adblocker-log-toggle');
const listsInfoEl = document.getElementById('adblock-lists-info');
const listsRefreshBtn = document.getElementById('adblock-lists-refresh');
const listsStatusEl = document.getElementById('adblock-lists-status');
const logPathEl = document.getElementById('adblock-log-path');
const logOpenBtn = document.getElementById('adblock-log-open');
// Schalter für die einzelnen Bereiche: Einstellung -> Schalter (an = Bereich aktiv)
const layerToggles = {
  networkEnabled: document.getElementById('adblocker-layer-network'),
  headersEnabled: document.getElementById('adblocker-layer-headers'),
  stylesEnabled: document.getElementById('adblocker-layer-styles'),
  scriptsEnabled: document.getElementById('adblocker-layer-scripts'),
  scriptsStructural: document.getElementById('adblocker-layer-structure')
};
let allowlist = [];

// Ausnahmen als Knöpfe: ein Klick (bzw. A) entfernt den Eintrag
function renderAllowlist() {
  allowListEl.innerHTML = '';
  if (allowlist.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'key-hint';
    empty.textContent = 'Keine Ausnahmen eingetragen.';
    allowListEl.appendChild(empty);
    return;
  }
  allowlist.forEach((host) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-btn adblock-allow-entry';
    btn.textContent = host + '  ✕';
    btn.title = 'Ausnahme entfernen';
    btn.addEventListener('click', async () => {
      await saveExtras({ allowlist: allowlist.filter((h) => h !== host) });
      allowHint.textContent = 'Entfernt: ' + host;
      allowAddBtn.focus();
    });
    allowListEl.appendChild(btn);
  });
}

// Speichert Ausnahmen/Protokoll (gilt sofort) und übernimmt die geprüften Werte aus dem Hauptprogramm
async function saveExtras(partial) {
  const merged = await window.electronAPI.saveAdblockerSettings(partial);
  allowlist = merged.allowlist || [];
  logToggle.checked = !!merged.log;
  Object.keys(layerToggles).forEach((key) => { layerToggles[key].checked = merged[key] !== false; });
  renderAllowlist();
  return merged;
}

async function addAllowEntry() {
  const text = allowInput.value.trim();
  if (!text) return;
  const before = allowlist.length;
  await saveExtras({ allowlist: [...allowlist, text] });
  if (allowlist.length > before) {
    allowHint.textContent = 'Hinzugefügt: ' + allowlist[allowlist.length - 1];
    allowInput.value = '';
  } else {
    allowHint.textContent = 'Nicht hinzugefügt: keine gültige Adresse oder schon vorhanden.';
  }
}

// Alter der Filterlisten in Worten
function formatAge(hours) {
  if (hours === null || hours === undefined) return 'unbekannt';
  if (hours < 1) return 'vor weniger als einer Stunde';
  if (hours < 48) return 'vor ' + Math.round(hours) + ' Std.';
  return 'vor ' + Math.round(hours / 24) + ' Tagen';
}

function renderListsInfo(info) {
  if (!info || info.active === false) {
    listsInfoEl.textContent = 'Der Adblocker ist ausgeschaltet.';
    return;
  }
  if (!info.installed) {
    listsInfoEl.textContent = info.refreshing
      ? 'Die Filterlisten werden gerade geladen …'
      : 'Die Filterlisten konnten nicht geladen werden' + (info.lastError ? ' (' + info.lastError + ')' : '') + '. Ein neuer Versuch folgt automatisch.';
    return;
  }
  const date = info.builtAt ? new Date(info.builtAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : null;
  const parts = ['Stand: ' + formatAge(info.ageHours) + (date ? ' (' + date + ')' : '')];
  if (info.networkFilters) parts.push(info.networkFilters.toLocaleString('de-DE') + ' Netzwerk- und ' + (info.cosmeticFilters || 0).toLocaleString('de-DE') + ' Ausblendregeln');
  if (info.sources && info.sources.length) parts.push('Quellen: ' + info.sources.join(', '));
  if (info.failed && info.failed.length) parts.push('nicht ladbar: ' + info.failed.join(', '));
  if (!info.builtAt) parts[0] = 'Stand: alte Datei ohne Angaben - wird gleich erneuert';
  else if (info.outdated) parts.push('veraltet, wird erneuert');
  listsInfoEl.textContent = parts.join(' · ');
}

// Läuft im Hintergrund gerade eine Erneuerung (Start, Zeitplan), zeigt die Seite sie an und wartet mit
async function pollWhileRefreshing() {
  for (let i = 0; i < 40; i++) {
    const info = await window.electronAPI.getAdblockerListsInfo();
    renderListsInfo(info);
    if (!info.refreshing) return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

listsRefreshBtn.addEventListener('click', async () => {
  listsRefreshBtn.disabled = true;
  listsStatusEl.textContent = 'Wird aktualisiert … das dauert etwa 10 bis 30 Sekunden.';
  const result = await window.electronAPI.refreshAdblockerLists();
  renderListsInfo(result.info);
  listsStatusEl.textContent = result.ok
    ? 'Aktualisiert. Bereits geöffnete Seiten bitte neu laden.'
    : 'Fehlgeschlagen: ' + (result.error || 'unbekannter Fehler') + '. Die bisherigen Listen bleiben im Einsatz.';
  listsRefreshBtn.disabled = false;
  listsRefreshBtn.focus();
});

window.addEventListener('DOMContentLoaded', async () => {
  const settings = await window.electronAPI.getAdblockerSettings();
  toggle.checked = !!settings.enabled;
  allowlist = settings.allowlist || [];
  logToggle.checked = !!settings.log;
  Object.keys(layerToggles).forEach((key) => { layerToggles[key].checked = settings[key] !== false; });
  renderAllowlist();
  logPathEl.textContent = await window.electronAPI.getAdblockerLogPath();
  pollWhileRefreshing();
});

logOpenBtn.addEventListener('click', () => window.electronAPI.openAdblockerLogFolder());
Object.keys(layerToggles).forEach((key) => {
  layerToggles[key].addEventListener('change', () => saveExtras({ [key]: layerToggles[key].checked }));
});

allowAddBtn.addEventListener('click', addAllowEntry);
allowInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addAllowEntry(); });
logToggle.addEventListener('change', () => saveExtras({ log: logToggle.checked }));

toggle.addEventListener('change', async () => {
  await window.electronAPI.saveAdblockerSettings({ enabled: toggle.checked });

  // Live-Umschalten ist bei dieser Bibliothek unzuverlässig, daher startet
  // die App kurz neu, damit die Änderung sauber greift.
  restartNote.textContent = 'Wird übernommen, App startet neu…';
  toggle.disabled = true;

  setTimeout(() => {
    window.electronAPI.restartApp();
  }, 1200);
});
