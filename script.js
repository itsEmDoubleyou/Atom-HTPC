// 1. Dock (max. 6 Apps) + weitere Apps im gleichen Raster aufbauen
const background = document.getElementById('background');
const backgroundLogo = document.getElementById('background-logo');
const dock = document.getElementById('dock');
const extraGrid = document.getElementById('extra-grid');
const appsViewport = document.getElementById('apps-viewport');
const settingsBtn = document.getElementById('settings-btn');
const volumeBtn = document.getElementById('volume-btn');
const mediaBtn = document.getElementById('media-btn');
const powerBtn = document.getElementById('power-btn');
const profileBtn = document.getElementById('profile-btn');
const homeBtn = document.getElementById('home-btn');
const quickMenu = document.getElementById('quick-menu');
const deviceIndicatorBtn = document.getElementById('device-indicator-btn');
const deviceIconKeyboard = document.getElementById('device-icon-keyboard');
const deviceIconGamepad = document.getElementById('device-icon-gamepad');
const deviceIconRemote = document.getElementById('device-icon-remote');

const MAX_DOCK_APPS = 6;
const STACK_GAP = 16;      // muss zum CSS-Gap von .apps-stack passen
const TOP_BUFFER = 20;     // muss zum CSS padding-top von .apps-viewport passen
const BOTTOM_BUFFER = 16;  // Puffer unterhalb des Docks, damit dessen Schatten nicht abgeschnitten wird (v.a. ohne Grid)
const PEEK_INTO_GRID = 22; // wie viele px der NÄCHSTEN Icon-Reihe sichtbar sind (farbige "Nasen")
const CM_TO_PX = 96 / 2.54; // CSS-Referenzpixel-Umrechnung (wie der Browser cm interpretiert)
const EXPANDED_TOP_MARGIN_CM = 2.5;  // Abstand zum oberen Rand im ausgeklappten Zustand
const EXPANDED_BOTTOM_MARGIN_CM = 0.5; // muss zu .apps-viewport.expanded (bottom) passen
const ENTER_HOLD_MS = 375;             // so lange muss Enter gehalten werden, um das Glasmenü zu öffnen
const EXPAND_TRANSITION_MS = 500;      // muss zur height/bottom-Transition von .apps-viewport in style.css passen

// ---------- Bildschirmschoner als Ebene in der Startseite ----------
// Auf der Startseite läuft der Bildschirmschoner nicht als eigene Ansicht über dem Fenster, sondern als Rahmen (iframe) in dieser
// Seite, UNTER dem Schnellmenü: So lässt sich das Schnellmenü bedienen, ohne ihn zu beenden. Der Hauptprozess meldet Start/Ende
// ('screensaver-embedded'); der Rahmen (screensaver-play.html?embedded=1) zeigt nur Video/Bilder und bekommt von hier seine Befehle
// (vor/zurück, Info, aufwecken). Die Eingaben liest diese Seite:
//   Menü zu:  links/rechts = voriges/nächstes, runter = Info an/aus, hoch = nichts, lange S (oder die direkte Schnellmenü-Taste
//             bzw. Home gehalten am Handy) = Menü auf, Bestätigen kurz = aufwecken beim Loslassen, jede andere Taste/Maus =
//             aufwecken (und verschluckt)
//   Menü auf: ganz normale Bedienung des Menüs; der Bildschirmschoner läuft dahinter weiter (ohne Info)
// Dieser Block muss VOR allen anderen Tasten-Handlern stehen: Die simulierten Controller-Tasten gehen direkt an das Fenster, und dort
// laufen die Handler in der Reihenfolge ihrer Anmeldung.
const SS_MOUSE_IGNORE_MS = 1000;   // beim Erscheinen erzeugt Chromium unter dem Zeiger eine Mausbewegung
const SS_MOUSE_WAKE_PX = 12;
const SS_CLICK_IGNORE_MS = 600;
const SS_SWALLOW_CLICK_MS = 2500;  // der Klick, der aufgeweckt hat, darf danach nichts auf der Startseite auslösen
const SS_LOAD_TIMEOUT_MS = 8000;   // Rahmen lädt nicht: nicht schwarz hängen bleiben
const SS_WAKE_TIMEOUT_MS = 2000;   // Rahmen antwortet beim Aufwecken nicht: trotzdem beenden
const ssLayer = document.getElementById('screensaver-layer');
let ssActive = false;
let ssWaking = false;
let ssFrame = null;
let ssFrameLoaded = false;
let ssStartedAt = 0;
let ssMouseOrigin = null;
let ssSwallowClickUntil = 0;
let ssEnterDown = false;
let ssSTimer = null;        // lange S (Tastatur) öffnet das Schnellmenü
let ssSDown = false;
let ssSLong = false;
let ssLoadTimer = null;
let ssWakeTimer = null;

function ssSend(message) {
  try { if (ssFrame && ssFrame.contentWindow) ssFrame.contentWindow.postMessage({ ss: 'cmd', ...message }, '*'); } catch (err) { /* Rahmen weg */ }
}

function ssStart(state) {
  if (ssActive || !ssLayer) return;
  ssActive = true;
  ssWaking = false;
  ssStartedAt = performance.now();
  ssMouseOrigin = null;
  ssSwallowClickUntil = 0;
  ssEnterDown = false;
  ssSDown = false;
  ssSLong = false;
  if (menuOpen) closeMenu(); // ein noch offenes Menü schließt sich, bevor der Bildschirmschoner einsetzt
  if (typeof closeHomeModals === 'function') closeHomeModals(); // App-Menü, Verschieben und offener Ordner enden ebenfalls
  const params = new URLSearchParams({ embedded: '1', mode: state.mode === 'images' ? 'images' : 'videos', scenes: state.scenes || '' });
  ssFrame = document.createElement('iframe');
  ssFrame.setAttribute('tabindex', '-1');
  ssFrame.setAttribute('aria-hidden', 'true');
  ssFrameLoaded = false;
  ssFrame.addEventListener('load', () => { ssFrameLoaded = true; clearTimeout(ssLoadTimer); });
  ssFrame.src = 'screensaver-play.html?' + params.toString();
  ssLayer.appendChild(ssFrame);
  ssLayer.hidden = false;
  document.body.classList.add('ss-active');
  ssLoadTimer = setTimeout(() => { if (ssActive && !ssFrameLoaded) ssFinish(true); }, SS_LOAD_TIMEOUT_MS);
}

// Beenden. notify: dem Hauptprozess Bescheid geben (wenn das Ende von hier ausgeht und nicht von ihm)
function ssFinish(notify) {
  clearTimeout(ssLoadTimer);
  clearTimeout(ssWakeTimer);
  clearTimeout(ssSTimer);
  ssEnterDown = false;
  ssSDown = false;
  ssSLong = false;
  const wasActive = ssActive;
  ssActive = false;
  ssWaking = false;
  document.body.classList.remove('ss-active');
  if (wasActive) { // die Uhr blendet danach weich wieder ein (Übergang aus dem Zustand "Bildschirmschoner")
    document.body.classList.add('ss-leaving');
    setTimeout(() => document.body.classList.remove('ss-leaving'), 700);
  }
  if (ssLayer) {
    ssLayer.hidden = true;
    ssLayer.textContent = '';
  }
  ssFrame = null;
  if (wasActive && notify) window.electronAPI.screensaverExit();
}

function ssWake(byPointer) {
  if (!ssActive || ssWaking) return;
  ssWaking = true;
  if (byPointer) ssSwallowClickUntil = performance.now() + SS_SWALLOW_CLICK_MS;
  ssSend({ cmd: 'wake' });
  ssWakeTimer = setTimeout(() => ssFinish(true), SS_WAKE_TIMEOUT_MS);
}

if (window.electronAPI.onScreensaverEmbedded) {
  window.electronAPI.onScreensaverEmbedded((state) => {
    if (state && state.active) ssStart(state);
    else ssFinish(false);
  });
}

// Nachrichten des Rahmens: Ende, Bilder und Logos (der Rahmen hat keine Verbindung zum Hauptprozess)
window.addEventListener('message', async (e) => {
  if (!ssFrame || e.source !== ssFrame.contentWindow) return;
  const d = e.data || {};
  const reply = (value) => { try { ssFrame.contentWindow.postMessage({ ss: 'reply', id: d.id, value }, '*'); } catch (err) { /* Rahmen weg */ } };
  if (d.ss === 'exit') ssFinish(true);
  else if (d.ss === 'images') reply(await window.electronAPI.screensaverImages().catch(() => []));
  else if (d.ss === 'logo') reply(await window.electronAPI.screensaverLogo(d.logoId).catch(() => ''));
});

window.addEventListener('keydown', (e) => {
  if (!ssActive || menuOpen) return; // Menü offen: die normale Bedienung des Menüs
  e.preventDefault();
  e.stopImmediatePropagation();
  if (ssWaking || e.repeat) return; // gehaltene Tasten wecken nicht und lösen nichts mehr aus
  if (e.code === 'ArrowLeft') ssSend({ cmd: 'go', dir: -1 });
  else if (e.code === 'ArrowRight') ssSend({ cmd: 'go', dir: 1 });
  else if (e.code === 'ArrowDown') ssSend({ cmd: 'info', value: 'toggle' });
  else if (e.code === 'ArrowUp') { /* ohne Funktion, weckt aber nicht auf */ }
  else if (e.code === 'Enter' || e.code === 'NumpadEnter') ssEnterDown = true; // weckt beim Loslassen auf
  else if (e.code === 'KeyS') {
    // Lange S (Tastatur) öffnet das Schnellmenü, ein kurzer Druck weckt beim Loslassen auf
    ssSDown = true;
    ssSLong = false;
    clearTimeout(ssSTimer);
    ssSTimer = setTimeout(() => {
      ssSLong = true;
      if (ssActive && !ssWaking && !menuOpen) openMenu();
    }, ENTER_HOLD_MS);
  } else if (e.code === 'GamepadQuickMenu') openMenu();
  else ssWake(false);
}, true);

window.addEventListener('keyup', (e) => {
  const isEnter = e.code === 'Enter' || e.code === 'NumpadEnter';
  if (!ssActive || (!isEnter && e.code !== 'KeyS')) return;
  let wasDown, wasLong = false;
  if (isEnter) {
    wasDown = ssEnterDown;
    ssEnterDown = false;
  } else {
    clearTimeout(ssSTimer);
    wasDown = ssSDown;
    wasLong = ssSLong;
    ssSDown = false;
    ssSLong = false;
  }
  if (menuOpen) return; // Menü offen (z.B. gerade per Halten geöffnet): die normale Bedienung
  e.preventDefault();
  e.stopImmediatePropagation();
  if (wasDown && !wasLong && !ssWaking) ssWake(false);
}, true);

['mousedown', 'wheel', 'touchstart', 'contextmenu'].forEach((type) => {
  window.addEventListener(type, (e) => {
    if (!ssActive || menuOpen) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (performance.now() - ssStartedAt > SS_CLICK_IGNORE_MS) ssWake(type === 'mousedown' || type === 'touchstart');
  }, { capture: true, passive: false });
});

['mouseup', 'click', 'auxclick', 'dblclick', 'touchend'].forEach((type) => {
  window.addEventListener(type, (e) => {
    const swallow = performance.now() < ssSwallowClickUntil;
    if (!(ssActive && !menuOpen) && !swallow) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (type === 'click' || type === 'touchend') ssSwallowClickUntil = 0;
  }, true);
});

