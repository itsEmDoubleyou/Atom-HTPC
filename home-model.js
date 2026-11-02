// Rechenregeln der Startseite mit Ordnern (reine Funktionen, ohne Oberfläche - deshalb einzeln testbar).
// Die Startseite besteht aus einer Liste von Einträgen: Apps { id, ... } und Ordnern { type: 'folder', id, name, apps: [...] }.
// Jede Funktion bekommt die Liste und liefert eine NEUE Liste (die Eingabe bleibt unverändert) bzw. null, wenn die Aktion nicht
// möglich ist (z.B. Ordner voll). Leere Ordner lösen sich nie "von selbst" auf, sondern werden hier sofort entfernt.
// Wird im Browser als window.HomeModel geladen und in Node (Tests) per require.
(function (root) {
  const MAX_FOLDER_APPS = 9;
  const DEFAULT_FOLDER_NAME = 'Ordner';

  const isFolder = (item) => !!item && item.type === 'folder';

  function clone(items) {
    return items.map((item) => (isFolder(item) ? { ...item, apps: item.apps.slice() } : item));
  }

  // Wo steht die App? { topIndex, folderIndex | -1, folder | null } - topIndex ist der Platz der App bzw. ihres Ordners
  function locate(items, appId) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (isFolder(item)) {
        const j = item.apps.findIndex((a) => a.id === appId);
        if (j !== -1) return { topIndex: i, folderIndex: j, folder: item };
      } else if (item.id === appId) {
        return { topIndex: i, folderIndex: -1, folder: null };
      }
    }
    return null;
  }

  function findFolder(items, folderId) {
    return items.find((item) => isFolder(item) && item.id === folderId) || null;
  }

  function flatten(items) {
    const out = [];
    for (const item of items) {
      if (isFolder(item)) out.push(...item.apps);
      else out.push(item);
    }
    return out;
  }

  // "Ordner", "Ordner 2", "Ordner 3", ... - der erste noch freie Name
  function nextFolderName(items) {
    const taken = new Set(items.filter(isFolder).map((f) => f.name));
    if (!taken.has(DEFAULT_FOLDER_NAME)) return DEFAULT_FOLDER_NAME;
    for (let n = 2; ; n++) {
      const name = `${DEFAULT_FOLDER_NAME} ${n}`;
      if (!taken.has(name)) return name;
    }
  }

  function newFolderId(items) {
    const taken = new Set(items.filter(isFolder).map((f) => f.id));
    let id;
    do { id = 'folder-' + Math.random().toString(36).slice(2, 8); } while (taken.has(id));
    return id;
  }

  // Entfernt leere Ordner
  function dropEmptyFolders(items) {
    return items.filter((item) => !isFolder(item) || item.apps.length > 0);
  }

  // Nimmt die App aus ihrem Platz. Liefert { items, app, topIndex } (topIndex = Platz, an dem sie stand bzw. ihr Ordner stand).
  function take(items, appId) {
    const loc = locate(items, appId);
    if (!loc) return null;
    const out = clone(items);
    let app;
    if (loc.folder) {
      app = out[loc.topIndex].apps.splice(loc.folderIndex, 1)[0];
    } else {
      app = out.splice(loc.topIndex, 1)[0];
    }
    return { items: out, app, topIndex: loc.topIndex, wasInFolder: !!loc.folder };
  }

  // "Neuer Ordner": ein Ordner nur mit dieser App. Er steht dort, wo die App stand (aus einem Ordner heraus: direkt dahinter).
  function moveToNewFolder(items, appId) {
    const t = take(items, appId);
    if (!t) return null;
    const out = t.items;
    const folder = { type: 'folder', id: newFolderId(items), name: nextFolderName(items), apps: [t.app] };
    const at = t.wasInFolder ? t.topIndex + 1 : t.topIndex;
    out.splice(at, 0, folder);
    return { items: dropEmptyFolders(out), folderId: folder.id };
  }

  // In einen vorhandenen Ordner (ans Ende). null: Ordner voll/unbekannt oder die App ist schon dort.
  function moveToFolder(items, appId, folderId) {
    const target = findFolder(items, folderId);
    const loc = locate(items, appId);
    if (!target || !loc) return null;
    if (loc.folder && loc.folder.id === folderId) return null;
    if (target.apps.length >= MAX_FOLDER_APPS) return null;
    const t = take(items, appId);
    const dest = findFolder(t.items, folderId);
    dest.apps.push(t.app);
    return { items: dropEmptyFolders(t.items), folderId };
  }

  // "Aus Ordner entfernen": die App steht danach direkt hinter dem Ordner; war sie die letzte, nimmt sie den Platz des Ordners ein.
  function removeFromFolder(items, appId) {
    const loc = locate(items, appId);
    if (!loc || !loc.folder) return null;
    const t = take(items, appId);
    const out = t.items;
    const folderGone = out[t.topIndex].apps.length === 0;
    if (folderGone) out.splice(t.topIndex, 1, t.app);
    else out.splice(t.topIndex + 1, 0, t.app);
    return { items: out, appId };
  }

  function deleteApp(items, appId) {
    const t = take(items, appId);
    if (!t) return null;
    return { items: dropEmptyFolders(t.items), topIndex: t.topIndex };
  }

  // Eintrag innerhalb einer Liste verschieben: to = Platz in der Liste NACH dem Herausnehmen (0 ... length-1)
  function moveInList(list, from, to) {
    if (from < 0 || from >= list.length) return list.slice();
    const out = list.slice();
    const [moved] = out.splice(from, 1);
    out.splice(Math.max(0, Math.min(to, out.length)), 0, moved);
    return out;
  }

  // Oberste Ebene: Eintrag (App oder Ordner) mit der Id an einen anderen Platz
  function moveTopItem(items, itemId, to) {
    const from = items.findIndex((item) => item.id === itemId);
    if (from === -1) return null;
    return moveInList(items, from, to);
  }

  // Innerhalb eines Ordners
  function moveInFolder(items, folderId, appId, to) {
    const out = clone(items);
    const folder = findFolder(out, folderId);
    if (!folder) return null;
    const from = folder.apps.findIndex((a) => a.id === appId);
    if (from === -1) return null;
    folder.apps = moveInList(folder.apps, from, to);
    return out;
  }

  function renameFolder(items, folderId, name) {
    const out = clone(items);
    const folder = findFolder(out, folderId);
    if (!folder) return null;
    const trimmed = String(name || '').trim().slice(0, 40);
    folder.name = trimmed || folder.name || DEFAULT_FOLDER_NAME;
    return out;
  }

  // Nur Ids (so schickt die Startseite die Anordnung an den Hauptprozess)
  function toLayout(items) {
    return items.map((item) => (isFolder(item) ? { type: 'folder', id: item.id, name: item.name, apps: item.apps.map((a) => a.id) } : item.id));
  }

  const api = {
    MAX_FOLDER_APPS, DEFAULT_FOLDER_NAME, isFolder, locate, findFolder, flatten, nextFolderName,
    moveToNewFolder, moveToFolder, removeFromFolder, deleteApp, moveInList, moveTopItem, moveInFolder, renameFolder, toLayout
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HomeModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
