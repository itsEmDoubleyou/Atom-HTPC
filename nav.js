// Gemeinsame Tastatur-Navigation für die Einstellungsseiten (Menüs, Formulare).
// Zwei Bausteine:
//   1) enableLinearNav(): Pfeiltasten bewegen den Fokus durch alle fokussierbaren
//      Elemente der Seite in DOM-Reihenfolge (wie Tab/Shift+Tab) - passend für
//      einfache Menüs und Formularseiten.
//   2) Hilfsfunktionen (isTextEditable, isSelect, isNativeArrowUse,
//      getFocusableElements), die auch von Seiten mit eigener 2D-Raster-
//      Navigation (z.B. manage.js) wiederverwendet werden, damit Textcursor
//      und <select>-Bedienung nie durch die Pfeiltasten-Navigation gestört werden.
window.NavHelper = (function () {
  function isTextEditable(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA';
  }

  function isSelect(el) {
    return !!el && el.tagName === 'SELECT';
  }

  function isRange(el) {
    return !!el && el.tagName === 'INPUT' && el.type === 'range';
  }

  // Regler per Controller verstellen: Simulierte Pfeiltasten ändern einen Regler nicht von
  // selbst. Die Schrittweite wird so gewählt, dass man mit ca. 30 Tastendrücken von Anschlag
  // zu Anschlag kommt (bei feinen Reglern wie 0-100 sonst unnötig mühsam).
  function stepRange(el, dir) {
    const min = parseFloat(el.min);
    const max = parseFloat(el.max);
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) ? max : 100;
    const step = parseFloat(el.step) || 1;
    const steps = Math.max(1, Math.round((hi - lo) / step));
    const inc = step * Math.max(1, Math.ceil(steps / 30));
    const cur = Number(el.value);
    const next = Math.max(lo, Math.min(hi, cur + dir * inc));
    if (next === cur) return;
    el.value = String(next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Die Bildschirmtastatur (virtual-keyboard.js) bedient ihre Tasten selbst. Die
  // Seiten-Navigation darf dort nicht zusätzlich eingreifen, sonst bewegt sich der
  // Fokus pro Tastendruck doppelt (einmal hier, einmal in der Tastatur).
  function isInOnScreenKeyboard(el) {
    return !!(el && el.closest && el.closest('#osk-container'));
  }

  // true, wenn diese Pfeiltaste bei diesem Element ihrer nativen Bedeutung
  // überlassen werden soll (Textcursor bzw. Select-Auswahl), statt zu navigieren.
  // Mit dem Ereignis e als dritten Parameter: Simulierte (Controller-)Tasten verändern
  // eine Auswahlliste nicht von selbst - dort sollen Hoch/Runter navigieren, sonst
  // käme man mit dem Controller nie wieder aus einer Auswahlliste heraus.
  function isNativeArrowUse(el, code, e) {
    if (isTextEditable(el) && (code === 'ArrowLeft' || code === 'ArrowRight')) return true;
    if (isSelect(el) && (code === 'ArrowUp' || code === 'ArrowDown')) return !e || e.isTrusted;
    return false;
  }

  // Alle sichtbaren, aktivierten, fokussierbaren Elemente innerhalb eines
  // Containers (Standard: die ganze Seite), in DOM-Reihenfolge.
  function getFocusableElements(container) {
    const selector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
      'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from((container || document).querySelectorAll(selector))
      .filter(el => el.offsetParent !== null && !isInOnScreenKeyboard(el));
  }

  // Bewegt den Fokus in DOM-Reihenfolge weiter/zurück, ausgehend vom aktuell
  // fokussierten Element. container einschränken, um z.B. nur innerhalb eines
  // geöffneten Formulars zu navigieren.
  function moveLinearFocus(code, container, e) {
    const active = document.activeElement;
    if (isNativeArrowUse(active, code, e)) return;

    const els = getFocusableElements(container);
    if (els.length === 0) return;

    let index = els.indexOf(active);
    if (index === -1) {
      els[0].focus();
      return;
    }

    const forward = code === 'ArrowDown' || code === 'ArrowRight';
    index = forward ? Math.min(els.length - 1, index + 1) : Math.max(0, index - 1);
    els[index].focus();
  }

  // Stellt den zuletzt fokussierten Zustand dieser Ansicht wieder her (falls
  // vorhanden) - z.B. wenn man aus einem Untermenü per Backspace zurückkommt,
  // landet der Fokus wieder auf dem Menüpunkt, von dem aus man losgegangen ist.
  async function restoreLastFocus() {
    if (!window.electronAPI || !window.electronAPI.getLastFocusedElement) return;
    try {
      const lastId = await window.electronAPI.getLastFocusedElement();
      if (!lastId) return;
      const el = document.getElementById(lastId);
      if (el && el.offsetParent !== null) {
        el.focus();
      }
    } catch (err) {
      // still ignorieren - Fokus bleibt dann einfach ungesetzt, erste Pfeiltaste
      // initialisiert wie gewohnt auf das erste Element
    }
  }

  // "Enter" (bzw. A-Taste des Controllers) auf dem fokussierten Element. Wird selbst
  // behandelt statt sich auf das native Verhalten zu verlassen - das greift nämlich nur
  // bei echten, vertrauenswürdigen Tastatur-Events, nicht bei den simulierten Events des
  // Controllers. Ausgelöst wird beim Loslassen, und nur auf dem Element, auf dem die
  // Taste gedrückt wurde (verschiebt sich der Fokus dazwischen, passiert nichts).
  function activateElement(el, e) {
    if (el.tagName === 'BUTTON') {
      el.click();
      return;
    }
    if (e.isTrusted) return; // echte Tastatur: Auswahllisten/Kacheln reagieren selbst auf Enter
    if (isSelect(el)) {
      // Controller: nächste Option (springt am Ende wieder zur ersten)
      if (el.options.length > 0) {
        el.selectedIndex = (el.selectedIndex + 1) % el.options.length;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      el.click(); // Schalter/Checkboxen umschalten (löst auch das change-Ereignis aus)
      return;
    }
    if (isTextEditable(el) || el.tagName === 'A') return;
    // Sonstige fokussierbare Elemente (z.B. Kacheln mit eigenem Enter-Handler direkt am
    // Element): das Enter-Ereignis direkt an ihnen auslösen. bubbles:false verhindert,
    // dass es zum Fenster hochläuft und hier erneut verarbeitet wird.
    if (el.tabIndex >= 0) {
      el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', bubbles: false, cancelable: true }));
    }
  }

  function enableControllerActivation() {
    let enterDownEl = null;

    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
      if (isInOnScreenKeyboard(document.activeElement)) return;
      e.preventDefault(); // natives Verhalten unterdrücken, damit nichts doppelt auslöst
      if (!e.repeat) enterDownEl = document.activeElement;
    }, true); // Capture-Phase: Fokus merken, BEVOR ein Handler am Element ihn verschiebt

    window.addEventListener('keyup', (e) => {
      if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
      const active = document.activeElement;
      const downEl = enterDownEl;
      enterDownEl = null;
      if (isInOnScreenKeyboard(active)) return;
      if (!active || active !== downEl) return;
      activateElement(active, e);
    });
  }

  // Aktiviert die lineare Pfeiltasten-Navigation für die ganze Seite.
  function enableLinearNav() {
    window.addEventListener('keydown', (e) => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) return;
      if (isInOnScreenKeyboard(document.activeElement)) return;
      if (!e.isTrusted && isRange(document.activeElement) && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        e.preventDefault();
        stepRange(document.activeElement, e.code === 'ArrowRight' ? 1 : -1);
        return;
      }
      if (isNativeArrowUse(document.activeElement, e.code, e)) return;
      e.preventDefault();
      moveLinearFocus(e.code, undefined, e);
    });

    enableControllerActivation();
    restoreLastFocus();
  }

  // Seitenwechsel mit Ausblenden: Die Seite blendet per CSS (.fade-out) aus, danach wird navigiert.
  const FADE_OUT_MS = 300; // muss zur Dauer der .fade-out-Animation in style.css passen (0.3s)

  function fadeOutThen(navigate) {
    document.body.classList.add('fade-out');
    setTimeout(navigate, FADE_OUT_MS);
  }

  // Verknüpft Menüeinträge mit dem Seitenwechsel: { Element-ID: () => Navigationsaufruf }
  function bindMenuNavigation(targets) {
    Object.entries(targets).forEach(([id, navigate]) => {
      document.getElementById(id).addEventListener('click', () => fadeOutThen(navigate));
    });
  }

  return { isTextEditable, isSelect, isRange, stepRange, isInOnScreenKeyboard, isNativeArrowUse, enableControllerActivation, getFocusableElements, moveLinearFocus, enableLinearNav, restoreLastFocus, fadeOutThen, bindMenuNavigation };
})();
