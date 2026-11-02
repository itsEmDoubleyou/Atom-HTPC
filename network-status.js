// Netzwerkstatus für die Anzeige im Schnellmenü: LAN (Kabel), WLAN mit Signalstärke oder keine Verbindung.
// Unter Windows läuft dafür ein dauerhaft laufendes PowerShell (der Start dauert einen Moment, jede Abfrage ist danach nur eine
// Zeile über die Standardeingabe). Es ermittelt die Verbindung, die Windows gerade für den Internetverkehr nutzt (Standardroute mit
// der niedrigsten Metrik), und ignoriert dabei virtuelle Adapter (VPN, Hyper-V, ...). Ist keine Standardroute da, zählt ein
// verbundener Hardware-Adapter (Kabel vor WLAN). Beim WLAN kommt die Signalstärke in Prozent von "netsh wlan show interfaces".
// Auf anderen Systemen als Windows (Tests) gibt es einen Ersatz, dessen Zustand sich setzen lässt.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const POLL_MS = 4000;          // so oft wird gefragt
const CONFIRM_NONE_MS = 1500;  // "keine Verbindung" wird einmal kurz nachgeprüft (beim Wechsel zwischen Netzen kurz leer)
const REPLY_TIMEOUT_MS = 10000;

// Stufen des WLAN-Symbols: 0 = nur der Punkt (unter 25 %), 1 / 2 / 3 = Bögen (ab 25 / 50 / 75 %).
// Mit kleiner Hysterese (HYST Prozentpunkte), damit ein schwankendes Signal an einer Grenze nicht ständig flackert.
const LEVEL_EDGES = [25, 50, 75];
const HYST = 4;
function wifiLevel(percent, previousLevel = null) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  let level = 0;
  LEVEL_EDGES.forEach((edge) => { if (p >= edge) level++; });
  if (previousLevel !== null && previousLevel !== level && previousLevel >= 0 && previousLevel <= 3) {
    // Die alte Stufe bleibt, solange das Signal nur knapp über der Grenze zur neuen Stufe liegt
    if (level < previousLevel && p >= LEVEL_EDGES[previousLevel - 1] - HYST) return previousLevel;
    if (level > previousLevel && p < LEVEL_EDGES[previousLevel] + HYST) return previousLevel;
  }
  return level;
}

