// Preload des Musikplayer-Fensters: nur die Brücken, die der Player braucht (kein Zugriff auf den Rest der App)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mediaPlayerAPI', {
  onState: (callback) => ipcRenderer.on('media-player-state', (event, state) => callback(state)),
  ready: () => ipcRenderer.send('media-player-ready'),
  // action: 'toggle' | 'prev' | 'next' | 'seek' (value = Sekunden)
  control: (action, value) => ipcRenderer.send('media-player-control', { action, value }),
  close: () => ipcRenderer.send('media-player-close'),
  // Bild im Player einblenden (true) oder ausblenden (false): Video-Bilder bzw. Titelbild
  setPicture: (on) => ipcRenderer.send('media-player-set-picture', !!on),
  // Größe des Players: 1, 2 oder 3 (Vielfaches der Standardbreite)
  setScale: (n) => ipcRenderer.send('media-player-set-scale', Number(n)),
  // Live-Video: Angebot der App-Seite (SDP) kommt herein, die Antwort geht zurück; 'stop' baut ab; 'failed' = es kommt kein brauchbares Bild an
  onRtcOffer: (callback) => ipcRenderer.on('media-player-rtc-offer', (event, data) => callback(data)),
  onRtcStop: (callback) => ipcRenderer.on('media-player-rtc-stop', () => callback()),
  rtcAnswer: (sdp) => ipcRenderer.send('media-player-rtc-answer', String(sdp)),
  rtcFailed: () => ipcRenderer.send('media-player-rtc-failed'),
  // Controller: { action: 'up' | 'down' | 'left' | 'right' | 'activate', repeat }
  onNav: (callback) => ipcRenderer.on('media-player-nav', (event, nav) => callback(nav)),
  // Verschieben ('move') und Größe ändern (Kante/Ecke: n, s, e, w, ne, nw, se, sw): der Hauptprozess liest die
  // Mausposition selbst, hier wird nur Anfang, Bewegung und Ende gemeldet
  dragStart: (mode) => ipcRenderer.send('media-player-drag-start', mode),
  dragMove: () => ipcRenderer.send('media-player-drag-move'),
  dragEnd: () => ipcRenderer.send('media-player-drag-end')
});
