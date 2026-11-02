// Neutrales Platzhalter-Icon (Data-URI, keine externe Datei nötig)
const PLACEHOLDER_ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="100%" height="100%" fill="#333"/><text x="50%" y="50%" fill="#aaa" font-size="14" font-family="Arial" text-anchor="middle" dominant-baseline="middle">Icon</text></svg>'
);

// Vorgefertigte Vorlagen für bekannte Dienste - Icon wird nur gesetzt, wenn im
// img/-Ordner bereits eine passende Datei mitgeliefert wird. Für die anderen
// Dienste bleibt das Icon-Feld leer, der Nutzer kann selbst eins hinterlegen.
const APP_TEMPLATES = {
  netflix: { name: 'Netflix', url: 'https://www.netflix.com/de/', icon: 'img/icon/netflix.svg' },
  paramount: { name: 'Paramount+', url: 'https://www.paramountplus.com/de/', icon: 'img/icon/paramount.svg' },
  youtube: { name: 'YouTube', url: 'https://www.youtube.com/tv', icon: 'img/icon/youtube.svg' },
  disney: { name: 'Disney+', url: 'https://www.disneyplus.com/de-de', icon: 'img/icon/disney.svg' },
  primevideo: { name: 'Amazon Prime', url: 'https://www.primevideo.com/', icon: 'img/icon/prime.svg' },
  appletv: { name: 'Apple TV', url: 'https://tv.apple.com/de', icon: 'img/icon/appletv.svg' },
  spotify: { name: 'Spotify', url: 'https://open.spotify.com/', icon: 'img/icon/spotify.svg' },
  discord: { name: 'Discord', url: 'https://discord.com/app', icon: 'img/icon/discord.svg' },
  ard: { name: 'ARD Mediathek', url: 'https://www.ardmediathek.de/', icon: '' },
  zdf: { name: 'ZDF Mediathek', url: 'https://www.zdf.de/', icon: '' },
  arte: { name: 'Arte Mediathek', url: 'https://www.arte.tv/de/', icon: '' },
  browser: { name: 'Browser', url: 'https://www.google.com/', icon: 'img/icon/browser.svg', type: 'browser' }
};

let apps = [];
let editingId = null; // null = neue App, sonst ID der bearbeiteten App
let draggedId = null;
let tileEls = []; // aktuelle Kachel-Elemente in Grid-Reihenfolge (inkl. Plus-Kachel), für die Pfeiltasten-Navigation
const GRID_COLUMNS = 4; // muss zu .manage-grid (grid-template-columns) passen

const grid = document.getElementById('manage-grid');
const overlay = document.getElementById('form-overlay');
const appForm = document.querySelector('.app-form');

async function loadApps() {
  apps = await window.electronAPI.getApps();
  renderGrid();
}

function renderGrid() {
  grid.innerHTML = '';

  apps.forEach(appData => {
    const tile = document.createElement('div');
    tile.className = 'icon manage-tile';
    tile.setAttribute('draggable', 'true');
    tile.tabIndex = 0; // per Pfeiltasten erreichbar
    tile.dataset.id = appData.id;

    const img = document.createElement('img');
    img.src = appData.icon;
    img.alt = appData.name;
    tile.appendChild(img);

    const label = document.createElement('span');
    label.className = 'manage-tile-label';
    label.textContent = appData.name;
    tile.appendChild(label);

    // Hover-Overlay mit den beiden Optionen statt direktem Klick-Verhalten
    const tileOverlay = document.createElement('div');
    tileOverlay.className = 'tile-overlay';

    const editBtn = document.createElement('button');
    editBtn.className = 'tile-action tile-edit';
    editBtn.textContent = '✎ Bearbeiten';
    editBtn.tabIndex = -1; // Kachel selbst ist der Fokus-Stopp, nicht der Button einzeln
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openForm(appData);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'tile-action tile-delete';
    deleteBtn.textContent = '🗑 Löschen';
    deleteBtn.tabIndex = -1;
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeApp(appData.id);
    });

    tileOverlay.appendChild(editBtn);
    tileOverlay.appendChild(deleteBtn);
    tile.appendChild(tileOverlay);

    // Enter/Space auf der fokussierten Kachel öffnet das Bearbeiten-Formular
    // (Löschen ist dort ebenfalls per Button erreichbar)
    tile.addEventListener('keydown', (e) => {
      if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        openForm(appData);
      }
    });

    // Drag & Drop zum Sortieren
    tile.addEventListener('dragstart', () => {
      draggedId = appData.id;
      tile.classList.add('dragging');
    });
    tile.addEventListener('dragend', () => {
      tile.classList.remove('dragging');
      draggedId = null;
    });
    tile.addEventListener('dragover', (e) => {
      e.preventDefault();
      tile.classList.add('drag-over');
    });
    tile.addEventListener('dragleave', () => {
      tile.classList.remove('drag-over');
    });
    tile.addEventListener('drop', (e) => {
      e.preventDefault();
      tile.classList.remove('drag-over');
      if (draggedId && draggedId !== appData.id) {
        reorderApps(draggedId, appData.id);
      }
    });

    grid.appendChild(tile);
  });

  // Plus-Kachel zum Hinzufügen einer neuen App
  const addTile = document.createElement('div');
  addTile.className = 'icon manage-tile add-tile';
  addTile.textContent = '+';
  addTile.title = 'App hinzufügen';
  addTile.tabIndex = 0;
  addTile.addEventListener('click', () => openForm(null));
  addTile.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      openForm(null);
    }
  });
  grid.appendChild(addTile);

  tileEls = Array.from(grid.children);
}