window.addEventListener('mousemove', (e) => {
  if (!ssActive) return;
  if (menuOpen) { ssMouseOrigin = null; return; } // Menü offen: die Maus gehört dem Menü; danach neu ansetzen
  e.stopImmediatePropagation();
  if (ssWaking || performance.now() - ssStartedAt < SS_MOUSE_IGNORE_MS) return;
  if (!ssMouseOrigin) { ssMouseOrigin = { x: e.clientX, y: e.clientY }; return; }
  if (Math.hypot(e.clientX - ssMouseOrigin.x, e.clientY - ssMouseOrigin.y) > SS_MOUSE_WAKE_PX) ssWake(false);
}, true);

// Startseite: Tasten für App-Menü, Verschieben und geöffneten Ordner (home-folders.js, setzt homeKeyDown/homeKeyUp). Muss direkt hinter dem
// Bildschirmschoner und VOR den Handlern unten stehen (Reihenfolge der Anmeldung, siehe oben): die Funktionen sind nur Platzhalter.
window.addEventListener('keydown', (e) => { if (window.homeKeyDown) window.homeKeyDown(e); }, true);
window.addEventListener('keyup', (e) => { if (window.homeKeyUp) window.homeKeyUp(e); }, true);

let currentBg = '';
let hasExtraApps = false;
let showingAllApps = false;
let collapsedHeight = 0;
let expandedHeight = 0;

// Rückweg aus einer App: main.js lädt den Launcher dann HINTER der noch sichtbaren App-Ansicht und
// gibt eine Kennung mit (?ready=...). Sobald alles im Endzustand steht, melden wir "bereit" - erst
// dann wird die App abgenommen. Bis dahin werden Hintergrund-Wechsel ohne Aus-/Einblenden gesetzt
// (unsichtbar hinter der App), damit beim Aufdecken nichts mehr nachträglich einblendet.
const launcherReadyToken = new URLSearchParams(window.location.search).get('ready');
let startupInstant = !!launcherReadyToken; // true, bis "bereit" gemeldet wurde
const startupWork = [];                    // Promises, auf die "bereit" noch wartet
const READY_PAGE_TIMEOUT_MS = 700;         // Sicherung seitenseitig (main.js hat eine eigene, längere)

function trackStartupWork(promise) {
  if (startupInstant) startupWork.push(promise);
}

// Lädt und dekodiert ein Bild vorab, damit es beim Aufdecken sofort da ist
function decodeImage(url) {
  const img = new Image();
  img.src = url;
  return img.decode().catch(() => {});
}

// -- Tastatur-Navigation -----------------------------------------------
// dockButtons: die Buttons der Dock-Zeile (Zeile 0)
// gridRows: die weiteren Apps, aufgeteilt in Zeilen zu je 6 (wie im CSS-Grid)
// focusZone: 'row' (irgendeine Icon-Zeile) oder null (noch nicht navigiert)
// focusZone ist anfangs null - erst der erste Tastendruck setzt den Fokus,
// damit sich beim bloßen Laden der Seite nichts optisch verändert.
let dockButtons = [];
let gridRows = [];
let dockApps = []; // Einträge (Apps und Ordner) der Dock-Zeile, für Topshelf-Zugriff aus der Tastatursteuerung
let homeItems = []; // alle Einträge der Startseite (Apps und Ordner { type: 'folder', id, name, apps }) in Anzeigereihenfolge
let focusZone = null;

// ---------- Topshelf ----------
const topshelfHintEl = document.getElementById('topshelf-hint');
const topshelfCardsEl = document.getElementById('topshelf-cards');
let topshelfCurrentAppData = null; // App, deren Topshelf gerade (passiv) angezeigt wird
let topshelfItems = [];
let topshelfSelectedIndex = 0;
let topshelfCardsActive = false; // true = interaktive Karten-Navigation läuft gerade (nach Pfeiltaste hoch)
// Der Hauptprozess erfährt das für die Handy-Fernbedienung: beim Blättern durch die Karten springt ein Wisch immer nur ein Element weiter
function setTopshelfCardsActive(active) {
  if (topshelfCardsActive === active) return;
  topshelfCardsActive = active;
  if (window.electronAPI.setTopshelfCardsActive) window.electronAPI.setTopshelfCardsActive(active);
}
window.addEventListener('pagehide', () => { if (window.electronAPI.setTopshelfCardsActive) window.electronAPI.setTopshelfCardsActive(false); });
let topshelfFetchToken = 0; // verhindert, dass eine spät eintreffende Antwort ein zwischenzeitlich anderes Icon überschreibt
let bgPreviewFetchToken = 0; // selbes Prinzip für den dynamischen Hintergrund beim Hovern
let focusRowIndex = 0;
let focusColIndex = 0;

// Überblendet den Hintergrund sanft zu einem neuen Zustand.
// bgValue ist entweder ein CSS-Wert "url('...')" (normaler Bild-Hintergrund,
// z.B. das allgemeine Hintergrundbild oder ein manuell hinterlegter App-Hintergrund)
// oder ein Objekt { logo: '<icon-url>' } (App hat keinen eigenen Hintergrund ->
// Logo zentriert auf Schwarz, siehe #background-logo in style.css).
// Setzt den Inhalt des Hintergrunds (Bild oder zentriertes Logo auf Schwarz)
function showBackground(isLogo, bgValue) {
  if (isLogo) {
    background.style.backgroundImage = 'none'; // Grundfarbe Schwarz kommt durch
    backgroundLogo.src = bgValue.logo;
    backgroundLogo.style.display = 'block';
  } else {
    backgroundLogo.style.display = 'none';
    background.style.backgroundImage = bgValue;
  }
}

