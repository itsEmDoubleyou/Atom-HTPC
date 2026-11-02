// Tastenbelegung des Controllers: welche Taste löst welche Aktion aus.
// Die Standardbelegung ist die bisherige feste Belegung des Programms (A bestätigen, B zurück, ...). Steuerkreuz, Sticks und die
// Trigger (Scrollen) sind nicht belegbar. Jede Taste gehört höchstens einer Aktion; wird eine belegte Taste gewählt, tauschen beide.
// Gespeichert wird die Nummer der Taste im "Standard-Layout" der Gamepad-API (0 = A, 1 = B, 2 = X, 3 = Y, 4 = LB, 5 = RB,
// 8 = Select, 9 = Start, 10 = L3, 11 = R3); bei Pads mit anderer Nummerierung steht dieselbe Nummer für deren Taste - wer die
// Taste beim Belegen einfach drückt, bekommt immer die richtige.
// Dieses Modul kennt kein Electron (testbar) und läuft nur im Hauptprozess; die Seiten bekommen die fertige Belegung.

// Belegbare Tasten: alles außer Steuerkreuz (12-15) und den Triggern LT/RT (6, 7), die zum Scrollen gehören
const FIXED_BUTTONS = [6, 7, 12, 13, 14, 15];
const MAX_BUTTON = 31;

const BUTTON_NAMES = { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 8: 'Select', 9: 'Start', 10: 'L3', 11: 'R3' };

function isBindable(button) {
  return Number.isInteger(button) && button >= 0 && button <= MAX_BUTTON && !FIXED_BUTTONS.includes(button);
}

function buttonLabel(button) {
  if (button === null || button === undefined) return '';
  return BUTTON_NAMES[button] || `Taste ${button}`;
}

// Aktionen in der Reihenfolge der Einstellungsseite. optional = darf ohne Taste bleiben (Standard: keine).
const ACTIONS = [
  { id: 'confirm', group: 'Navigation', label: 'Bestätigen', def: 0,
    desc: 'Auswählen und bestätigen. Gehalten öffnet die Taste auf der Startseite das App-Menü (verschieben, in Ordner legen, löschen), in Apps klickt sie mit dem Cursor.' },
  { id: 'back', group: 'Navigation', label: 'Zurück', def: 1,
    desc: 'Einen Schritt zurück. In einer App minimiert sie die App zurück zur Startseite.' },
  { id: 'quickMenu', group: 'Navigation', label: 'Schnellmenü direkt', def: null, optional: true,
    desc: 'Öffnet und schließt das Schnellmenü auf der Startseite mit einem Druck. Ohne belegte Taste lässt sich das Schnellmenü mit dem Controller nicht öffnen (auf der Tastatur: S gehalten, am Handy: Home gehalten).' },
  { id: 'switcher', group: 'Programm', label: 'App-Umschalter', def: 5,
    desc: 'Gehalten zeigt sie die im Hintergrund laufenden Apps.' },
  { id: 'pip', group: 'Programm', label: 'Bild-in-Bild', def: 4,
    desc: 'Schaltet das Video der aktuellen App in ein kleines Fenster und zurück.' },
  { id: 'musicPlayer', group: 'Programm', label: 'Musikplayer', def: 11,
    desc: 'Öffnet und schließt den Musikplayer, wenn gerade etwas abgespielt wird.' },
  { id: 'cursor', group: 'In Apps', label: 'Cursor an/aus', def: 10,
    desc: 'Schaltet den Mauszeiger in Apps ein oder aus. Mit dem linken Stick bewegst du ihn, mit Bestätigen klickst du.' },
  { id: 'keyboard', group: 'In Apps', label: 'Bildschirmtastatur', def: 3,
    desc: 'Blendet die Bildschirmtastatur für das gerade gewählte Textfeld ein oder aus.' },
  { id: 'extra', group: 'In Apps', label: 'Zusatztaste', def: 2,
    desc: 'In YouTube TV Wiedergabe/Pause. Bei offenem Musikplayer wählst du gehalten mit dem Steuerkreuz dessen Platz auf dem Bildschirm.' }
];