// Das Skript für PowerShell (nur ASCII). Jede Eingabezeile ergibt genau eine Antwortzeile:
//   "OK lan" | "OK wifi <Prozent>" | "OK none" | "ERR"
const PS_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
function Get-Kind($adapter) {
  if ($adapter -eq $null) { return $null }
  if ($adapter.HardwareInterface -ne $true) { return $null }
  if ($adapter.NdisPhysicalMedium -eq 9 -or [string]$adapter.PhysicalMediaType -match '802\\.11') { return 'wifi' }
  return 'lan'
}
function Get-WifiPercent {
  $text = (& netsh.exe wlan show interfaces) -join "\`n"
  $m = [regex]::Match($text, ':\\s*(\\d{1,3})\\s*%')
  if ($m.Success) { return [int]$m.Groups[1].Value }
  return -1
}
function Get-Active {
  $best = $null
  $bestMetric = [int]::MaxValue
  foreach ($r in (Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0')) {
    $a = Get-NetAdapter -InterfaceIndex $r.InterfaceIndex
    if ($a -eq $null -or $a.Status -ne 'Up') { continue }
    $kind = Get-Kind $a
    if ($kind -eq $null) { continue }
    $if = Get-NetIPInterface -InterfaceIndex $r.InterfaceIndex -AddressFamily IPv4
    $metric = [int]$r.RouteMetric + [int]$if.InterfaceMetric
    if ($metric -lt $bestMetric) { $bestMetric = $metric; $best = $kind }
  }
  if ($best -ne $null) { return $best }
  $up = @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.HardwareInterface -eq $true })
  if (@($up | Where-Object { (Get-Kind $_) -eq 'lan' }).Count -gt 0) { return 'lan' }
  if (@($up | Where-Object { (Get-Kind $_) -eq 'wifi' }).Count -gt 0) { return 'wifi' }
  return 'none'
}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $kind = Get-Active
    if ($kind -eq 'wifi') {
      $p = Get-WifiPercent
      if ($p -lt 0) { $p = 50 }
      [Console]::Out.WriteLine('OK wifi ' + $p)
    } else {
      [Console]::Out.WriteLine('OK ' + $kind)
    }
  } catch {
    [Console]::Out.WriteLine('ERR')
  }
  [Console]::Out.Flush()
}
`;

// Antwortzeile -> { type: 'lan'|'wifi'|'none', percent } oder null
function parseReply(line) {
  const text = String(line || '').trim();
  let m = /^OK (lan|none)$/.exec(text);
  if (m) return { type: m[1], percent: 0 };
  m = /^OK wifi (\d{1,3})$/.exec(text);
  if (m) return { type: 'wifi', percent: Math.max(0, Math.min(100, parseInt(m[1], 10))) };
  return null;
}

// Anbindung an Windows über ein dauerhaft laufendes PowerShell: { query(): Promise<{type, percent}|null>, close() }
function createPowerShellBackend({ scriptDir, spawnImpl = spawn }) {
  let proc = null;
  let buf = '';
  let pending = [];
  let warned = false;

  function failAll() {
    const list = pending;
    pending = [];
    list.forEach((cb) => cb(null));
  }

  function ensure() {
    if (proc) return true;
    try {
      const file = path.join(scriptDir, 'network-status-helper.ps1');
      fs.writeFileSync(file, PS_SCRIPT, 'utf8');
      const child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore']
      });
      proc = child;
      buf = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const cb = pending.shift();
          if (cb) cb(line);
        }
      });
      const gone = () => { if (proc === child) { proc = null; failAll(); } };
      child.on('exit', gone);
      child.on('error', gone);
      child.stdin.on('error', () => {});
      return true;
    } catch (err) {
      if (!warned) { warned = true; console.error('Netzwerkstatus: PowerShell konnte nicht gestartet werden:', err); }
      proc = null;
      return false;
    }
  }

  return {
    query() {
      return new Promise((resolve) => {
        if (!ensure()) { resolve(null); return; }
        const child = proc;
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          try { child.kill(); } catch (err) { /* schon beendet */ }
          resolve(null);
        }, REPLY_TIMEOUT_MS);
        pending.push((line) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(line === null ? null : parseReply(line));
        });
        try { child.stdin.write('poll\n'); } catch (err) { /* der Exit-Handler räumt auf */ }
      });
    },
    close() {
      const child = proc;
      proc = null;
      failAll();
      try { if (child) child.kill(); } catch (err) { /* schon beendet */ }
    }
  };
}

// Ersatz ohne Windows (Tests, andere Systeme): ein Zustand, den man setzen kann
function createMemoryBackend(initial = { type: 'lan', percent: 0 }) {
  let state = initial;
  return {
    query: async () => state,
    close() {},
    set(next) { state = next; }
  };
}

// backend: { query(): Promise<{type, percent}|null>, close() }; onChange(status) bei jeder Änderung.
// status = { type: 'lan'|'wifi'|'none', level: 0-3 (nur bei WLAN, sonst 0), percent }; vor der ersten Antwort ist status null.
function createNetworkStatus({ backend, onChange = () => {}, pollMs = POLL_MS, confirmNoneMs = CONFIRM_NONE_MS }) {
  let status = null;
  let timer = null;
  let stopped = false;
  let noneSeen = false;

  function apply(reading) {
    let next;
    if (reading.type === 'wifi') {
      const level = wifiLevel(reading.percent, status && status.type === 'wifi' ? status.level : null);
      next = { type: 'wifi', level, percent: reading.percent };
    } else {
      next = { type: reading.type, level: 0, percent: 0 };
    }
    // gemeldet wird nur, was sich für die Anzeige ändert (Art oder Stufe), nicht jedes Schwanken des Prozentwerts
    const changed = !status || status.type !== next.type || status.level !== next.level;
    status = next;
    if (changed) {
      try { onChange(status); } catch (err) { /* die Seite wechselt gerade */ }
    }
  }

  async function poll() {
    timer = null;
    if (stopped) return;
    let delay = pollMs;
    let reading = null;
    try { reading = await backend.query(); } catch (err) { reading = null; }
    if (stopped) return;
    if (reading) {
      if (reading.type === 'none' && !noneSeen && status && status.type !== 'none') {
        noneSeen = true;       // erst einmal kurz nachprüfen
        delay = confirmNoneMs;
      } else {
        noneSeen = reading.type === 'none';
        apply(reading);
      }
    }
    // keine Antwort (PowerShell nicht lesbar): der alte Stand bleibt stehen
    timer = setTimeout(poll, delay);
  }

  return {
    start() {
      if (timer || stopped) return;
      poll();
    },
    getStatus: () => status,
    // sofort neu abfragen (z.B. wenn der Launcher wieder sichtbar wird)
    refresh() {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      poll();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try { backend.close(); } catch (err) { /* schon beendet */ }
    }
  };
}

// Standard: unter Windows PowerShell, sonst der Speicher-Ersatz
function createDefaultNetworkStatus({ scriptDir, onChange }) {
  const backend = process.platform === 'win32' ? createPowerShellBackend({ scriptDir }) : createMemoryBackend();
  return createNetworkStatus({ backend, onChange });
}

module.exports = { createNetworkStatus, createDefaultNetworkStatus, createPowerShellBackend, createMemoryBackend, parseReply, wifiLevel, PS_SCRIPT };