// Springt ohne Übergang direkt auf den Endzustand (Seite ist noch hinter der App verborgen)
function applyBackgroundInstantly(isLogo, bgValue, key) {
  background.style.transition = 'none';
  backgroundLogo.style.transition = 'none';
  showBackground(isLogo, bgValue);
  currentBg = key;
  background.style.opacity = '1';
  backgroundLogo.style.opacity = '1';
  void background.offsetHeight; // Stil jetzt übernehmen, bevor die Übergänge wieder aktiv werden
  background.style.transition = '';
  backgroundLogo.style.transition = '';

  const url = isLogo ? bgValue.logo : (/url\((['"]?)(.*?)\1\)/.exec(bgValue) || [])[2];
  if (url) trackStartupWork(decodeImage(url));
}

// Klappt das Grid gerade ein (zurück ins Dock), läuft die Höhen-Animation des Docks samt Weichzeichner 500 ms lang. Ein gleichzeitiger
// Hintergrundwechsel (Ausblenden, Tauschen, Einblenden) lässt das ruckeln: er wartet, bis das Grid zu ist. Währenddessen gilt die
// jeweils letzte Anfrage (schnelles Weiternavigieren im Dock überspringt Zwischenstände); danach wechselt der Hintergrund einmal.
let backgroundHeld = false;
let backgroundHoldTimer = null;
let heldBackground = null;
function holdBackgroundWhileGridCloses() {
  backgroundHeld = true;
  clearTimeout(backgroundHoldTimer);
  backgroundHoldTimer = setTimeout(releaseHeldBackground, EXPAND_TRANSITION_MS);
}
function releaseHeldBackground() {
  clearTimeout(backgroundHoldTimer);
  backgroundHoldTimer = null;
  backgroundHeld = false;
  const pending = heldBackground;
  heldBackground = null;
  if (pending) applyBackground(pending.value);
}

function applyBackground(bgValue) {
  const isLogo = bgValue && typeof bgValue === 'object' && bgValue.logo;
  const key = isLogo ? `logo:${bgValue.logo}` : bgValue;

  if (!key || key === currentBg) {
    if (backgroundHeld) heldBackground = null; // die zuletzt fokussierte App hat den Hintergrund, der schon steht: nichts nachholen
    return;
  }
  if (backgroundHeld) { heldBackground = { value: bgValue }; return; }

  if (startupInstant) {
    applyBackgroundInstantly(isLogo, bgValue, key);
    return;
  }

  background.style.opacity = '0';
  backgroundLogo.style.opacity = '0';

  setTimeout(() => {
    showBackground(isLogo, bgValue);
    currentBg = key;
    background.style.opacity = '1';
    backgroundLogo.style.opacity = '1';
  }, 250);
}

async function renderApps() {
  homeItems = await window.electronAPI.getHomeItems();
  renderHomeTiles();

  // Herausfinden, wohin der Fokus wiederhergestellt werden soll - noch VOR der
  // Höhenberechnung. Liegt das Ziel im Grid, soll die Seite direkt im bereits
  // ausgeklappten Zustand starten (das Grid war beim Minimieren ja schon offen),
  // statt die Öffnen-Animation nochmal komplett neu abzuspielen.
  const restoreTarget = await findLauncherRestoreTarget();
  const shouldStartExpanded = !!(restoreTarget && restoreTarget.rowIndex > 0 && hasExtraApps);

  // Höhe erst messen, nachdem die Icons im DOM sind. In ein Promise verpackt,
  // damit renderApps() wirklich erst fertig ist, wenn die Fokus-Wiederherstellung
  // (inkl. ausgelöster App-Vorschau) abgeschlossen ist - wichtig für die
  // Koordination mit dem Hintergrund der fokussierten App.
  await new Promise((resolve) => {
    requestAnimationFrame(() => {
      const dockHeight = dock.offsetHeight;

      if (!hasExtraApps) {
        collapsedHeight = TOP_BUFFER + dockHeight + BOTTOM_BUFFER;
        expandedHeight = collapsedHeight; // Scrollen ist ohnehin deaktiviert
      } else {
        // Ruhezustand: nur ein kleiner Peek der nächsten Zeile
        collapsedHeight = TOP_BUFFER + dockHeight + STACK_GAP + PEEK_INTO_GRID;

        // Ausgeklappter Zustand: fester Px-Wert, der bis auf EXPANDED_TOP_MARGIN_CM
        // an den oberen Bildschirmrand reicht (nicht "auto", sonst keine
        // animierbare Höhe) - dadurch rutscht das Dock beim Ausklappen sichtbar
        // sanft ganz nach oben, unabhängig davon wie viele Grid-Zeilen es sind.
        const topMarginPx = EXPANDED_TOP_MARGIN_CM * CM_TO_PX;
        const bottomMarginPx = EXPANDED_BOTTOM_MARGIN_CM * CM_TO_PX;
        expandedHeight = window.innerHeight - topMarginPx - bottomMarginPx;
      }

      if (shouldStartExpanded) {
        // Direkt (ohne Animation) im ausgeklappten Zustand anzeigen - "war ja
        // schon offen". Transition kurz aus, damit der Sprung nicht doch animiert.
        appsViewport.style.transition = 'none';
        appsViewport.style.height = `${expandedHeight}px`;
        appsViewport.classList.add('expanded');
        document.body.classList.add('grid-expanded');
        showingAllApps = true;
        // Im nächsten Frame die Transition wieder aktivieren, damit spätere
        // Auf-/Zuklapp-Vorgänge (z.B. per Pfeiltaste) weiterhin animiert sind.
        requestAnimationFrame(() => {
          appsViewport.style.transition = '';
        });
      } else {
        appsViewport.style.height = `${collapsedHeight}px`;
      }

      // Die Startseite hat immer eine fokussierte App: nach der Rückkehr aus einer App die zuletzt benutzte, sonst
      // (frischer Start, Profilwechsel, Neuladen) die erste im Dock. Der Hintergrund der Startseite ist der der fokussierten App.
      if (restoreTarget) {
        focusRowItem(restoreTarget.rowIndex, restoreTarget.colIndex);
        // Die zuletzt benutzte App liegt in einem Ordner: der Ordner steht wieder offen, mit der App im Fokus
        if (restoreTarget.insideFolder && typeof openFolder === 'function') openFolder(restoreTarget.folderId, { instant: true, focusAppId: restoreTarget.appId });
      } else {
        focusRowItem(0, 0);
      }

      resolve();
    });
  });

}

// Ermittelt, auf welche Kachel (Zeile/Spalte) der Fokus nach dem Minimieren/
// Zurückkehren wiederhergestellt werden soll - anhand der zuletzt gestarteten
// App-ID. Liefert null, wenn nichts wiederherzustellen ist.
async function findLauncherRestoreTarget() {
  if (!window.electronAPI.getLastLaunchedAppId) return null;
  const lastId = await window.electronAPI.getLastLaunchedAppId();
  if (!lastId) return null;

  const rows = [dockButtons, ...gridRows];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const colIndex = rows[rowIndex].findIndex(btn => btn.dataset.appId === lastId);
    if (colIndex !== -1) {
      return { rowIndex, colIndex };
    }
    const inFolder = rows[rowIndex].findIndex(btn => btn.dataset.folderId && (btn.dataset.appIds || '').split(',').includes(lastId));
    if (inFolder !== -1) {
      return { rowIndex, colIndex: inFolder, insideFolder: true, folderId: rows[rowIndex][inFolder].dataset.folderId, appId: lastId };
    }
  }
  return null;
}

function createIconTile(appData, { withBgPreview, rowIndex, colIndex, onHover }) {
  if (appData && appData.type === 'folder') return createFolderTile(appData, { rowIndex, colIndex });
  const iconDiv = document.createElement('div');
  iconDiv.className = 'icon';

  const button = document.createElement('button');
  button.tabIndex = -1; // nicht per Tab erreichbar - nur unsere eigene Pfeiltasten-Navigation steuert den Fokus
  button.dataset.appId = appData.id;
  const img = document.createElement('img');
  img.src = appData.icon;
  img.alt = appData.name;

  button.appendChild(img);
  button.addEventListener('click', () => { if (!homeClickBlocked(button)) launchApp(appData); });
  iconDiv.addEventListener('contextmenu', (e) => { e.preventDefault(); openAppMenuForButton(button); }); // Rechtsklick = langes Enter
  iconDiv.appendChild(button);

  if (withBgPreview) {
    const showPreview = () => {
      const applyFallback = () => {
        if (appData.bg) {
          applyBackground(`url('${appData.bg}')`);
        } else {
          applyBackground({ logo: appData.icon });
        }
      };

      if (appData.dynamicBg && appData.topshelfProvider) {
        // Direkt auf das fertige dynamische Bild warten, statt zwischendurch
        // kurz das Logo zu zeigen und dann nochmal umzublenden (zwei Fades
        // statt einem - sah flackerig aus und kostete unnötig Zeit).
        const token = ++bgPreviewFetchToken;
        trackStartupWork(window.electronAPI.getDynamicAppBackground(appData.id).then((url) => {
          if (token !== bgPreviewFetchToken) return; // zwischenzeitlich anderes Icon fokussiert
          if (url) {
            applyBackground(`url('${url}')`);
          } else {
            applyFallback(); // z.B. kein TMDb-Key hinterlegt o.ä.
          }
        }));
      } else {
        applyFallback();
      }
    };

    // Topshelf gibt es ausdrücklich nur im Dock, nicht im Grid
    const hasTopshelf = rowIndex === 0 && appData.topshelf && appData.topshelf !== 'off';

    const showTopshelf = () => {
      if (!hasTopshelf) return;
      topshelfCurrentAppData = appData;
      const showHint = appData.topshelf === 'fullscreen';
      positionTopshelfElements(button, showHint);
      // Der Pfeil-Hinweis gehört nur zum Vollbild-Modus (da geht's tatsächlich
      // "weiter nach oben") - im Fenster-Modus sieht man ja schon alles direkt.
      // Immer explizit setzen (nicht nur bedingt hinzufügen), sonst kann die
      // Sichtbarkeit von der vorherigen App "hängen bleiben", wenn der Wechsel
      // schneller passiert als das blur-ausgelöste Verstecken.
      topshelfHintEl.classList.toggle('visible', showHint);
      loadTopshelfCardsPreview(appData);
    };

    const hideTopshelf = () => hideTopshelfPreview();

    // Maus-Hover setzt den echten Fokus (und merkt sich die Position für die Pfeiltasten-Navigation). Verlässt die Maus die
    // App wieder, bleibt der Fokus - und damit Hintergrund und Topshelf - bei ihr. Solange das Schnellmenü offen ist,
    // ändert Hovern nichts.
    iconDiv.addEventListener('mouseenter', () => {
      if (menuOpen || ssActive || homeModalBlocksHover(!!onHover)) return;
      if (onHover) onHover(); // Kachel in einem geöffneten Ordner: der Ordner führt den Fokus selbst
      else if (rowIndex !== undefined) {
        focusZone = 'row';
        focusRowIndex = rowIndex;
        focusColIndex = colIndex;
      }
      button.focus({ preventScroll: true });
    });

    // Fokus (Tastatur, Controller, Maus) zeigt den Hintergrund der App; nur das Topshelf gehört zum Fokus und wird beim
    // Verlassen ausgeblendet. Der Hintergrund bleibt dabei stehen (z.B. beim Öffnen des Schnellmenüs).
    button.addEventListener('focus', () => {
      showPreview();
      showTopshelf();
    });
    button.addEventListener('blur', () => {
      hideTopshelf();
    });
  }

  return iconDiv;
}

// Positioniert Hinweis-Pfeil + Karten mittig/direkt über der fokussierten App und dem Dock
// Blendet Topshelf-Hinweis + Karten aus (sanfte CSS-Transition, 0.25s) - von
// überall aufrufbar, nicht nur beim Verlassen (blur) der jeweiligen Kachel.
function hideTopshelfPreview() {
  if (topshelfCardsActive) return; // während aktiver Navigation nicht verstecken
  topshelfHintEl.classList.remove('visible');
  topshelfCardsEl.classList.remove('visible');
  topshelfCurrentAppData = null;
}

function positionTopshelfElements(button, includeHint) {
  const buttonRect = button.getBoundingClientRect();
  const dockRect = dock.getBoundingClientRect();
  const CARDS_GAP = window.innerHeight * 0.14;  // Fenster: etwas mehr Abstand zum Dock
  const HINT_GAP = window.innerHeight * 0.0125;  // Pfeil: bleibt knapp über dem Dock (-50%)

  // Nur umpositionieren, wenn der Pfeil für DIESE App überhaupt sichtbar wird -
  // sonst würde er (falls er von der vorherigen App noch am Ausblenden ist)
  // kurz an der neuen, falschen Position auftauchen, bevor er fertig verschwindet.
  if (includeHint) {
    topshelfHintEl.style.left = `${buttonRect.left + buttonRect.width / 2}px`;
    topshelfHintEl.style.bottom = `${window.innerHeight - dockRect.top + HINT_GAP}px`;
  }
  topshelfCardsEl.style.bottom = `${window.innerHeight - dockRect.top + CARDS_GAP}px`;
}

// Lädt die Topshelf-Vorschau (nur Modus "cards" zeigt die kleinen Fenster über dem Dock;
// Modus "fullscreen" zeigt vorab nur den Hinweis-Pfeil, der Rest passiert im Vollbild)
async function loadTopshelfCardsPreview(appData) {
  if (appData.topshelf !== 'cards') {
    topshelfCardsEl.classList.remove('visible');
    return;
  }

  const token = ++topshelfFetchToken;
  const items = await window.electronAPI.getTopshelfContent(appData.id);
  // Zwischenzeitlich wurde ein anderes Icon fokussiert - diese Antwort ist überholt
  if (token !== topshelfFetchToken) return;
  if (!topshelfCurrentAppData || topshelfCurrentAppData.id !== appData.id) return;

  topshelfItems = items;
  topshelfSelectedIndex = 0;
  renderTopshelfCards();
  topshelfCardsEl.classList.toggle('visible', items.length > 0);
}

const topshelfTrackEl = document.getElementById('topshelf-cards-track');
function topshelfCardGap() {
  return window.innerWidth * 0.014; // muss zum CSS-Gap (1.4vw) von .topshelf-cards-track passen
}

function renderTopshelfCards() {
  topshelfTrackEl.innerHTML = '';
  topshelfItems.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'topshelf-card';
    card.style.backgroundImage = `url('${item.backdropUrl}')`;
    card.classList.toggle('active', i === topshelfSelectedIndex);

    const label = document.createElement('div');
    label.className = 'topshelf-card-label';
    label.textContent = item.title;
    card.appendChild(label);

    topshelfTrackEl.appendChild(card);
  });

  positionTopshelfTrack();
}

// Verschiebt den Track so, dass die ausgewählte Karte als erste der beiden voll
// sichtbaren Karten erscheint (die dritte peakt dadurch automatisch am Rand rein)
function positionTopshelfTrack() {
  const firstCard = topshelfTrackEl.children[0];
  if (!firstCard) return;
  const cardWidth = firstCard.getBoundingClientRect().width;
  const offset = topshelfSelectedIndex * (cardWidth + topshelfCardGap());
  topshelfTrackEl.style.transform = `translateX(-${offset}px)`;
}

// Zeichnet Dock (erste 6 Einträge) und Grid (weitere, in Zeilen zu je 6) aus homeItems neu
function renderHomeTiles() {
  dockApps = homeItems.slice(0, MAX_DOCK_APPS);
  const extraApps = homeItems.slice(MAX_DOCK_APPS);
  hasExtraApps = extraApps.length > 0;
  appsViewport.classList.toggle('no-extra-apps', !hasExtraApps);
  renderDock(dockApps);
  renderExtra(extraApps);
}

function renderDock(dockApps) {
  dock.innerHTML = '';
  // Immer 6 Spalten nutzen (unabhängig von der tatsächlichen App-Zahl),
  // damit die Icon-Größe konstant bleibt und bei weniger Apps nicht wächst.
  dock.style.gridTemplateColumns = `repeat(${MAX_DOCK_APPS}, 1fr)`;

  dockButtons = [];
  dockApps.forEach((appData, colIndex) => {
    const tile = createIconTile(appData, { withBgPreview: true, rowIndex: 0, colIndex });
    dock.appendChild(tile);
    dockButtons.push(tile.querySelector('button'));
  });
}

// Weitere Apps: exakt gleiches Raster wie im Dock, nur ohne Glas-Hintergrund
function renderExtra(extraApps) {
  extraGrid.innerHTML = '';
  const buttons = [];

  extraApps.forEach((appData, index) => {
    const rowIndex = 1 + Math.floor(index / MAX_DOCK_APPS); // Zeile 0 ist das Dock
    const colIndex = index % MAX_DOCK_APPS;
    const tile = createIconTile(appData, { withBgPreview: true, rowIndex, colIndex });
    extraGrid.appendChild(tile);
    buttons.push(tile.querySelector('button'));
  });

  // In Zeilen zu je 6 aufteilen, passend zum CSS-Grid (repeat(6, 1fr))
  gridRows = [];
  for (let i = 0; i < buttons.length; i += MAX_DOCK_APPS) {
    gridRows.push(buttons.slice(i, i + MAX_DOCK_APPS));
  }
}

// Erst starten, wenn auch home-folders.js (Ordner, App-Menü) geladen ist: es steht in index.html hinter diesem Skript
const appsReady = new Promise((resolve) => {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resolve, { once: true });
  else resolve();
}).then(() => renderApps());

// 2. Uhr / Datum - Format, Zeitzone und Wochentag-Anzeige kommen aus den
//    Uhrzeit-Einstellungen (Einstellungen > Allgemein > Uhrzeit)
let clockSettings = { format: '24h', timezone: 'auto', showWeekday: true, weekdayFormat: 'long' };

async function loadClockSettings() {
  try {
    clockSettings = await window.electronAPI.getClockSettings();
  } catch (err) {
    console.error('Uhrzeit-Einstellungen konnten nicht geladen werden:', err);
  }
}

