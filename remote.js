// Fernbedienung per Handy (System): Ein/Aus, QR-Code mit Link, Port, neuer Code. Der Server selbst läuft im Hauptprozess
// (remote-service.js); diese Seite zeigt nur den Stand und ändert die Einstellungen.
window.NavHelper.enableLinearNav();

const els = {
  state: document.getElementById('remote-state'),
  toggle: document.getElementById('remote-toggle'),
  details: document.getElementById('remote-details'),
  qr: document.getElementById('remote-qr'),
  url: document.getElementById('remote-url'),
  address: document.getElementById('remote-address'),
  connection: document.getElementById('remote-connection'),
  port: document.getElementById('remote-port'),
  portSave: document.getElementById('remote-port-save'),
  copy: document.getElementById('remote-copy'),
  renew: document.getElementById('remote-renew'),
  status: document.getElementById('remote-status'),
  pointerSpeed: document.getElementById('remote-pointer-speed'),
  pointerSpeedValue: document.getElementById('remote-pointer-speed-value'),
  swipeSpeed: document.getElementById('remote-swipe-speed'),
  swipeSpeedValue: document.getElementById('remote-swipe-speed-value'),
  momentum: document.getElementById('remote-momentum'),
  momentumMax: document.getElementById('remote-momentum-max'),
  momentumMaxValue: document.getElementById('remote-momentum-max-value')
};

const CONFIRM_WINDOW_MS = 4000;
const CONFIRM_MIN_DELAY_MS = 400;

let info = null;
let busy = false;
let statusTimer = null;
let chosenAddress = '';      // vom Nutzer gewählte Adresse (bei mehreren Netzwerkkarten)
let renewArmedAt = 0;
let renewTimer = null;

function say(text, sticky) {
  els.status.textContent = text;
  clearTimeout(statusTimer);
  if (text && !sticky) statusTimer = setTimeout(() => { els.status.textContent = ''; }, 6000);
}

// Wählt die anzuzeigende Adresse: die gewählte, sonst die erste (echte Netzwerkkarten stehen vorn)
function currentUrl() {
  if (!info || !info.urls || info.urls.length === 0) return null;
  return info.urls.find((u) => u.address === chosenAddress) || info.urls[0];
}

function renderQr(text) {
  els.qr.textContent = '';
  if (!text || typeof qrcode !== 'function') return;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    els.qr.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true });
  } catch (err) {
    say('Der QR-Code konnte nicht erzeugt werden. Der Link steht darunter.', true);
  }
}

function render() {
  if (!info) return;
  const on = info.enabled;
  els.toggle.textContent = on ? 'Ausschalten' : 'Einschalten';
  els.toggle.disabled = busy;
  els.details.hidden = !on;
  renderTouch();

  if (!on) els.state.textContent = 'Aus';
  else if (info.error) els.state.textContent = 'Eingeschaltet, startet aber nicht';
  else if (info.listening) els.state.textContent = 'An';
  else els.state.textContent = 'Wird gestartet…';

  if (document.activeElement !== els.port) els.port.value = String(info.port);

  if (!on) return;

  const chosen = currentUrl();
  if (chosen) chosenAddress = chosen.address;
  els.url.textContent = chosen && info.listening ? chosen.url : '';
  renderQr(chosen && info.listening ? chosen.url : '');

  // Mehrere Netzwerkkarten (z.B. WLAN + VPN/virtuell): Auswahl anbieten
  const urls = info.urls || [];
  els.address.hidden = urls.length < 2;
  els.address.textContent = '';
  urls.forEach((u) => {
    const opt = document.createElement('option');
    opt.value = u.address;
    opt.textContent = `${u.name} (${u.address})${u.virtual ? ' – wohl virtuell' : ''}`;
    if (chosen && u.address === chosen.address) opt.selected = true;
    els.address.appendChild(opt);
  });

  if (info.error) els.connection.textContent = '';
  else if (urls.length === 0) els.connection.textContent = 'Keine Netzwerkverbindung gefunden. Bitte mit dem Heimnetz verbinden.';
  else els.connection.textContent = info.connected ? 'Smartphone verbunden ✓' : 'Wartet auf das Smartphone…';
  if (info.error) say(info.error, true); else if (els.status.textContent && !statusTimer) say('');
}

async function refresh() {
  const next = await window.electronAPI.getRemoteInfo();
  if (next) info = next;
  render();
}

async function run(action) {
  if (busy) return;
  busy = true;
  els.toggle.disabled = true;
  try {
    const next = await action();
    if (next) info = next;
  } catch (err) {
    say('Das hat nicht geklappt. Bitte noch einmal versuchen.');
  }
  busy = false;
  render();
}

