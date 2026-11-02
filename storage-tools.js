// Speicher & Daten: Größen ermitteln und Daten einer Browser-Sitzung (Profil) löschen. Arbeitet auf einer übergebenen Electron-Sitzung,
// kennt also weder Fenster noch Profile (siehe main.js: Seite "Speicher & Daten").
const fs = require('fs');
const path = require('path');

// Zwischenspeicher: lässt sich jederzeit verwerfen, Anmeldungen bleiben dabei erhalten
const CACHE_DIRS = [
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache',
  path.join('Service Worker', 'CacheStorage'), path.join('Service Worker', 'ScriptCache')
];
// Daten der Seiten (Cookies, lokaler Speicher, ...): dazu gehören die Anmeldungen
const DATA_DIRS = ['Local Storage', 'IndexedDB', 'Session Storage', 'File System', 'WebStorage', path.join('Service Worker', 'Database'), 'Network'];

// Speicherarten für clearStorageData
const CACHE_STORAGES = ['shadercache', 'cachestorage'];
const DATA_STORAGES = ['cookies', 'localstorage', 'indexdb', 'websql', 'filesystem', 'serviceworkers', 'cachestorage', 'shadercache'];

// Größe eines Ordners samt Unterordnern in Bytes (fehlende oder gesperrte Dateien zählen 0)
async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += await dirSize(full);
      else if (entry.isFile()) total += (await fs.promises.stat(full)).size;
    } catch (err) { /* Datei verschwand oder ist gesperrt */ }
  }
  return total;
}

async function sumDirs(base, dirs) {
  if (!base) return 0;
  const sizes = await Promise.all(dirs.map((d) => dirSize(path.join(base, d))));
  return sizes.reduce((a, b) => a + b, 0);
}

// { cacheBytes, dataBytes } der Sitzung
async function measure(sess) {
  let base = '';
  try { base = sess.getStoragePath() || ''; } catch (err) { /* Sitzung ohne Ordner (im Speicher) */ }
  const [cacheBytes, dataBytes] = await Promise.all([sumDirs(base, CACHE_DIRS), sumDirs(base, DATA_DIRS)]);
  return { cacheBytes, dataBytes };
}

async function tryStep(label, fn) {
  try {
    await fn();
    return true;
  } catch (err) {
    console.error(`Speicher leeren (${label}) fehlgeschlagen:`, err && err.message);
    return false;
  }
}

// Zwischenspeicher leeren (Webseiten-Cache, Code-Cache, Shader, Cache-Speicher der Seiten). Gibt die freigegebene Größe zurück.
async function clearCache(sess) {
  const before = await measure(sess);
  await tryStep('Cache', () => sess.clearCache());
  if (typeof sess.clearCodeCaches === 'function') await tryStep('Code-Cache', () => sess.clearCodeCaches({}));
  await tryStep('Cache-Speicher', () => sess.clearStorageData({ storages: CACHE_STORAGES }));
  const after = await measure(sess);
  return { ok: true, freedBytes: Math.max(0, before.cacheBytes - after.cacheBytes), cacheBytes: after.cacheBytes };
}

// Alle Daten der Sitzung löschen: Cookies, Anmeldungen, lokaler Speicher, Cache
async function clearAll(sess) {
  const okData = await tryStep('Daten', () => sess.clearStorageData({ storages: DATA_STORAGES }));
  await tryStep('Cache', () => sess.clearCache());
  if (typeof sess.clearCodeCaches === 'function') await tryStep('Code-Cache', () => sess.clearCodeCaches({}));
  await tryStep('Cookies sichern', () => sess.cookies.flushStore());
  return { ok: okData };
}

// Registrierbare Domain (grob): beispiel.de, bei Namen wie beispiel.co.uk drei Teile
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);
function baseDomain(host) {
  const lower = String(host || '').toLowerCase();
  if (/^\d+(\.\d+){3}$/.test(lower) || lower.includes(':')) return lower; // IP-Adresse: keine Domain
  const labels = lower.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  return labels.slice(-(tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2)).join('.');
}

// Eine App zurücksetzen: Cookies der Website (samt Cookies der übergeordneten und benachbarten Subdomains wie .netflix.com),
// lokaler Speicher und Cache-Speicher ihrer Adresse. Alle anderen Apps bleiben angemeldet.
async function resetSite(sess, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    return { ok: false, error: 'url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: 'url' };
  const host = parsed.hostname.toLowerCase();
  const base = baseDomain(host);

  let removed = 0;
  await tryStep('Cookies', async () => {
    const cookies = await sess.cookies.get({});
    for (const c of cookies) {
      const domain = String(c.domain || '').replace(/^\./, '').toLowerCase();
      if (!domain) continue;
      const related = domain === host || host.endsWith('.' + domain) || domain === base || domain.endsWith('.' + base);
      if (!related) continue;
      const scheme = c.secure ? 'https' : 'http';
      await sess.cookies.remove(`${scheme}://${domain}${c.path || '/'}`, c.name);
      removed += 1;
    }
    await sess.cookies.flushStore();
  });
  await tryStep('Seitendaten', () => sess.clearStorageData({ origin: parsed.origin, storages: ['localstorage', 'indexdb', 'websql', 'filesystem', 'serviceworkers', 'cachestorage'] }));
  return { ok: true, removedCookies: removed };
}

module.exports = { measure, clearCache, clearAll, resetSite, baseDomain, dirSize, CACHE_DIRS, DATA_DIRS };
