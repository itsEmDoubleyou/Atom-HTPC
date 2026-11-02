// Profile: jede Person hat ihr eigenes Dock (Apps und Anordnung), ihren Hintergrund, Bildschirmschoner, Uhr, Tabs und die
// Position des Musikplayers - und eigene Anmeldungen in den Web-Apps (eigene Sitzung je Profil).
// Gespeichert wird im Datenordner:
//   profiles.json                 Liste der Profile, das aktive Profil, Startverhalten
//   profiles/<id>/*.json          die Einstellungsdateien des Profils (apps.json, background-settings.json, ...)
// Gemeinsam für alle Profile bleiben Adblocker, Tastatur, Controller, Intro und der TMDb-Key (liegen weiter im Datenordner selbst).
// Dieses Modul kennt kein Electron: der Datenordner kommt als Parameter (testbar).
const fs = require('fs');
const path = require('path');

const MAX_PROFILES = 5;
const NAME_MAX = 16;
const COLORS = ['#e5484d', '#f5a524', '#30a46c', '#0091ff', '#8e4ec6', '#e93d82', '#12a594', '#8b8d98'];
const STARTUP_MODES = ['last', 'choose']; // zuletzt benutztes Profil direkt starten / Profilauswahl zeigen

// Diese Dateien gehören zu einem Profil (beim ersten Start mit Profilen werden die bisherigen hierher kopiert)
const PROFILE_FILES = [
  'apps.json',
  'background-settings.json',
  'clock-settings.json',
  'tabs-settings.json',
  'screensaver-settings.json',
  'media-player-settings.json'
];

function cleanName(value, fallback) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '';
  return text || fallback;
}

function cleanColor(value, fallback) {
  return COLORS.includes(value) ? value : fallback;
}