const ACTION_IDS = ACTIONS.map((a) => a.id);

const DEFAULT_MAPPING = Object.freeze(Object.fromEntries(ACTIONS.map((a) => [a.id, a.def])));

// Vorlagen: Nintendo-Layout = A/B und X/Y vertauscht (dort liegt die Bestätigen-Taste rechts)
const PRESETS = [
  { id: 'standard', label: 'Standard', mapping: { ...DEFAULT_MAPPING } },
  { id: 'nintendo', label: 'Nintendo', mapping: { ...DEFAULT_MAPPING, confirm: 1, back: 0, extra: 3, keyboard: 2 } }
];

function copyOf(mapping) {
  return { ...mapping };
}

// Bereinigt eine gelesene Belegung: unbekannte/ungültige Werte -> Standard, doppelte Tasten (kaputte Datei) -> alles Standard
function normalizeMapping(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const action of ACTIONS) {
    const value = src[action.id];
    if (action.optional && (value === null || value === undefined)) out[action.id] = value === null ? null : action.def;
    else out[action.id] = isBindable(value) ? value : action.def;
  }
  const used = ACTION_IDS.map((id) => out[id]).filter((v) => v !== null);
  if (new Set(used).size !== used.length) return copyOf(DEFAULT_MAPPING);
  return out;
}

// Weist einer Aktion eine Taste zu. Ist die Taste schon belegt, tauschen beide Aktionen ihre Tasten.
// Ergebnis: { ok, mapping, swapped (Kennung der getauschten Aktion oder null) } oder { ok: false, error }
//   error: 'unknown' (Aktion), 'fixed' (Taste nicht belegbar), 'occupied' (eine Aktion ohne Taste kann nicht tauschen)
function assignButton(mapping, actionId, button) {
  const action = ACTIONS.find((a) => a.id === actionId);
  if (!action) return { ok: false, error: 'unknown' };
  const current = normalizeMapping(mapping);
  if (button === null) {
    if (!action.optional) return { ok: false, error: 'unknown' };
    current[actionId] = null;
    return { ok: true, mapping: current, swapped: null };
  }
  if (!isBindable(button)) return { ok: false, error: 'fixed' };
  if (current[actionId] === button) return { ok: true, mapping: current, swapped: null };
  const otherId = ACTION_IDS.find((id) => id !== actionId && current[id] === button) || null;
  if (otherId) {
    const old = current[actionId];
    if (old === null) return { ok: false, error: 'occupied', other: otherId };
    current[otherId] = old;
  }
  current[actionId] = button;
  return { ok: true, mapping: current, swapped: otherId };
}

function presetMapping(id) {
  const preset = PRESETS.find((p) => p.id === id);
  return preset ? copyOf(preset.mapping) : null;
}

// Welche Vorlage entspricht der Belegung? 'custom', wenn keine
function detectPreset(mapping) {
  const m = normalizeMapping(mapping);
  const hit = PRESETS.find((p) => ACTION_IDS.every((id) => p.mapping[id] === m[id]));
  return hit ? hit.id : 'custom';
}

// Beschreibung für die Einstellungsseite (alles, was sie zum Zeichnen braucht)
function describe(mapping) {
  const m = normalizeMapping(mapping);
  return {
    mapping: m,
    defaults: copyOf(DEFAULT_MAPPING),
    actions: ACTIONS.map(({ id, group, label, desc, optional }) => ({ id, group, label, desc, optional: !!optional })),
    presets: PRESETS.map(({ id, label }) => ({ id, label })),
    preset: detectPreset(m),
    labels: Object.fromEntries(Array.from({ length: MAX_BUTTON + 1 }, (_, i) => [i, buttonLabel(i)])),
    fixedButtons: FIXED_BUTTONS.slice()
  };
}

module.exports = {
  ACTIONS, ACTION_IDS, DEFAULT_MAPPING, PRESETS, FIXED_BUTTONS, MAX_BUTTON,
  isBindable, buttonLabel, normalizeMapping, assignButton, presetMapping, detectPreset, describe
};
