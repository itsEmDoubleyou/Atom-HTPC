// Controller-Einstellungen: Tastenbelegung (welche Taste löst was aus) und die Regler für Cursor und Scrollen.
// Die Belegung selbst und ihre Regeln (Tausch bei doppelter Taste, Vorlagen, Standard) liegen im Hauptprozess (controller-mapping.js);
// diese Seite zeigt sie an und nimmt die Taste beim Belegen direkt vom Controller entgegen.
// Unsere Tasten-Behandlung (onPadKeydown, unten) muss VOR der gemeinsamen Navigation am Fenster hängen: Die simulierten Controller-Tasten
// werden direkt an das Fenster geschickt, und dort laufen die Handler in der Reihenfolge ihrer Anmeldung (Capture-Flag hin oder her).
window.addEventListener('keydown', (e) => onPadKeydown(e), true);
if (window.NavHelper) window.NavHelper.enableLinearNav();

const api = window.electronAPI;
const CAPTURE_TIMEOUT_MS = 8000;  // so lange wartet "Taste drücken", dann bricht es ab
const CAPTURE_RELEASE_MS = 1500;  // nach dem Belegen höchstens so lange auf das Loslassen warten

const presetsEl = document.getElementById('pad-presets');
const actionsEl = document.getElementById('pad-actions');
const statusEl = document.getElementById('pad-status');
const infoTitle = document.getElementById('pad-info-title');
const infoDesc = document.getElementById('pad-info-desc');
const captionEl = document.getElementById('pad-caption');
const hintsEl = document.getElementById('pad-hints');
const padSvg = document.getElementById('pad-controller');
const DEFAULT_INFO_TITLE = infoTitle.textContent;
const DEFAULT_INFO_DESC = infoDesc.textContent;

// Fest belegte Bedienelemente: stehen mit in der Liste (nicht änderbar), damit alles, was auf dem Controller-Symbol zu sehen ist, auch dort erklärt wird.
// part = data-btn der Trigger bzw. data-part der gezeichneten Teile im Symbol
const FIXED_ROWS = [
  { id: 'fixed:dpad', label: 'Auswählen', value: 'Steuerkreuz', part: 'dpad',
    desc: 'Mit dem Steuerkreuz wählst du in den Menüs aus (hoch, runter, links, rechts). Das lässt sich nicht ändern.' },
  { id: 'fixed:lstick', label: 'Cursor bewegen', value: 'Linker Stick', part: 'lstick',
    desc: 'Bewegt in Apps den Mauszeiger, solange der Cursor an ist. Die Geschwindigkeit stellst du weiter unten ein. Das lässt sich nicht ändern.' },
  { id: 'fixed:lt', label: 'Nach oben scrollen', value: 'LT', part: '6', bumper: true,
    desc: 'Scrollt in Apps die Seite nach oben (LT). Die Geschwindigkeit stellst du weiter unten ein. Das lässt sich nicht ändern.' },
  { id: 'fixed:rt', label: 'Nach unten scrollen', value: 'RT', part: '7', bumper: true,
    desc: 'Scrollt in Apps die Seite nach unten (RT). Die Geschwindigkeit stellst du weiter unten ein. Das lässt sich nicht ändern.' }
];
const fixedById = (id) => FIXED_ROWS.find((r) => r.id === id);

let info = null;       // Beschreibung vom Hauptprozess: Belegung, Standard, Aktionen, Vorlagen, Beschriftungen
let capture = null;    // läuft gerade "Taste drücken" für eine Aktion
let statusTimer = null;

const labelOf = (button) => (button === null || button === undefined ? 'Keine' : (info.labels[button] || `Taste ${button}`));
const actionById = (id) => info.actions.find((a) => a.id === id);

function say(text, ms = 5000) {
  statusEl.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusEl.textContent = ''; }, ms);
}

// Symbol einer Taste: Aktionstasten farbig rund, Schultertasten eckig, Sticks rund, sonst Text
function glyph(button) {
  const el = document.createElement('span');
  el.className = 'pad-glyph';
  if (button === null || button === undefined) { el.classList.add('g-none'); el.textContent = 'Keine Taste'; return el; }
  el.textContent = labelOf(button);
  if (button === 0) el.classList.add('g-face', 'g-a');
  else if (button === 1) el.classList.add('g-face', 'g-b');
  else if (button === 2) el.classList.add('g-face', 'g-x');
  else if (button === 3) el.classList.add('g-face', 'g-y');
  else if (button === 4 || button === 5) el.classList.add('g-bumper');
  else if (button === 10 || button === 11) el.classList.add('g-stick');
  else el.classList.add('g-word');
  return el;
}

