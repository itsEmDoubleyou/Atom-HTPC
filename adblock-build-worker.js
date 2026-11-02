// Läuft in einem eigenen Thread: baut aus den Listentexten die Filter-Engine und serialisiert sie.
// Das Parsen dauert 1-2 Sekunden - im Hauptprozess würde der Launcher dabei ruckeln.
const { parentPort, workerData } = require('worker_threads');
const { FiltersEngine } = require('@ghostery/adblocker');

try {
  const engine = FiltersEngine.parse(workerData.text, {});
  engine.updateResources(workerData.resourcesText, '' + workerData.resourcesText.length);
  const filters = engine.getFilters();
  const serialized = engine.serialize();
  parentPort.postMessage({ ok: true, buffer: Buffer.from(serialized), networkFilters: filters.networkFilters.length, cosmeticFilters: filters.cosmeticFilters.length });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });
}
