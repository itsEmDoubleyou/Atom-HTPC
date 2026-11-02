// Fernbedienung per Handy: kleiner Webserver (http) mit WebSocket im Heimnetz. Das Handy öffnet die Seite aus remote-ui/
// (über den QR-Code in den Einstellungen) und schickt Befehle, der Launcher meldet seinen Zustand zurück.
// Dieses Modul hängt nicht von Electron ab (nur Node + 'ws'), damit es sich für sich testen lässt.
//
// Sicherheit (Heimnetz, kein HTTPS):
//   - Jede Anfrage braucht den Token (aus dem QR-Code: ?t=...), die Seite merkt ihn sich in einem Cookie. Vergleich zeitkonstant.
//   - Nur Verbindungen aus privaten Adressbereichen (10.x, 172.16-31.x, 192.168.x, Link-Local, Loopback) werden bedient.
//   - Falsche Tokens: nach zu vielen Fehlversuchen einer Adresse wird sie kurz gesperrt.
//   - Nur ein Handy gleichzeitig: ein neues ersetzt das alte (das alte erfährt es mit Code 4001).
//   - Der Ursprung (Origin) der WebSocket-Verbindung muss zur Adresse des Servers passen (Schutz vor fremden Webseiten).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const CLOSE_REPLACED = 4001;   // ein anderes Handy hat die Verbindung übernommen
const CLOSE_BAD_TOKEN = 4003;  // Token ungültig
const CLOSE_STOPPED = 4000;    // Fernbedienung wurde ausgeschaltet bzw. der Code erneuert

const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_MESSAGES_PER_SECOND = 400;     // Touch-Bewegungen kommen mit bis zu ~60/s, dazu viel Luft
const HEARTBEAT_MS = 20000;
const AUTH_FAIL_LIMIT = 12;              // Fehlversuche ...
const AUTH_FAIL_WINDOW_MS = 60 * 1000;   // ... pro Minute und Adresse
const AUTH_BLOCK_MS = 60 * 1000;

// Dateien der Handy-Seite (nur diese werden ausgeliefert)
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/remote.js': { file: 'remote.js', type: 'text/javascript; charset=utf-8' },
  '/remote.css': { file: 'remote.css', type: 'text/css; charset=utf-8' },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json; charset=utf-8' }
};

// Ein zufälliger Token (URL-tauglich)
function generateToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// Stammt die Adresse aus dem Heimnetz (oder diesem Rechner selbst)? IPv4 und IPv6 (inkl. "::ffff:192.168.0.5").
function isPrivateAddress(address) {
  if (typeof address !== 'string' || !address) return false;
  let a = address.trim().toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  const m4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (m4) {
    const [o1, o2] = [Number(m4[1]), Number(m4[2])];
    if ([o1, o2, Number(m4[3]), Number(m4[4])].some((n) => n > 255)) return false;
    return o1 === 10 || o1 === 127 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168) || (o1 === 169 && o2 === 254);
  }
  if (a === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(a)) return true;       // fc00::/7 (privat)
  if (/^fe[89ab][0-9a-f]:/.test(a)) return true;       // fe80::/10 (Link-Local)
  return false;
}

// Liest den Token aus Adresse (?t=) oder Cookie (ml_remote)
function tokenFromRequest(req) {
  let fromQuery = '';
  try { fromQuery = new URL(req.url, 'http://x').searchParams.get('t') || ''; } catch (err) { /* ungültige Adresse */ }
  if (fromQuery) return fromQuery;
  const cookie = String(req.headers.cookie || '');
  const m = /(?:^|;\s*)ml_remote=([A-Za-z0-9_-]+)/.exec(cookie);
  return m ? m[1] : '';
}

// Wählt die beste Adresse dieses Rechners für den QR-Code: private IPv4-Adressen, echte Netzwerkkarten vor virtuellen
// (VPN, Hyper-V, WSL, Docker, VirtualBox ...). Gibt eine Liste zurück, die erste ist die Empfehlung.
const VIRTUAL_NAME = /(vethernet|hyper-v|wsl|docker|virtualbox|vmware|vbox|loopback|bluetooth|tailscale|zerotier|hamachi|tap-|tun|vpn|npcap|pseudo|isatap|teredo)/i;
function listLanAddresses(interfaces) {
  const result = [];
  Object.keys(interfaces || {}).forEach((name) => {
    (interfaces[name] || []).forEach((info) => {
      if (!info || info.internal) return;
      const family = typeof info.family === 'string' ? info.family : (info.family === 4 ? 'IPv4' : 'IPv6');
      if (family !== 'IPv4') return;
      if (!isPrivateAddress(info.address) || info.address.startsWith('169.254.')) return;
      result.push({ name, address: info.address, virtual: VIRTUAL_NAME.test(name) });
    });
  });
  return result.sort((a, b) => Number(a.virtual) - Number(b.virtual));
}

