// Home Wi-Fi sync: the computer listens, the phone connects when the user taps
// 「與電腦同步」. Nothing leaves the local network.
//
// Pairing (once): the computer shows a 6-digit code. The phone and computer do
// an ECDH (P-256) key exchange and each proves it knows the code with an HMAC
// over both public keys, so an eavesdropper learns nothing and a
// man-in-the-middle can't pair without the code. The shared secret → HKDF →
// a per-phone AES-256-GCM key that encrypts every later request/response.
//
// After pairing, POST /sync carries { d: deviceId, iv, c } where c is the
// encrypted JSON { t, op, payload }. Ops:
//   state      → notes/folders/tombstones + image lists + encrypted vault file
//   getImages  → image files (base64); vault images stay encrypted
//   putImages  → store image files sent by the phone
//   apply      → adopt the merged data (and vault file) computed by the phone

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 47821;
const PAIRING_MS = 3 * 60 * 1000;
const MAX_BODY = 200 * 1024 * 1024;
const safeName = (n) => path.basename(String(n)).replace(/[^\w.-]/g, '');

const b64 = (buf) => Buffer.from(buf).toString('base64');
const hmac = (code, msg) => crypto.createHmac('sha256', Buffer.from(code, 'utf8')).update(msg).digest('base64');

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { iv: b64(iv), c: b64(data) };
}
function open(key, { iv, c }) {
  const buf = Buffer.from(c, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(buf.subarray(0, buf.length - 16)), decipher.final()]).toString('utf8'));
}

class SyncServer {
  // opts: { dataDir, imagesDir, vaultImagesDir, vaultFile, askRenderer(op, payload), onEvent(evt) }
  constructor(opts) {
    Object.assign(this, opts);
    this.configFile = path.join(this.dataDir, 'sync.json');
    this.config = { enabled: false, devices: [] };
    try { Object.assign(this.config, JSON.parse(fs.readFileSync(this.configFile, 'utf8'))); } catch { /* first run */ }
    this.server = null;
    this.pairing = null;
    this.error = null;
  }

