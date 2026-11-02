window.NavHelper.enableLinearNav();

window.NavHelper.bindMenuNavigation({
  'menu-general': () => window.electronAPI.loadGeneral(),
  'menu-system': () => window.electronAPI.loadSystem()
});
