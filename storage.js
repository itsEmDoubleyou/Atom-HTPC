// Speicher & Daten: Cache leeren, Cookies und Anmeldungen löschen, einzelne App zurücksetzen, TMDb-Daten neu laden.
// Alles gilt für das aktive Profil. Gefährliches (Anmeldungen löschen, App zurücksetzen) verlangt einen zweiten Druck innerhalb von
// 4 Sekunden ("Wirklich löschen?"); ein zu schneller zweiter Druck (Doppeltipp, gehaltene Taste) zählt nicht.
window.NavHelper.enableLinearNav();

const CONFIRM_WINDOW_MS = 4000;
const CONFIRM_MIN_DELAY_MS = 400;

const els = {
  hint: document.getElementById('storage-hint'),
  sizeCache: document.getElementById('size-cache'),
  sizeData: document.getElementById('size-data'),
  appSelect: document.getElementById('storage-app'),
  status: document.getElementById('storage-status'),
  btnCache: document.getElementById('btn-cache'),
  btnData: document.getElementById('btn-data'),
  btnApp: document.getElementById('btn-app'),
  btnTmdb: document.getElementById('btn-tmdb')
};

let busy = false;
let statusTimer = null;

function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  const nf = (v, digits) => v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${nf(b / 1024, 0)} KB`;
  if (b < 1024 * 1024 * 1024) { const mb = b / (1024 * 1024); return `${nf(mb, mb < 100 ? 1 : 0)} MB`; }
  return `${nf(b / (1024 * 1024 * 1024), 1)} GB`;
}

function say(text, sticky) {
  els.status.textContent = text;
  clearTimeout(statusTimer);
  if (!sticky) statusTimer = setTimeout(() => { els.status.textContent = ''; }, 6000);
}

function setBusy(value) {
  busy = value;
  [els.btnCache, els.btnData, els.btnApp, els.btnTmdb].forEach((b) => { b.disabled = value || b.dataset.locked === '1'; });
  els.appSelect.disabled = value || els.appSelect.dataset.locked === '1';
}

async function refresh() {
  const info = await window.electronAPI.getStorageInfo();
  if (!info) return;
  els.hint.textContent = info.profileName ? `Gilt für das aktive Profil „${info.profileName}“.` : 'Gilt für das aktive Profil.';
  els.sizeCache.textContent = `Belegt: ${formatBytes(info.cacheBytes)}`;
  els.sizeData.textContent = `Gespeicherte Seitendaten: ca. ${formatBytes(info.dataBytes)}`;

  const previous = els.appSelect.value;
  els.appSelect.textContent = '';
  info.apps.forEach((a) => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name;
    els.appSelect.appendChild(opt);
  });
  const none = info.apps.length === 0;
  if (none) {
    const opt = document.createElement('option');
    opt.textContent = 'Keine Apps vorhanden';
    els.appSelect.appendChild(opt);
  } else if (info.apps.some((a) => a.id === previous)) {
    els.appSelect.value = previous;
  }
  els.appSelect.dataset.locked = none ? '1' : '';
  els.btnApp.dataset.locked = none ? '1' : '';
  setBusy(busy);
}

// Zweistufige Bestätigung für einen Knopf: erster Druck ändert die Beschriftung, zweiter (nach CONFIRM_MIN_DELAY_MS, vor Ablauf
// von CONFIRM_WINDOW_MS) führt aus. Ein Wechsel der Auswahl oder ein anderer Knopf bricht ab.
const confirmState = new Map(); // Knopf -> { since, timer, label }

function cancelConfirm(btn) {
  const st = confirmState.get(btn);
  if (!st) return;
  clearTimeout(st.timer);
  btn.textContent = st.label;
  btn.classList.remove('confirm');
  confirmState.delete(btn);
}

function cancelAllConfirms(except) {
  Array.from(confirmState.keys()).forEach((b) => { if (b !== except) cancelConfirm(b); });
}

function withConfirm(btn, confirmText, action) {
  btn.addEventListener('click', () => {
    if (busy) return;
    cancelAllConfirms(btn);
    const st = confirmState.get(btn);
    if (!st) {
      const label = btn.textContent;
      const timer = setTimeout(() => cancelConfirm(btn), CONFIRM_WINDOW_MS);
      confirmState.set(btn, { since: Date.now(), timer, label });
      btn.textContent = confirmText;
      btn.classList.add('confirm');
      return;
    }
    if (Date.now() - st.since < CONFIRM_MIN_DELAY_MS) return; // zu schnell hintereinander: noch keine Bestätigung
    cancelConfirm(btn);
    action();
  });
}

async function run(label, fn) {
  if (busy) return;
  setBusy(true);
  say(label, true);
  try {
    await fn();
  } catch (err) {
    console.error(err);
    say('Das hat nicht geklappt. Bitte erneut versuchen.');
  } finally {
    setBusy(false);
    refresh().catch(() => {});
  }
}

els.btnCache.addEventListener('click', () => {
  if (busy) return;
  cancelAllConfirms();
  run('Cache wird geleert …', async () => {
    const r = await window.electronAPI.clearStorageCache();
    say(r && r.ok ? `Cache geleert${r.freedBytes ? ` – ${formatBytes(r.freedBytes)} freigegeben` : ''}.` : 'Cache konnte nicht geleert werden.');
  });
});

withConfirm(els.btnData, 'Wirklich löschen?', () => run('Anmeldungen werden gelöscht …', async () => {
  const r = await window.electronAPI.clearStorageData();
  say(r && r.ok ? 'Alle Cookies und Anmeldungen gelöscht. Die Apps wurden beendet.' : 'Löschen war nur teilweise erfolgreich.');
}));

withConfirm(els.btnApp, 'Wirklich zurücksetzen?', () => run('App wird zurückgesetzt …', async () => {
  const id = els.appSelect.value;
  const r = await window.electronAPI.resetStorageApp(id);
  say(r && r.ok ? `„${r.name}“ wurde zurückgesetzt und beendet.` : 'Die App konnte nicht zurückgesetzt werden.');
}));
els.appSelect.addEventListener('change', () => cancelConfirm(els.btnApp));

els.btnTmdb.addEventListener('click', () => {
  if (busy) return;
  cancelAllConfirms();
  run('TMDb-Daten werden verworfen …', async () => {
    const r = await window.electronAPI.reloadTmdbData();
    say(r && r.ok ? 'Erledigt. Die Daten werden beim nächsten Bedarf neu geladen.' : 'Das hat nicht geklappt.');
  });
});

window.addEventListener('DOMContentLoaded', () => { refresh().catch((err) => console.error(err)); });
