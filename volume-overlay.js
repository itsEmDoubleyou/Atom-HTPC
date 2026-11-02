// Lautstärke-Regler (Hauptprozess): ein kleines, durchsichtiges Fenster rechts am Bildschirmrand, vertikal mittig, mit einem
// weißen, abgerundeten senkrechten Regler. Es erscheint, solange die Lautstärke verändert wird, und blendet danach aus. Wie der
// Musikplayer liegt es als eigenes Fenster ohne Fokus über allem (Launcher, Apps, YouTube TV, Bildschirmschoner), fängt keine
// Mausklicks ab und stiehlt keinen Fokus.
const { BrowserWindow, screen } = require('electron');
const path = require('path');

const WIDTH = 84;
const HEIGHT = 320;
const RIGHT_MARGIN = Math.round(0.8 * 96 / 2.54); // 0,8 cm vom rechten Bildschirmrand
const HIDE_FADE_MS = 350;                          // so lange blendet die Seite aus, danach wird das Fenster versteckt

// getMainWindow: das Hauptfenster (bestimmt den Bildschirm); hideAfterMs: so lange bleibt der Regler nach der letzten Änderung
function createVolumeOverlay({ getMainWindow, baseDir, hideAfterMs = 1500 }) {
  let win = null;
  let ready = null;      // Promise: Seite geladen
  let hideTimer = null;
  let hideWindowTimer = null;
  let token = 0;

  function bounds() {
    const main = getMainWindow();
    const display = main && !main.isDestroyed()
      ? screen.getDisplayMatching(main.getBounds())
      : screen.getPrimaryDisplay();
    const b = display.bounds;
    return {
      x: b.x + b.width - WIDTH - RIGHT_MARGIN,
      y: b.y + Math.round((b.height - HEIGHT) / 2),
      width: WIDTH,
      height: HEIGHT
    };
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return ready;
    win = new BrowserWindow({
      ...bounds(),
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false, // kein Tastaturfokus: der Launcher behält Tastatur und Controller
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: path.join(baseDir, 'volume-overlay-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });
    win.setAlwaysOnTop(true, 'screen-saver'); // über dem Vollbild-Launcher und den App-Ansichten
    win.setIgnoreMouseEvents(true);           // Klicks gehen durch
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.on('closed', () => { win = null; ready = null; });
    ready = win.loadFile(path.join(baseDir, 'volume-overlay.html')).catch(() => {});
    return ready;
  }

  // Zeigt den Regler mit dem Stand (0-100) und plant das Ausblenden
  async function show(level) {
    const my = ++token;
    await ensureWindow();
    if (my !== token || !win || win.isDestroyed()) return; // inzwischen kam ein neuerer Aufruf
    clearTimeout(hideTimer);
    clearTimeout(hideWindowTimer);
    win.setBounds(bounds());
    if (!win.isVisible()) win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
    win.webContents.send('volume-overlay-level', { level });
    hideTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      win.webContents.send('volume-overlay-hide');
      hideWindowTimer = setTimeout(() => { if (win && !win.isDestroyed()) win.hide(); }, HIDE_FADE_MS);
    }, hideAfterMs);
  }

  // Fenster schon vorab anlegen (versteckt), damit die erste Anzeige ohne Ladezeit erscheint
  function warm() { return ensureWindow(); }

  function destroy() {
    clearTimeout(hideTimer);
    clearTimeout(hideWindowTimer);
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    ready = null;
  }

  return { show, warm, destroy, getWindow: () => win, BOUNDS: { WIDTH, HEIGHT, RIGHT_MARGIN } };
}

module.exports = { createVolumeOverlay };