function createRemoteServer({ publicDir, onMessage = () => {}, onConnectionChange = () => {}, log = () => {} } = {}) {
  let httpServer = null;
  let wss = null;
  let token = '';
  let port = 0;
  let client = null;            // aktuell verbundenes Handy (WebSocket)
  let heartbeatTimer = null;
  const authFailures = new Map(); // Adresse -> { count, firstAt, blockedUntil }
  const sockets = new Set();      // offene TCP-Verbindungen (zum sauberen Beenden)

  function failedAuth(address) {
    const now = Date.now();
    const entry = authFailures.get(address);
    if (!entry || now - entry.firstAt > AUTH_FAIL_WINDOW_MS) {
      authFailures.set(address, { count: 1, firstAt: now, blockedUntil: 0 });
      return;
    }
    entry.count += 1;
    if (entry.count >= AUTH_FAIL_LIMIT) entry.blockedUntil = now + AUTH_BLOCK_MS;
  }

  function isBlocked(address) {
    const entry = authFailures.get(address);
    if (!entry) return false;
    if (entry.blockedUntil && Date.now() < entry.blockedUntil) return true;
    if (entry.blockedUntil && Date.now() >= entry.blockedUntil) authFailures.delete(address);
    return false;
  }

  function reply(res, status, body, headers = {}) {
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers
    });
    res.end(body);
  }

  function handleHttp(req, res) {
    const address = req.socket.remoteAddress || '';
    if (!isPrivateAddress(address)) return reply(res, 403, 'Nur im Heimnetz erreichbar.');
    if (isBlocked(address)) return reply(res, 429, 'Zu viele Versuche. Bitte kurz warten.', { 'Retry-After': '60' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, 'Nicht erlaubt.');

    let pathname = '/';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch (err) { return reply(res, 400, 'Ungültige Adresse.'); }
    const entry = STATIC_FILES[pathname];
    if (!entry) return reply(res, 404, 'Nicht gefunden.');

    const given = tokenFromRequest(req);
    if (!token || !given || !safeEqual(given, token)) {
      failedAuth(address);
      return reply(res, 403, 'Zugangscode fehlt oder ist ungültig. Bitte den QR-Code in den Einstellungen des Launchers neu scannen.');
    }

    fs.readFile(path.join(publicDir, entry.file), (err, data) => {
      if (err) return reply(res, 404, 'Nicht gefunden.');
      const headers = {
        'Content-Type': entry.type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'"
      };
      // Seite öffnen = Cookie setzen, damit die weiteren Dateien (Skript, Stile) ohne ?t= geladen werden können
      if (entry.file === 'index.html') headers['Set-Cookie'] = `ml_remote=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
      let body = data;
      if (entry.file === 'manifest.webmanifest') { // "Zum Home-Bildschirm": das Symbol startet die Seite gleich mit dem Zugangscode
        try {
          const manifest = JSON.parse(data.toString('utf8'));
          manifest.start_url = `/?t=${token}`;
          manifest.scope = '/';
          body = Buffer.from(JSON.stringify(manifest));
        } catch (err) { /* Datei unverändert ausliefern */ }
      }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  }

  function dropClient(code, reason) {
    const old = client;
    client = null;
    if (!old) return;
    try { old.close(code, reason); } catch (err) { /* schon zu */ }
    setTimeout(() => { try { old.terminate(); } catch (err) { /* schon zu */ } }, 1000).unref();
  }

  function handleConnection(ws, req) {
    const address = req.socket.remoteAddress || '';
    if (client && client !== ws) dropClient(CLOSE_REPLACED, 'replaced');
    client = ws;
    ws.isAlive = true;
    let windowStart = Date.now();
    let windowCount = 0;
    onConnectionChange(true, { address });
    log(`Handy verbunden (${address})`);

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary || ws !== client) return;
      const now = Date.now();
      if (now - windowStart >= 1000) { windowStart = now; windowCount = 0; }
      if (++windowCount > MAX_MESSAGES_PER_SECOND) return; // Überflutung: verwerfen
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch (err) { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      if (msg.t === 'ping') { try { ws.send('{"t":"pong"}'); } catch (err) { /* Verbindung bricht ab */ } return; } // Lebenszeichen für die Handy-Seite
      try { onMessage(msg); } catch (err) { log('Fehler bei der Verarbeitung: ' + (err && err.message)); }
    });
    ws.on('close', () => {
      if (ws === client) {
        client = null;
        onConnectionChange(false, { address });
        log('Handy getrennt');
      }
    });
    ws.on('error', () => { /* close folgt */ });
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!client) return;
      if (client.isAlive === false) { // seit dem letzten Ping keine Antwort: Verbindung ist weg
        const dead = client;
        try { dead.terminate(); } catch (err) { /* schon zu */ }
        return;
      }
      client.isAlive = false;
      try { client.ping(); } catch (err) { /* Verbindung bricht gerade ab */ }
    }, HEARTBEAT_MS);
    heartbeatTimer.unref();
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  return {
    // Startet den Server. Gibt { port } zurück; bei belegtem Port wird mit err.code === 'EADDRINUSE' abgelehnt.
    start({ port: wantedPort, token: wantedToken, host = '0.0.0.0' }) {
      if (httpServer) return Promise.resolve({ port });
      token = wantedToken;
      return new Promise((resolve, reject) => {
        const server = http.createServer(handleHttp);
        const socketServer = new WebSocketServer({
          noServer: true,
          maxPayload: MAX_MESSAGE_BYTES,
          perMessageDeflate: false // Touch-Daten sind klein; ohne Kompression kleinere Verzögerung
        });
        server.on('connection', (socket) => {
          sockets.add(socket);
          socket.setNoDelay(true); // kleine Touch-Nachrichten sofort senden
          socket.on('close', () => sockets.delete(socket));
        });
        server.on('upgrade', (req, socket, head) => {
          const address = req.socket.remoteAddress || '';
          const refuse = (status, text) => {
            try { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch (err) { /* Verbindung weg */ }
            socket.destroy();
          };
          if (!isPrivateAddress(address)) return refuse(403, 'Forbidden');
          if (isBlocked(address)) return refuse(429, 'Too Many Requests');
          let pathname = '';
          try { pathname = new URL(req.url, 'http://x').pathname; } catch (err) { return refuse(400, 'Bad Request'); }
          if (pathname !== '/ws') return refuse(404, 'Not Found');
          const origin = req.headers.origin;
          if (origin) { // Browser schicken ihn mit: er muss zu unserer Adresse passen
            let originHost = '';
            try { originHost = new URL(origin).host; } catch (err) { /* ungültig */ }
            if (!originHost || originHost !== req.headers.host) return refuse(403, 'Forbidden');
          }
          const given = tokenFromRequest(req);
          if (!token || !given || !safeEqual(given, token)) {
            failedAuth(address);
            // Handschlag abschließen und mit eigenem Code schließen: so erfährt die Seite, dass der Code ungültig ist
            return socketServer.handleUpgrade(req, socket, head, (ws) => { try { ws.close(CLOSE_BAD_TOKEN, 'bad token'); } catch (err) { /* weg */ } });
          }
          socketServer.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, req));
        });
        server.once('error', (err) => {
          try { socketServer.close(); } catch (e) { /* nicht gestartet */ }
          reject(err);
        });
        server.listen(wantedPort, host, () => {
          httpServer = server;
          wss = socketServer;
          port = server.address().port;
          startHeartbeat();
          log(`Server läuft auf Port ${port}`);
          resolve({ port });
        });
      });
    },

    // Beendet den Server und trennt das Handy
    stop() {
      stopHeartbeat();
      const wasConnected = !!client;
      dropClient(CLOSE_STOPPED, 'stopped');
      if (wasConnected) onConnectionChange(false, {});
      const server = httpServer;
      const socketServer = wss;
      httpServer = null;
      wss = null;
      port = 0;
      authFailures.clear();
      if (!server) return Promise.resolve();
      return new Promise((resolve) => {
        try { socketServer.close(); } catch (err) { /* schon zu */ }
        server.close(() => resolve());
        sockets.forEach((socket) => { try { socket.destroy(); } catch (err) { /* schon zu */ } });
        sockets.clear();
      });
    },

    // Neuer Token: das verbundene Handy wird getrennt (der alte Code gilt nicht mehr)
    setToken(newToken) {
      token = newToken;
      dropClient(CLOSE_STOPPED, 'token changed');
    },

    // Nachricht an das verbundene Handy (Objekt wird als JSON gesendet)
    send(message) {
      if (!client || client.readyState !== 1) return false;
      try { client.send(JSON.stringify(message)); return true; } catch (err) { return false; }
    },

    isConnected() { return !!client && client.readyState === 1; },
    isListening() { return !!httpServer; },
    getPort() { return port; }
  };
}

module.exports = {
  createRemoteServer, generateToken, isPrivateAddress, listLanAddresses,
  CLOSE_REPLACED, CLOSE_BAD_TOKEN, CLOSE_STOPPED
};
