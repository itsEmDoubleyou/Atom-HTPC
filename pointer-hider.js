// Mauszeiger (Windows-Pfeil) ausblenden, solange Controller oder Handy-Fernbedienung benutzt werden - in ALLEN Fenstern und Ansichten
// (Startseite, Einstellungen, Apps samt iFrames, Bildschirmschoner, Musikplayer, ...), nicht nur auf der Startseite.
//
// Ein einziger Zustand im Hauptprozess:
//   - AN, sobald der Controller oder das Handy etwas auslöst (padUsed() - vom Handy-Dienst und per IPC 'pad-used' von den Seiten,
//     die den Controller abfragen),
//   - AUS, sobald die ECHTE Maus bewegt wird. "Echt" heißt: der Zeiger des Betriebssystems hat sich bewegt. Die Bewegungen des
//     Controller-Cursors in Apps kommen zwar auch als Mausereignisse in der Seite an (sendInputEvent), verschieben den Zeiger des
//     Systems aber nicht - so lassen sich beide ohne Zeitfenster und ohne Sonderfälle auseinanderhalten.
// Die Tastatur ändert hier nichts (auf der Startseite blendet eine Taste den Zeiger wie bisher selbst aus, preload.js).
//
// Technik: Stil "cursor: none" für alles. Im Hauptframe als Nutzer-Stil (insertCSS, cssOrigin 'user'): ein "!important" im Nutzer-Stil
// schlägt jedes "!important" der Seite. Weil sich eingefügte Nutzer-Stile in Electron nicht wieder entfernen lassen (removeInsertedCSS
// wirkt bei ihnen nicht), steht der Stil dauerhaft im Dokument und gilt nur, solange die Wurzel das Attribut HIDE_ATTR trägt - das wird
// ein- und ausgeschaltet. In iFrames (auch fremde Seiten) ist es ein eigenes Stylesheet über adoptedStyleSheets (wird von der
// Content-Security-Policy der Seite nicht blockiert). Ein Overlay wie auf der Startseite taugt in Apps nicht: es finge die Mausereignisse
// ab, die der Controller-Cursor an die Seite schickt.
const HIDE_ATTR = 'data-ml-pointer-hidden';
const HIDE_RULE = '*, *::before, *::after { cursor: none !important; }';
const MAIN_SHEET = `:root[${HIDE_ATTR}], :root[${HIDE_ATTR}] *, :root[${HIDE_ATTR}] *::before, :root[${HIDE_ATTR}] *::after { cursor: none !important; }`;
const mainAttrScript = (on) => `(() => { try { document.documentElement.toggleAttribute(${JSON.stringify(HIDE_ATTR)}, ${on ? 'true' : 'false'}); } catch (err) {} })()`;
const FRAME_KEY = 'ml.pointer.hidden';

const FRAME_ON = `(() => { try {
  const k = Symbol.for(${JSON.stringify(FRAME_KEY)});
  if (document[k]) return;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(${JSON.stringify(HIDE_RULE)});
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  document[k] = sheet;
} catch (err) {} })()`;

const FRAME_OFF = `(() => { try {
  const k = Symbol.for(${JSON.stringify(FRAME_KEY)});
  const sheet = document[k];
  if (!sheet) return;
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
  delete document[k];
} catch (err) {} })()`;

function createPointerHider({ app, ipcMain, screen, webContents, minMovePx = 3, log = () => {} }) {
  let hidden = false;
  let lastPoint = null;
  const sheetGen = new WeakMap();     // webContents -> Zähler der Seite, in die der Nutzer-Stil schon eingefügt ist
  const pending = new WeakSet();      // webContents, bei denen insertCSS gerade läuft
  const generation = new WeakMap();   // webContents -> Zähler, +1 mit jeder neuen Seite im Hauptframe (der Nutzer-Stil gehört zum Dokument)
  const gen = (wc) => generation.get(wc) || 0;
  let armed = false;                  // war der Zeiger schon einmal aus? Erst dann bekommen Seiten den Stil

  function cursorPoint() {
    try { return screen.getCursorScreenPoint(); } catch (err) { return null; }
  }

  function alive(wc) {
    try { return !!wc && !wc.isDestroyed(); } catch (err) { return false; }
  }

  function applyToFrames(wc) {
    let frames = [];
    try { frames = wc.mainFrame ? wc.mainFrame.framesInSubtree : []; } catch (err) { return; }
    for (const frame of frames) {
      if (frame === wc.mainFrame) continue;
      try {
        frame.executeJavaScript(hidden ? FRAME_ON : FRAME_OFF).catch(() => {});
      } catch (err) { /* Frame ist gerade weg */ }
    }
  }

  // Nutzer-Stil einmal pro Seite einfügen (bleibt dann stehen)
  function ensureSheet(wc) {
    const g = gen(wc);
    if (sheetGen.get(wc) === g || pending.has(wc)) return;
    pending.add(wc);
    wc.insertCSS(MAIN_SHEET, { cssOrigin: 'user' }).then(() => {
      if (gen(wc) !== g) return; // inzwischen eine neue Seite: der Stil ist mit dem alten Dokument verschwunden
      pending.delete(wc);
      sheetGen.set(wc, g);
    }).catch(() => { if (gen(wc) === g) pending.delete(wc); });
  }

  function applyToMainFrame(wc) {
    if (!armed) return;
    ensureSheet(wc);
    try { wc.executeJavaScript(mainAttrScript(hidden)).catch(() => {}); } catch (err) { /* Seite wechselt gerade */ }
  }

  function apply(wc) {
    if (!alive(wc)) return;
    applyToMainFrame(wc);
    applyToFrames(wc);
  }

  function setHidden(next) {
    next = !!next;
    if (next === hidden) return;
    hidden = next;
    if (hidden) armed = true;
    lastPoint = hidden ? cursorPoint() : null;
    log(hidden ? 'Mauszeiger aus (Controller/Handy)' : 'Mauszeiger an (Maus bewegt)');
    for (const wc of webContents.getAllWebContents()) apply(wc);
  }

  function onMouse(event, mouse) {
    if (!hidden || !mouse || mouse.type !== 'mouseMove') return;
    const point = cursorPoint();
    if (!point) return;
    if (!lastPoint) { lastPoint = point; return; }
    // Unter der Schwelle bleibt der Ausgangspunkt stehen: kleine Schritte zählen zusammen
    if (Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y) < minMovePx) return;
    setHidden(false);
  }

  function watch(wc) {
    wc.on('before-mouse-event', onMouse);
    // Neue Seite im Hauptframe: der Nutzer-Stil gehörte zum alten Dokument. Gleich beim Übernehmen der neuen Seite (Hauptframe und
    // iFrames) wieder einfügen, dom-ready als Absicherung
    wc.on('did-frame-navigate', (event, url, code, text, isMainFrame) => {
      if (isMainFrame) {
        generation.set(wc, gen(wc) + 1);
        pending.delete(wc);
      }
      if (armed) apply(wc);
    });
    wc.on('dom-ready', () => { if (armed) apply(wc); });
    wc.on('did-frame-finish-load', () => { if (hidden) applyToFrames(wc); });
  }

  function install() {
    app.on('web-contents-created', (event, wc) => watch(wc));
    for (const wc of webContents.getAllWebContents()) watch(wc);
    // Die Seiten melden Controller-Eingaben (Gamepad-API gibt es nur dort)
    ipcMain.on('pad-used', () => setHidden(true));
  }

  return { install, padUsed: () => setHidden(true), mouseUsed: () => setHidden(false), isHidden: () => hidden, _onMouse: onMouse };
}

module.exports = { createPointerHider, HIDE_RULE };
