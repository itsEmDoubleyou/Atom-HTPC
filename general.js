window.NavHelper.enableLinearNav();

// Reihenfolge im Menü: alphabetisch (siehe general.html)
window.NavHelper.bindMenuNavigation({
  'menu-manage': () => window.electronAPI.loadManage(),
  'menu-screensaver': () => window.electronAPI.loadScreensaver(),
  'menu-input-devices': () => window.electronAPI.loadInputDevices(),
  'menu-intro': () => window.electronAPI.loadIntro(),
  'menu-tabs': () => window.electronAPI.loadTabs(),
  'menu-time': () => window.electronAPI.loadTime()
});