function createProfileStore({ userDataPath, fsImpl = fs }) {
  const stateFile = path.join(userDataPath, 'profiles.json');
  const profilesRoot = path.join(userDataPath, 'profiles');
  let state = null;

  function dirFor(id) {
    return path.join(profilesRoot, id);
  }

  function writeState() {
    fsImpl.mkdirSync(userDataPath, { recursive: true });
    const tmp = stateFile + '.tmp';
    fsImpl.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fsImpl.renameSync(tmp, stateFile); // ganz oder gar nicht: eine halb geschriebene Datei gibt es nicht
  }

  // Bereinigt gelesene Daten: gültige Profile (höchstens MAX_PROFILES), aktives Profil vorhanden, Startverhalten gültig
  function normalize(raw) {
    const list = [];
    const seen = new Set();
    for (const p of (raw && Array.isArray(raw.profiles) ? raw.profiles : [])) {
      if (!p || typeof p.id !== 'string' || !/^p\d+$/.test(p.id) || seen.has(p.id)) continue;
      seen.add(p.id);
      const profile = { id: p.id, name: cleanName(p.name, 'Profil'), color: cleanColor(p.color, COLORS[list.length % COLORS.length]) };
      if (p.legacySession === true) profile.legacySession = true;
      list.push(profile);
      if (list.length >= MAX_PROFILES) break;
    }
    if (!list.length) return null;
    const maxNum = list.reduce((m, p) => Math.max(m, parseInt(p.id.slice(1), 10)), 0);
    return {
      version: 1,
      profiles: list,
      activeId: list.some((p) => p.id === (raw && raw.activeId)) ? raw.activeId : list[0].id,
      startupMode: STARTUP_MODES.includes(raw && raw.startupMode) ? raw.startupMode : 'last',
      nextId: Math.max(Number.isInteger(raw && raw.nextId) ? raw.nextId : 0, maxNum + 1) // eine Kennung wird nie ein zweites Mal vergeben
    };
  }

  // Erster Start mit Profilen: aus den bisherigen Dateien wird "Profil 1". Die bisherigen Dateien bleiben unangetastet liegen
  // (Rückfall, falls jemand zu einer älteren Version zurückgeht). Das erste Profil behält die bisherige Sitzung der Web-Apps,
  // damit alle Anmeldungen bestehen bleiben.
  function migrate() {
    const id = 'p1';
    fsImpl.mkdirSync(dirFor(id), { recursive: true });
    for (const name of PROFILE_FILES) {
      const from = path.join(userDataPath, name);
      const to = path.join(dirFor(id), name);
      try {
        if (fsImpl.existsSync(from) && !fsImpl.existsSync(to)) fsImpl.copyFileSync(from, to);
      } catch (err) {
        console.error(`Profil 1: ${name} konnte nicht übernommen werden:`, err);
      }
    }
    return { version: 1, profiles: [{ id, name: 'Profil 1', color: COLORS[0], legacySession: true }], activeId: id, startupMode: 'last', nextId: 2 };
  }

  function load() {
    let parsed = null;
    try {
      if (fsImpl.existsSync(stateFile)) parsed = normalize(JSON.parse(fsImpl.readFileSync(stateFile, 'utf-8')));
    } catch (err) {
      console.error('profiles.json konnte nicht gelesen werden:', err);
    }
    if (!parsed) {
      // keine oder kaputte Datei: Profile aus den vorhandenen Ordnern wiederherstellen, sonst aus den bisherigen Dateien übernehmen
      let existing = [];
      try { existing = fsImpl.existsSync(profilesRoot) ? fsImpl.readdirSync(profilesRoot).filter((n) => /^p\d+$/.test(n)).sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10)) : []; } catch (err) { existing = []; }
      if (existing.length) {
        parsed = normalize({ profiles: existing.slice(0, MAX_PROFILES).map((id, i) => ({ id, name: `Profil ${i + 1}`, legacySession: id === 'p1' })), activeId: existing[0] });
      } else {
        parsed = migrate();
      }
    }
    state = parsed;
    fsImpl.mkdirSync(dirFor(state.activeId), { recursive: true });
    writeState();
  }

  load();

  const find = (id) => state.profiles.find((p) => p.id === id) || null;
  const copyOf = (p) => ({ ...p });

  return {
    MAX_PROFILES,
    NAME_MAX,
    COLORS,
    // Zustand für die Oberfläche
    getState() {
      return { profiles: state.profiles.map(copyOf), activeId: state.activeId, startupMode: state.startupMode, max: MAX_PROFILES };
    },
    get: (id) => (find(id) ? copyOf(find(id)) : null),
    activeId: () => state.activeId,
    active: () => copyOf(find(state.activeId)),
    // Ordner des aktiven Profils (wird bei Bedarf angelegt)
    activeDir() {
      const dir = dirFor(state.activeId);
      if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });
      return dir;
    },
    dirFor,
    // Name der Sitzung für die Web-Apps: null = die bisherige Standardsitzung (nur das erste, übernommene Profil)
    partitionFor(id) {
      const p = find(id);
      if (!p || p.legacySession) return null;
      return `persist:profile-${p.id}`;
    },
    activePartition() {
      return this.partitionFor(state.activeId);
    },
    setActive(id) {
      if (!find(id)) return false;
      state.activeId = id;
      fsImpl.mkdirSync(dirFor(id), { recursive: true });
      writeState();
      return true;
    },
    // Neues Profil mit Standardwerten (die Dateien legt der Einstellungsspeicher beim ersten Lesen an)
    create(name) {
      if (state.profiles.length >= MAX_PROFILES) return null;
      const id = `p${state.nextId}`;
      state.nextId += 1;
      const used = new Set(state.profiles.map((p) => p.color));
      const color = COLORS.find((c) => !used.has(c)) || COLORS[state.profiles.length % COLORS.length];
      const profile = { id, name: cleanName(name, `Profil ${state.profiles.length + 1}`), color };
      state.profiles.push(profile);
      fsImpl.mkdirSync(dirFor(id), { recursive: true });
      writeState();
      return copyOf(profile);
    },
    update(id, { name, color } = {}) {
      const p = find(id);
      if (!p) return null;
      if (name !== undefined) p.name = cleanName(name, p.name);
      if (color !== undefined) p.color = cleanColor(color, p.color);
      writeState();
      return copyOf(p);
    },
    // Löscht ein Profil samt seiner Dateien. Das aktive Profil und das letzte verbleibende lassen sich nicht löschen.
    remove(id) {
      const p = find(id);
      if (!p) return { ok: false, error: 'unknown' };
      if (state.profiles.length <= 1) return { ok: false, error: 'last' };
      if (state.activeId === id) return { ok: false, error: 'active' };
      const partition = this.partitionFor(id);
      state.profiles = state.profiles.filter((x) => x.id !== id);
      writeState();
      try { fsImpl.rmSync(dirFor(id), { recursive: true, force: true }); } catch (err) { console.error('Profilordner konnte nicht gelöscht werden:', err); }
      return { ok: true, partition, legacySession: !!p.legacySession };
    },
    setStartupMode(mode) {
      if (!STARTUP_MODES.includes(mode)) return false;
      state.startupMode = mode;
      writeState();
      return true;
    },
    startupMode: () => state.startupMode
  };
}

module.exports = { createProfileStore, MAX_PROFILES, NAME_MAX, COLORS, PROFILE_FILES, STARTUP_MODES };
