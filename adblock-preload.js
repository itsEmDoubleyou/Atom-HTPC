// Preload des Adblockers: holt die uBlock-Skripte (Scriptlets) für diese Seite SYNCHRON vom Hauptprozess und setzt sie
// sofort ein - noch vor dem ersten Skript der Seite. Die Bibliothek selbst führt sie erst nachträglich aus (nach dem
// Start der Seite), dann ist es für Seiten wie YouTube zu spät: sie lesen ihre Werbedaten im allerersten Skript.
// Läuft nur in http(s)-Seiten, nicht in den eigenen Seiten des Launchers (file:).
const { ipcRenderer, webFrame } = require('electron');

if (location.protocol === 'http:' || location.protocol === 'https:') {
  try {
    const scripts = ipcRenderer.sendSync('adblock-early-scripts', location.href);
    for (const code of Array.isArray(scripts) ? scripts : []) {
      try {
        webFrame.executeJavaScript(code).catch(() => {});
      } catch (err) {
        // ein einzelnes Skript, das sich nicht ausführen lässt, darf die anderen nicht verhindern
      }
    }
  } catch (err) {
    // Hauptprozess antwortet nicht: Seite normal laden
  }
}