// Controller: A-Taste aktiviert das fokussierte Element (Buttons, Auswahllisten, Kacheln).
// Ohne das erreichen simulierte Tasten die Handler direkt an den Kacheln nicht.
if (window.NavHelper) window.NavHelper.enableControllerActivation();

// 2D-Grid-Navigation: Pfeiltasten bewegen den Fokus zeilen-/spaltenweise durch
// die Kacheln, geklemmt am Rand (kein Umbruch). Reagiert nur, wenn eine Kachel
// (nicht das Formular) den Fokus hat, und nicht während das Formular offen ist.
window.addEventListener('keydown', (e) => {
  if (overlay.classList.contains('visible')) return; // Formular übernimmt seine eigene Navigation
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) return;

  const active = document.activeElement;
  let index = tileEls.indexOf(active);
  if (index === -1) {
    if (tileEls.length > 0) {
      e.preventDefault();
      tileEls[0].focus();
    }
    return;
  }

  e.preventDefault();
  const row = Math.floor(index / GRID_COLUMNS);
  const col = index % GRID_COLUMNS;
  const rowCount = Math.ceil(tileEls.length / GRID_COLUMNS);

  let targetIndex = index;
  if (e.code === 'ArrowLeft' && col > 0) targetIndex = index - 1;
  else if (e.code === 'ArrowRight' && col < GRID_COLUMNS - 1 && index + 1 < tileEls.length) targetIndex = index + 1;
  else if (e.code === 'ArrowUp' && row > 0) targetIndex = index - GRID_COLUMNS;
  else if (e.code === 'ArrowDown' && row < rowCount - 1) {
    targetIndex = Math.min(index + GRID_COLUMNS, tileEls.length - 1);
  }

  if (tileEls[targetIndex]) tileEls[targetIndex].focus();
});

function reorderApps(draggedAppId, targetAppId) {
  const fromIndex = apps.findIndex(a => a.id === draggedAppId);
  const toIndex = apps.findIndex(a => a.id === targetAppId);
  if (fromIndex === -1 || toIndex === -1) return;

  const [moved] = apps.splice(fromIndex, 1);
  apps.splice(toIndex, 0, moved);

  renderGrid();
  persistApps();
}

async function persistApps() {
  await window.electronAPI.saveApps(apps);
}

function removeApp(id) {
  apps = apps.filter(a => a.id !== id);
  renderGrid();
  persistApps();
}

// ---------- Formular (Hinzufügen / Bearbeiten) ----------

let lastFocusedTile = null;

