# Atom

Medialauncher im tvOS-Stil für Fernseher und Heimkino-PC: Kachel-Oberfläche, Bedienung mit Controller oder Handy-Fernbedienung, Web-Apps (Netflix, YouTube & Co.) und lokale Programme in einem Kiosk-Fenster.

> **Beta** - frühe Version, Windows ist das Hauptziel. Das Linux-Paket ist noch kaum erprobt.

## Download

Fertige Pakete stehen im Bereich [Releases](../../releases):

| Plattform | Datei |
| --- | --- |
| Windows | `Atom-Setup-<Version>.exe` (Installer) oder `Atom-Portable-<Version>.exe` (ohne Installation) |
| Linux | `Atom-<Version>.AppImage` (`chmod +x` und starten) |

Die Pakete sind derzeit **nicht signiert**. Windows zeigt deshalb eine SmartScreen-Warnung, und DRM-Dienste (Widevine) können eingeschränkt sein, solange das Paket nicht mit castLabs EVS signiert ist.

## Aus dem Quellcode starten

Voraussetzung: Node.js 22.

```
npm install
npm start
```

Das Programm nutzt die [castLabs-Variante von Electron](https://github.com/castlabs/electron-releases) (Widevine-Unterstützung), sie wird über `npm install` mitgeladen.

## Pakete selbst bauen

```
npm run dist:win     # Windows: Installer + portable (auf Windows ausführen)
npm run dist:linux   # Linux: AppImage (auf Linux ausführen)
```

Die Ergebnisse liegen in `dist/`. Bei einem Tag `v*` baut GitHub Actions beide Pakete automatisch und legt sie als Vorabversion in den Releases ab (`.github/workflows/release.yml`).

## Signierung (Widevine / EVS)

Für DRM-Dienste auf Windows muss das Paket mit castLabs EVS signiert werden. Das ist in dieser Version noch nicht eingebaut.
