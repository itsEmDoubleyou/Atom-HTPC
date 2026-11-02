if (window.NavHelper) window.NavHelper.enableLinearNav();

const formatSelect = document.getElementById('clock-format');
const timezoneSelect = document.getElementById('clock-timezone');
const weekdayToggle = document.getElementById('clock-weekday-toggle');
const weekdayFormatSelect = document.getElementById('clock-weekday-format');
const saveBtn = document.getElementById('general-save');

window.addEventListener('DOMContentLoaded', async () => {
  const settings = await window.electronAPI.getClockSettings();
  formatSelect.value = settings.format || '24h';
  weekdayToggle.checked = settings.showWeekday !== false;
  weekdayFormatSelect.value = settings.weekdayFormat === 'short' ? 'short' : 'long';
  syncWeekdayFormatState();

  // Falls eine gespeicherte Zeitzone nicht in der Liste steht (z.B. manuell
  // gesetzt), als zusätzliche Option ergänzen, damit sie nicht verloren geht
  const savedTz = settings.timezone || 'auto';
  if (![...timezoneSelect.options].some(o => o.value === savedTz)) {
    const opt = document.createElement('option');
    opt.value = savedTz;
    opt.textContent = savedTz;
    timezoneSelect.appendChild(opt);
  }
  timezoneSelect.value = savedTz;
});

// Die Darstellung des Wochentags ist nur wählbar, solange der Wochentag angezeigt wird
function syncWeekdayFormatState() {
  weekdayFormatSelect.disabled = !weekdayToggle.checked;
}
weekdayToggle.addEventListener('change', syncWeekdayFormatState);

saveBtn.addEventListener('click', async () => {
  await window.electronAPI.saveClockSettings({
    format: formatSelect.value,
    timezone: timezoneSelect.value,
    showWeekday: weekdayToggle.checked,
    weekdayFormat: weekdayFormatSelect.value === 'short' ? 'short' : 'long'
  });

  const originalText = saveBtn.textContent;
  saveBtn.textContent = 'Gespeichert ✓';
  saveBtn.disabled = true;
  setTimeout(() => {
    saveBtn.textContent = originalText;
    saveBtn.disabled = false;
  }, 1500);
});
