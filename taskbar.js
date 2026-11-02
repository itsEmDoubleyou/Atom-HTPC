if (window.NavHelper) window.NavHelper.enableLinearNav();

const hideToggle = document.getElementById('taskbar-hide-toggle');
const unavailableHint = document.getElementById('taskbar-unavailable');
const saveBtn = document.getElementById('general-save');

window.addEventListener('DOMContentLoaded', async () => {
  const settings = await window.electronAPI.getTaskbarSettings();
  hideToggle.checked = !!settings.hideTaskbar;
  if (settings.available === false) {
    hideToggle.disabled = true;
    saveBtn.disabled = true;
    unavailableHint.hidden = false;
  }
});

saveBtn.addEventListener('click', async () => {
  await window.electronAPI.saveTaskbarSettings({ hideTaskbar: hideToggle.checked });

  const originalText = saveBtn.textContent;
  saveBtn.textContent = 'Gespeichert ✓';
  saveBtn.disabled = true;
  setTimeout(() => {
    saveBtn.textContent = originalText;
    saveBtn.disabled = false;
  }, 1500);
});
