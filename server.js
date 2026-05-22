// CPA SHOHAG PRO TEAM — Render Server
// HTTP + WebSocket on SAME port (Render requirement)
const WebSocket = require('ws');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');

const PORT    = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'licenses.json');

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { licenses: {} }; }
}
function saveDB(db) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch(e) {}
}
function genKey() {
  return 'SHOHAG-' + crypto.randomBytes(3).toString('hex').toUpperCase() + '-' +
         crypto.randomBytes(3).toString('hex').toUpperCase() + '-' +
         crypto.randomBytes(3).toString('hex').toUpperCase();
}

// ── HTTP Server ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' };

  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  if (req.method === 'GET' && req.url === '/api/status') {
    const db   = loadDB();
    const bots = [...wsClients.values()].filter(c => c.type === 'bot');
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify({
      licenses: db.licenses,
      online: bots.map(c => ({ id: c.id, name: c.name, ip: c.ip, status: c.status, clicks: c.clicks, sessions: c.sessions, licenseKey: c.licenseKey, lastSeen: c.lastSeen }))
    }));
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const db   = loadDB();
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });

        if (req.url === '/api/create-key') {
          const key = genKey();
          db.licenses[key] = { active: true, note: data.note || '', hwid: '', pcName: '', createdAt: Date.now(), lastIp: '', lastSeen: 0, totalClicks: 0, totalSessions: 0 };
          saveDB(db);
          res.end(JSON.stringify({ ok: true, key }));

        } else if (req.url === '/api/revoke') {
          if (db.licenses[data.key]) { db.licenses[data.key].active = false; saveDB(db); }
          for (const [, c] of wsClients)
            if (c.licenseKey === data.key && c.ws.readyState === 1)
              c.ws.send(JSON.stringify({ event: 'license-status', ok: false, revoked: true }));
          res.end(JSON.stringify({ ok: true }));

        } else if (req.url === '/api/restore') {
          if (db.licenses[data.key]) { db.licenses[data.key].active = true; saveDB(db); }
          res.end(JSON.stringify({ ok: true }));

        } else if (req.url === '/api/delete') {
          for (const [, c] of wsClients)
            if (c.licenseKey === data.key && c.ws.readyState === 1)
              c.ws.send(JSON.stringify({ event: 'license-status', ok: false, revoked: true }));
          delete db.licenses[data.key];
          saveDB(db);
          res.end(JSON.stringify({ ok: true }));

        } else if (req.url === '/api/reset-hwid') {
          if (db.licenses[data.key]) { db.licenses[data.key].hwid = ''; saveDB(db); }
          res.end(JSON.stringify({ ok: true }));

        } else if (req.url === '/api/cmd') {
          for (const [, c] of wsClients)
            if (c.id === data.targetId && c.ws.readyState === 1)
              c.ws.send(JSON.stringify({ event: data.event }));
          res.end(JSON.stringify({ ok: true }));

        } else if (req.url === '/api/cmd-all') {
          for (const [, c] of wsClients)
            if (c.type === 'bot' && c.ws.readyState === 1)
              c.ws.send(JSON.stringify({ event: data.event }));
          res.end(JSON.stringify({ ok: true }));

        } else { res.end(JSON.stringify({ ok: false })); }
      } catch(e) { res.writeHead(400, cors); res.end('{}'); }
    });
    return;
  }

  // Serve dashboard HTML
  res.writeHead(200, { 'Content-Type': 'text/html' });
  try { res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8')); }
  catch { res.end('<h1>CPA SHOHAG PRO TEAM</h1>'); }
});

// ── WebSocket on same HTTP server ─────────────────────────────
const wss = new WebSocket.Server({ server });
const wsClients = new Map();
let nextId = 1;

wss.on('connection', (ws, req) => {
  const id = nextId++;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const c  = { ws, id, ip, name: `PC-${id}`, type: 'bot', status: 'idle', clicks: 0, sessions: 0, lastSeen: Date.now(), licenseKey: '', hwid: '' };
  wsClients.set(id, c);
  console.log(`[+] #${id} from ${ip}`);
  ws.send(JSON.stringify({ event: 'welcome', id }));

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    c.lastSeen = Date.now();
    const db = loadDB();

    switch (msg.event) {
      case 'register':
        c.name = msg.name || c.name;
        c.type = msg.type || 'bot';
        c.hwid = msg.hwid || '';
        break;

      case 'activate': {
        const key = (msg.key || '').trim().toUpperCase();
        if (!db.licenses[key]) { ws.send(JSON.stringify({ event: 'activate-result', ok: false, msg: 'Invalid key!' })); break; }
        const lic = db.licenses[key];
        if (!lic.active) { ws.send(JSON.stringify({ event: 'activate-result', ok: false, msg: 'License বাতিল!' })); break; }
        
        lic.hwid = msg.hwid; lic.pcName = msg.pcName || c.name;
        lic.lastIp = ip; lic.lastSeen = Date.now();
        lic.activatedAt = lic.activatedAt || Date.now();
        saveDB(db);
        c.licenseKey = key; c.name = lic.pcName;
        ws.send(JSON.stringify({ event: 'activate-result', ok: true, msg: 'OK!', pcName: c.name }));
        console.log(`[LIC] ${key} → ${c.name} (${ip})`);
        break;
      }

      case 'check-license': {
        const key = (msg.key || '').trim().toUpperCase();
        if (!key || !db.licenses[key]) { ws.send(JSON.stringify({ event: 'license-status', ok: false })); break; }
        const lic = db.licenses[key];
        if (!lic.active) { ws.send(JSON.stringify({ event: 'license-status', ok: false, revoked: true })); break; }
        lic.lastIp = ip; lic.lastSeen = Date.now();
        saveDB(db);
        c.licenseKey = key; c.name = lic.pcName || c.name;
        ws.send(JSON.stringify({ event: 'license-status', ok: true, pcName: c.name }));
        break;
      }

      case 'status-update':
        c.status   = msg.status   !== undefined ? msg.status   : c.status;
        c.clicks   = msg.clicks   !== undefined ? msg.clicks   : c.clicks;
        c.sessions = msg.sessions !== undefined ? msg.sessions : c.sessions;
        if (c.licenseKey && db.licenses[c.licenseKey]) {
          db.licenses[c.licenseKey].totalClicks   = c.clicks;
          db.licenses[c.licenseKey].totalSessions = c.sessions;
          db.licenses[c.licenseKey].lastSeen      = Date.now();
          saveDB(db);
        }
        break;

      case 'ping': ws.send(JSON.stringify({ event: 'pong' })); break;
    }
  });

  ws.on('close', () => { console.log(`[-] #${id} (${c.name})`); wsClients.delete(id); });
  ws.on('error', () => wsClients.delete(id));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ CPA SHOHAG PRO TEAM Server`);
  console.log(`   HTTP + WS: port ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}\n`);
});
