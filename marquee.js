// Titelzeile mit Laufschrift (gemeinsam für das Player-Fenster und das Schnellmenü des Launchers).
// Aufbau: <div class="…title"><span>Text</span></div>. Passt der Text in die Zeile, steht er mittig. Ist er zu lang, läuft er
// langsam bis zu seinem Ende, wartet kurz, läuft zurück und wartet wieder (hin und her), bis sich der Titel ändert.
(function () {
  var SPEED_PX_PER_S = 28;   // Lauftempo
  var HOLD_MS = 1800;        // Pause am Anfang und am Ende
  var SETTLE_MS = 140;       // nach einer Größenänderung (auch Ein-/Ausklappen) erst neu messen, wenn Ruhe ist

  window.createTitleMarquee = function (box) {
    var text = box.firstElementChild;
    var shown = null;
    var anim = null;
    var timer = 0;

    function stop() {
      if (anim) { anim.cancel(); anim = null; }
      box.classList.remove('scrolling');
    }

    function measure() {
      stop();
      var boxWidth = box.clientWidth;
      var over = Math.ceil(text.offsetWidth - boxWidth);
      if (boxWidth <= 0 || over <= 1) return; // passt (oder ist gerade eingeklappt): nichts zu laufen
      box.classList.add('scrolling');
      var move = (over / SPEED_PX_PER_S) * 1000;
      var total = move * 2 + HOLD_MS * 2;
      var end = 'translateX(' + (-over) + 'px)';
      anim = text.animate([
        { transform: 'translateX(0)', offset: 0 },
        { transform: 'translateX(0)', offset: HOLD_MS / total },
        { transform: end, offset: (HOLD_MS + move) / total },
        { transform: end, offset: (HOLD_MS * 2 + move) / total },
        { transform: 'translateX(0)', offset: 1 }
      ], { duration: total, iterations: Infinity, easing: 'linear' });
    }

    function later() {
      clearTimeout(timer);
      timer = setTimeout(measure, SETTLE_MS);
    }

    if (typeof ResizeObserver === 'function') new ResizeObserver(later).observe(box);

    return {
      set: function (value) {
        var next = value ? String(value) : '';
        if (next === shown) return;
        shown = next;
        text.textContent = next;
        box.classList.toggle('empty', !next);
        stop();
        measure();   // sofort (steht die Zeile schon), sonst holt es der ResizeObserver nach
        later();
      }
    };
  };
})();