els.toggle.addEventListener('click', () => run(() => {
  say('');
  return window.electronAPI.setRemoteEnabled(!(info && info.enabled));
}));

els.address.addEventListener('change', () => {
  chosenAddress = els.address.value;
  render();
});

els.portSave.addEventListener('click', () => run(async () => {
  const text = els.port.value.trim();
  if (!/^\d{4,5}$/.test(text)) { say('Der Port muss eine Zahl zwischen 1024 und 65535 sein.'); return null; }
  const next = await window.electronAPI.setRemotePort(Number(text));
  if (next && !next.error) say(`Port ${next.port} gespeichert.`);
  return next;
}));

// Neuer Code: zweiter Druck innerhalb von 4 Sekunden bestätigt (ein zu schneller zweiter Druck zählt nicht)
els.renew.addEventListener('click', () => {
  const now = Date.now();
  if (renewArmedAt && now - renewArmedAt >= CONFIRM_MIN_DELAY_MS && now - renewArmedAt <= CONFIRM_WINDOW_MS) {
    clearTimeout(renewTimer);
    renewArmedAt = 0;
    els.renew.textContent = 'Erneuern';
    run(async () => {
      const next = await window.electronAPI.renewRemoteToken();
      say('Neuer Code erzeugt. Bitte den neuen QR-Code scannen.');
      return next;
    });
    return;
  }
  if (renewArmedAt) return;
  renewArmedAt = now;
  els.renew.textContent = 'Wirklich erneuern?';
  renewTimer = setTimeout(() => { renewArmedAt = 0; els.renew.textContent = 'Erneuern'; }, CONFIRM_WINDOW_MS);
});

window.electronAPI.onRemoteStatus(() => { refresh(); });
refresh();


// Link in die Zwischenablage (Rückfall über ein verstecktes Textfeld, falls die moderne Schnittstelle nicht erlaubt ist)
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    area.remove();
    return ok;
  }
}

els.copy.addEventListener('click', async () => {
  const chosen = currentUrl();
  if (!chosen || !info || !info.listening) { say('Es gibt gerade keinen Link zum Kopieren.'); return; }
  say((await copyText(chosen.url)) ? 'Link kopiert.' : 'Kopieren hat nicht geklappt. Bitte den Link abtippen.');
});


// ---------- Touchfläche: Geschwindigkeiten und Schwung ----------
let touchSaveTimer = null;

function touchValuesFromControls() {
  return {
    pointerSpeed: Number(els.pointerSpeed.value),
    swipeSpeed: Number(els.swipeSpeed.value),
    momentum: els.momentum.checked,
    momentumMax: Number(els.momentumMax.value)
  };
}

function renderTouchLabels() {
  els.pointerSpeedValue.textContent = els.pointerSpeed.value + ' %';
  els.swipeSpeedValue.textContent = els.swipeSpeed.value + ' %';
  els.momentumMaxValue.textContent = els.momentumMax.value;
  els.momentumMax.disabled = !els.momentum.checked; // ohne Schwung gibt es nichts zu begrenzen
}

// Werte vom Hauptprozess übernehmen, aber nie ein Feld überschreiben, das gerade bedient wird
function renderTouch() {
  if (!info || !info.touch || touchSaveTimer) return;
  const t = info.touch;
  const controls = [[els.pointerSpeed, t.pointerSpeed], [els.swipeSpeed, t.swipeSpeed], [els.momentumMax, t.momentumMax]];
  controls.forEach(([el, value]) => { if (document.activeElement !== el && Number.isFinite(value)) el.value = String(value); });
  if (document.activeElement !== els.momentum) els.momentum.checked = t.momentum !== false;
  renderTouchLabels();
}

async function saveTouch() {
  clearTimeout(touchSaveTimer);
  touchSaveTimer = null;
  try {
    const next = await window.electronAPI.setRemoteTouch(touchValuesFromControls());
    if (next) info = next;
  } catch (err) { /* nächster Versuch beim nächsten Verstellen */ }
}

[els.pointerSpeed, els.swipeSpeed, els.momentumMax].forEach((el) => {
  el.addEventListener('input', () => {
    renderTouchLabels();
    clearTimeout(touchSaveTimer);
    touchSaveTimer = setTimeout(saveTouch, 150); // beim Ziehen/Halten der Pfeiltaste nicht jeden Zwischenwert speichern
  });
});
els.momentum.addEventListener('change', () => { renderTouchLabels(); saveTouch(); });

// Verlässt man die Seite direkt nach dem Verstellen (z. B. B-Taste), soll der Wert nicht verloren gehen
window.addEventListener('pagehide', () => { if (touchSaveTimer) saveTouch(); });