function updateClock() {
  const now = new Date();
  const timeOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: clockSettings.format === '12h'
  };
  if (clockSettings.timezone && clockSettings.timezone !== 'auto') {
    timeOptions.timeZone = clockSettings.timezone;
  }
  // ohne timeZone-Angabe nutzt Intl automatisch die Systemzeitzone ("auto")

  let timeText;
  try {
    timeText = new Intl.DateTimeFormat('de-DE', timeOptions).format(now);
  } catch (err) {
    // z.B. ungültige/unbekannte Zeitzone gespeichert - auf Systemzeitzone zurückfallen
    const { timeZone, ...fallbackOptions } = timeOptions;
    timeText = new Intl.DateTimeFormat('de-DE', fallbackOptions).format(now);
  }
  document.getElementById('clock-time').textContent = timeText;

  // Wochentag: nur befüllen, wenn in den Uhrzeit-Einstellungen aktiviert -
  // die Sichtbarkeit selbst (nur im ausgeklappten Schnellmenü) steuert CSS.
  const weekdayEl = document.getElementById('clock-weekday');
  if (clockSettings.showWeekday) {
    const weekdayStyle = clockSettings.weekdayFormat === 'short' ? 'short' : 'long'; // 'Do' bzw. 'Donnerstag'
    const weekdayOptions = { weekday: weekdayStyle };
    if (clockSettings.timezone && clockSettings.timezone !== 'auto') {
      weekdayOptions.timeZone = clockSettings.timezone;
    }
    let weekdayText;
    try {
      weekdayText = new Intl.DateTimeFormat('de-DE', weekdayOptions).format(now);
    } catch (err) {
      weekdayText = new Intl.DateTimeFormat('de-DE', { weekday: weekdayStyle }).format(now);
    }
    weekdayEl.textContent = weekdayText.replace(/\.$/, '') + ','; // je nach ICU-Version liefert 'short' "Do" oder "Do."
  } else {
    weekdayEl.textContent = '';
  }
  if (menuOpen) syncWeekdayWidth(); // Tageswechsel bei geöffnetem Menü
}

const clockReady = loadClockSettings().then(() => {
  updateClock();
  setInterval(updateClock, 1000);
});

// 3. App starten (mit Fade-Out Animation)
function launchApp(appData) {
  document.body.classList.add('fade-out');
  setTimeout(() => {
    window.electronAPI.loadApp({
      id: appData.id,
      name: appData.name,
      url: appData.url,
      icon: appData.icon,
      type: appData.type || 'web',
      programPath: appData.programPath || '',
      launchArgs: appData.launchArgs || '',
      loadingStyle: appData.loadingStyle || 'default'
    });
  }, 300);
}

// 4. Einstellungen öffnen (gleicher Übergang wie beim App-Start)
document.getElementById('settings-btn').addEventListener('click', () => {
  document.body.classList.add('fade-out');
  setTimeout(() => {
    window.electronAPI.loadSettings();
  }, 300);
});

// 4d. Medien-Modus des Schnellmenüs: Der Musikplayer-Button blendet Uhr und Buttons aus und die Steuerelemente der
//     Medienwiedergabe ein (Fortschrittsbalken, Zurück, Play/Pause, Weiter). Zurück zum Schnellmenü: B / Backspace.
//     Den Stand liefert der Hauptprozess, solange das Menü offen ist (Abo 'media-quick-start'); ohne etwas zu
//     steuern ist der Button ausgegraut. Bedienung: Maus (Klick, Balken ziehen), Tastatur und Controller (Steuerkreuz).
let mediaAvailable = false;
let mediaMode = false;
let quickState = { available: false, paused: true, current: 0, duration: 0, canPrev: false, canNext: false, title: '' };

const qmPanel = document.getElementById('quick-media-panel');
const qmTrack = document.getElementById('qm-track');
const qmFill = document.getElementById('qm-fill');
const qmThumb = document.getElementById('qm-thumb');
const qmCurrent = document.getElementById('qm-current');
const qmDuration = document.getElementById('qm-duration');
const qmTitle = window.createTitleMarquee(document.getElementById('qm-title'));
const qmPrev = document.getElementById('qm-prev');
const qmPlay = document.getElementById('qm-play');
const qmNext = document.getElementById('qm-next');
const qmIconPlay = document.getElementById('qm-icon-play');
const qmIconPause = document.getElementById('qm-icon-pause');

const QM_SEEK_SEND_INTERVAL_MS = 120;  // beim Ziehen am Balken höchstens so oft melden
const QM_SEEK_HOLD_MS = 900;           // nach dem Springen keinen älteren Stand der Seite anzeigen
let qmSeeking = false;
let qmSeekValue = 0;
let qmPendingSeek = null;              // { value, until }
let qmLastSeekSent = 0;
let qmSeekFlushTimer = null;

// Aktuelle Zeit abgerundet, Gesamtlänge gerundet (19,98 s = 0:20), wie im Player
function qmFormatTime(seconds, round) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const total = round ? Math.round(seconds) : Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function qmDurationValue() {
  return quickState.available && isFinite(quickState.duration) && quickState.duration > 0 ? quickState.duration : 0;
}

function qmSetDisabled(el, off) {
  el.classList.toggle('is-disabled', off);
  el.setAttribute('aria-disabled', off ? 'true' : 'false');
}

function qmIsDisabled(el) {
  return el.classList.contains('is-disabled');
}

// Zuletzt fokussiertes Element im Medien-Bereich (Balken oder einer der Knöpfe) - dorthin geht der Fokus beim Wechsel zurück
let qmLastFocus = qmPlay;
let qmLastButton = qmPlay; // zuletzt fokussierter Knopf (für "runter" vom Balken)
qmPanel.addEventListener('focusin', (event) => {
  if (event.target === qmTrack || event.target === qmPrev || event.target === qmPlay || event.target === qmNext) qmLastFocus = event.target;
  if (event.target === qmPrev || event.target === qmPlay || event.target === qmNext) qmLastButton = event.target;
});

function renderMedia() {
  const duration = qmDurationValue();
  const current = Math.max(0, Math.min(duration || Infinity, qmSeeking ? qmSeekValue : quickState.current));
  const pct = duration ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;
  qmFill.style.width = pct + '%';
  qmThumb.style.left = pct + '%';
  qmTitle.set(quickState.available ? quickState.title : '');
  qmCurrent.textContent = qmFormatTime(quickState.available ? current : 0);
  qmDuration.textContent = qmFormatTime(duration, true);
  qmPanel.classList.toggle('idle', !quickState.available);
  qmTrack.classList.toggle('seeking', qmSeeking);
  // Ausgegraut, aber nicht "disabled": ein deaktivierter Knopf würde den Fokus verlieren (der spränge dann auf den Balken)
  qmSetDisabled(qmPlay, !quickState.available);
  qmSetDisabled(qmPrev, !(quickState.available && quickState.canPrev));
  qmSetDisabled(qmNext, !(quickState.available && quickState.canNext));
  qmIconPlay.toggleAttribute('hidden', !quickState.paused); // pausiert -> Play-Symbol, läuft -> Pause-Symbol
  qmIconPause.toggleAttribute('hidden', quickState.paused);
  qmTrack.setAttribute('aria-valuemax', String(Math.round(duration)));
  qmTrack.setAttribute('aria-valuenow', String(Math.round(current)));
}

window.electronAPI.onMediaQuickState((next) => {
  if (!next) return;
  const incoming = { ...quickState, ...next };
  // Gerade gesprungen: ein noch älterer Stand der Seite soll die Anzeige nicht zurückspringen lassen
  if (qmPendingSeek) {
    if (Date.now() > qmPendingSeek.until || Math.abs(incoming.current - qmPendingSeek.value) <= 2) qmPendingSeek = null;
    else incoming.current = qmPendingSeek.value;
  }
  quickState = incoming;
  mediaAvailable = !!incoming.available;
  mediaBtn.classList.toggle('unavailable', !mediaAvailable);
  if (!qmSeeking) renderMedia();
  // Ein fokussierter Knopf, der gerade ausgegraut wurde, verliert den Fokus: auf Play/Pause zurückholen
  if (mediaMode && !qmPanel.contains(document.activeElement)) ensureMediaFocus();
});

mediaBtn.classList.add('unavailable');
mediaBtn.addEventListener('click', () => {
  if (!mediaAvailable || !menuOpen || mixerMode || mixerLoading || powerMode || profileMode) return;
  enterMediaMode();
});

function enterMediaMode() {
  if (mediaMode || !menuOpen) return;
  mediaMode = true;
  menuFocusIndex = menuButtons.indexOf(mediaBtn); // Backspace/B führt zurück auf den Musikplayer-Button
  quickMenu.classList.add('media-mode', 'sub-mode');
  renderMedia();
  menuButtons[menuFocusIndex].blur();
  qmLastFocus.focus({ preventScroll: true }); // dort weitermachen, wo der Fokus zuletzt war (zu Beginn: Play/Pause)
}

function exitMediaMode() {
  if (!mediaMode) return;
  mediaMode = false;
  quickMenu.classList.remove('media-mode', 'sub-mode');
  qmSeeking = false;
  if (document.activeElement && qmPanel.contains(document.activeElement)) document.activeElement.blur();
  if (menuOpen) menuButtons[menuFocusIndex].focus(); // zurück beim Musikplayer-Button des normalen Schnellmenüs
}

function ensureMediaFocus() {
  if (!qmPanel.contains(document.activeElement)) qmLastFocus.focus({ preventScroll: true });
}

function qmSendControl(action, value) {
  window.electronAPI.mediaQuickControl(action, value);
}

qmPrev.addEventListener('click', () => { if (!qmIsDisabled(qmPrev)) qmSendControl('prev'); });
qmNext.addEventListener('click', () => { if (!qmIsDisabled(qmNext)) qmSendControl('next'); });
qmPlay.addEventListener('click', () => { if (!qmIsDisabled(qmPlay)) qmSendControl('toggle'); });

// ----- Balken: anklicken/ziehen (Maus) oder mit links/rechts springen (Tastatur, Controller) -----
function qmSendSeek(value, force) {
  const now = performance.now();
  if (!force && now - qmLastSeekSent < QM_SEEK_SEND_INTERVAL_MS) return;
  qmLastSeekSent = now;
  qmSendControl('seek', value);
}

function qmTimeFromPointer(event) {
  const rect = qmTrack.getBoundingClientRect();
  const fraction = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
  return Math.max(0, Math.min(1, fraction)) * qmDurationValue();
}

qmTrack.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !qmDurationValue()) return;
  qmSeeking = true;
  qmSeekValue = qmTimeFromPointer(event);
  try { qmTrack.setPointerCapture(event.pointerId); } catch (err) { /* ohne Aufnahme weitermachen */ }
  renderMedia();
  qmSendSeek(qmSeekValue, true);
});
qmTrack.addEventListener('pointermove', (event) => {
  if (!qmSeeking) return;
  qmSeekValue = qmTimeFromPointer(event);
  renderMedia();
  qmSendSeek(qmSeekValue, false);
});
function qmEndSeek() {
  if (!qmSeeking) return;
  qmSeeking = false;
  qmPendingSeek = { value: qmSeekValue, until: Date.now() + QM_SEEK_HOLD_MS };
  qmSendSeek(qmSeekValue, true);
  quickState = { ...quickState, current: qmSeekValue };
  renderMedia();
}
qmTrack.addEventListener('pointerup', qmEndSeek);
qmTrack.addEventListener('pointercancel', qmEndSeek);

