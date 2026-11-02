// Startseite: Ordner, App-Menü (langes Enter), Verschieben-Modus.
// Läuft NACH script.js und nutzt dessen Variablen und Funktionen (homeItems, focusRowItem, createIconTile, ...). Die reinen Rechenregeln
// (Ordner anlegen, verschieben, auflösen) stehen in home-model.js.
//
// Bedienung (Tastatur, Controller und Handy geben dieselben Tasten):
//   Enter lang halten auf einer App / einem Ordner   App-Menü (Karte links oder rechts neben der Kachel)
//   Hoch/Runter wählt, Rechts öffnet das Untermenü "Bewegen ...", Links / Zurück geht eine Ebene zurück, Enter führt aus
//   "Home-Bildschirm bearbeiten" = Verschieben-Modus: Pfeile bewegen die Einfüge-Marke, Enter setzt ab, Zurück bricht ab
//   Ordner öffnen: Enter; im Ordner Pfeile zwischen den Apps, Hoch aus der ersten Reihe = Ordnername (Enter = umbenennen), Zurück schließt

(function () {
  const HM = window.HomeModel;
  const folderLayer = document.getElementById('folder-layer');
  const folderBackdrop = document.getElementById('folder-backdrop');
  const folderPanel = document.getElementById('folder-panel');
  const folderContent = document.getElementById('folder-content');
  const folderTitle = document.getElementById('folder-title');
  const folderGrid = document.getElementById('folder-grid');
  const appMenuLayer = document.getElementById('app-menu-layer');
  const moveBar = document.getElementById('move-bar');
  const folderMoveBar = document.createElement('div');
  folderMoveBar.className = 'move-bar';
  folderMoveBar.hidden = true;

  const FOLDER_COLS = 3;
  const FOLDER_ANIM_MS = 450;     // muss zur Transition von .folder-panel passen
  const HOME_COLS = MAX_DOCK_APPS; // 6 Kacheln je Zeile (Dock und Grid)

  let appMenu = null;     // offenes App-Menü (siehe openAppMenu)
  let moveState = null;   // Verschieben-Modus: { scope: 'top' | Ordner-Id, itemId, from, target }
  let folderState = null; // geöffneter Ordner: { folderId, buttons, index, titleActive, closing, openTimer }
  const modalEnter = { armed: false, long: false, timer: null };

  // ---------- Hilfen ----------

  window.homeModalActive = () => !!(appMenu || moveState || folderState);
  // Maus-Hover ändert den Fokus nicht, solange ein Menü / der Verschieben-Modus offen ist; in einem offenen Ordner nur dort
  window.homeModalBlocksHover = (inFolder) => !!(appMenu || moveState || (folderState && !inFolder) || (folderState && folderState.closing));

  function setModalClasses() {
    document.body.classList.toggle('app-menu-open', !!appMenu);
    document.body.classList.toggle('home-moving', !!moveState);
    document.body.classList.toggle('folder-open', !!folderState);
  }

  function itemName(item) {
    return item && (item.type === 'folder' ? item.name : (item.name || item.id));
  }

  function homeButtonFor(id) {
    for (const row of getAllRows()) {
      const found = row.find((b) => b.dataset.appId === id || b.dataset.folderId === id);
      if (found) return found;
    }
    return null;
  }

  function persist() {
    try {
      const result = window.electronAPI.saveHomeItems(HM.toLayout(homeItems));
      if (result && result.catch) result.catch(() => {});
    } catch (err) { /* wird beim nächsten Speichern erneut versucht */ }
  }

  // Höhen neu berechnen, nachdem sich die Zahl der Zeilen geändert hat (ohne die Öffnen-Animation neu abzuspielen)
  function refreshHomeLayout() {
    const dockHeight = dock.offsetHeight;
    appsViewport.classList.toggle('no-extra-apps', !hasExtraApps);
    if (!hasExtraApps) {
      collapsedHeight = TOP_BUFFER + dockHeight + BOTTOM_BUFFER;
      expandedHeight = collapsedHeight;
      showingAllApps = false;
      appsViewport.classList.remove('expanded');
      document.body.classList.remove('grid-expanded');
      appsViewport.style.height = `${collapsedHeight}px`;
      return;
    }
    collapsedHeight = TOP_BUFFER + dockHeight + STACK_GAP + PEEK_INTO_GRID;
    expandedHeight = window.innerHeight - EXPANDED_TOP_MARGIN_CM * CM_TO_PX - EXPANDED_BOTTOM_MARGIN_CM * CM_TO_PX;
    appsViewport.style.height = `${showingAllApps ? expandedHeight : collapsedHeight}px`;
  }

  // Fokus auf den Eintrag (App oder Ordner) mit dieser Id; klappt das Grid bei Bedarf aus bzw. wieder ein
  function focusHomeItem(id) {
    const rows = getAllRows();
    for (let r = 0; r < rows.length; r++) {
      const c = rows[r].findIndex((b) => b.dataset.appId === id || b.dataset.folderId === id);
      if (c === -1) continue;
      if (r > 0 && !showingAllApps) {
        showExtraApps();
        setTimeout(() => { if (!homeModalActive()) focusRowItem(r, c); }, EXPAND_TRANSITION_MS);
        focusZone = 'row'; focusRowIndex = r; focusColIndex = c;
      } else {
        if (r === 0 && showingAllApps) hideExtraApps(); // zuerst: der Hintergrundwechsel wartet, bis das Grid zu ist
        focusRowItem(r, c);
      }
      return true;
    }
    return false;
  }

  // Neue Anordnung übernehmen: speichern, neu zeichnen, Fokus setzen.
  // opts: focusId (Eintrag, der danach den Fokus bekommt), folderFocusAppId (App im offenen Ordner), closeFolder
  function applyHomeItems(newItems, opts = {}) {
    homeItems = newItems;
    persist();
    renderHomeTiles();
    refreshHomeLayout();
    const fs = folderState;
    if (fs && !fs.closing) {
      const folder = HM.findFolder(homeItems, fs.folderId);
      const folderTile = homeButtonFor(fs.folderId);
      if (folderTile) folderTile.parentElement.classList.add('folder-opened');
      if (!folder || opts.closeFolder) {
        closeFolder({ fade: !folder, focusId: opts.focusId });
        return;
      }
      renderFolderGrid(opts.folderFocusAppId);
      return;
    }
    if (opts.focusId) focusHomeItem(opts.focusId);
    else focusRowItem(Math.min(focusRowIndex, getAllRows().length - 1), focusColIndex);
  }

  // ---------- Ordner-Kachel ----------

  window.createFolderTile = function createFolderTile(folder, { rowIndex, colIndex }) {
    const iconDiv = document.createElement('div');
    iconDiv.className = 'icon folder-tile';
    const button = document.createElement('button');
    button.tabIndex = -1;
    button.dataset.folderId = folder.id;
    button.dataset.appIds = folder.apps.map((a) => a.id).join(',');
    button.title = folder.name;
    button.setAttribute('aria-label', `Ordner ${folder.name}`);
    const preview = document.createElement('div');
    preview.className = 'folder-preview';
    folder.apps.slice(0, 6).forEach((app) => {
      const cell = document.createElement('span');
      cell.className = 'fp-cell';
      const img = document.createElement('img');
      img.src = app.icon;
      img.alt = '';
      cell.appendChild(img);
      preview.appendChild(cell);
    });
    button.appendChild(preview);
    button.addEventListener('click', () => { if (!homeClickBlocked(button)) openFolder(folder.id); });
    iconDiv.addEventListener('contextmenu', (e) => { e.preventDefault(); openAppMenuForButton(button); });
    iconDiv.addEventListener('mouseenter', () => {
      if (menuOpen || ssActive || homeModalBlocksHover(false)) return;
      focusZone = 'row';
      focusRowIndex = rowIndex;
      focusColIndex = colIndex;
      button.focus({ preventScroll: true });
    });
    iconDiv.appendChild(button);
    return iconDiv;
  };

  window.homeClickBlocked = (button) => {
    if (appMenu || moveState) return true;
    if (folderState) return folderState.closing || !button.closest('#folder-grid');
    return false;
  };

  // ---------- Geöffneter Ordner ----------

  function folderOf(id) {
    return HM.findFolder(homeItems, id);
  }

  function renderFolderGrid(focusAppId) {
    const fs = folderState;
    const folder = fs && folderOf(fs.folderId);
    if (!folder) return;
    const keepIndex = fs.index || 0;
    folderGrid.innerHTML = '';
    fs.buttons = [];
    folder.apps.forEach((app, i) => {
      const tile = createIconTile(app, {
        withBgPreview: true,
        rowIndex: -1,
        colIndex: i,
        onHover: () => { fs.index = i; fs.titleActive = false; tile.querySelector('button').focus({ preventScroll: true }); }
      });
      folderGrid.appendChild(tile);
      fs.buttons.push(tile.querySelector('button'));
    });
    folderGrid.appendChild(folderMoveBar);
    folderMoveBar.hidden = true;
    folderGrid.style.setProperty('--folder-rows', String(Math.max(1, Math.ceil(folder.apps.length / FOLDER_COLS))));
    let index = keepIndex;
    if (focusAppId) {
      const found = folder.apps.findIndex((a) => a.id === focusAppId);
      if (found !== -1) index = found;
    }
    index = Math.max(0, Math.min(index, folder.apps.length - 1));
    if (!fs.titleActive) focusFolderIndex(index);
    else fs.index = index;
    if (folderTitle.value !== folder.name && !fs.titleActive) folderTitle.value = folder.name;
  }

  function focusFolderIndex(i) {
    const fs = folderState;
    if (!fs || !fs.buttons.length) return;
    fs.index = Math.max(0, Math.min(i, fs.buttons.length - 1));
    fs.titleActive = false;
    fs.buttons[fs.index].focus({ preventScroll: true });
  }

  window.openFolder = function openFolder(folderId, { instant = false, focusAppId = null } = {}) {
    if (folderState) return;
    const folder = folderOf(folderId);
    if (!folder) return;
    const tileButton = homeButtonFor(folderId);
    const tile = tileButton && tileButton.parentElement;
    hideTopshelfPreview();
    folderState = { folderId, buttons: [], index: 0, titleActive: false, closing: false, openTimer: null };
    setModalClasses();
    folderLayer.hidden = false;
    folderTitle.value = folder.name;
    renderFolderGrid(focusAppId);

    const first = tile ? tile.getBoundingClientRect() : null;
    const last = folderPanel.getBoundingClientRect();
    if (tile) tile.classList.add('folder-opened');
    if (instant || !first || !last.width) {
      folderLayer.classList.add('shown');
      return;
    }
    // FLIP: das Feld startet in der Größe/Lage der Kachel und wächst in die Mitte
    folderLayer.classList.add('animating');
    folderPanel.style.transition = 'none';
    folderPanel.style.transformOrigin = '0 0';
    folderPanel.style.transform = `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / last.width}, ${first.height / last.height})`;
    void folderPanel.offsetWidth;
    folderPanel.style.transition = '';
    folderPanel.style.transform = 'translate(0px, 0px) scale(1, 1)';
    folderLayer.classList.add('shown');
    folderState.openTimer = setTimeout(() => {
      folderLayer.classList.remove('animating');
      folderPanel.style.transform = '';
      folderPanel.style.transformOrigin = '';
    }, FOLDER_ANIM_MS);
  };

  function commitFolderTitle() {
    const fs = folderState;
    if (!fs) return;
    const folder = folderOf(fs.folderId);
    if (!folder) return;
    const name = folderTitle.value.trim();
    if (!name) { folderTitle.value = folder.name; return; }
    if (name === folder.name) return;
    const renamed = HM.renameFolder(homeItems, fs.folderId, name);
    if (renamed) {
      homeItems = renamed;
      persist();
      const tileButton = homeButtonFor(fs.folderId);
      if (tileButton) { tileButton.title = name; tileButton.setAttribute('aria-label', `Ordner ${name}`); }
    }
  }

  function leaveTitle() {
    const fs = folderState;
    if (!fs) return;
    commitFolderTitle();
    fs.titleActive = false;
    folderTitle.blur();
    focusFolderIndex(fs.index);
  }

  function focusTitle() {
    const fs = folderState;
    if (!fs) return;
    fs.titleActive = true;
    folderTitle.focus({ preventScroll: true });
    try { folderTitle.setSelectionRange(folderTitle.value.length, folderTitle.value.length); } catch (err) { /* egal */ }
  }

  folderTitle.addEventListener('focus', () => { if (folderState) folderState.titleActive = true; });
  folderBackdrop.addEventListener('mousedown', (e) => { e.preventDefault(); if (folderState && !appMenu && !moveState) closeFolder(); });

  // opts: instant (ohne Animation), fade (Ordner gibt es nicht mehr: nur ausblenden), focusId (Fokus danach)
  window.closeFolder = function closeFolderImpl(opts = {}) {
    const fs = folderState;
    if (!fs || fs.closing) return;
    if (!opts.fade) commitFolderTitle();
    fs.closing = true;
    clearTimeout(fs.openTimer);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const tileButton = homeButtonFor(fs.folderId);
    const tile = tileButton && tileButton.parentElement;
    const finish = () => {
      folderLayer.hidden = true;
      folderLayer.classList.remove('shown', 'animating', 'closing', 'fading');
      folderPanel.style.transition = '';
      folderPanel.style.transform = '';
      folderPanel.style.transformOrigin = '';
      folderGrid.innerHTML = '';
      const left = homeButtonFor(fs.folderId);
      if (left) left.parentElement.classList.remove('folder-opened');
      folderState = null;
      setModalClasses();
      focusHomeItem(opts.focusId || fs.folderId) || focusRowItem(0, 0);
    };
    if (opts.instant || opts.fade || !tile) {
      if (opts.instant) { finish(); return; }
      folderLayer.classList.add('fading');
      fs.openTimer = setTimeout(finish, 220);
      return;
    }
    const first = tile.getBoundingClientRect();
    const last = folderPanel.getBoundingClientRect();
    folderLayer.classList.add('animating', 'closing');
    folderPanel.style.transformOrigin = '0 0';
    folderPanel.style.transition = '';
    folderPanel.style.transform = `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / last.width}, ${first.height / last.height})`;
    fs.openTimer = setTimeout(finish, FOLDER_ANIM_MS - 20);
  };

  // ---------- App-Menü ----------

  const MINUS_ICON = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9.2"/><line x1="7.6" y1="12" x2="16.4" y2="12"/></svg>';
  const CHEVRON_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9,5 16,12 9,19"/></svg>';

  // Wer ist die Kachel? App (evtl. in einem geöffneten Ordner) oder Ordner
  function describeButton(button) {
    if (!button) return null;
    const inFolder = !!button.closest('#folder-grid');
    if (button.dataset.folderId && !inFolder) {
      const folder = folderOf(button.dataset.folderId);
      return folder ? { kind: 'folder', id: folder.id, name: folder.name, button, inFolderId: null } : null;
    }
    const id = button.dataset.appId;
    const loc = id && HM.locate(homeItems, id);
    if (!loc) return null;
    const app = loc.folder ? loc.folder.apps[loc.folderIndex] : homeItems[loc.topIndex];
    return { kind: 'app', id, name: itemName(app), button, inFolderId: loc.folder ? loc.folder.id : null };
  }

  function focusedButton() {
    if (folderState) return folderState.closing || folderState.titleActive ? null : folderState.buttons[folderState.index];
    if (topshelfCardsActive) return null;
    const row = getAllRows()[focusRowIndex];
    return row ? row[focusColIndex] : null;
  }

  window.openAppMenuForFocus = function openAppMenuForFocus() {
    if (menuOpen || ssActive || appMenu || moveState) return false;
    return openAppMenu(describeButton(focusedButton()));
  };

  window.openAppMenuForButton = function openAppMenuForButton(button) {
    if (menuOpen || ssActive || appMenu || moveState) return false;
    if (folderState && (folderState.closing || !button.closest('#folder-grid'))) return false;
    if (!folderState) {
      const rows = getAllRows();
      for (let r = 0; r < rows.length; r++) {
        const c = rows[r].indexOf(button);
        if (c !== -1) { focusZone = 'row'; focusRowIndex = r; focusColIndex = c; }
      }
    } else {
      const i = folderState.buttons.indexOf(button);
      if (i !== -1) folderState.index = i;
    }
    button.focus({ preventScroll: true });
    return openAppMenu(describeButton(button));
  };

  function mainRows(ctx) {
    if (ctx.kind === 'folder') return [{ id: 'edit', label: 'Verschieben' }];
    return [
      { id: 'edit', label: 'Home-Bildschirm bearbeiten' },
      { id: 'move', label: 'Bewegen …', chevron: true },
      { id: 'delete', label: 'App löschen', danger: true, icon: MINUS_ICON }
    ];
  }

  function moveRows(ctx) {
    const loc = HM.locate(homeItems, ctx.id);
    const rows = [{ id: 'newFolder', label: 'Neuer Ordner', disabled: !!(loc.folder && loc.folder.apps.length === 1) }];
    for (const item of homeItems) {
      if (!HM.isFolder(item) || (loc.folder && loc.folder.id === item.id)) continue;
      const full = item.apps.length >= HM.MAX_FOLDER_APPS;
      rows.push({ id: 'toFolder', folderId: item.id, label: item.name, disabled: full, hint: full ? 'voll' : '' });
    }
    if (loc.folder) rows.push({ id: 'out', label: 'Aus Ordner entfernen' });
    return rows;
  }

  function confirmRows(ctx) {
    return [
      { id: 'confirmDelete', label: 'Löschen', danger: true },
      { id: 'cancel', label: 'Abbrechen' }
    ];
  }

  function firstEnabled(rows, from = 0, step = 1) {
    for (let i = from; i >= 0 && i < rows.length; i += step) if (!rows[i].disabled) return i;
    return -1;
  }

  function openAppMenu(ctx) {
    if (!ctx) return false;
    hideTopshelfPreview();
    const rect = ctx.button.parentElement.getBoundingClientRect();
    const side = rect.left + rect.width / 2 > window.innerWidth / 2 ? 'left' : 'right';
    const rows = mainRows(ctx);
    appMenu = { ctx, side, anchor: rect, level: 0, cards: [], levels: [{ rows, index: 0, title: '' }] };
    appMenuLayer.hidden = false;
    setModalClasses();
    buildCard(0);
    return true;
  }

  function closeAppMenu() {
    if (!appMenu) return;
    appMenu = null;
    appMenuLayer.hidden = true;
    appMenuLayer.textContent = '';
    setModalClasses();
  }

  // Karte für die Ebene (0 = Hauptmenü, 1 = Untermenü/Bestätigung) bauen und neben der Kachel bzw. neben der Hauptkarte anordnen
  function buildCard(level) {
    const m = appMenu;
    const data = m.levels[level];
    if (m.cards[level]) m.cards[level].remove();
    const card = document.createElement('div');
    card.className = 'am-card';
    card.dataset.level = String(level);
    if (data.title) {
      const title = document.createElement('div');
      title.className = 'am-title';
      title.textContent = data.title;
      card.appendChild(title);
    }
    data.rows.forEach((row, i) => {
      const el = document.createElement('div');
      el.className = 'am-row' + (row.danger ? ' danger' : '') + (row.disabled ? ' disabled' : '');
      const label = document.createElement('span');
      label.className = 'am-label';
      label.textContent = row.label;
      el.appendChild(label);
      if (row.hint) {
        const hint = document.createElement('span');
        hint.className = 'am-hint';
        hint.textContent = row.hint;
        el.appendChild(hint);
      }
      if (row.icon || row.chevron) {
        const icon = document.createElement('span');
        icon.className = 'am-icon';
        icon.innerHTML = row.icon || CHEVRON_ICON;
        el.appendChild(icon);
      }
      el.addEventListener('mouseenter', () => { if (!row.disabled && appMenu && appMenu.level === level) { data.index = i; paintMenu(); } });
      el.addEventListener('click', (e) => { e.stopPropagation(); if (!row.disabled && appMenu) { appMenu.level = level; data.index = i; paintMenu(); activateMenuRow(); } });
      card.appendChild(el);
    });
    appMenuLayer.appendChild(card);
    m.cards[level] = card;
    placeCard(level);
    paintMenu();
  }

  function placeCard(level) {
    const m = appMenu;
    const card = m.cards[level];
    const gap = 18;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    let left;
    let top;
    if (level === 0) {
      left = m.side === 'right' ? m.anchor.right + gap : m.anchor.left - gap - w;
      top = m.anchor.top;
    } else {
      const main = m.cards[0].getBoundingClientRect();
      left = m.side === 'right' ? main.right + gap : main.left - gap - w;
      const rowEl = m.cards[0].children[m.levels[0].index];
      top = rowEl ? rowEl.getBoundingClientRect().top - 10 : main.top;
    }
    left = Math.max(16, Math.min(left, window.innerWidth - w - 16));
    top = Math.max(16, Math.min(top, window.innerHeight - h - 16));
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  function paintMenu() {
    const m = appMenu;
    if (!m) return;
    m.cards.forEach((card, level) => {
      if (!card) return;
      card.classList.toggle('inactive', level !== m.level);
      const offset = m.levels[level].title ? 1 : 0;
      Array.from(card.querySelectorAll('.am-row')).forEach((el, i) => el.classList.toggle('selected', i === m.levels[level].index && (level === m.level || level === 0)));
      const sel = card.querySelector('.am-row.selected');
      if (sel && level === m.level && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
    });
  }

  function openSubLevel(rows, index, title) {
    const m = appMenu;
    m.levels[1] = { rows, index: Math.max(0, index), title };
    m.level = 1;
    buildCard(1);
  }

  function closeSubLevel() {
    const m = appMenu;
    if (m.cards[1]) m.cards[1].remove();
    m.cards[1] = null;
    m.levels.length = 1;
    m.level = 0;
    paintMenu();
  }

  function moveMenuSelection(delta) {
    const m = appMenu;
    const data = m.levels[m.level];
    const next = firstEnabled(data.rows, data.index + delta, delta);
    if (next !== -1) { data.index = next; paintMenu(); }
  }

  function activateMenuRow() {
    const m = appMenu;
    const data = m.levels[m.level];
    const row = data.rows[data.index];
    if (!row || row.disabled) return;
    const ctx = m.ctx;
    switch (row.id) {
      case 'edit':
        closeAppMenu();
        startMove(ctx);
        break;
      case 'move': {
        const rows = moveRows(ctx);
        openSubLevel(rows, firstEnabled(rows), '');
        break;
      }
      case 'delete':
        openSubLevel(confirmRows(ctx), 1, `„${ctx.name}“ löschen?`);
        break;
      case 'cancel':
        closeSubLevel();
        break;
      case 'confirmDelete':
        closeAppMenu();
        deleteApp(ctx);
        break;
      case 'newFolder': {
        const result = HM.moveToNewFolder(homeItems, ctx.id);
        closeAppMenu();
        if (result) applyHomeItems(result.items, { focusId: result.folderId, closeFolder: !!ctx.inFolderId });
        break;
      }
      case 'toFolder': {
        const result = HM.moveToFolder(homeItems, ctx.id, row.folderId);
        closeAppMenu();
        if (result) applyHomeItems(result.items, { focusId: result.folderId, closeFolder: !!ctx.inFolderId });
        break;
      }
      case 'out': {
        const result = HM.removeFromFolder(homeItems, ctx.id);
        closeAppMenu();
        if (result) applyHomeItems(result.items, { focusId: ctx.id, closeFolder: true });
        break;
      }
      default:
        break;
    }
  }

  function deleteApp(ctx) {
    const result = HM.deleteApp(homeItems, ctx.id);
    if (!result) return;
    try {
      const r = window.electronAPI.deleteHomeApp(ctx.id);
      if (r && r.catch) r.catch(() => {});
    } catch (err) { /* App bleibt dann in apps.json - beim nächsten Start wieder da */ }
    const items = result.items;
    const nextTop = items[Math.min(result.topIndex, items.length - 1)];
    const folder = ctx.inFolderId ? HM.findFolder(items, ctx.inFolderId) : null;
    // nur anzeigen/neu zeichnen; gespeichert hat der Hauptprozess schon
    homeItems = items;
    renderHomeTiles();
    refreshHomeLayout();
    if (folderState && !folderState.closing) {
      if (!folder) { closeFolder({ fade: true, focusId: nextTop && nextTop.id }); return; }
      const tileButton = homeButtonFor(folderState.folderId);
      if (tileButton) tileButton.parentElement.classList.add('folder-opened');
      renderFolderGrid();
      return;
    }
    if (nextTop) focusHomeItem(nextTop.id);
  }

  appMenuLayer.addEventListener('mousedown', (e) => {
    if (e.target === appMenuLayer) { e.preventDefault(); closeAppMenu(); }
  });

  // ---------- Verschieben-Modus ----------

  function moveList() {
    if (!moveState) return [];
    if (moveState.scope === 'top') return homeItems;
    const folder = folderOf(moveState.scope);
    return folder ? folder.apps : [];
  }

  function startMove(ctx) {
    const scope = ctx.inFolderId || 'top';
    const list = scope === 'top' ? homeItems : (folderOf(scope) || { apps: [] }).apps;
    const from = list.findIndex((item) => item.id === ctx.id);
    if (from === -1) return;
    moveState = { scope, itemId: ctx.id, from, target: from, button: ctx.button };
    ctx.button.parentElement.classList.add('lifted');
    setModalClasses();
    updateMoveBar();
  }

  function moveButtons() {
    if (!moveState) return [];
    if (moveState.scope === 'top') return getAllRows().flat();
    return folderState ? folderState.buttons : [];
  }

  function updateMoveBar() {
    const ms = moveState;
    if (!ms) return;
    const bar = ms.scope === 'top' ? moveBar : folderMoveBar;
    const buttons = moveButtons();
    const n = buttons.length;
    if (n < 2) { bar.hidden = true; return; }
    const t = ms.target;
    const atEnd = t === n - 1;
    // Index in der vollen Liste (mit der angehobenen App), VOR dem die Marke steht bzw. (am Ende) hinter dem sie steht
    let fullIndex;
    if (atEnd) fullIndex = ms.from === n - 1 ? n - 2 : n - 1;
    else fullIndex = t < ms.from ? t : t + 1;
    const el = buttons[fullIndex].parentElement;
    const host = bar.parentElement;
    const hostRect = host.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const x = (atEnd ? r.right + 8 : r.left - 8) - hostRect.left;
    bar.style.left = `${x - 2}px`;
    bar.style.top = `${r.top - hostRect.top}px`;
    bar.style.height = `${r.height}px`;
    bar.hidden = false;
    if (ms.scope === 'top') {
      const needExpanded = Math.max(Math.floor(ms.from / HOME_COLS), Math.floor(fullIndex / HOME_COLS)) > 0;
      if (needExpanded) showExtraApps(); else hideExtraApps();
    }
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function exitMove() {
    if (!moveState) return;
    const lifted = document.querySelector('.icon.lifted');
    if (lifted) lifted.classList.remove('lifted');
    moveBar.hidden = true;
    folderMoveBar.hidden = true;
    moveState = null;
    setModalClasses();
  }

  function commitMove() {
    const ms = moveState;
    if (!ms) return;
    const { scope, itemId, from, target } = ms;
    exitMove();
    if (target === from) return;
    const items = scope === 'top' ? HM.moveTopItem(homeItems, itemId, target) : HM.moveInFolder(homeItems, scope, itemId, target);
    if (items) applyHomeItems(items, scope === 'top' ? { focusId: itemId } : { folderFocusAppId: itemId });
  }

  function moveTarget(code) {
    const ms = moveState;
    const n = moveList().length;
    const cols = ms.scope === 'top' ? HOME_COLS : FOLDER_COLS;
    let t = ms.target;
    if (code === 'ArrowLeft') t -= 1;
    else if (code === 'ArrowRight') t += 1;
    else if (code === 'ArrowUp') t -= cols;
    else if (code === 'ArrowDown') t += cols;
    ms.target = Math.max(0, Math.min(t, n - 1));
    updateMoveBar();
  }

  // ---------- Tasten ----------

  window.closeHomeModals = function closeHomeModals() {
    closeAppMenu();
    exitMove();
    if (folderState) closeFolder({ instant: true });
    modalEnter.armed = false;
    clearTimeout(modalEnter.timer);
  };

  function folderMove(code) {
    const fs = folderState;
    const n = fs.buttons.length;
    const i = fs.index;
    const row = Math.floor(i / FOLDER_COLS);
    const col = i % FOLDER_COLS;
    if (code === 'ArrowLeft') { if (col > 0) focusFolderIndex(i - 1); }
    else if (code === 'ArrowRight') { if (col < FOLDER_COLS - 1 && i + 1 < n) focusFolderIndex(i + 1); }
    else if (code === 'ArrowUp') {
      if (row > 0) focusFolderIndex(i - FOLDER_COLS);
      else focusTitle();
    } else if (code === 'ArrowDown') {
      if (i + FOLDER_COLS < n) focusFolderIndex(i + FOLDER_COLS);
      else if (Math.floor((n - 1) / FOLDER_COLS) > row) focusFolderIndex(n - 1);
    }
  }

  const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

  function handleTitleKey(e) {
    const fs = folderState;
    const trusted = e.isTrusted;
    const code = e.code;
    const keep = () => e.stopImmediatePropagation(); // Taste gehört dem Textfeld: nicht weiterreichen, aber auch nicht verhindern
    const swallow = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (code === 'Enter' || code === 'NumpadEnter') {
      if (e.repeat) { swallow(); return; }
      swallow();
      leaveTitle();
      return;
    }
    if (code === 'Escape') {
      swallow();
      const folder = folderOf(fs.folderId);
      if (folder) folderTitle.value = folder.name;
      leaveTitle();
      return;
    }
    if (code === 'ArrowDown') { swallow(); leaveTitle(); return; }
    if (code === 'ArrowUp') { swallow(); return; }
    if (code === 'ArrowLeft' || code === 'ArrowRight') { if (trusted) keep(); else swallow(); return; }
    if (code === 'Backspace') {
      if (trusted) keep(); // löscht ein Zeichen
      else { swallow(); leaveTitle(); } // B am Controller / Zurück am Handy
      return;
    }
    if (trusted) keep(); // Buchstaben usw. gehören dem Textfeld
    else if (code === 'GamepadQuickMenu' || code === 'GamepadAppMenu') swallow();
  }

  // Von script.js (ganz vorn in der Handler-Reihenfolge) aufgerufen - simulierte Tasten von Controller/Handy gehen direkt an das Fenster,
  // wo die Handler in der Reihenfolge ihrer Anmeldung laufen
  window.homeKeyDown = function homeKeyDown(e) {
    if (!homeModalActive() || menuOpen || ssActive) return;
    const code = e.code;
    const isEnter = code === 'Enter' || code === 'NumpadEnter';
    const swallow = () => { e.preventDefault(); e.stopImmediatePropagation(); };

    if (code === 'GamepadQuickMenu' || code === 'GamepadAppMenu') { swallow(); return; } // das Schnellmenü bleibt zu

    if (folderState && folderState.closing) {
      if (ARROWS.includes(code) || isEnter || code === 'Backspace' || code === 'Escape') swallow();
      return;
    }

    if (folderState && folderState.titleActive && !appMenu && !moveState) { handleTitleKey(e); return; }

    if (appMenu) {
      if (ARROWS.includes(code) || isEnter || code === 'Backspace' || code === 'Escape') swallow(); else return;
      if (e.repeat && isEnter) return;
      if (isEnter) { modalEnter.armed = true; modalEnter.long = false; return; } // ausgeführt wird beim Loslassen
      const m = appMenu;
      if (code === 'ArrowUp') moveMenuSelection(-1);
      else if (code === 'ArrowDown') moveMenuSelection(1);
      else if (code === 'ArrowRight') {
        const row = m.levels[m.level].rows[m.levels[m.level].index];
        if (m.level === 0 && row && row.id === 'move') activateMenuRow();
      } else if (code === 'ArrowLeft' || code === 'Backspace' || code === 'Escape') {
        if (m.level > 0) closeSubLevel(); else closeAppMenu();
      }
      return;
    }

    if (moveState) {
      if (ARROWS.includes(code) || isEnter || code === 'Backspace' || code === 'Escape') swallow(); else return;
      if (isEnter) { if (!e.repeat) { modalEnter.armed = true; modalEnter.long = false; } return; }
      if (code === 'Backspace' || code === 'Escape') { if (!e.repeat) exitMove(); return; }
      moveTarget(code);
      return;
    }

    if (folderState) {
      if (ARROWS.includes(code)) { swallow(); folderMove(code); return; }
      if (code === 'Backspace' || code === 'Escape') { swallow(); if (!e.repeat) closeFolder(); return; }
      if (isEnter) {
        swallow();
        if (e.repeat || modalEnter.armed) return;
        modalEnter.armed = true;
        modalEnter.long = false;
        clearTimeout(modalEnter.timer);
        modalEnter.timer = setTimeout(() => {
          if (!modalEnter.armed || !folderState || appMenu || moveState) return;
          modalEnter.long = true;
          openAppMenuForFocus();
        }, ENTER_HOLD_MS);
      }
    }
  };

  window.homeKeyUp = function homeKeyUp(e) {
    if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
    if (!homeModalActive() || menuOpen || ssActive) { modalEnter.armed = false; return; }
    if (folderState && folderState.titleActive && !appMenu && !moveState) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    clearTimeout(modalEnter.timer);
    const wasArmed = modalEnter.armed;
    const wasLong = modalEnter.long;
    modalEnter.armed = false;
    modalEnter.long = false;
    if (!wasArmed || wasLong) return; // Loslassen des Enter, das das Menü geöffnet hat
    if (folderState && folderState.closing) return;
    if (appMenu) { activateMenuRow(); return; }
    if (moveState) { commitMove(); return; }
    if (folderState) {
      const button = folderState.buttons[folderState.index];
      if (button) button.click();
    }
  };
})();
