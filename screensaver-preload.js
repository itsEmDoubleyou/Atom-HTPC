// Preload der Bildschirmschoner-Ansicht: nur die Brücken zum Beenden, zum Holen der Bilder und zum Holen eines Film-Logos
// (kein Zugriff auf den Rest der App)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screensaverAPI', {
  exit: () => ipcRenderer.send('screensaver-exit'),
  padUsed: () => ipcRenderer.send('pad-used'), // Controller benutzt: Mauszeiger (Pfeil) überall aus (pointer-hider.js)
  getImages: () => ipcRenderer.invoke('screensaver-images'),
  getLogo: (id) => ipcRenderer.invoke('screensaver-logo', id)
});