function qmSeekBy(delta) {
  const duration = qmDurationValue();
  if (!duration) return;
  const base = qmPendingSeek ? qmPendingSeek.value : quickState.current;
  const value = Math.max(0, Math.min(duration, base + delta));
  qmPendingSeek = { value, until: Date.now() + QM_SEEK_HOLD_MS };
  quickState = { ...quickState, current: value };
  renderMedia();
  qmSendSeek(value, false);
  clearTimeout(qmSeekFlushTimer);
  qmSeekFlushTimer = setTimeout(() => qmSendSeek(value, true), QM_SEEK_SEND_INTERVAL_MS + 30); // der letzte Stand kommt auf jeden Fall an
}

// ----- Tastatur / Controller (das Steuerkreuz kommt als Pfeiltasten an) -----
// Zwei Zeilen: Balken, darunter Zurück/Play/Weiter. Links/Rechts: auf dem Balken springen (5 s, bei Inhalten über
// 20 Minuten 10 s), sonst zwischen den Knöpfen wechseln. Hoch/Runter: zwischen Balken und Knöpfen.
function qmButtonsEnabled() {
  return [qmPrev, qmPlay, qmNext].filter((el) => !qmIsDisabled(el));
}

function handleMediaKey(code) {
  ensureMediaFocus();
  const active = document.activeElement;
  if (code === 'ArrowUp') {
    if (active === qmTrack) focusTopTab(); // schon auf dem Balken: weiter hoch in die obere Reihe
    else qmTrack.focus({ preventScroll: true });
  } else if (code === 'ArrowDown') {
    if (active === qmTrack) {
      // Vom Balken nach unten: zu dem Knopf, auf dem der Fokus zuletzt war (sonst Play/Pause, sonst der erste aktive)
      const target = [qmLastButton, qmPlay].find((el) => !qmIsDisabled(el)) || qmButtonsEnabled()[0];
      if (target) target.focus({ preventScroll: true });
    }
  } else {
    const dir = code === 'ArrowLeft' ? -1 : 1;
    if (active === qmTrack) {
      qmSeekBy(dir * (qmDurationValue() > 1200 ? 10 : 5));
    } else {
      // Nächster aktiver Knopf in Richtung; steht der Fokus auf einem gerade ausgegrauten Knopf, geht es von dort aus weiter
      const all = [qmPrev, qmPlay, qmNext];
      let i = all.indexOf(active) + dir;
      while (i >= 0 && i < all.length && qmIsDisabled(all[i])) i += dir;
      if (all[i]) all[i].focus({ preventScroll: true });
    }
  }
}

// 4e. Mixer-Modus des Schnellmenüs: Der Lautsprecher-Button blendet Uhr und Buttons aus und zeigt die Lautstärke der geöffneten
//     Apps direkt im Schnellmenü (Gesamtlautstärke, dann je App eine Zeile: Logo mit Play/Pause, Name, Regler, Stumm). Der Rahmen
//     behält seine Breite und wächst nach unten (höchstens ca. 70 % der Bildschirmhöhe, darüber scrollt die Liste). Zurück: B / Backspace.
//     Bedienung (Tastatur und Controller gleich): Hoch/Runter bleiben in der Spalte, Links/Rechts wechseln die Spalte; auf einem
//     Regler greift A/Enter ihn, dann verstellen Links/Rechts den Wert (A, B/Backspace oder Hoch/Runter lässt ihn los).
const mixerPanel = document.getElementById('quick-mixer-panel');
const mixerList = document.getElementById('qx-list');
const MIXER_COL_SLIDER = 1;
const MIXER_STEP = 5;                // Prozent pro Schritt
const MIXER_SEND_INTERVAL_MS = 100;  // höchstens so oft geht ein Wert an eine App
const MIXER_POLL_MS = 1500;          // Abfrage der Play/Pause-Zustände
const MIXER_MAX_HEIGHT_RATIO = 0.7;  // so hoch darf der Rahmen höchstens werden (Anteil der Fensterhöhe)
const QUICK_FRAME_MIN_HEIGHT = 218;  // Mindesthöhe des geöffneten Rahmens (= Mediensteuerung), inklusive der oberen Reihe (38 px)
const QUICK_FRAME_CHROME = 77;       // Rahmen: 2 x 18 px Innenabstand + 2 x 1,5 px Rand + obere Reihe (38 px)

let mixerMode = false;
let mixerLoading = false;
let mixerRows = [];                  // je Zeile [Play/Pause-Knopf oder null, Regler, Stumm-Knopf]
let mixerSenders = [];
const mixerSliderSender = new Map(); // Regler -> gedrosselter Sender
const mixerSliderRender = new Map(); // Regler -> Funktion, die den Prozentwert (mit/ohne Pfeile) neu schreibt
const mixerPlayButtons = {};         // appId -> Play/Pause-Knopf
let mixerGrabbed = null;
let mixerPollTimer = null;

// Gesamtlautstärke (gilt für alle Apps, auch für später gestartete): der Hauptprozess führt den Wert, die Handy-Fernbedienung kann ihn ändern
let knownGlobalVolume = 100;
window.electronAPI.getGlobalVolume().then((value) => { if (Number.isFinite(value)) knownGlobalVolume = value; }).catch(() => {});
window.electronAPI.onGlobalVolumeChanged((value) => {
  knownGlobalVolume = value;
  if (!mixerMode) return;
  mixerList.querySelectorAll('.qx-slider').forEach((s) => { // geöffneter Mixer: alle Regler mitziehen (außer dem, den man gerade bedient)
    if (s === document.activeElement && mixerGrabbed === s) return;
    s.value = String(value);
    const render = mixerSliderRender.get(s);
    if (render) render();
  });
});

// Der erste Wert geht sofort an die App, danach höchstens alle MIXER_SEND_INTERVAL_MS; der letzte Wert kommt immer an.
function createMixerSender(send) {
  let timer = null;
  let pending = null;
  function push(value) {
    if (timer) { pending = { value }; return; }
    send(value);
    timer = setTimeout(() => {
      timer = null;
      if (pending) { const next = pending.value; pending = null; push(next); }
    }, MIXER_SEND_INTERVAL_MS);
  }
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pending) { const next = pending.value; pending = null; send(next); }
  }
  const sender = { push, flush };
  mixerSenders.push(sender);
  return sender;
}

// Name mit Prozentwert und darunter der Regler. onInput läuft bei jeder Änderung sofort (Anzeige), onSend gedrosselt (Wert an die App).
function buildMixerSlider(nameText, value, onInput, onSend) {
  const main = document.createElement('div');
  main.className = 'qx-main';
  const head = document.createElement('div');
  head.className = 'qx-head';
  const name = document.createElement('span');
  name.className = 'qx-name';
  name.textContent = nameText;
  const valueEl = document.createElement('span');
  valueEl.className = 'slider-value';
  head.appendChild(name);
  head.appendChild(valueEl);
  main.appendChild(head);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = String(MIXER_STEP);
  slider.value = String(value);
  slider.className = 'settings-slider qx-slider';
  slider.setAttribute('aria-label', nameText);
  main.appendChild(slider);

  // Gegriffen zeigt der Prozentwert Pfeile: ◀ 70 % ▶
  const render = () => {
    const grabbed = slider === mixerGrabbed;
    valueEl.textContent = (grabbed ? '◀ ' : '') + slider.value + ' %' + (grabbed ? ' ▶' : '');
  };
  render();
  mixerSliderRender.set(slider, render);
  const sender = createMixerSender(onSend);
  mixerSliderSender.set(slider, sender);

  slider.addEventListener('input', () => {
    render();
    if (onInput) onInput(Number(slider.value));
    sender.push(Number(slider.value));
  });
  slider.addEventListener('blur', () => {
    if (mixerGrabbed === slider) releaseMixerSlider();
  });
  return { main, slider };
}

function mixerMuteLabel(btn, muted, all) {
  btn.textContent = muted ? '🔇' : '🔊';
  btn.title = muted ? (all ? 'Stummschaltung aller Apps aufheben' : 'Stummschaltung aufheben') : (all ? 'Alle Apps stummschalten' : 'Stummschalten');
}

function buildMixerGlobalRow(apps) {
  const row = document.createElement('div');
  row.className = 'qx-row qx-row-global';
  const iconWrap = document.createElement('div');
  iconWrap.className = 'qx-icon-wrap';
  iconWrap.textContent = '🔊';
  row.appendChild(iconWrap);

  const { main, slider } = buildMixerSlider('Gesamtlautstärke', knownGlobalVolume,
    (value) => { // Einzel-Regler visuell mitziehen
      mixerList.querySelectorAll('.qx-row:not(.qx-row-global) .qx-slider').forEach((s) => {
        s.value = String(value);
        mixerSliderRender.get(s)();
      });
    },
    (value) => window.electronAPI.setGlobalVolume(value));
  row.appendChild(main);

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'qx-mute';
  const allMuted = () => apps.length > 0 && apps.every((appData) => appData.muted);
  mixerMuteLabel(muteBtn, allMuted(), true);
  muteBtn.addEventListener('click', () => {
    const next = !allMuted();
    apps.forEach((appData) => { appData.muted = next; window.electronAPI.setAppMuted(appData.id, next); });
    mixerMuteLabel(muteBtn, next, true);
    mixerList.querySelectorAll('.qx-row:not(.qx-row-global) .qx-mute').forEach((btn) => mixerMuteLabel(btn, next, false));
  });
  row.appendChild(muteBtn);
  mixerRows.push([null, slider, muteBtn]);
  return row;
}

// Zeigt/aktualisiert das Play/Pause-Symbol; null = kein Video-/Audio-Element gefunden, dann bleibt es unsichtbar
function updateMixerPlayIcon(btn, state) {
  if (!state) { btn.style.display = 'none'; return; }
  btn.style.display = 'flex';
  btn.textContent = state.paused ? '▶' : '⏸';
}

function buildMixerAppRow(appData) {
  const row = document.createElement('div');
  row.className = 'qx-row';

  const iconWrap = document.createElement('div');
  iconWrap.className = 'qx-icon-wrap';
  const icon = document.createElement('img');
  icon.className = 'qx-icon';
  icon.src = appData.icon;
  icon.alt = '';
  iconWrap.appendChild(icon);

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'qx-playpause';
  playBtn.title = 'Wiedergabe umschalten';
  playBtn.style.display = 'none';
  playBtn.addEventListener('click', async () => {
    const state = await window.electronAPI.toggleAppPlayback(appData.id);
    updateMixerPlayIcon(playBtn, state);
  });
  iconWrap.appendChild(playBtn);
  mixerPlayButtons[appData.id] = playBtn;
  row.appendChild(iconWrap);

  const { main, slider } = buildMixerSlider(appData.name, appData.volume ?? 100, null,
    (value) => window.electronAPI.setAppVolume(appData.id, value));
  row.appendChild(main);

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'qx-mute';
  mixerMuteLabel(muteBtn, !!appData.muted, false);
  muteBtn.addEventListener('click', () => {
    appData.muted = !appData.muted;
    mixerMuteLabel(muteBtn, appData.muted, false);
    window.electronAPI.setAppMuted(appData.id, appData.muted);
  });
  row.appendChild(muteBtn);

  mixerRows.push([playBtn, slider, muteBtn]);
  return row;
}

function renderMixer(apps) {
  mixerList.innerHTML = '';
  mixerRows = [];
  mixerSenders = [];
  mixerSliderSender.clear();
  mixerSliderRender.clear();
  mixerGrabbed = null;
  Object.keys(mixerPlayButtons).forEach((key) => delete mixerPlayButtons[key]);
  mixerPanel.scrollTop = 0;

  if (apps.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'qx-empty';
    empty.textContent = 'Keine App geöffnet';
    mixerList.appendChild(empty);
    return;
  }
  mixerList.appendChild(buildMixerGlobalRow(apps));
  const divider = document.createElement('div');
  divider.className = 'qx-divider';
  mixerList.appendChild(divider);
  apps.forEach((appData) => mixerList.appendChild(buildMixerAppRow(appData)));
}