// ---------- Anzeige rechts: Beschreibung, Controller-Symbol mit leuchtender Taste ----------
function showAction(actionId) {
  padSvg.querySelectorAll('.pad-part.on').forEach((el) => el.classList.remove('on'));
  if (!info || !actionId) {
    infoTitle.textContent = DEFAULT_INFO_TITLE;
    infoDesc.textContent = DEFAULT_INFO_DESC;
    captionEl.textContent = '';
    return;
  }
  const fixed = fixedById(actionId);
  if (fixed) {
    infoTitle.textContent = fixed.label;
    infoDesc.textContent = fixed.desc;
    const part = padSvg.querySelector(`[data-part="${fixed.part}"]`);
    if (part) part.classList.add('on');
    captionEl.textContent = `${fixed.value} (fest belegt)`;
    return;
  }
  const action = actionById(actionId);
  const button = info.mapping[actionId];
  infoTitle.textContent = action.label;
  infoDesc.textContent = action.desc;
  const target = button === null ? null : padSvg.querySelector(`.pad-btn[data-btn="${button}"]`);
  if (target) target.classList.add('on');
  if (capture && capture.action === actionId) captionEl.textContent = 'Drücke jetzt die neue Taste am Controller …';
  else if (button === null) captionEl.textContent = 'Keine Taste belegt';
  else if (!target) captionEl.textContent = `${labelOf(button)} (auf dem Symbol nicht abgebildet)`;
  else captionEl.textContent = labelOf(button);
}

function renderHints() {
  hintsEl.textContent = '';
  const add = (button, text) => {
    const item = document.createElement('span');
    item.className = 'pad-hint';
    item.append(glyph(button), document.createTextNode(' ' + text));
    hintsEl.appendChild(item);
  };
  add(info.mapping.confirm, 'Ändern');
  add(info.mapping.back, 'Zurück');
}

function currentActionId() {
  const row = document.activeElement && document.activeElement.closest && document.activeElement.closest('.pad-row');
  return row ? row.dataset.action : null;
}

// ---------- Aufbau der Liste ----------
function render(focusAction) {
  presetsEl.textContent = '';
  info.presets.forEach((preset) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pad-preset-btn' + (info.preset === preset.id ? ' active' : '');
    btn.dataset.preset = preset.id;
    btn.textContent = preset.label;
    btn.addEventListener('click', async () => {
      if (capture) return;
      const result = await api.applyControllerPreset(preset.id);
      if (result && result.info) info = result.info;
      render();
      const el = presetsEl.querySelector(`[data-preset="${preset.id}"]`);
      if (el) el.focus({ preventScroll: true });
      if (result && result.ok) say(preset.id === 'standard' ? 'Alle Tasten auf Standard zurückgesetzt.' : `Vorlage „${preset.label}“ übernommen.`);
    });
    presetsEl.appendChild(btn);
  });
  const custom = document.createElement('span');
  custom.className = 'pad-preset-custom' + (info.preset === 'custom' ? ' active' : '');
  custom.textContent = 'Eigene';
  presetsEl.appendChild(custom);

  actionsEl.textContent = '';
  let group = null;
  info.actions.forEach((action) => {
    if (action.group !== group) {
      group = action.group;
      const title = document.createElement('div');
      title.className = 'pad-section-title';
      title.textContent = group;
      actionsEl.appendChild(title);
    }
    const button = info.mapping[action.id];
    const row = document.createElement('div');
    row.className = 'pad-row';
    row.dataset.action = action.id;

    const name = document.createElement('span');
    name.className = 'pad-row-name';
    name.textContent = action.label;

    const bind = document.createElement('button');
    bind.type = 'button';
    bind.className = 'pad-bind';
    bind.setAttribute('aria-label', `${action.label}: ${labelOf(button)} - Taste ändern`);
    if (capture && capture.action === action.id) {
      row.classList.add('capturing');
      const wait = document.createElement('span');
      wait.className = 'pad-glyph g-wait';
      wait.textContent = 'Taste drücken …';
      bind.appendChild(wait);
    } else {
      bind.appendChild(glyph(button));
    }
    bind.addEventListener('click', () => startCapture(action.id));

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'pad-reset';
    reset.textContent = '↺';
    reset.title = 'Auf Standard zurücksetzen';
    reset.setAttribute('aria-label', `${action.label} auf Standard zurücksetzen`);
    if (button === info.defaults[action.id]) reset.disabled = true; // schon die Standardtaste
    reset.addEventListener('click', async () => {
      if (capture) return;
      const before = info.mapping[action.id];
      const result = await api.resetControllerAction(action.id);
      if (result && result.info) info = result.info;
      render(action.id);
      if (result && result.ok) {
        const other = result.swapped ? actionById(result.swapped) : null;
        say(other
          ? `${action.label}: wieder ${labelOf(info.mapping[action.id])}. „${other.label}“ bekam dafür ${labelOf(before)}.`
          : `${action.label}: wieder ${labelOf(info.mapping[action.id])}.`);
      }
    });

    row.append(name, bind, reset);
    actionsEl.appendChild(row);
  });

  const fixedTitle = document.createElement('div');
  fixedTitle.className = 'pad-section-title';
  fixedTitle.textContent = 'Fest belegt';
  actionsEl.appendChild(fixedTitle);
  FIXED_ROWS.forEach((fixed) => {
    const row = document.createElement('div');
    row.className = 'pad-row pad-row-fixed';
    row.dataset.action = fixed.id;
    const name = document.createElement('span');
    name.className = 'pad-row-name';
    name.textContent = fixed.label;
    const bind = document.createElement('button');
    bind.type = 'button';
    bind.className = 'pad-bind pad-bind-fixed';
    bind.setAttribute('aria-label', `${fixed.label}: ${fixed.value} - fest belegt`);
    const g = document.createElement('span');
    g.className = 'pad-glyph ' + (fixed.bumper ? 'g-bumper' : 'g-word');
    g.textContent = fixed.value;
    bind.appendChild(g);
    bind.addEventListener('click', () => { if (!capture) say(`${fixed.value} ist fest belegt und lässt sich nicht ändern.`); });
    const lock = document.createElement('span');
    lock.className = 'pad-lock';
    lock.textContent = 'fest';
    row.append(name, bind, lock);
    actionsEl.appendChild(row);
  });

  renderHints();
  if (focusAction) {
    const el = actionsEl.querySelector(`[data-action="${focusAction}"] .pad-bind`);
    if (el) el.focus();
  }
  showAction(currentActionId());
}

