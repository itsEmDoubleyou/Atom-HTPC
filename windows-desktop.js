// Windows-spezifisches: die Taskleiste ausblenden (nur wenn der Nutzer es in den Einstellungen unter System eingeschaltet hat).
// Arbeitet über PowerShell und ist auf anderen Plattformen ein No-Op. Hängt von nichts im Projekt ab.
// Den Desktop-Hintergrund fasst der Launcher nicht mehr an.
const { execFile } = require('child_process');
const fs = require('fs');

// Blendet die Windows-Taskleiste ein/aus. Nutzt einen bekannten, aber fragilen
// Win32-Kniff über PowerShell (FindWindow "Shell_TrayWnd" + ShowWindow) - es gibt
// dafür keine offizielle Electron-/Windows-API.
function buildScript(visible) {
  return [
    "Add-Type -Name Win32 -Namespace Native -MemberDefinition '",
    '[DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);',
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
    "';",
    '$hwnd = [Native.Win32]::FindWindow("Shell_TrayWnd", $null);',
    `[Native.Win32]::ShowWindow($hwnd, ${visible ? 5 : 0}) | Out-Null;`
  ].join(' ');
}

// markerFile: Merkdatei. Sie liegt da, solange DER LAUNCHER die Taskleiste ausgeblendet hat. Grund: Ein Absturz räumt nicht auf; sonst
// bliebe die Taskleiste weg, auch wenn die Option inzwischen aus ist. Beim nächsten Start findet recoverIfLeftHidden() die Datei.
// platform / execFileImpl: nur für Tests austauschbar.
function createTaskbar({ markerFile = null, platform = process.platform, execFileImpl = execFile, log = (...a) => console.error(...a) } = {}) {
  let hiddenByUs = false;

  const isWindows = () => platform === 'win32';

  function markerExists() {
    if (!markerFile) return false;
    try { return fs.existsSync(markerFile); } catch (err) { return false; }
  }
  function writeMarker() {
    if (!markerFile) return;
    try { fs.writeFileSync(markerFile, String(Date.now())); } catch (err) { log('Merkdatei der Taskleiste konnte nicht geschrieben werden:', err); }
  }
  function removeMarker() {
    if (!markerFile) return;
    try { fs.rmSync(markerFile, { force: true }); } catch (err) { log('Merkdatei der Taskleiste konnte nicht gelöscht werden:', err); }
  }

  function run(visible) {
    return new Promise((resolve) => {
      execFileImpl('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', buildScript(visible)], (err) => {
        if (err) log('Taskleiste konnte nicht umgeschaltet werden:', err);
        resolve(!err);
      });
    });
  }

  // Ausblenden. Die Merkdatei kommt VOR dem Ausblenden: stürzt der Launcher dazwischen ab, bleibt die Datei und das Einblenden wird nachgeholt.
  async function hide() {
    if (!isWindows()) return;
    writeMarker();
    const ok = await run(false);
    if (ok) hiddenByUs = true;
    else if (!hiddenByUs) removeMarker(); // nichts ausgeblendet: keine Spur zurücklassen
  }

  // Einblenden, aber nur, wenn der Launcher sie ausgeblendet hat (in dieser Sitzung oder in einer, die abgestürzt ist).
  // Scheitert das Einblenden, bleibt die Merkdatei für den nächsten Start.
  async function restore() {
    if (!isWindows()) return;
    if (!hiddenByUs && !markerExists()) return;
    const ok = await run(true);
    if (ok) {
      hiddenByUs = false;
      removeMarker();
    }
  }

  // Beim Start mit ausgeschalteter Option: war die Taskleiste von einer abgestürzten Sitzung her noch ausgeblendet, wird sie eingeblendet
  async function recoverIfLeftHidden() {
    if (!isWindows() || !markerExists()) return;
    await restore();
  }

  return { hide, restore, recoverIfLeftHidden, isHiddenByUs: () => hiddenByUs, markerExists };
}

module.exports = { createTaskbar, buildScript };