// Rahmenhöhe: so hoch wie die Liste (mindestens die normale Höhe, höchstens ca. 70 % des Fensters); der Rahmen wächst per CSS-Übergang
function updateMixerHeight() {
  const wanted = mixerList.offsetHeight + QUICK_FRAME_CHROME;
  const limit = Math.max(QUICK_FRAME_MIN_HEIGHT, Math.round(window.innerHeight * MIXER_MAX_HEIGHT_RATIO));
  quickMenu.style.setProperty('--mixer-h', `${Math.max(QUICK_FRAME_MIN_HEIGHT, Math.min(wanted, limit))}px`);
}

async function pollMixerPlayStates() {
  const states = await window.electronAPI.getAppPlayingStates();
  if (!mixerMode) return;
  Object.keys(mixerPlayButtons).forEach((id) => updateMixerPlayIcon(mixerPlayButtons[id], states[id]));
}

async function enterMixerMode() {
  if (mixerMode || mixerLoading || mediaMode || powerMode || profileMode || !menuOpen) return;
  mixerLoading = true;
  let apps = [];
  try {
    apps = await window.electronAPI.getRunningApps();
  } catch (err) { /* ohne Liste: "Keine App geöffnet" */ }
  mixerLoading = false;
  if (!menuOpen || mediaMode) return; // inzwischen geschlossen
  mixerMode = true;
  menuFocusIndex = menuButtons.indexOf(volumeBtn); // Backspace/B führt zurück auf den Lautsprecher-Button
  renderMixer(apps);
  updateMixerHeight();
  quickMenu.classList.add('mixer-mode', 'sub-mode');
  menuButtons[menuFocusIndex].blur();
  if (mixerRows.length) mixerRows[0][MIXER_COL_SLIDER].focus({ preventScroll: true }); // Gesamtlautstärke
  clearInterval(mixerPollTimer);
  if (apps.length) {
    pollMixerPlayStates();
    mixerPollTimer = setInterval(pollMixerPlayStates, MIXER_POLL_MS);
  }
}

// Zustand zurücksetzen (zurück zum Schnellmenü oder Menü zu): letzte Werte senden, Regler loslassen, Abfrage beenden
function resetMixerMode() {
  if (!mixerMode && !mixerLoading) return;
  mixerMode = false;
  mixerLoading = false;
  if (mixerGrabbed) releaseMixerSlider();
  mixerSenders.forEach((sender) => sender.flush());
  clearInterval(mixerPollTimer);
  mixerPollTimer = null;
  quickMenu.classList.remove('mixer-mode', 'sub-mode');
}

function exitMixerMode() {
  if (!mixerMode) return;
  resetMixerMode();
  if (document.activeElement && mixerPanel.contains(document.activeElement)) document.activeElement.blur();
  if (menuOpen) menuButtons[menuFocusIndex].focus(); // zurück beim Lautsprecher-Button des normalen Schnellmenüs
}

volumeBtn.addEventListener('click', () => {
  if (!menuOpen) return;
  enterMixerMode();
});

// ----- Regler greifen -----
function grabMixerSlider(slider) {
  mixerGrabbed = slider;
  slider.classList.add('grabbed');
  mixerSliderRender.get(slider)();
  window.electronAPI.setBackspaceCapture(true); // B/Backspace lässt jetzt den Regler los, statt etwas anderes auszulösen
}

function releaseMixerSlider() {
  if (!mixerGrabbed) return;
  const slider = mixerGrabbed;
  mixerGrabbed = null;
  slider.classList.remove('grabbed');
  mixerSliderRender.get(slider)();
  mixerSliderSender.get(slider).flush(); // der zuletzt eingestellte Wert darf nicht in der Drosselung hängen bleiben
  window.electronAPI.setBackspaceCapture(false);
}

// Simulierte (Controller-)Pfeiltasten verstellen einen Regler nicht von selbst: Schrittweite wie in den anderen Einstellungen
function stepMixerSlider(slider, dir) {
  const min = parseFloat(slider.min) || 0;
  const max = parseFloat(slider.max) || 100;
  const step = parseFloat(slider.step) || 1;
  const steps = Math.max(1, Math.round((max - min) / step));
  const inc = step * Math.max(1, Math.ceil(steps / 30));
  const cur = Number(slider.value);
  const next = Math.max(min, Math.min(max, cur + dir * inc));
  if (next === cur) return;
  slider.value = String(next);
  slider.dispatchEvent(new Event('input', { bubbles: true }));
}

function isMixerSlider(el) {
  return !!el && mixerPanel.contains(el) && el.classList.contains('qx-slider');
}

// ----- Raster-Navigation -----
function mixerUsable(el) {
  return !!el && el.offsetParent !== null; // ausgeblendetes Play/Pause (display:none) zählt nicht
}

function mixerLocate(el) {
  for (let r = 0; r < mixerRows.length; r++) {
    const c = mixerRows[r].indexOf(el);
    if (c !== -1) return { r, c };
  }
  return null;
}

function focusMixerEl(el) {
  el.focus({ preventScroll: true });
  const row = el.closest('.qx-row');
  if (row) row.scrollIntoView({ block: 'nearest' }); // bei langer Liste folgt die Ansicht dem Fokus
}

function handleMixerKey(code) {
  const active = document.activeElement;
  if (mixerGrabbed && active === mixerGrabbed) {
    if (code === 'ArrowLeft' || code === 'ArrowRight') {
      stepMixerSlider(mixerGrabbed, code === 'ArrowRight' ? 1 : -1);
      return;
    }
    releaseMixerSlider(); // Hoch/Runter lässt los und geht gleich weiter
  }
  const pos = mixerLocate(document.activeElement);
  if (!pos) { // noch nichts fokussiert: der erste Regler (Gesamtlautstärke)
    if (mixerRows.length) focusMixerEl(mixerRows[0][MIXER_COL_SLIDER]);
    return;
  }
  if (code === 'ArrowLeft' || code === 'ArrowRight') {
    const dir = code === 'ArrowRight' ? 1 : -1;
    for (let c = pos.c + dir; c >= 0 && c < mixerRows[pos.r].length; c += dir) {
      if (mixerUsable(mixerRows[pos.r][c])) { focusMixerEl(mixerRows[pos.r][c]); return; }
    }
    return;
  }
  const dir = code === 'ArrowDown' ? 1 : -1;
  for (let r = pos.r + dir; r >= 0 && r < mixerRows.length; r += dir) {
    if (mixerUsable(mixerRows[r][pos.c])) { focusMixerEl(mixerRows[r][pos.c]); return; }
  }
  if (dir === -1) focusTopTab(); // ganz oben angekommen: weiter in die obere Reihe
}

// Verlässt man die Seite direkt nach dem Verstellen, sollen letzte Werte nicht verloren gehen
window.addEventListener('pagehide', () => {
  mixerSenders.forEach((sender) => sender.flush());
  if (mixerGrabbed) window.electronAPI.setBackspaceCapture(false);
});

// 4c. Power-Modus im Schnellmenü: Der Power-Knopf öffnet die Auswahl Beenden / Neustart (nur Symbole). Links/Rechts wechselt,
//     Enter/A löst aus, Backspace/B führt zurück auf den Power-Knopf.
const powerPanel = document.getElementById('quick-power-panel');
const qpQuit = document.getElementById('qp-quit');
const qpRestart = document.getElementById('qp-restart');
let powerMode = false;

function enterPowerMode() {
  if (powerMode || profileMode || mediaMode || mixerMode || mixerLoading || !menuOpen) return;
  powerMode = true;
  menuFocusIndex = menuButtons.indexOf(powerBtn); // Backspace/B führt zurück auf den Power-Knopf
  quickMenu.classList.add('power-mode', 'sub-mode');
  menuButtons[menuFocusIndex].blur();
  qpQuit.focus({ preventScroll: true }); // vorausgewählt: Beenden
}

// Zustand zurücksetzen (zurück zum Schnellmenü oder Menü zu)
function resetPowerMode() {
  if (!powerMode) return;
  powerMode = false;
  quickMenu.classList.remove('power-mode', 'sub-mode');
}

function exitPowerMode() {
  if (!powerMode) return;
  resetPowerMode();
  if (document.activeElement && powerPanel.contains(document.activeElement)) document.activeElement.blur();
  if (menuOpen) menuButtons[menuFocusIndex].focus(); // zurück beim Power-Knopf des normalen Schnellmenüs
}

powerBtn.addEventListener('click', () => {
  if (!menuOpen) return;
  enterPowerMode();
});
qpQuit.addEventListener('click', () => {
  if (powerMode) window.electronAPI.quitApp();
});
qpRestart.addEventListener('click', () => {
  if (powerMode) window.electronAPI.restartApp();
});

// 4c-2. Profil-Modus im Schnellmenü: Der Profil-Knopf (zeigt das aktive Profil) öffnet die Auswahl der Profile. Links/Rechts wechselt,
//     Enter/A wählt (das aktive Profil nochmal wählen = zurück), Backspace/B führt zurück auf den Profil-Knopf. Beim Wechsel werden
//     alle laufenden Apps beendet und die Startseite lädt mit den Daten des neuen Profils.
const profileBtnAvatar = document.getElementById('profile-btn-avatar');
const profilePanel = document.getElementById('quick-profile-panel');
let profileMode = false;
let profileState = null;

function profileInitial(name) {
  const ch = Array.from(String(name || '').trim())[0];
  return ch ? ch.toUpperCase() : '?';
}

// Der Knopf zeigt das aktive Profil: farbiger Kreis mit dem Anfangsbuchstaben
function applyProfileButton(state) {
  const active = state && state.profiles.find((p) => p.id === state.activeId);
  if (!active) return;
  profileBtnAvatar.style.background = active.color;
  profileBtnAvatar.textContent = profileInitial(active.name);
  profileBtn.title = 'Profil wechseln (' + active.name + ')';
}

function renderProfilePanel() {
  profilePanel.textContent = '';
  profileState.profiles.forEach((profile) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'qpf-tile' + (profile.id === profileState.activeId ? ' current' : '');
    tile.dataset.id = profile.id;
    tile.title = profile.name;
    const avatar = document.createElement('span');
    avatar.className = 'profile-avatar';
    avatar.style.background = profile.color;
    avatar.textContent = profileInitial(profile.name);
    const name = document.createElement('span');
    name.className = 'qpf-name';
    name.textContent = profile.name;
    tile.append(avatar, name);
    tile.addEventListener('click', () => {
      if (!profileMode) return;
      if (profile.id === profileState.activeId) { exitProfileMode(); return; }
      window.electronAPI.switchProfile(profile.id);
    });
    profilePanel.appendChild(tile);
  });
}

// Eine andere Unteransicht (Mixer, Mediensteuerung, Beenden) verlassen, ohne den Fokus zurückzugeben
function leaveSubModes() {
  if (mixerMode) exitMixerMode();
  if (mediaMode) exitMediaMode();
  if (powerMode) exitPowerMode();
}

async function enterProfileMode() {
  if (profileMode || mixerLoading || !menuOpen) return;
  try {
    profileState = await window.electronAPI.getProfiles();
  } catch (err) {
    return;
  }
  if (!menuOpen || profileMode || mixerLoading) return;
  leaveSubModes(); // der Profil-Reiter ersetzt die aktuelle Ansicht
  profileMode = true;
  renderProfilePanel();
  quickMenu.classList.add('profile-mode', 'sub-mode');
  const current = profilePanel.querySelector('.qpf-tile.current') || profilePanel.firstElementChild;
  if (current) current.focus({ preventScroll: true }); // vorausgewählt: das aktive Profil
}