document.getElementById('pad-left').addEventListener('focusin', () => showAction(currentActionId()));

// ---------- Taste belegen ----------
function firstPad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  return Array.from(pads).find((g) => g) || null;
}

function pressedButtons() {
  const gp = firstPad();
  if (!gp) return [];
  const list = [];
  gp.buttons.forEach((b, i) => { if (b && b.pressed) list.push(i); });
  return list;
}

function startCapture(actionId) {
  if (capture) return;
  capture = { action: actionId, armed: false, startedAt: performance.now(), warned: false, finishing: false, finishAt: 0, raf: 0, message: '' };
  api.setControllerCapture(true);   // die gedrückte Taste soll in dieser Zeit nichts auslösen
  api.setBackspaceCapture(true);    // Rücktaste der Tastatur bricht ab (statt "Zurück")
  say('Drücke die neue Taste am Controller. Abbrechen: Rücktaste der Tastatur.', CAPTURE_TIMEOUT_MS);
  render(actionId);
  capture.raf = requestAnimationFrame(captureTick);
}

function endCapture(message) {
  if (!capture) return;
  const actionId = capture.action;
  cancelAnimationFrame(capture.raf);
  capture = null;
  api.setControllerCapture(false);
  api.setBackspaceCapture(false);
  render(actionId);
  if (message) say(message);
}

async function assignCaptured(button) {
  const actionId = capture.action;
  const action = actionById(actionId);
  const before = info.mapping[actionId];
  const result = await api.setControllerButton(actionId, button);
  if (result && result.info) info = result.info;
  if (!result || !result.ok) {
    const other = result && result.other ? actionById(result.other) : null;
    return result && result.error === 'occupied' && other
      ? `${labelOf(button)} gehört schon zu „${other.label}“. Ändere zuerst dort, dann lässt sich „${action.label}“ darauf legen.`
      : 'Diese Taste lässt sich nicht belegen.';
  }
  const swapped = result.swapped ? actionById(result.swapped) : null;
  return swapped
    ? `${action.label}: ${labelOf(button)}. „${swapped.label}“ bekam dafür ${labelOf(before)}.`
    : `${action.label}: ${labelOf(button)}.`;
}

