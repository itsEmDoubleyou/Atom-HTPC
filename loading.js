// Namen der App aus der URL lesen (main.js übergibt ihn via loadFile-Query)
// und im Ladetext anzeigen, z.B. "Netflix wird geladen…"
const params = new URLSearchParams(window.location.search);
const appName = params.get('name');
const style = params.get('style') || 'bar';

if (appName) {
  document.getElementById('loading-text').textContent = `${appName} wird geladen…`;
}

// Zwischen Standard-Stil (Logo-Spinner + Text) und dem minimalistischen
// Balken umschalten - Auswahl kommt aus den App-Einstellungen.
if (style === 'bar') {
  document.getElementById('loading-box-default').style.display = 'none';
  document.getElementById('loading-box-bar').style.display = 'flex';

  const icon = params.get('icon');
  if (icon) {
    const logoEl = document.getElementById('loading-bar-logo');
    logoEl.src = icon;
    logoEl.style.display = 'block';
  }

  // Balken läuft über die tatsächliche Mindestdauer des Ladebildschirms (von
  // main.js mitgegeben) - kein unbestimmtes Hin-und-Her, sondern ein echter
  // 0%-auf-100%-Fortschritt, der zeitlich zum Übergang passt.
  const duration = parseInt(params.get('duration'), 10) || 1200;
  const fill = document.querySelector('.loading-bar-fill');
  fill.style.transitionDuration = `${duration}ms`;

  // Zwei Frames abwarten, damit der Browser die Startbreite (0%) wirklich
  // rendert, bevor der Übergang zu 100% losläuft - sonst macht das kein Fade.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fill.style.width = '100%';
    });
  });
}