function resetProfileMode() {
  if (!profileMode) return;
  profileMode = false;
  quickMenu.classList.remove('profile-mode', 'sub-mode');
}

function exitProfileMode() {
  if (!profileMode) return;
  resetProfileMode();
  if (document.activeElement && profilePanel.contains(document.activeElement)) document.activeElement.blur();
  if (menuOpen) profileBtn.focus(); // zurück beim Profil-Knopf (obere Reihe), von dem aus man gekommen ist
}

profileBtn.addEventListener('click', () => {
  if (!menuOpen) return;
  enterProfileMode();
});

// Obere Reihe: Startseite und Profil (wie Reiter). Der Startseiten-Knopf führt aus jeder Unteransicht zurück zu den Knöpfen.
const topButtons = [homeBtn, profileBtn];

// Fokus auf den Knopf der aktuellen Ansicht in der oberen Reihe
function focusTopTab() {
  (profileMode ? profileBtn : homeBtn).focus({ preventScroll: true });
}

// Von der oberen Reihe nach unten: in den Inhalt der aktuellen Ansicht
function focusModeContent() {
  if (profileMode) {
    const current = profilePanel.querySelector('.qpf-tile.current') || profilePanel.firstElementChild;
    if (current) current.focus({ preventScroll: true });
  } else if (powerMode) {
    qpQuit.focus({ preventScroll: true });
  } else if (mixerMode) {
    if (mixerRows.length) focusMixerEl(mixerRows[0][MIXER_COL_SLIDER]);
  } else if (mediaMode) {
    ensureMediaFocus();
  } else {
    menuButtons[menuFocusIndex].focus({ preventScroll: true });
  }
}

function goHome() {
  if (!menuOpen || mixerLoading) return;
  if (profileMode) exitProfileMode();
  else if (mixerMode) exitMixerMode();
  else if (mediaMode) exitMediaMode();
  else if (powerMode) exitPowerMode();
  homeBtn.focus({ preventScroll: true });
}
homeBtn.addEventListener('click', goHome);

function moveProfileFocus(delta) {
  const tiles = Array.from(profilePanel.querySelectorAll('.qpf-tile'));
  if (!tiles.length) return;
  const index = tiles.indexOf(document.activeElement);
  const next = index === -1 ? 0 : Math.max(0, Math.min(tiles.length - 1, index + delta));
  tiles[next].focus({ preventScroll: true });
}

if (window.electronAPI.getProfiles) {
  window.electronAPI.getProfiles().then(applyProfileButton).catch(() => {});
}

// 4b. Glasmenü (Uhr + Lautstärke + Musikplayer + Zahnrad): standardmäßig eingeklappt und unsichtbar.
//     Öffnet sich, wenn Enter ENTER_HOLD_MS lang gehalten wird; Backspace schließt es.
let menuOpen = false;
const menuButtons = [volumeBtn, mediaBtn, settingsBtn, powerBtn]; // Reihe unter der Uhr (die obere Reihe: topButtons)
const SETTINGS_INDEX = menuButtons.indexOf(settingsBtn);
let menuFocusIndex = SETTINGS_INDEX; // nach unten geht es zuerst zum Zahnrad

// Breite des Wochentags (Textbreite): offen wächst der Wochentag per CSS auf diese Breite vor die Uhrzeit (--weekday-w) und blendet nach
// der Größenänderung ein.
function syncWeekdayWidth() {
  const weekdayEl = document.getElementById('clock-weekday');
  const width = weekdayEl.textContent ? weekdayEl.scrollWidth : 0; // Textbreite (der Wochentag selbst ist im Ruhezustand 0 px breit)
  quickMenu.style.setProperty('--weekday-w', `${width}px`);
}

function openMenu() {
  if (menuOpen) return;
  menuOpen = true;

  syncWeekdayWidth();
  if (ssActive) ssSend({ cmd: 'info', value: false }); // Bildschirmschoner dahinter: die Film-Info verschwindet, solange das Menü offen ist
  quickMenu.classList.add('open');
  window.electronAPI.startMediaQuick(); // Stand der Wiedergabe für den Musikplayer-Button und den Medien-Modus
  // Fokus ins Menü, damit ein kurzer Enter-Druck den fokussierten Button aktiviert: er startet in der oberen Reihe (Startseite)
  menuFocusIndex = SETTINGS_INDEX;
  homeBtn.focus({ preventScroll: true });
}

function closeMenu() {
  if (!menuOpen) return;
  menuOpen = false;
  resetMixerMode();
  resetPowerMode();
  resetProfileMode();
  quickMenu.classList.remove('open');
  quickMenu.classList.remove('media-mode', 'sub-mode');
  mediaMode = false;
  qmSeeking = false;
  window.electronAPI.stopMediaQuick();
  if (document.activeElement && quickMenu.contains(document.activeElement)) document.activeElement.blur();
  // Fokus zurück auf die zuvor gewählte App (falls schon navigiert wurde)
  if (focusZone === 'row') focusRowItem(focusRowIndex, focusColIndex);
}

// Links/Rechts wechselt im geöffneten Menü zwischen den Buttons (Lautstärke,
// Zahnrad, Beenden)
window.addEventListener('keydown', (e) => {
  if (!menuOpen) return;
  // Obere Reihe (Startseite, Profil): Links/Rechts wechselt, Runter geht in den Inhalt der Ansicht
  if (topButtons.includes(document.activeElement) && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
    e.preventDefault();
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      const next = Math.max(0, Math.min(topButtons.indexOf(document.activeElement) + (e.code === 'ArrowLeft' ? -1 : 1), topButtons.length - 1));
      topButtons[next].focus({ preventScroll: true });
    } else if (e.code === 'ArrowDown') {
      focusModeContent();
    }
    return;
  }
  if (powerMode) {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
      e.preventDefault();
      if (e.code === 'ArrowLeft') qpQuit.focus({ preventScroll: true });
      else if (e.code === 'ArrowRight') qpRestart.focus({ preventScroll: true });
      else if (e.code === 'ArrowUp') focusTopTab();
    }
    return;
  }
  if (profileMode) {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
      e.preventDefault();
      if (e.code === 'ArrowLeft') moveProfileFocus(-1);
      else if (e.code === 'ArrowRight') moveProfileFocus(1);
      else if (e.code === 'ArrowUp') focusTopTab();
    }
    return;
  }
  if (mixerMode || mixerLoading) {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
      e.preventDefault();
      if (mixerMode) handleMixerKey(e.code);
    }
    return;
  }
  if (mediaMode) {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
      e.preventDefault();
      handleMediaKey(e.code);
    }
    return;
  }
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    e.preventDefault();
    const delta = e.code === 'ArrowLeft' ? -1 : 1;
    menuFocusIndex = Math.max(0, Math.min(menuFocusIndex + delta, menuButtons.length - 1));
    menuButtons[menuFocusIndex].focus();
  } else if (e.code === 'ArrowUp') {
    e.preventDefault();
    focusTopTab();
  }
});

// 5. Weitere Apps per Pfeiltaste runter/hoch oder Mausrad ein-/ausblenden.
//    Funktioniert nur, wenn es tatsächlich mehr als 6 Apps gibt.
function showExtraApps() {
  if (!hasExtraApps || showingAllApps) return;
  appsViewport.style.height = `${expandedHeight}px`;
  appsViewport.classList.add('expanded');
  document.body.classList.add('grid-expanded');
  showingAllApps = true;
}

function hideExtraApps() {
  if (!hasExtraApps || !showingAllApps) return;
  holdBackgroundWhileGridCloses(); // vor dem Fokuswechsel aufrufen, dessen Hintergrundwechsel wartet
  appsViewport.style.height = `${collapsedHeight}px`;
  appsViewport.classList.remove('expanded');
  document.body.classList.remove('grid-expanded');
  showingAllApps = false;
}

// 6. Tastatur-Navigation: Pfeiltasten bewegen den Fokus zwischen Dock-Zeile
//    und Grid-Zeile(n). Das Zahnrad ist nur noch über das Glasmenü erreichbar
//    (Enter lange halten, siehe unten).
function getAllRows() {
  return [dockButtons, ...gridRows];
}

// Fokussiert eine bestimmte Spalte in einer bestimmten Zeile (0 = Dock, 1+ = Grid-Zeilen).
// Spalte wird an den Rand der Zeile geklemmt, falls die Zielzeile kürzer ist.
// Gibt true zurück, wenn ein Button fokussiert werden konnte.
function focusRowItem(rowIndex, colIndex) {
  const rows = getAllRows();
  const row = rows[rowIndex];
  if (!row || row.length === 0) return false;

  const clampedCol = Math.max(0, Math.min(colIndex, row.length - 1));
  const button = row[clampedCol];
  if (!button) return false;

  focusZone = 'row';
  focusRowIndex = rowIndex;
  focusColIndex = clampedCol;
  button.focus();
  return true;
}

window.addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) return;
  e.preventDefault();

  // Solange das Glasmenü offen ist, bleibt der Fokus im Menü
  if (menuOpen) return;

  // Erster Tastendruck initialisiert den Fokus nur (auf das erste Dock-Icon),
  // löst noch keine Bewegung aus - so verändert sich beim reinen Laden der
  // Seite optisch nichts, bevor man tatsächlich navigiert.
  if (focusZone === null) {
    focusRowItem(0, 0);
    return;
  }

  // Interaktive Topshelf-Karten-Navigation (Modus "cards", nach Pfeiltaste hoch
  // aktiviert) hat Vorrang vor der normalen Dock-/Grid-Navigation.
  if (topshelfCardsActive) {
    if (e.code === 'ArrowLeft') {
      topshelfSelectedIndex = Math.max(0, topshelfSelectedIndex - 1);
      renderTopshelfCards();
    } else if (e.code === 'ArrowRight') {
      topshelfSelectedIndex = Math.min(topshelfItems.length - 1, topshelfSelectedIndex + 1);
      renderTopshelfCards();
    } else if (e.code === 'ArrowDown') {
      setTopshelfCardsActive(false); // zurück zur normalen Dock-Navigation
    }
    // ArrowUp hat im Karten-Modus keine weitere Funktion
    return;
  }

  // Pfeiltaste hoch im Dock mit aktiviertem Topshelf -> Topshelf aktivieren,
  // statt wie sonst (im Dock ist "oben" das Ende) nichts zu tun.
  if (e.code === 'ArrowUp' && focusRowIndex === 0) {
    const appData = dockApps[focusColIndex];
    if (appData && appData.type !== 'folder' && appData.topshelf && appData.topshelf !== 'off') {
      if (appData.topshelf === 'fullscreen') {
        document.body.classList.add('fade-out');
        setTimeout(() => {
          window.electronAPI.loadTopshelf(appData.id);
        }, 300); // gleiche Dauer wie die übrige Fade-Out-Animation der App
      } else if (topshelfItems.length > 0) {
        setTopshelfCardsActive(true);
        topshelfSelectedIndex = 0;
        renderTopshelfCards();
      }
      return;
    }
  }

  switch (e.code) {
    case 'ArrowLeft':
      focusRowItem(focusRowIndex, focusColIndex - 1);
      break;

    case 'ArrowRight':
      focusRowItem(focusRowIndex, focusColIndex + 1);
      break;

    case 'ArrowUp':
      if (focusRowIndex > 0) {
        const targetRow = focusRowIndex - 1;
        // Zurück im Dock angekommen -> Grid wieder einklappen (zuerst, damit der Hintergrundwechsel der Dock-App bis dahin wartet)
        if (targetRow === 0 && showingAllApps) {
          hideExtraApps();
        }
        focusRowItem(targetRow, focusColIndex);
      }
      // Im Dock: schon ganz oben, nichts zu tun
      break;

    case 'ArrowDown':
      if (focusRowIndex === 0) {
        if (hasExtraApps) {
          hideTopshelfPreview(); // sofort+sanft ausblenden, nicht erst nach dem Ausklappen warten
          if (!showingAllApps) {
            // Grid war noch eingeklappt: erst ausklappen lassen, Fokus erst NACH
            // der Animation ins Grid setzen - sonst wird das frisch fokussierte
            // (und dadurch skalierende) Icon vom noch wachsenden Rahmen abgeschnitten.
            showExtraApps();
            setTimeout(() => focusRowItem(1, focusColIndex), EXPAND_TRANSITION_MS);
          } else {
            focusRowItem(1, focusColIndex);
          }
        }
        // keine weiteren Apps vorhanden -> nichts tun
      } else {
        focusRowItem(focusRowIndex + 1, focusColIndex);
      }
      break;
  }
});

