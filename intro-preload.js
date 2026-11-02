// Preload der Intro-Ansicht: nur die Brücke, mit der sie das Ende meldet (kein Zugriff auf den Rest der App)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('introAPI', {
  done: () => ipcRenderer.send('intro-done')
});
