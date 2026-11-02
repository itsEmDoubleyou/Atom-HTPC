// Eigene Bildschirmtastatur für unsere Einstellungsseiten (Stufe 1).
// Grundlage ist simple-keyboard (lib/simple-keyboard) - wir nutzen nur dessen
// Darstellung und Tasten-Callbacks. Eingefügt/gelöscht wird bewusst selbst
// (an der echten Cursor-Position des Textfelds), nicht über den internen
// Eingabe-Zustand der Bibliothek.
//
// Bedienung:
//   - Öffnen:    A-Taste (= simuliertes Enter vom Controller) auf einem fokussierten
//                Textfeld. Echtes Enter der Tastatur bleibt unverändert, damit z.B.
//                "Enter speichert den API-Key" weiter funktioniert.
//   - Nur Controller: Reagiert ausschließlich auf simulierte (Controller-)Ereignisse.
//                Wird auf der echten Tastatur getippt, schließt sie sich wieder.
//   - Navigieren: Steuerkreuz/Stick bzw. Pfeiltasten wandern zeilenweise durch die Tasten.
//                 Pfeil hoch aus der obersten Reihe -> zurück ins Textfeld,
//                 Pfeil runter im Textfeld -> in die Tastatur.
//   - Tippen:    A-Taste bzw. Enter auf der fokussierten Taste.
//   - Schließen: B-Taste (Backspace) oder die Taste "Fertig".
(function () {
  const Keyboard = window.SimpleKeyboard && window.SimpleKeyboard.default;
  if (!Keyboard || !window.electronAPI || !window.electronAPI.getKeyboardSettings) return;

  const TEXT_TYPES = ['text', 'search', 'url', 'email', 'password', 'tel'];

  // Alle drei Layouts haben dieselbe Zeilenstruktur (5 Zeilen), und die Taste unten
  // links bzw. die Shift-Taste liegt jeweils an derselben Position. Dadurch bleibt der
  // Fokus beim Layout-Wechsel an derselben Stelle (Umschalten wird neu gerendert).
  const LAYOUTS = {
    default: [
      '1 2 3 4 5 6 7 8 9 0 ß {bksp}',
      'q w e r t z u i o p ü',
      'a s d f g h j k l ö ä',
      '{shift} y x c v b n m , . -',
      '{numbers} {left} {space} {right} {enter}'
    ],
    shift: [
      '! " § $ % & / ( ) = ? {bksp}',
      'Q W E R T Z U I O P Ü',
      'A S D F G H J K L Ö Ä',
      '{shift} Y X C V B N M ; : _',
      '{numbers} {left} {space} {right} {enter}'
    ],
    numbers: [
      '1 2 3 4 5 6 7 8 9 0 + {bksp}',
      '@ # € _ & - ( ) = / *',
      ': ; " \' ! ? ~ % ^ \\ |',
      '< > [ ] $ , . ` ´ § ß',
      '{abc} {left} {space} {right} {enter}'
    ]
  };

  const DISPLAY = {
    '{bksp}': '⌫',
    '{enter}': 'Fertig',
    '{shift}': '⇧',
    '{space}': 'Leertaste',
    '{numbers}': '123',
    '{abc}': 'ABC',
    '{left}': '◀',
    '{right}': '▶',
    // Anzeigenamen werden von der Bibliothek als HTML eingesetzt
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;'
  };

  let enabled = false;
  let container = null;
  let host = null;
  let preview = null;
  let keyboard = null;
  let target = null;
  let visible = false;
  let layoutName = 'default';
  let focusPos = { row: 1, col: 5 }; // zuletzt fokussierte Taste (Zeile/Spalte), überlebt das Neu-Rendern
  let pendingRefocus = false;
  let enterDownInKeyboard = false;
  let valueAtOpen = '';

  // Nur der Schalter "Eigene Bildschirmtastatur" zählt (die Windows-Tastatur ist davon getrennt).
  function refreshSettings() {
    window.electronAPI.getKeyboardSettings()
      .then((s) => {
        enabled = !!(s && s.ownEnabled);
        if (!enabled) close(false);
      })
      .catch(() => { enabled = false; });
  }
  refreshSettings();
  // Die Tastatur-Einstellungsseite meldet Änderungen, damit sie sofort greifen
  window.addEventListener('osk-settings-changed', refreshSettings);

  // ---------- Hilfsfunktionen ----------

  function isTextField(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') return TEXT_TYPES.includes((el.type || 'text').toLowerCase());
    return false;
  }

  function isInKeyboard(el) {
    return !!(el && el.closest && el.closest('#osk-container'));
  }

  function rows() {
    return host ? Array.from(host.querySelectorAll('.hg-row')) : [];
  }

  function keysOfRow(rowEl) {
    return Array.from(rowEl.querySelectorAll('button.hg-button'));
  }

  function posOf(btn) {
    const rs = rows();
    for (let i = 0; i < rs.length; i++) {
      const j = keysOfRow(rs[i]).indexOf(btn);
      if (j >= 0) return { row: i, col: j };
    }
    return null;
  }

  function keyAt(pos) {
    const rs = rows();
    if (rs.length === 0) return null;
    const row = rs[Math.max(0, Math.min(rs.length - 1, pos.row))];
    const ks = keysOfRow(row);
    return ks[Math.max(0, Math.min(ks.length - 1, pos.col))] || null;
  }

  function focusKey(btn) {
    if (!btn) return;
    const pos = posOf(btn);
    if (pos) focusPos = pos;
    btn.focus({ preventScroll: true });
  }

  function centerX(el) {
    const r = el.getBoundingClientRect();
    return r.left + r.width / 2;
  }

  // ---------- Aufbau ----------

  function ensureBuilt() {
    if (container) return;

    container = document.createElement('div');
    container.id = 'osk-container';
    container.className = 'osk-container';

    preview = document.createElement('div');
    preview.className = 'osk-preview';
    container.appendChild(preview);

    host = document.createElement('div');
    host.className = 'osk-host'; // die Bibliothek verlangt eine CSS-Klasse am Host-Element
    container.appendChild(host);

    // Mausklick auf den Rahmen (nicht auf eine Taste) soll den Fokus nicht klauen
    container.addEventListener('mousedown', (e) => {
      if (!e.target.closest || !e.target.closest('button')) e.preventDefault();
    });

    document.body.appendChild(container);

    keyboard = new Keyboard(host, {
      layout: LAYOUTS,
      layoutName: 'default',
      display: DISPLAY,
      mergeDisplay: true,
      theme: 'hg-theme-default osk-theme',
      useButtonTag: true,          // echte <button>-Elemente -> fokussierbar
      disableCaretPositioning: true, // Cursor-Position verwalten wir selbst
      onKeyPress: (button, event) => {
        const btn = event && event.target && event.target.closest ? event.target.closest('button[data-skbtn]') : null;
        pressKey(button, btn);
      },
      onRender: onRendered
    });
  }

  function onRendered() {
    if (!pendingRefocus) return;
    pendingRefocus = false;
    focusKey(keyAt(focusPos));
  }

  function setLayout(name) {
    if (name === layoutName) return;
    layoutName = name;
    if (container) container.classList.toggle('osk-shifted', name === 'shift');
    pendingRefocus = true; // setOptions rendert neu -> die fokussierte Taste wird ersetzt
    keyboard.setOptions({ layoutName: name });
    pendingRefocus = false;
  }

  function updatePreview() {
    if (!preview || !target) return;
    const empty = !target.value;
    preview.classList.toggle('osk-preview-empty', empty);
    if (empty) {
      preview.textContent = target.placeholder || '';
    } else {
      preview.textContent = target.type === 'password' ? '•'.repeat(target.value.length) : target.value;
    }
  }

  // ---------- Öffnen / Schließen ----------

  function open(input) {
    if (visible) return;
    ensureBuilt();
    target = input;
    valueAtOpen = input.value;
    setLayout('default');
    updatePreview();
    container.classList.add('visible');
    visible = true;
    // Textfeld möglichst sichtbar halten (Best-Effort: wirkt nur, wenn die Seite scrollbar ist)
    requestAnimationFrame(() => { if (target) target.scrollIntoView({ block: 'center' }); });
    focusKey(keyAt(focusPos));
  }

  function close(refocus) {
    if (!visible) return;
    visible = false;
    container.classList.remove('visible');
    const t = target;
    target = null;
    if (t && t.value !== valueAtOpen) t.dispatchEvent(new Event('change', { bubbles: true }));
    if (refocus && t) t.focus();
  }

  // ---------- Tasten ----------

  function fireInput() {
    target.dispatchEvent(new Event('input', { bubbles: true }));
    updatePreview();
  }

  function insertText(text) {
    const start = target.selectionStart;
    const end = target.selectionEnd;
    if (start == null) {
      target.value += text; // z.B. type=email: keine Selection-API
    } else {
      target.setRangeText(text, start, end, 'end');
    }
    fireInput();
  }

  function deleteBackward() {
    const start = target.selectionStart;
    const end = target.selectionEnd;
    if (start == null) {
      target.value = target.value.slice(0, -1);
    } else if (start !== end) {
      target.setRangeText('', start, end, 'end');
    } else if (start > 0) {
      target.setRangeText('', start - 1, start, 'end');
    } else {
      return;
    }
    fireInput();
  }

  function moveCaret(delta) {
    const len = target.value.length;
    const base = delta < 0 ? target.selectionStart : target.selectionEnd;
    const pos = Math.max(0, Math.min(len, (base == null ? len : base) + delta));
    try { target.setSelectionRange(pos, pos); } catch (err) { /* z.B. type=email: ignorieren */ }
  }

  function pressKey(button, btn) {
    if (!visible || !target) return;
    if (btn) {
      const pos = posOf(btn);
      if (pos) focusPos = pos;
    }

    switch (button) {
      case '{shift}':   setLayout(layoutName === 'shift' ? 'default' : 'shift'); return;
      case '{numbers}': setLayout('numbers'); return;
      case '{abc}':     setLayout('default'); return;
      case '{left}':    moveCaret(-1); return;
      case '{right}':   moveCaret(1); return;
      case '{enter}':   close(true); return;
      case '{bksp}':    deleteBackward(); return;
      case '{space}':   insertText(' '); break;
      default:          insertText(button);
    }

    // Shift gilt nur für den nächsten Buchstaben
    if (layoutName === 'shift') setLayout('default');
  }

  function activateFocusedKey() {
    const btn = document.activeElement && document.activeElement.closest
      ? document.activeElement.closest('button[data-skbtn]')
      : null;
    if (btn) pressKey(btn.getAttribute('data-skbtn'), btn);
  }

  // ---------- Navigation innerhalb der Tastatur ----------

  function navigateKeys(code) {
    const active = document.activeElement;
    const pos = posOf(active);
    if (!pos) return;
    const rs = rows();

    if (code === 'ArrowLeft' || code === 'ArrowRight') {
      const next = keysOfRow(rs[pos.row])[pos.col + (code === 'ArrowRight' ? 1 : -1)];
      if (next) focusKey(next);
      return;
    }

    const newRow = pos.row + (code === 'ArrowDown' ? 1 : -1);
    if (newRow < 0) {
      if (target) target.focus(); // zurück ins Textfeld, Tastatur bleibt offen
      return;
    }
    if (newRow >= rs.length) return;

    const cx = centerX(active);
    let best = null;
    let bestDist = Infinity;
    keysOfRow(rs[newRow]).forEach((k) => {
      const d = Math.abs(centerX(k) - cx);
      if (d < bestDist) { bestDist = d; best = k; }
    });
    focusKey(best);
  }

  // ---------- Ereignisse (Capture-Phase, damit wir vor nav.js & Co. dran sind) ----------

  function swallow(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // Tasten, die für sich allein keine "Eingabe" sind - sie sollen die Tastatur nicht schließen
  const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock'];

  window.addEventListener('keydown', (e) => {
    if (!enabled) return;
    const active = document.activeElement;

    // Die Bildschirmtastatur ist nur für die Controller-Nutzung da. Echte Tastatur-
    // Ereignisse sind vertrauenswürdig (isTrusted), die des Controllers simuliert und
    // nicht. Sobald auf der echten Tastatur getippt wird, verschwindet die Bildschirm-
    // tastatur wieder und die Eingabe läuft ganz normal ins Textfeld.
    if (e.isTrusted) {
      if (visible && !MODIFIER_KEYS.includes(e.key)) close(isInKeyboard(active));
      return;
    }

    if (!visible) {
      // Das vom Controller simulierte Enter (A-Taste) auf einem Textfeld öffnet die Tastatur
      if (e.code === 'Enter' && isTextField(active)) {
        swallow(e);
        open(active);
      }
      return;
    }

    if (isInKeyboard(active)) {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        swallow(e);
        navigateKeys(e.code);
      } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        swallow(e);
        if (!e.repeat) enterDownInKeyboard = true;
      } else if (e.code === 'Backspace') {
        swallow(e);
        close(true);
      }
      return;
    }

    if (active === target) {
      if (e.code === 'ArrowDown' || e.code === 'Enter') {
        // Runter oder A im Textfeld bei offener Tastatur: zurück in die Tastatur
        swallow(e);
        focusKey(keyAt(focusPos));
      } else if (e.code === 'Backspace') {
        // B-Taste des Controllers im Textfeld: Tastatur schließen
        swallow(e);
        close(false);
      }
    }
  }, true);

  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
    if (e.isTrusted) { enterDownInKeyboard = false; return; } // echte Tastatur: nicht unsere Sache
    if (!visible || !isInKeyboard(document.activeElement)) {
      enterDownInKeyboard = false;
      return;
    }
    swallow(e);
    // Nur auslösen, wenn auch das passende keydown innerhalb der Tastatur kam -
    // das keyup des Enter, das die Tastatur gerade geöffnet hat, wird ignoriert.
    if (enterDownInKeyboard) {
      enterDownInKeyboard = false;
      activateFocusedKey();
    }
  }, true);

  // Fokus verlässt Tastatur und Textfeld -> Tastatur schließen
  document.addEventListener('focusin', (e) => {
    if (!visible) return;
    if (isInKeyboard(e.target)) {
      const pos = posOf(e.target.closest('button'));
      if (pos) focusPos = pos;
      return;
    }
    if (e.target !== target) close(false);
  });

  // Mausklick irgendwo außerhalb schließt ebenfalls
  document.addEventListener('mousedown', (e) => {
    if (!visible) return;
    if (isInKeyboard(e.target) || e.target === target) return;
    close(false);
  }, true);
})();