window.addEventListener('wheel', (e) => {
  if (menuOpen || homeModalActive()) return; // Grid bleibt unverändert, solange ein Menü offen ist
  if (e.deltaY > 0) {
    showExtraApps();
  } else if (e.deltaY < 0) {
    hideExtraApps();
  }
});

// 7. Enter: kurz drücken = fokussierten Button aktivieren, ENTER_HOLD_MS lang halten =
//    Glasmenü (Uhr + Zahnrad) öffnen. Damit sich beides nicht in die Quere kommt,
//    wird die native Sofort-Aktivierung von Enter unterdrückt und ein kurzer Druck
//    stattdessen erst beim Loslassen ausgelöst.
let enterTimer = null;
let enterHeld = false;
let enterLongPressed = false;

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
  e.preventDefault();
  if (e.repeat || enterHeld) return;

  enterHeld = true;
  enterLongPressed = false;

  if (menuOpen) return; // im offenen Menü gibt es nichts zu "lang halten"

  // Langes Enter öffnet das App-Menü der fokussierten App bzw. des Ordners (das Schnellmenü liegt auf lange S)
  enterTimer = setTimeout(() => {
    enterLongPressed = true;
    if (openAppMenuForFocus()) { // das Menü übernimmt die Tasten: das Loslassen kommt hier nicht mehr an
      enterHeld = false;
      enterLongPressed = false;
    }
  }, ENTER_HOLD_MS);
});

window.addEventListener('keyup', (e) => {
  if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
  e.preventDefault();

  clearTimeout(enterTimer);
  enterTimer = null;

  const wasHeld = enterHeld;
  enterHeld = false;

  // Nach einem Long-Press (Menü wurde gerade geöffnet) beim Loslassen nichts aktivieren,
  // sonst würde das frisch fokussierte Zahnrad sofort die Einstellungen öffnen.
  if (!wasHeld || enterLongPressed) {
    enterLongPressed = false;
    return;
  }

  const active = document.activeElement;
  if (active && active.tagName === 'BUTTON') active.click();
  else if (mixerMode && isMixerSlider(active)) { // A/Enter auf einem Regler: greifen bzw. loslassen
    if (mixerGrabbed === active) releaseMixerSlider();
    else grabMixerSlider(active);
  } else if (mediaMode && active === qmTrack && !qmIsDisabled(qmPlay)) qmSendControl('toggle'); // A/Enter auf dem Balken: Play/Pause
});

// Controller: die in den Einstellungen belegte Taste "Schnellmenü direkt" (preload.js) öffnet und schließt das Schnellmenü mit einem Druck
window.addEventListener('keydown', (e) => {
  if (e.code !== 'GamepadQuickMenu' || e.repeat) return;
  e.preventDefault();
  if (menuOpen) closeMenu();
  else if (!homeModalActive()) openMenu();
});

// Tastatur: lange S öffnet das Schnellmenü (früher: Enter halten - das öffnet jetzt das App-Menü). Kurz gedrückt passiert nichts;
// in einem Textfeld (z.B. Ordnername) ist S ein ganz normaler Buchstabe.
let sTimer = null;
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyS' || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
  clearTimeout(sTimer);
  if (menuOpen || homeModalActive()) return;
  sTimer = setTimeout(() => { if (!menuOpen && !homeModalActive()) openMenu(); }, ENTER_HOLD_MS);
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'KeyS') clearTimeout(sTimer);
});

// Handy: Halten der OK-Fläche auf der Startseite = App-Menü (wie langes Enter am Controller)
window.addEventListener('keydown', (e) => {
  if (e.code !== 'GamepadAppMenu' || e.repeat) return;
  e.preventDefault();
  if (!menuOpen) openAppMenuForFocus();
});

// 8. Backspace: im Medien-Modus zurück zum Schnellmenü, sonst schließt es das Glasmenü
window.addEventListener('keydown', (e) => {
  if (e.code === 'Backspace' && menuOpen) {
    e.preventDefault();
    if (mixerMode) { // gegriffener Regler: erst loslassen; sonst zurück zum normalen Schnellmenü
      if (mixerGrabbed) releaseMixerSlider();
      else exitMixerMode();
    } else if (mixerLoading) { /* Liste wird gerade geladen: nichts tun */ }
    else if (powerMode) exitPowerMode();
    else if (profileMode) exitProfileMode();
    else if (mediaMode) exitMediaMode(); // erst zurück zum normalen Schnellmenü, ein weiteres Mal schließt es
    else closeMenu();
    return;
  }
  if (e.code === 'Backspace' && topshelfCardsActive) {
    e.preventDefault();
    setTopshelfCardsActive(false); // zurück zur normalen Dock-/Grid-Navigation
    return;
  }
  // Startseite, nichts mehr zurückzugehen: erst ein ausgeklapptes Grid einklappen (zurück ins Dock), dann startet der
  // Bildschirmschoner (Controller "B" kommt hier ebenfalls als Backspace an)
  if (e.code === 'Backspace' && !menuOpen) {
    e.preventDefault();
    if (e.repeat) return; // gehaltene Taste startet nichts
    if (document.querySelector('.osk-container.visible')) return; // Bildschirmtastatur offen: Backspace gehört ihr
    if (showingAllApps) {
      hideExtraApps(); // zuerst: der Hintergrundwechsel der Dock-App wartet, bis das Grid zu ist
      focusRowItem(0, focusColIndex);
      return;
    }
    window.electronAPI.startScreensaver();
  }
});

// ---------- Eingabegerät-Anzeige (Tastatur/Fernbedienung vs. Controller) ----------
// Tastatur und Fernbedienung lassen sich technisch nicht zuverlässig
// unterscheiden (die meisten Fernbedienungen geben sich dem System gegenüber
// als Tastatur aus) - deshalb nur zwei Zustände: Controller (per Gamepad-API
// zuverlässig erkennbar) oder Tastatur/Fernbedienung (alles andere).
let currentInputDevice = 'keyboard';

const DEVICE_TITLES = { keyboard: 'Tastatur aktiv', gamepad: 'Controller aktiv', remote: 'Smartphone aktiv' };

function setInputDevice(device) {
  if (currentInputDevice === device) return;
  currentInputDevice = device;
  deviceIconKeyboard.style.display = device === 'keyboard' ? 'block' : 'none';
  deviceIconGamepad.style.display = device === 'gamepad' ? 'block' : 'none';
  deviceIconRemote.style.display = device === 'remote' ? 'block' : 'none';
  deviceIndicatorBtn.title = DEVICE_TITLES[device] || '';
}

// Nur echte Tastendrücke zählen: die simulierten Tasten von Controller und Handy kommen als nicht vertrauenswürdige
// Ereignisse an und würden sonst die Anzeige auf "Tastatur" zurückstellen
window.addEventListener('keydown', (e) => { if (e.isTrusted) setInputDevice('keyboard'); });

// Die Gamepad-API hat keine "Taste gedrückt"-Events, deshalb wird laufend
// geprüft, ob gerade aktiv eine Taste/ein Stick benutzt wird (nicht nur, ob
// ein Controller verbunden ist - der könnte ja nur ungenutzt rumliegen).
function pollGamepadActivity() {
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of gamepads) {
    if (!gp) continue;
    const buttonActive = gp.buttons.some(b => b.pressed);
    const axisActive = gp.axes.some(a => Math.abs(a) > 0.3);
    if (buttonActive || axisActive) {
      setInputDevice('gamepad');
      break;
    }
  }
  requestAnimationFrame(pollGamepadActivity);
}
requestAnimationFrame(pollGamepadActivity);

// ---------- Netzwerk-Anzeige (LAN / WLAN mit Signalstärke / keine Verbindung) ----------
// Der Hauptprozess ermittelt den Stand (network-status.js) und meldet nur Änderungen. Vor der ersten Antwort bleibt der Button leer.
const networkBtn = document.getElementById('network-indicator-btn');
const netIcons = {
  lan: document.getElementById('net-icon-lan'),
  wifi: document.getElementById('net-icon-wifi'),
  none: document.getElementById('net-icon-off')
};

function applyNetworkStatus(status) {
  const type = status && netIcons[status.type] ? status.type : '';
  const level = type === 'wifi' ? Math.max(0, Math.min(3, Number(status.level) || 0)) : 0;
  Object.keys(netIcons).forEach((key) => { netIcons[key].style.display = key === type ? 'block' : 'none'; });
  networkBtn.dataset.type = type;
  networkBtn.dataset.level = String(level);
}

if (window.electronAPI.getNetworkStatus) {
  window.electronAPI.getNetworkStatus().then(applyNetworkStatus).catch(() => {});
  window.electronAPI.onNetworkStatus(applyNetworkStatus);
}

// ---------- Handy-Fernbedienung im Eingabegerät-Symbol ----------
// Jede Eingabe vom Handy stellt das Symbol auf "Handy"; trennt sich das Handy, geht es zurück auf "Tastatur".
if (window.electronAPI.onRemoteInput) window.electronAPI.onRemoteInput(() => setInputDevice('remote'));
function applyRemoteStatus(status) {
  if (!(status && status.connected) && currentInputDevice === 'remote') setInputDevice('keyboard');
}
if (window.electronAPI.getRemoteStatus) {
  window.electronAPI.getRemoteStatus().then(applyRemoteStatus).catch(() => {});
  window.electronAPI.onRemoteStatus(applyRemoteStatus);
}

// ---------- Bereit-Meldung für den Rückweg aus einer App ----------
// Bereit = alles, was man beim Aufdecken sieht, steht im Endzustand: Dock samt Höhe, Hintergrund
// (inkl. wiederhergestellter App-Vorschau), Uhrzeit und dekodierte Icons.
async function signalLauncherReady() {
  if (!launcherReadyToken) return;

  const settled = (async () => {
    await Promise.allSettled([appsReady, clockReady]);
    // Während des Wartens kann weitere Arbeit hinzukommen (z.B. die Abfrage des dynamischen Hintergrunds)
    let seen;
    do {
      seen = startupWork.length;
      await Promise.allSettled(startupWork);
    } while (startupWork.length !== seen);
    await Promise.allSettled([...document.querySelectorAll('.dock img, .extra-grid img')].map((img) => img.decode()));
  })();
  const timeout = new Promise((resolve) => setTimeout(resolve, READY_PAGE_TIMEOUT_MS));
  await Promise.race([settled, timeout]);

  // Zwei Frames abwarten: Der Endzustand ist dann sicher gezeichnet, bevor die App verschwindet
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  startupInstant = false;
  window.electronAPI.launcherReady(launcherReadyToken);
}
signalLauncherReady();

// ---------- Bildschirmschoner: diese Seite kann ihn als Ebene aufnehmen (siehe oben) ----------
if (window.electronAPI.screensaverHostReady) window.electronAPI.screensaverHostReady();
