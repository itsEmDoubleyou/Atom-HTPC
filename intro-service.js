// Intro beim Start des Medienlaunchers (Hauptprozess): ein Video, das sanft über dem Launcher eingeblendet wird, kurz
// steht und sanft wieder ausgeblendet wird. Die Datei liegt in videos/intro/intro.mp4 (ersatzweise videos/intro.mp4);
// fehlt sie oder ist das Intro in den Einstellungen (Allgemein > Intro) aus, passiert nichts.
// Wie beim Bildschirmschoner ist das Intro eine eigene Ansicht über dem Hauptfenster (intro-play.html): seine Eingaben
// landen nicht in der Tastenlogik des Launchers, und es wird beim Ende wieder entfernt. Den Ablauf (Einblenden, 4 s
// stehen lassen, Ausblenden) steuert die Seite selbst und meldet das Ende mit 'intro-done'.
const { WebContentsView, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const VIDEO_CANDIDATES = ['videos/intro/intro.mp4', 'videos/intro.mp4'];
const SAFETY_MS = 15000; // Notbremse: hängt die Ansicht, wird das Intro nach dieser Zeit auf jeden Fall entfernt

// getMainWindow: liefert das Hauptfenster (oder null); readSettings: gespeicherte Einstellungen { enabled };
// onActiveChanged(active): Rückruf beim Beginn/Ende (der Launcher soll währenddessen nichts annehmen)
function createIntro({ getMainWindow, readSettings, onActiveChanged, baseDir }) {
  let active = false;
  let view = null;
  let resizeHandler = null;
  let safetyTimer = null;

  // Relativer Pfad der Intro-Datei oder null
  function findVideo() {
    return VIDEO_CANDIDATES.find((rel) => {
      try { return fs.statSync(path.join(baseDir, rel)).isFile(); } catch (err) { return false; }
    }) || null;
  }

  function fitView() {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || !view) return;
    const b = win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
  }

  // preview: auch starten, wenn das Intro ausgeschaltet ist (Vorschau auf der Einstellungsseite)
  function start({ preview = false } = {}) {
    const win = getMainWindow();
    if (active || !win || win.isDestroyed()) return false;
    if (!preview && !readSettings().enabled) return false;
    const video = findVideo();
    if (!video) return false;

    view = new WebContentsView({
      webPreferences: {
        preload: path.join(baseDir, 'intro-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        autoplayPolicy: 'no-user-gesture-required' // das Intro darf mit Ton starten
      }
    });
    view.setBackgroundColor('#00000000'); // durchsichtig: die Seite blendet ihr Schwarz selbst ein und aus
    active = true;
    win.contentView.addChildView(view);
    fitView();
    resizeHandler = () => fitView();
    win.on('resize', resizeHandler);

    // geht die Ansicht kaputt, darf der Bildschirm nicht schwarz hängen bleiben
    view.webContents.on('render-process-gone', () => stop());
    view.webContents.on('did-fail-load', () => stop());
    view.webContents.loadFile(path.join(baseDir, 'intro-play.html'), { query: { src: video } });
    view.webContents.focus();
    safetyTimer = setTimeout(stop, SAFETY_MS);
    try { onActiveChanged(true); } catch (err) { /* Seite wechselt gerade */ }
    return true;
  }

  function stop() {
    if (!active) return;
    active = false;
    clearTimeout(safetyTimer);
    safetyTimer = null;
    const win = getMainWindow();
    const v = view;
    view = null;
    if (win && !win.isDestroyed()) {
      if (resizeHandler) win.removeListener('resize', resizeHandler);
      try { win.contentView.removeChildView(v); } catch (err) { /* schon entfernt */ }
      win.webContents.focus();
    }
    resizeHandler = null;
    try { if (v && !v.webContents.isDestroyed()) v.webContents.close(); } catch (err) { /* schon geschlossen */ }
    try { onActiveChanged(false); } catch (err) { /* Seite wechselt gerade */ }
  }

  // Die Ansicht meldet, dass der Ablauf zu Ende ist (nur von ihr selbst angenommen)
  ipcMain.on('intro-done', (event) => {
    if (view && event.sender === view.webContents) stop();
  });

  return {
    start,
    stop,
    isActive() { return active; },
    findVideo
  };
}

module.exports = { createIntro, VIDEO_CANDIDATES };
