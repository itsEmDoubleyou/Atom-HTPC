window.NavHelper.enableLinearNav();

window.NavHelper.bindMenuNavigation({
  'menu-controller': () => window.electronAPI.loadControllerSettings(),
  'menu-remote': () => window.electronAPI.loadRemote(),
  'menu-keyboard': () => window.electronAPI.loadKeyboardSettings()
});
