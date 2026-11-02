if (window.NavHelper) window.NavHelper.enableLinearNav();

const keepPlayingToggle = document.getElementById('tabs-keep-playing-toggle');
const sizeSelect = document.getElementById('tabs-size');
const showLabelToggle = document.getElementById('tabs-show-label-toggle');
const saveBtn = document.getElementById('general-save');

window.addEventListener('DOMContentLoaded', async () => {
  const settings = await window.electronAPI.getTabsSettings();
  keepPlayingToggle.checked = !!settings.keepPlayingInBackground;
  sizeSelect.value = settings.cardSize || 'large';
  showLabelToggle.checked = settings.showLabel !== false;
});

saveBtn.addEventListener('click', async () => {
  await window.electronAPI.saveTabsSettings({
    keepPlayingInBackground: keepPlayingToggle.checked,
    cardSize: sizeSelect.value,
    showLabel: showLabelToggle.checked
  });

  const originalText = saveBtn.textContent;
  saveBtn.textContent = 'Gespeichert ✓';
  saveBtn.disabled = true;
  setTimeout(() => {
    saveBtn.textContent = originalText;
    saveBtn.disabled = false;
  }, 1500);
});