function openForm(appData) {
  editingId = appData ? appData.id : null;
  lastFocusedTile = document.activeElement && tileEls.includes(document.activeElement)
    ? document.activeElement
    : null;

  document.getElementById('form-title').textContent = appData ? 'App bearbeiten' : 'App hinzufügen';
  document.getElementById('form-template').value = ''; // Vorlage ist nur eine Ausfüllhilfe, kein gespeichertes Feld
  document.getElementById('form-name').value = appData ? appData.name : '';
  document.getElementById('form-url').value = appData ? (appData.url || '') : '';
  document.getElementById('form-program-path').value = appData ? (appData.programPath || '') : '';
  document.getElementById('form-program-args').value = appData ? (appData.launchArgs || '') : '';
  document.getElementById('form-icon-url').value = (appData && !appData.icon.startsWith('data:')) ? appData.icon : '';
  document.getElementById('form-bg-url').value = (appData && !appData.bg.startsWith('data:')) ? appData.bg : '';
  document.getElementById('form-topshelf-mode').value = (appData && appData.topshelf) ? appData.topshelf : 'off';
  document.getElementById('form-tmdb-provider').value = (appData && appData.topshelfProvider) ? appData.topshelfProvider : '';
  document.getElementById('form-dynamic-bg-toggle').checked = !!(appData && appData.dynamicBg);
  document.getElementById('form-loading-style').value = (appData && appData.loadingStyle) ? appData.loadingStyle : 'bar';

  setAppType(appData && (appData.type === 'native' || appData.type === 'browser') ? appData.type : 'web');

  updatePreview('form-icon-preview', appData ? appData.icon : '');
  updatePreview('form-bg-preview', appData ? appData.bg : '');

  document.getElementById('form-delete').style.display = appData ? 'inline-block' : 'none';

  overlay.classList.add('visible');
  window.electronAPI.setBackspaceCapture(true); // Backspace schließt jetzt das Formular statt "zurück" zu navigieren
  document.getElementById('form-template').focus();
}

// App-Typ umschalten: Web-App (URL) oder lokales Programm (Programmpfad)
let currentAppType = 'web';

function setAppType(type) {
  currentAppType = type;
  document.getElementById('type-web').classList.toggle('active', type === 'web');
  document.getElementById('type-browser').classList.toggle('active', type === 'browser');
  document.getElementById('type-native').classList.toggle('active', type === 'native');
  document.getElementById('url-field-group').style.display = type !== 'native' ? 'block' : 'none';
  document.querySelector('label[for="form-url"]').textContent = type === 'browser' ? 'Startseite (URL)' : 'URL';
  document.getElementById('program-field-group').style.display = type === 'native' ? 'block' : 'none';
  // Topshelf ergibt nur bei Web-Apps Sinn (keine eigene Ansicht bei nativen Programmen)
  document.getElementById('topshelf-field-group').style.display = type === 'web' ? 'block' : 'none';
}

document.getElementById('type-web').addEventListener('click', () => setAppType('web'));
document.getElementById('type-browser').addEventListener('click', () => setAppType('browser'));
document.getElementById('type-native').addEventListener('click', () => setAppType('native'));



document.getElementById('form-program-file').addEventListener('click', async () => {
  const programPath = await window.electronAPI.selectProgram();
  if (programPath) {
    document.getElementById('form-program-path').value = programPath;
  }
});

// Vorlage gewählt: Name, URL und (falls vorhanden) Icon automatisch übernehmen -
// Vorlagen sind Web-Apps (schaltet daher zurück auf "Web-App"), nur die Vorlage "Browser" bringt ihren Typ mit
document.getElementById('form-template').addEventListener('change', (e) => {
  const template = APP_TEMPLATES[e.target.value];
  if (!template) return;

  setAppType(template.type || 'web');
  document.getElementById('form-name').value = template.name;
  document.getElementById('form-url').value = template.url;

  if (template.icon) {
    document.getElementById('form-icon-url').value = template.icon;
    updatePreview('form-icon-preview', template.icon);
  }
});

function closeForm() {
  overlay.classList.remove('visible');
  editingId = null;
  window.electronAPI.setBackspaceCapture(false);
  if (lastFocusedTile) lastFocusedTile.focus();
  lastFocusedTile = null;
}

function updatePreview(imgId, src) {
  const img = document.getElementById(imgId);
  if (src) {
    img.src = src;
    img.style.display = 'block';
  } else {
    img.removeAttribute('src');
    img.style.display = 'none';
  }
}

document.getElementById('form-icon-url').addEventListener('input', (e) => {
  updatePreview('form-icon-preview', e.target.value);
});
document.getElementById('form-bg-url').addEventListener('input', (e) => {
  updatePreview('form-bg-preview', e.target.value);
});

document.getElementById('form-icon-file').addEventListener('click', async () => {
  const filePath = await window.electronAPI.selectImage();
  if (filePath) {
    document.getElementById('form-icon-url').value = filePath;
    updatePreview('form-icon-preview', filePath);
  }
});

document.getElementById('form-bg-file').addEventListener('click', async () => {
  const filePath = await window.electronAPI.selectImage();
  if (filePath) {
    document.getElementById('form-bg-url').value = filePath;
    updatePreview('form-bg-preview', filePath);
  }
});

