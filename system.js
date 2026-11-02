window.NavHelper.enableLinearNav();

// Reihenfolge im Menü: alphabetisch (siehe system.html)
window.NavHelper.bindMenuNavigation({
  'menu-adblocker': () => window.electronAPI.loadAdblocker(),
  'menu-services': () => window.electronAPI.loadServices(),
  'menu-profiles': () => window.electronAPI.loadProfiles(),
  'menu-storage': () => window.electronAPI.loadStorage(),
  'menu-taskbar': () => window.electronAPI.loadTaskbar()
});
