// Profile verwalten: anlegen (höchstens 5), umbenennen, Farbe wählen, löschen, Startverhalten.
// Jede Änderung gilt sofort (kein Speichern-Knopf nötig). Das aktive Profil lässt sich nicht löschen.
window.NavHelper.enableLinearNav();

const COLORS = ['#e5484d', '#f5a524', '#30a46c', '#0091ff', '#8e4ec6', '#e93d82', '#12a594', '#8b8d98'];
const list = document.getElementById('profile-list');
const addBtn = document.getElementById('profile-add');
const limitNote = document.getElementById('profile-limit-note');
const startupSelect = document.getElementById('profile-startup');
const statusEl = document.getElementById('profile-status');
let state = null;
let statusTimer = null;
let confirmId = null;     // Profil, dessen Löschen gerade bestätigt werden soll
let confirmTimer = null;

function initialOf(name) {
  const ch = Array.from(String(name || '').trim())[0];
  return ch ? ch.toUpperCase() : '?';
}

function say(text) {
  statusEl.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 2500);
}

function cancelConfirm() {
  clearTimeout(confirmTimer);
  confirmTimer = null;
  confirmId = null;
}

function render(focusSelector) {
  list.textContent = '';
  state.profiles.forEach((profile) => {
    const isActive = profile.id === state.activeId;
    const item = document.createElement('div');
    item.className = 'profile-row';
    item.dataset.id = profile.id;

    // Farbe: Klick wechselt zur nächsten
    const colorBtn = document.createElement('button');
    colorBtn.type = 'button';
    colorBtn.className = 'profile-avatar profile-color-btn';
    colorBtn.style.background = profile.color;
    colorBtn.textContent = initialOf(profile.name);
    colorBtn.title = 'Farbe ändern';
    colorBtn.setAttribute('aria-label', 'Farbe von ' + profile.name + ' ändern');
    colorBtn.addEventListener('click', async () => {
      const next = COLORS[(COLORS.indexOf(profile.color) + 1) % COLORS.length];
      const result = await window.electronAPI.updateProfile({ id: profile.id, color: next });
      if (result && result.ok) { state = result.state; render(`[data-id="${profile.id}"] .profile-color-btn`); say('Gespeichert ✓'); }
    });

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'profile-name-input';
    input.maxLength = 16;
    input.value = profile.name;
    input.setAttribute('aria-label', 'Name');
    // Geändert wird beim Verlassen des Feldes bzw. mit Enter der Tastatur
    const saveName = async () => {
      const name = input.value.replace(/\s+/g, ' ').trim();
      if (!name) { input.value = profile.name; return; }
      if (name === profile.name) return;
      const result = await window.electronAPI.updateProfile({ id: profile.id, name });
      if (result && result.ok) {
        state = result.state;
        profile.name = name;
        colorBtn.textContent = initialOf(name);
        say('Gespeichert ✓');
      }
    };
    input.addEventListener('change', saveName);
    input.addEventListener('keydown', (e) => { if (e.code === 'Enter' && e.isTrusted) input.blur(); });

    const badge = document.createElement('span');
    badge.className = 'profile-badge';
    badge.textContent = isActive ? 'Aktiv' : '';

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'profile-delete';
    delBtn.textContent = confirmId === profile.id ? 'Wirklich löschen?' : 'Löschen';
    if (confirmId === profile.id) delBtn.classList.add('confirm');
    if (isActive || state.profiles.length <= 1) {
      delBtn.disabled = true;
      delBtn.title = isActive ? 'Das aktive Profil lässt sich nicht löschen - erst im Schnellmenü zu einem anderen wechseln' : '';
    }
    delBtn.addEventListener('click', async () => {
      if (confirmId !== profile.id) { // erster Klick: bestätigen lassen
        cancelConfirm();
        confirmId = profile.id;
        confirmTimer = setTimeout(() => { cancelConfirm(); render(`[data-id="${profile.id}"] .profile-delete`); }, 4000);
        render(`[data-id="${profile.id}"] .profile-delete`);
        return;
      }
      cancelConfirm();
      const result = await window.electronAPI.deleteProfile(profile.id);
      if (result && result.state) state = result.state;
      render('#profile-add');
      say(result && result.ok ? 'Profil gelöscht' : 'Das Profil konnte nicht gelöscht werden');
    });

    item.append(colorBtn, input, badge, delBtn);
    list.appendChild(item);
  });

  const full = state.profiles.length >= state.max;
  addBtn.disabled = full;
  limitNote.textContent = full ? `Es sind höchstens ${state.max} Profile möglich.` : '';
  startupSelect.value = state.startupMode;

  if (focusSelector) {
    const el = document.querySelector(focusSelector);
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }
}

addBtn.addEventListener('click', async () => {
  const result = await window.electronAPI.createProfile();
  if (!result || !result.ok) { say('Es sind keine weiteren Profile möglich'); return; }
  state = result.state;
  render(`[data-id="${result.profile.id}"] .profile-name-input`);
  say('Profil angelegt');
});

startupSelect.addEventListener('change', async () => {
  const result = await window.electronAPI.setProfileStartup(startupSelect.value);
  if (result && result.ok) { state = result.state; say('Gespeichert ✓'); }
});

window.addEventListener('DOMContentLoaded', async () => {
  try {
    state = await window.electronAPI.getProfiles();
    render();
  } catch (err) {
    console.error('Profile konnten nicht geladen werden:', err);
  }
});