document.getElementById('form-cancel').addEventListener('click', closeForm);

document.getElementById('form-save').addEventListener('click', () => {
  const name = document.getElementById('form-name').value.trim();
  const url = document.getElementById('form-url').value.trim();
  const programPath = document.getElementById('form-program-path').value.trim();
  const programArgs = document.getElementById('form-program-args').value.trim();
  const icon = document.getElementById('form-icon-url').value.trim();
  const bg = document.getElementById('form-bg-url').value.trim();
  const topshelfMode = document.getElementById('form-topshelf-mode').value;
  const tmdbProvider = document.getElementById('form-tmdb-provider').value;
  const dynamicBg = document.getElementById('form-dynamic-bg-toggle').checked;
  const loadingStyle = document.getElementById('form-loading-style').value;

  if (!name) {
    alert('Bitte einen Namen angeben.');
    return;
  }
  if (currentAppType !== 'native' && !url) {
    alert('Bitte eine URL angeben.');
    return;
  }
  if (currentAppType === 'native' && !programPath) {
    alert('Bitte einen Programmpfad angeben.');
    return;
  }
  if (currentAppType === 'web' && (topshelfMode !== 'off' || dynamicBg) && !tmdbProvider) {
    alert('Bitte einen TMDb-Anbieter wählen (für Topshelf und/oder dynamischen Hintergrund) - oder beides ausschalten.');
    return;
  }

  if (editingId) {
    const app = apps.find(a => a.id === editingId);
    app.name = name;
    app.type = currentAppType;
    app.url = currentAppType !== 'native' ? url : '';
    app.programPath = currentAppType === 'native' ? programPath : '';
    app.launchArgs = currentAppType === 'native' ? programArgs : '';
    app.icon = icon || app.icon;
    app.bg = bg; // leer lassen = kein eigener Hintergrund -> Logo wird auf der Startseite gezeigt
    app.topshelf = currentAppType === 'web' ? topshelfMode : 'off';
    app.topshelfProvider = currentAppType === 'web' ? tmdbProvider : '';
    app.dynamicBg = currentAppType === 'web' ? dynamicBg : false;
    app.loadingStyle = loadingStyle; // gilt für Web- UND native Apps, beide nutzen den Ladebildschirm
  } else {
    apps.push({
      id: crypto.randomUUID(),
      name,
      type: currentAppType,
      url: currentAppType !== 'native' ? url : '',
      programPath: currentAppType === 'native' ? programPath : '',
      launchArgs: currentAppType === 'native' ? programArgs : '',
      icon: icon || PLACEHOLDER_ICON,
      bg: bg, // leer lassen = kein eigener Hintergrund -> Logo wird auf der Startseite gezeigt
      topshelf: currentAppType === 'web' ? topshelfMode : 'off',
      topshelfProvider: currentAppType === 'web' ? tmdbProvider : '',
      dynamicBg: currentAppType === 'web' ? dynamicBg : false,
      loadingStyle: loadingStyle
    });
  }

  renderGrid();
  persistApps();
  closeForm();
});

document.getElementById('form-delete').addEventListener('click', () => {
  if (editingId) {
    removeApp(editingId);
  }
  closeForm();
});

window.addEventListener('DOMContentLoaded', () => {
  loadApps();
});

// Solange das Formular offen ist: Backspace schließt es, Pfeiltasten bleiben
// innerhalb des Formulars (statt zur Kachel-Navigation im Hintergrund zu wechseln)
window.addEventListener('keydown', (e) => {
  if (!overlay.classList.contains('visible')) return;
  if (!window.NavHelper) return; // ohne nav.js keine Formular-Navigation, aber Maus/Buttons bleiben nutzbar
  // Liegt der Fokus auf der Bildschirmtastatur, bedient sie sich selbst (sonst würde
  // z.B. Backspace/B das ganze Formular schließen statt nur die Tastatur)
  if (window.NavHelper.isInOnScreenKeyboard(document.activeElement)) return;

  if (e.code === 'Backspace' && !window.NavHelper.isTextEditable(document.activeElement)) {
    e.preventDefault();
    closeForm();
    return;
  }

  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
    if (window.NavHelper.isNativeArrowUse(document.activeElement, e.code, e)) return;
    e.preventDefault();
    window.NavHelper.moveLinearFocus(e.code, appForm, e);
  }
});
