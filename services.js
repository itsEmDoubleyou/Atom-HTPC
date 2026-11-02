if (window.NavHelper) window.NavHelper.enableLinearNav();

// Seite "Dienste & Schlüssel" (System): Zugangsschlüssel für Online-Dienste, derzeit der TMDb-API-Key.
// Der Hintergrund der Startseite ist der der fokussierten App, es gibt keinen allgemeinen Startseitenhintergrund mehr.

const tmdbKeyInput = document.getElementById('tmdb-key-input');
const tmdbKeySaveBtn = document.getElementById('tmdb-key-save');
const tmdbKeyHint = document.getElementById('tmdb-key-hint');

let savingKey = false;

const KEY_HINT_MISSING =
  'Ohne API-Key sind dynamische App-Hintergründe, die TMDb-Suche, das Topshelf und die Bilder des Bildschirmschoners nicht verfügbar. ' +
  'Einen kostenlosen Key gibt es auf themoviedb.org unter Einstellungen → API.';

// ---------- API-Key ----------

function setKeyHint(text, kind) {
  tmdbKeyHint.textContent = text;
  tmdbKeyHint.className = 'key-hint' + (kind ? ` ${kind}` : '');
}

// Aktualisiert alles, was vom Vorhandensein eines Keys abhängt
function updateKeyState(hasKey) {
  if (hasKey) {
    setKeyHint('API-Key hinterlegt ✓', 'ok');
  } else {
    setKeyHint(KEY_HINT_MISSING, 'warn');
  }
}

async function saveTmdbKey() {
  if (savingKey) return;
  savingKey = true;

  const value = tmdbKeyInput.value.trim();
  setKeyHint(value ? 'Key wird geprüft…' : 'Key wird entfernt…');

  const result = await window.electronAPI.saveTmdbKey(value);
  savingKey = false;

  switch (result.status) {
    case 'invalid':
      setKeyHint(
        'TMDb hat diesen API-Key abgelehnt. Bitte den „API-Schlüssel“ (v3) verwenden, ' +
        'nicht das „API Read Access Token“.',
        'error'
      );
      break;

    case 'removed':
      updateKeyState(false);
      setKeyHint('API-Key entfernt. Dynamische App-Hintergründe und die TMDb-Suche sind damit deaktiviert.', 'warn');
      break;

    case 'saved-unverified':
      updateKeyState(true);
      setKeyHint('API-Key gespeichert, konnte aber ohne Internetverbindung nicht geprüft werden.', 'warn');
      break;

    default: // 'saved'
      updateKeyState(true);
  }
}

tmdbKeySaveBtn.addEventListener('click', saveTmdbKey);
tmdbKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveTmdbKey();
});

// ---------- Beim Öffnen der Seite ----------

window.addEventListener('DOMContentLoaded', async () => {
  const settings = await window.electronAPI.getBackgroundSettings();
  tmdbKeyInput.value = settings.tmdbApiKey || '';
  updateKeyState(!!settings.tmdbApiKey);
});