function captureTick() {
  if (!capture) return;
  const now = performance.now();
  const pressed = pressedButtons();
  if (capture.finishing) {
    // Warten, bis die Taste wieder losgelassen ist (sonst löst sie danach sofort ihre neue Aktion aus)
    if (capture.done && (!pressed.length || now - capture.finishAt > CAPTURE_RELEASE_MS)) endCapture(capture.message);
    else capture.raf = requestAnimationFrame(captureTick);
    return;
  }
  if (!capture.armed) {
    // Erst scharf, wenn nichts mehr gedrückt ist (z.B. die Taste, mit der "Ändern" ausgelöst wurde)
    if (!pressed.length) capture.armed = true;
  } else if (pressed.length) {
    const button = pressed.find((i) => !info.fixedButtons.includes(i));
    if (button === undefined) {
      if (!capture.warned) { capture.warned = true; say('Steuerkreuz und Trigger sind fest belegt. Drücke eine andere Taste.', CAPTURE_TIMEOUT_MS); }
    } else {
      capture.finishing = true;
      capture.finishAt = now;
      const current = capture;
      assignCaptured(button).then((message) => { current.message = message; current.done = true; });
    }
  } else {
    capture.warned = false;
  }
  if (!capture.finishing && now - capture.startedAt > CAPTURE_TIMEOUT_MS) {
    endCapture(firstPad() ? 'Keine Taste gedrückt - abgebrochen.' : 'Kein Controller erkannt - abgebrochen.');
    return;
  }
  capture.raf = requestAnimationFrame(captureTick);
}

// ---------- Navigation: pro Zeile Taste und Zurücksetzen, Hoch/Runter wechselt die Zeile ----------
function navStops() {
  const stops = [];
  const presetBtns = Array.from(presetsEl.querySelectorAll('.pad-preset-btn'));
  if (presetBtns.length) stops.push(presetBtns);
  actionsEl.querySelectorAll('.pad-row').forEach((row) => {
    stops.push(Array.from(row.querySelectorAll('button:not([disabled])')));
  });
  ['cursor-speed', 'scroll-speed', 'controller-reset'].forEach((id) => stops.push([document.getElementById(id)]));
  return stops;
}

function onPadKeydown(e) {
  if (capture) {
    // Beim Belegen gehört die Tastatur der Abbruch-Taste; alles andere (Pfeile, Enter) tut nichts
    if (e.code === 'Backspace') {
      e.preventDefault();
      e.stopImmediatePropagation();
      endCapture('Abgebrochen.');
    } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.code)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    return;
  }
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) return;
  const active = document.activeElement;
  const stops = navStops();
  const si = stops.findIndex((stop) => stop.includes(active));
  if (si === -1) return; // nichts gewählt: die gemeinsame Navigation setzt den Fokus auf das erste Element
  const horizontal = e.code === 'ArrowLeft' || e.code === 'ArrowRight';
  if (horizontal && active.type === 'range') return; // Regler: die gemeinsame Navigation verstellt ihn
  e.preventDefault();
  e.stopImmediatePropagation();
  const stop = stops[si];
  if (horizontal) {
    const next = Math.max(0, Math.min(stop.indexOf(active) + (e.code === 'ArrowLeft' ? -1 : 1), stop.length - 1));
    stop[next].focus();
    return;
  }
  const target = stops[Math.max(0, Math.min(si + (e.code === 'ArrowUp' ? -1 : 1), stops.length - 1))];
  target[Math.min(stop.indexOf(active), target.length - 1)].focus();
}

// ---------- Regler: Cursor- und Scroll-Geschwindigkeit ----------
const DEFAULT_SPEED = 100;
const CONTROLS = [
  { key: 'cursorSpeed', slider: document.getElementById('cursor-speed'), valueEl: document.getElementById('cursor-speed-value') },
  { key: 'scrollSpeed', slider: document.getElementById('scroll-speed'), valueEl: document.getElementById('scroll-speed-value') }
];
const resetBtn = document.getElementById('controller-reset');
let saveTimer = null;

function renderValue(control) {
  control.valueEl.textContent = control.slider.value + ' %';
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const values = {};
  CONTROLS.forEach((c) => { values[c.key] = Number(c.slider.value); });
  api.saveControllerSettings(values);
}

// Beim Verstellen (Ziehen, Halten der Pfeiltaste) nicht jeden Zwischenwert speichern
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}

CONTROLS.forEach((c) => {
  c.slider.addEventListener('input', () => {
    renderValue(c);
    scheduleSave();
  });
});

resetBtn.addEventListener('click', () => {
  CONTROLS.forEach((c) => {
    c.slider.value = DEFAULT_SPEED;
    renderValue(c);
  });
  scheduleSave();
});

window.addEventListener('DOMContentLoaded', async () => {
  const settings = await api.getControllerSettings();
  CONTROLS.forEach((c) => {
    c.slider.value = settings[c.key];
    renderValue(c);
  });
  info = await api.getControllerMappingInfo();
  render();
});

// Verlässt man die Seite direkt nach dem Verstellen (z.B. B-Taste), soll der Wert nicht verloren gehen
window.addEventListener('pagehide', () => {
  if (saveTimer) saveNow();
  if (capture) { api.setControllerCapture(false); api.setBackspaceCapture(false); }
});
