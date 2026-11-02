// Bildschirmschoner (Hauptprozess): Leerlauf-Zeitgeber und die eigene Ansicht über dem Hauptfenster.
// Die Ansicht (screensaver-play.html) wird nur bei Bedarf erzeugt und beim Beenden wieder entfernt. Weil sie eine
// eigene Ansicht ist, landen ihre Eingaben nicht in der Tastenlogik des Launchers (z.B. Backspace = zurück).
// Wann er startet: nach delayMinutes ohne gemeldete Aktivität (die Launcher-Seiten melden Tastatur, Maus und
// Controller über 'user-activity'), eingeschaltet, nur in erlaubten Ansichten (nicht in Apps) - siehe isViewAllowed.
const { WebContentsView, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// Die Videos liegen in videos/screensaver/ und heißen video1, video2, video3 ... (mp4/webm/m4v/mov). Sie laufen in der
// Reihenfolge der Nummer; nach dem letzten geht es wieder bei video1 los.
const SCENE_FILE = /^video\s*(\d+)\.(mp4|webm|m4v|mov)$/i;
const MIN_DELAY_MS = 1000;

// getMainWindow: liefert das Hauptfenster (oder null); isViewAllowed: ob die aktuelle Ansicht einen Bildschirmschoner
// erlaubt (Launcher/Einstellungen ja, laufende App/Ladebildschirm/Umschalter nein); readSettings: gespeicherte Einstellungen.
// getImages: liefert (als Promise) die Bild-Adressen für die Bildervariante (aktuell beliebte Filme von TMDb, mit
// Zwischenspeicher und eigener Fehlerbehandlung); fehlt es oder schlägt es fehl, bleibt der Bildschirm schwarz.
// Die Einträge sind { url, id, title, overview } (reine Adress-Zeichenketten werden akzeptiert). getLogo(id): Logo-Adresse
// eines Films für die Zusatzinfo, oder ''.
// canEmbed (optional): ob die Startseite gerade geladen ist und den Bildschirmschoner als Ebene in sich aufnehmen kann. Dann läuft er
// dort in einem Rahmen UNTER dem Schnellmenü (und lässt sich damit bedienen, ohne ihn zu beenden); sonst (Einstellungsseiten,
// Vorschau, Startseite noch nicht bereit) als eigene Ansicht über dem Fenster wie bisher.
function createScreensaver({ getMainWindow, isViewAllowed, readSettings, getImages, getLogo, baseDir, canEmbed }) {
  let timer = null;
  let active = false;
  let view = null;
  let embedded = false; // läuft gerade als Ebene in der Startseite (dann gibt es keine eigene Ansicht)
  let resizeHandler = null;

  // Stammt die Nachricht von der Ansicht des Bildschirmschoners bzw. (eingebettet) von der Startseite selbst?
  function isOwnSender(event) {
    if (!active) return false;
    if (embedded) {
      const win = getMainWindow();
      return !!win && !win.isDestroyed() && event.sender === win.webContents;
    }
    return !!view && event.sender === view.webContents;
  }

  // Dateinamen der vorhandenen Videos, nach der Nummer sortiert (video2 vor video10); Lücken in der Nummerierung
  // stören nicht, ein fehlender Ordner ergibt eine leere Liste.
  function listSceneFiles() {
    let names;
    try {
      names = fs.readdirSync(path.join(baseDir, 'videos', 'screensaver'));
    } catch (err) {
      return [];
    }
    return names
      .map((name) => ({ name, match: SCENE_FILE.exec(name) }))
      .filter((entry) => entry.match)
      .sort((a, b) => Number(a.match[1]) - Number(b.match[1]) || a.name.localeCompare(b.name))
      .map((entry) => entry.name);
  }

  // Liste der Bilder { url, id, title, overview }; nie ein Fehler nach außen (ohne Key/Netz ist die Liste einfach leer)
  async function loadImages() {
    if (typeof getImages !== 'function') return [];
    try {
      const list = await getImages();
      if (!Array.isArray(list)) return [];
      const out = [];
      for (const entry of list) {
        const raw = typeof entry === 'string' ? { url: entry } : entry;
        if (!raw || typeof raw.url !== 'string' || !/^https:\/\//.test(raw.url)) continue;
        out.push({
          url: raw.url,
          id: Number.isInteger(raw.id) ? raw.id : 0,
          title: typeof raw.title === 'string' ? raw.title : '',
          overview: typeof raw.overview === 'string' ? raw.overview : ''
        });
      }
      return out;
    } catch (err) {
      return [];
    }
  }

  function prefetchImages(settings) {
    if (settings.mode === 'images') loadImages();
  }

  // Sofortstart per Backspace/B auf der Startseite: Das B, das den Bildschirmschoner beendet, darf ihn nicht gleich wieder
  // starten (ein gehaltener Controller-Knopf meldet sich beim Loslassen der Sperre erneut)
  const MANUAL_COOLDOWN_MS = 1000;
  let lastStopAt = 0;

  function canStart() {
    const win = getMainWindow();
    return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && isViewAllowed();
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  // Zeitgeber neu setzen (nach Aktivität, geänderten Einstellungen oder dem Ende des Bildschirmschoners)
  function arm() {
    clearTimer();
    if (active) return;
    const settings = readSettings();
    if (!settings.enabled) return;
    prefetchImages(settings); // die Bilder schon vorher holen, damit sie beim Einsetzen sofort da sind
    timer = setTimeout(() => {
      timer = null;
      if (canStart()) start();
    }, Math.max(MIN_DELAY_MS, Math.round(settings.delayMinutes * 60000)));
  }

  function fitView() {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || !view) return;
    const b = win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
  }

  // preview: sofort starten, auch wenn der Bildschirmschoner ausgeschaltet ist (Vorschau auf der Einstellungsseite)
  function start({ preview = false } = {}) {
    const win = getMainWindow();
    if (active || !win || win.isDestroyed()) return false;
    const settings = readSettings();
    if (!preview && !settings.enabled) return false;
    clearTimer();

    const scenes = settings.mode === 'videos' ? listSceneFiles() : [];
    const playMode = settings.mode === 'images' ? 'images' : 'videos';

    // Auf der Startseite: als Ebene in ihr (die Seite baut den Rahmen und meldet das Ende)
    if (!preview && typeof canEmbed === 'function' && canEmbed()) {
      active = true;
      embedded = true;
      try { win.webContents.send('screensaver-embedded', { active: true, mode: playMode, scenes: scenes.join(',') }); } catch (err) { /* Seite wechselt gerade */ }
      return true;
    }

    view = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, 'screensaver-preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    view.setBackgroundColor('#00000000'); // durchsichtig: die Seite startet schwarz und blendet selbst ein/aus
    active = true;
    win.contentView.addChildView(view);
    fitView();
    resizeHandler = () => fitView();
    win.on('resize', resizeHandler);

    // geht die Ansicht kaputt, darf der Bildschirm nicht schwarz hängen bleiben
    view.webContents.on('render-process-gone', () => stop());
    view.webContents.on('did-fail-load', () => stop());
    view.webContents.loadFile(path.join(__dirname, 'screensaver-play.html'), {
      query: { mode: settings.mode === 'images' ? 'images' : 'videos', scenes: scenes.join(',') }
    });
    view.webContents.focus();
    try { win.webContents.send('screensaver-state', true); } catch (err) { /* Seite wechselt gerade */ }
    return true;
  }

  function stop() {
    if (!active) return;
    active = false;
    lastStopAt = Date.now();
    const win = getMainWindow();
    if (embedded) {
      embedded = false;
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('screensaver-embedded', { active: false }); } catch (err) { /* Seite wechselt gerade */ }
      }
      arm();
      return;
    }
    const v = view;
    view = null;
    if (win && !win.isDestroyed()) {
      if (resizeHandler) win.removeListener('resize', resizeHandler);
      try { win.contentView.removeChildView(v); } catch (err) { /* schon entfernt */ }
      try { win.webContents.send('screensaver-state', false); } catch (err) { /* Seite wechselt gerade */ }
      win.webContents.focus();
    }
    resizeHandler = null;
    try { if (v && !v.webContents.isDestroyed()) v.webContents.close(); } catch (err) { /* schon geschlossen */ }
    arm();
  }

  // Die Ansicht meldet, dass der Nutzer aufgeweckt hat (nur von ihr selbst angenommen)
  ipcMain.on('screensaver-exit', (event) => {
    if (isOwnSender(event)) stop();
  });

  // Die Ansicht fragt die Bilder selbst an (nur von ihr selbst angenommen)
  ipcMain.handle('screensaver-images', (event) => {
    if (!isOwnSender(event)) return [];
    return loadImages();
  });

  // Die Ansicht fragt das Logo zu einem Film an (nur von ihr selbst angenommen); nur TMDb-Bildadressen werden weitergegeben
  ipcMain.handle('screensaver-logo', async (event, id) => {
    if (!isOwnSender(event) || typeof getLogo !== 'function') return '';
    if (!Number.isInteger(id) || id <= 0) return '';
    try {
      const url = await getLogo(id);
      return typeof url === 'string' && /^https:\/\/image\.tmdb\.org\//.test(url) ? url : '';
    } catch (err) {
      return '';
    }
  });

  return {
    // Eine Eingabe im Launcher: Zeitgeber neu starten (während des Bildschirmschoners ohne Wirkung)
    noteActivity() { if (!active) arm(); },
    // Einstellungen wurden geändert
    settingsChanged() { if (!active) arm(); },
    start,
    // Sofort starten, aber nur bei eingeschaltetem Bildschirmschoner, in erlaubten Ansichten und nicht direkt nach seinem Ende
    startManual() {
      if (active || Date.now() - lastStopAt < MANUAL_COOLDOWN_MS || !canStart()) return false;
      return start(); // ohne preview: bei ausgeschaltetem Bildschirmschoner passiert nichts
    },
    stop,
    isActive() { return active; },
    // Die Startseite wird verlassen/neu geladen: läuft der Bildschirmschoner als Ebene in ihr, endet er damit
    hostNavigated() { if (embedded) stop(); },
    isEmbedded() { return active && embedded; },
    availableScenes: listSceneFiles
  };
}

module.exports = { createScreensaver, SCENE_FILE };