  saveConfig() { fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2)); }

  addresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
    return out;
  }

  status() {
    return {
      enabled: this.config.enabled,
      running: !!this.server,
      error: this.error,
      port: PORT,
      addresses: this.addresses(),
      devices: this.config.devices.map(({ id, name, pairedAt, lastSync }) => ({ id, name, pairedAt, lastSync })),
      pairing: this.pairing && this.pairing.expires > Date.now()
        ? { code: this.pairing.code, expires: this.pairing.expires } : null,
    };
  }

  start() {
    if (this.server) return;
    this.error = null;
    const server = http.createServer((req, res) => this.handle(req, res));
    server.on('error', (err) => {
      this.error = err.code === 'EADDRINUSE' ? `連接埠 ${PORT} 已被其他程式使用` : err.message;
      this.server = null;
      this.onEvent({ type: 'status' });
    });
    server.listen(PORT, '0.0.0.0', () => this.onEvent({ type: 'status' }));
    this.server = server;
  }

  stop() {
    if (this.server) this.server.close();
    this.server = null;
  }

  setEnabled(on) {
    this.config.enabled = !!on;
    this.saveConfig();
    if (on) this.start(); else this.stop();
  }

  startPairing() {
    if (!this.config.enabled) this.setEnabled(true);
    this.pairing = { code: String(crypto.randomInt(0, 1e6)).padStart(6, '0'), expires: Date.now() + PAIRING_MS, attempts: 0 };
    return this.status();
  }

  cancelPairing() { this.pairing = null; }

  removeDevice(id) {
    this.config.devices = this.config.devices.filter((d) => d.id !== id);
    this.saveConfig();
  }

  // ---------- HTTP ----------

  async handle(req, res) {
    // CORS: requests are authenticated and encrypted, so any origin may ask.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const reply = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method !== 'POST') { reply(404, { error: 'not-found' }); return; }
    try {
      const body = await readBody(req);
      if (req.url === '/pair/start') reply(200, this.pairStart(body));
      else if (req.url === '/pair/finish') reply(200, this.pairFinish(body));
      else if (req.url === '/sync') reply(200, await this.sync(body));
      else reply(404, { error: 'not-found' });
    } catch (err) {
      reply(err.status || 500, { error: err.code || 'error', message: err.message });
    }
  }

  pairStart({ deviceId, name, pub }) {
    const p = this.pairing;
    if (!p || p.expires < Date.now()) throw fail(403, 'not-pairing', '電腦沒有在等待配對');
    const ecdh = crypto.createECDH('prime256v1');
    const pcPub = b64(ecdh.generateKeys());
    p.pending = { deviceId: String(deviceId), name: String(name || '手機').slice(0, 40), phonePub: pub, pcPub, shared: ecdh.computeSecret(Buffer.from(pub, 'base64')) };
    return { pcPub, proof: hmac(p.code, `pc|${pub}|${pcPub}`), pcName: os.hostname() };
  }

  pairFinish({ deviceId, proof }) {
    const p = this.pairing;
    if (!p || !p.pending || p.expires < Date.now() || p.pending.deviceId !== deviceId) throw fail(403, 'not-pairing', '配對已逾時');
    const expected = hmac(p.code, `phone|${p.pending.phonePub}|${p.pending.pcPub}`);
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(proof).padEnd(expected.length).slice(0, expected.length)))) {
      if (++p.attempts >= 5) this.pairing = null;
      throw fail(403, 'bad-code', '配對碼錯誤');
    }
    const key = Buffer.from(crypto.hkdfSync('sha256', p.pending.shared, Buffer.from('desknotes-sync'), Buffer.from('v1'), 32));
    this.config.devices = this.config.devices.filter((d) => d.id !== deviceId);
    this.config.devices.push({ id: deviceId, name: p.pending.name, key: b64(key), pairedAt: Date.now(), lastSync: 0 });
    this.saveConfig();
    this.pairing = null;
    this.onEvent({ type: 'paired', name: p.pending.name });
    return { ok: true };
  }

  async sync(body) {
    const device = this.config.devices.find((d) => d.id === body.d);
    if (!device) throw fail(403, 'not-paired', '這支手機尚未配對，請重新配對');
    const key = Buffer.from(device.key, 'base64');
    let req;
    try { req = open(key, body); } catch { throw fail(403, 'bad-key', '配對資料不符，請重新配對'); }
    if (Math.abs(Date.now() - req.t) > 10 * 60 * 1000) throw fail(403, 'clock', '手機和電腦的時間相差太多');
    let result;
    try {
      result = { ok: true, result: await this.op(req.op, req.payload || {}, device) };
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    return seal(key, result);
  }

  async op(op, payload, device) {
    const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
    const dirFor = (vault) => (vault ? this.vaultImagesDir : this.imagesDir);
    switch (op) {
      case 'hello':
        return { pcName: os.hostname() };
      case 'state': {
        this.onEvent({ type: 'sync-start', name: device.name });
        const db = await this.askRenderer('state');
        let vault = null;
        if (fs.existsSync(this.vaultFile)) {
          vault = { envelope: fs.readFileSync(this.vaultFile, 'utf8'), images: list(this.vaultImagesDir) };
        }
        return { db, images: list(this.imagesDir), vault };
      }
      case 'getImages': {
        const files = {};
        for (const n of payload.names || []) {
          const p = path.join(dirFor(payload.vault), safeName(n));
          if (fs.existsSync(p)) files[safeName(n)] = b64(fs.readFileSync(p));
        }
        return { files };
      }
      case 'putImages': {
        const dir = dirFor(payload.vault);
        fs.mkdirSync(dir, { recursive: true });
        for (const [n, data] of Object.entries(payload.files || {})) fs.writeFileSync(path.join(dir, safeName(n)), Buffer.from(data, 'base64'));
        return { ok: true };
      }
      case 'apply': {
        if (payload.vault) {
          const tmp = `${this.vaultFile}.tmp`;
          fs.writeFileSync(tmp, payload.vault);
          if (fs.existsSync(this.vaultFile)) fs.copyFileSync(this.vaultFile, `${this.vaultFile}.bak`);
          fs.renameSync(tmp, this.vaultFile);
        }
        await this.askRenderer('apply', { db: payload.db, vaultChanged: !!payload.vault, stats: payload.stats });
        device.lastSync = Date.now();
        this.saveConfig();
        this.onEvent({ type: 'sync-done', name: device.name });
        return { ok: true };
      }
      case 'abort':
        await this.askRenderer('abort');
        return { ok: true };
      default:
        throw new Error(`unknown op ${op}`);
    }
  }
}

function fail(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(fail(413, 'too-large', '資料太大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(fail(400, 'bad-json', 'bad request')); }
    });
    req.on('error', reject);
  });
}

module.exports = { SyncServer, PORT };
