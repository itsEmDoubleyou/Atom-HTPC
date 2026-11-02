// Profilauswahl beim Start: ein Feld pro Profil, Steuerkreuz/Pfeile wechseln, A/Enter wählt. Esc beendet wie überall.
window.NavHelper.enableLinearNav();

const row = document.getElementById('profile-select-row');
let chosen = false;

function initialOf(name) {
  const ch = Array.from(String(name || '').trim())[0];
  return ch ? ch.toUpperCase() : '?';
}

function render(state) {
  row.textContent = '';
  state.profiles.forEach((profile) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'profile-tile';
    tile.dataset.id = profile.id;

    const avatar = document.createElement('span');
    avatar.className = 'profile-avatar profile-avatar-large';
    avatar.style.background = profile.color;
    avatar.textContent = initialOf(profile.name);

    const name = document.createElement('span');
    name.className = 'profile-tile-name';
    name.textContent = profile.name;

    tile.append(avatar, name);
    tile.addEventListener('click', () => {
      if (chosen) return;
      chosen = true;
      window.electronAPI.switchProfile(profile.id);
    });
    row.appendChild(tile);
  });
  // vorausgewählt: das zuletzt benutzte Profil
  const last = row.querySelector(`[data-id="${state.activeId}"]`) || row.firstElementChild;
  if (last) last.focus({ preventScroll: true });
}

window.addEventListener('DOMContentLoaded', async () => {
  try {
    render(await window.electronAPI.getProfiles());
  } catch (err) {
    console.error('Profile konnten nicht geladen werden:', err);
  }
});
