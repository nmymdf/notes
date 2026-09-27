// Android (Capacitor) implementation of window.notesAPI — the same interface
// the Electron preload provides, so src/renderer runs unchanged on the phone.
//
// Data lives in the app's private storage (Directory.Data/desknotes), with the
// same layout and formats as the desktop app:
//   notes.json, images/, vault.enc, vault-images/
// Locked notes use the same crypto as src/vault.js: scrypt(N=2^17, r=8, p=1)
// → AES-256-GCM, so the files are interchangeable with the Windows version.

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { App } from '@capacitor/app';
import { Share } from '@capacitor/share';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';

const DIR = Directory.Data;
const ROOT = 'desknotes';
const DB_FILE = `${ROOT}/notes.json`;
const IMG_DIR = `${ROOT}/images`;
const VAULT_FILE = `${ROOT}/vault.enc`;
const VAULT_IMG_DIR = `${ROOT}/vault-images`;
const KDF = { N: 2 ** 17, r: 8, p: 1 };
const NATIVE = Capacitor.isNativePlatform();

const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
};
const mimeOf = (name) => Object.keys(EXT_BY_MIME).find((k) => EXT_BY_MIME[k] === name.split('.').pop()) || 'image/png';

// ---------- bytes / base64 ----------

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// ---------- filesystem ----------

async function exists(path) {
  try { await Filesystem.stat({ path, directory: DIR }); return true; } catch { return false; }
}
async function mkdirp(path) {
  try { await Filesystem.mkdir({ path, directory: DIR, recursive: true }); } catch { /* exists */ }
}
async function readText(path) {
  return (await Filesystem.readFile({ path, directory: DIR, encoding: Encoding.UTF8 })).data;
}
async function writeText(path, text) {
  await Filesystem.writeFile({ path, directory: DIR, data: text, encoding: Encoding.UTF8, recursive: true });
}
async function readBytes(path) {
  const { data } = await Filesystem.readFile({ path, directory: DIR });
  return typeof data === 'string' ? fromB64(data) : new Uint8Array(await data.arrayBuffer());
}
async function writeBytes(path, bytes) {
  await Filesystem.writeFile({ path, directory: DIR, data: toB64(bytes), recursive: true });
}
async function remove(path) {
  try { await Filesystem.deleteFile({ path, directory: DIR }); } catch { /* gone */ }
}
async function listFiles(dir) {
  try {
    const { files } = await Filesystem.readdir({ path: dir, directory: DIR });
    return files.map((f) => (typeof f === 'string' ? f : f.name));
  } catch { return []; }
}
// Write via a temp file, keeping the previous version as .bak (like the desktop app).
async function writeTextSafe(path, text, { scrub = false } = {}) {
  await writeText(`${path}.tmp`, text);
  if (await exists(path)) {
    await remove(`${path}.bak`);
    await Filesystem.copy({ from: path, to: `${path}.bak`, directory: DIR, toDirectory: DIR });
  }
  await remove(path);
  await Filesystem.rename({ from: `${path}.tmp`, to: path, directory: DIR, toDirectory: DIR });
  if (scrub) await writeText(`${path}.bak`, text);
}

const newImageName = (mime) => `${Date.now()}-${toB64(crypto.getRandomValues(new Uint8Array(6))).replace(/[^a-z0-9]/gi, '').slice(0, 10)}.${EXT_BY_MIME[mime] || 'png'}`;

function refs(html, host) {
  const out = new Set();
  const re = new RegExp(`note-img://${host}/([\\w.-]+)`, 'g');
  let m;
  while ((m = re.exec(html || ''))) out.add(m[1]);
  return out;
}

// ---------- crypto (compatible with src/vault.js) ----------

async function deriveKey(password, salt, { N, r, p }) {
  const raw = await scryptAsync(new TextEncoder().encode(password.normalize('NFC')), salt, {
    N, r, p, dkLen: 32, maxmem: 256 * 1024 * 1024, asyncTick: 20,
  });
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encrypt(key, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return { iv, tag: out.subarray(out.length - 16), data: out.subarray(0, out.length - 16) };
}
async function decrypt(key, iv, tag, data) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, concat(data, tag)));
}
async function packImage(key, plain) {
  const { iv, tag, data } = await encrypt(key, plain);
  return concat(iv, tag, data);
}
async function unpackImage(key, buf) {
  return decrypt(key, buf.subarray(0, 12), buf.subarray(12, 28), buf.subarray(28));
}

// The password is kept in memory while unlocked, only to open the computer's
// vault during a sync when it was created with a different salt.
const vault = { key: null, meta: null, lastNotes: null, password: null };
const blobCache = new Map(); // note-img URL → object URL

async function writeVault(payload, key = vault.key, meta = vault.meta) {
  const body = { notes: payload.notes || [], folders: payload.folders || [], tombstones: payload.tombstones || {} };
  const { iv, tag, data } = await encrypt(key, new TextEncoder().encode(JSON.stringify(body)));
  await writeTextSafe(VAULT_FILE, JSON.stringify({
    version: 1, kdf: 'scrypt', N: meta.N, r: meta.r, p: meta.p,
    salt: toB64(meta.salt), iv: toB64(iv), tag: toB64(tag), data: toB64(data),
  }));
}

async function unlockWith(password) {
  const env = JSON.parse(await readText(VAULT_FILE));
  const meta = { N: env.N, r: env.r, p: env.p, salt: fromB64(env.salt) };
  const key = await deriveKey(password, meta.salt, meta);
  try {
    const plain = await decrypt(key, fromB64(env.iv), fromB64(env.tag), fromB64(env.data));
    const body = JSON.parse(new TextDecoder().decode(plain));
    return { key, meta, payload: { notes: body.notes || [], folders: body.folders || [], tombstones: body.tombstones || {} } };
  } catch {
    return null;
  }
}

async function saveImage(bytes, mime, inVault) {
  const name = newImageName(mime);
  if (inVault) {
    if (!vault.key) throw new Error('vault is locked');
    await writeBytes(`${VAULT_IMG_DIR}/${name}`, await packImage(vault.key, bytes));
    return `note-img://vault/${name}`;
  }
  await writeBytes(`${IMG_DIR}/${name}`, bytes);
  return `note-img://img/${name}`;
}


// ---------- sync with the computer (client side; see src/sync-server.js) ----------

const SYNC_FILE = `${ROOT}/sync.json`;
const SYNC_PORT = 47821;
const foreign = { key: null, meta: null }; // the computer's vault key while syncing
const enc = (s) => new TextEncoder().encode(s);

async function hmacB64(code, msg) {
  const k = await crypto.subtle.importKey('raw', enc(code), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toB64(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc(msg))));
}
async function transportKey(rawB64) {
  return crypto.subtle.importKey('raw', fromB64(rawB64), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function sealMsg(key, obj) {
  const { iv, tag, data } = await encrypt(key, enc(JSON.stringify(obj)));
  return { iv: toB64(iv), c: toB64(concat(data, tag)) };
}
async function openMsg(key, { iv, c }) {
  const buf = fromB64(c);
  const plain = await decrypt(key, fromB64(iv), buf.subarray(buf.length - 16), buf.subarray(0, buf.length - 16));
  return JSON.parse(new TextDecoder().decode(plain));
}

const baseUrl = (address) => (/:\d+$/.test(address) ? `http://${address}` : `http://${address}:${SYNC_PORT}`);

async function post(url, data) {
  let res;
  try {
    res = await CapacitorHttp.request({
      url, method: 'POST', data, headers: { 'Content-Type': 'application/json' },
      responseType: 'json', connectTimeout: 8000, readTimeout: 120000,
    });
  } catch {
    const err = new Error('連不到電腦。請確認電腦上的 DeskNotes 有開著，而且手機和電腦連在同一個 Wi-Fi。');
    err.code = 'unreachable';
    throw err;
  }
  const body = typeof res.data === 'string' ? JSON.parse(res.data || '{}') : res.data;
  if (res.status !== 200) {
    const err = new Error(body.message || `電腦回應錯誤 (${res.status})`);
    err.code = body.error;
    throw err;
  }
  return body;
}

async function readPairing() {
  try { return JSON.parse(await readText(SYNC_FILE)); } catch { return null; }
}
async function writePairing(p) { await writeText(SYNC_FILE, JSON.stringify(p)); }

async function foreignKeyFor(envelopeText) {
  const env = JSON.parse(envelopeText);
  const meta = { N: env.N, r: env.r, p: env.p, salt: fromB64(env.salt) };
  if (vault.meta && toB64(vault.meta.salt) === env.salt) return { key: vault.key, meta: vault.meta, env };
  if (foreign.meta && toB64(foreign.meta.salt) === env.salt) return { key: foreign.key, meta: foreign.meta, env };
  const key = await deriveKey(vault.password, meta.salt, meta);
  return { key, meta, env };
}

const syncApi = {
  role: 'client',
  getPairing: readPairing,
  async pair(address, code) {
    const url = baseUrl(address.trim());
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const pub = toB64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
    const deviceId = `phone-${toB64(crypto.getRandomValues(new Uint8Array(9))).replace(/[^a-z0-9]/gi, '')}`;
    const start = await post(`${url}/pair/start`, { deviceId, name: 'Android 手機', pub });
    if (start.proof !== await hmacB64(code, `pc|${pub}|${start.pcPub}`)) {
      const err = new Error('配對碼錯誤，請確認電腦上顯示的 6 位數字');
      err.code = 'bad-code';
      throw err;
    }
    const pcKey = await crypto.subtle.importKey('raw', fromB64(start.pcPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: pcKey }, pair.privateKey, 256);
    const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    const key = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: enc('desknotes-sync'), info: enc('v1') }, hk, 256));
    await post(`${url}/pair/finish`, { deviceId, proof: await hmacB64(code, `phone|${pub}|${start.pcPub}`) });
    const pairing = { address: address.trim(), deviceId, key: toB64(key), pcName: start.pcName, lastSync: 0 };
    await writePairing(pairing);
    return pairing;
  },
  async update(changes) {
    const p = await readPairing();
    if (p) await writePairing({ ...p, ...changes });
  },
  async unpair() { await remove(SYNC_FILE); },
  async request(op, payload) {
    const p = await readPairing();
    if (!p) throw new Error('尚未配對');
    const key = await transportKey(p.key);
    const res = await post(`${baseUrl(p.address)}/sync`, { d: p.deviceId, ...(await sealMsg(key, { t: Date.now(), op, payload })) });
    const out = await openMsg(key, res);
    if (!out.ok) throw new Error(out.error);
    return out.result;
  },

  // images: { name: base64 } — vault images are exchanged still encrypted
  localImages: async (inVault) => listFiles(inVault ? VAULT_IMG_DIR : IMG_DIR),
  async readImages(names, inVault) {
    const files = {};
    for (const n of names) files[n] = toB64(await readBytes(`${inVault ? VAULT_IMG_DIR : IMG_DIR}/${n}`));
    return files;
  },
  async writeImages(files, inVault) {
    for (const [n, data] of Object.entries(files)) await writeBytes(`${inVault ? VAULT_IMG_DIR : IMG_DIR}/${n}`, fromB64(data));
  },

  // ----- the computer's vault (needs the phone to be unlocked, same password)
  async openForeignVault(envelopeText) {
    if (!vault.key) return null;
    const { key, meta, env } = await foreignKeyFor(envelopeText);
    try {
      const plain = await decrypt(key, fromB64(env.iv), fromB64(env.tag), fromB64(env.data));
      Object.assign(foreign, { key, meta });
      const body = JSON.parse(new TextDecoder().decode(plain));
      return { notes: body.notes || [], folders: body.folders || [], tombstones: body.tombstones || {} };
    } catch {
      return null; // different password on the computer
    }
  },
  // Encrypt the merged vault for the computer (with its key, or ours if it had none).
  async sealForeignVault(payload) {
    const key = foreign.key || vault.key;
    const meta = foreign.meta || vault.meta;
    const body = { notes: payload.notes || [], folders: payload.folders || [], tombstones: payload.tombstones || {} };
    const { iv, tag, data } = await encrypt(key, enc(JSON.stringify(body)));
    return JSON.stringify({
      version: 1, kdf: 'scrypt', N: meta.N, r: meta.r, p: meta.p,
      salt: toB64(meta.salt), iv: toB64(iv), tag: toB64(tag), data: toB64(data),
    });
  },
  // Vault images: re-encrypt between the phone's and the computer's key.
  async importForeignVaultImages(files) {
    const from = foreign.key || vault.key;
    for (const [n, data] of Object.entries(files)) {
      const plain = await unpackImage(from, fromB64(data));
      await writeBytes(`${VAULT_IMG_DIR}/${n}`, await packImage(vault.key, plain));
    }
  },
  async exportVaultImagesForForeign(names) {
    const to = foreign.key || vault.key;
    const files = {};
    for (const n of names) {
      const plain = await unpackImage(vault.key, await readBytes(`${VAULT_IMG_DIR}/${n}`));
      files[n] = toB64(await packImage(to, plain));
    }
    return files;
  },
  // The phone has no vault yet: take the computer's as is (unlock with its password).
  async adoptVault(envelopeText, files) {
    await writeTextSafe(VAULT_FILE, envelopeText);
    await syncApi.writeImages(files, true);
  },
  endSync() { foreign.key = null; foreign.meta = null; },
};

// ---------- file folders (content stored by file id) ----------

const FILES_DIR = `${ROOT}/files`;
const INCOMING_DIR = `${ROOT}/.sync-incoming`;
const MAX_FILE = 200 * 1024 * 1024;
const CHUNK = 2 * 1024 * 1024;
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const newFileId = () => Date.now().toString(36) + hex(crypto.getRandomValues(new Uint8Array(5)));

async function readChunk(path, offset, length) {
  const { data } = await Filesystem.readFile({ path, directory: DIR, offset, length });
  let bytes = typeof data === 'string' ? fromB64(data) : new Uint8Array(await data.arrayBuffer());
  if (bytes.length > length) bytes = bytes.subarray(offset, offset + length); // web: offset not supported
  return bytes;
}
async function appendBytes(path, bytes, first) {
  if (first) await Filesystem.writeFile({ path, directory: DIR, data: toB64(bytes), recursive: true });
  else await Filesystem.appendFile({ path, directory: DIR, data: toB64(bytes) });
}
async function moveFile(from, to) {
  await remove(to);
  await mkdirp(to.slice(0, to.lastIndexOf('/')));
  await Filesystem.rename({ from, to, directory: DIR, toDirectory: DIR });
}

const filesApi = {
  inApp: true, // open files inside the app (no File Explorer on the phone)
  scan: async () => ({ newFolders: [], missingFolderIds: [], newFiles: [], changedFiles: [], missingFileIds: [] }),
  pick() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.onchange = () => resolve([...input.files]);
      input.oncancel = () => resolve([]);
      input.click();
    });
  },
  // sources: File objects from pick()
  async add(_folders, folderId, sources) {
    const added = [];
    const skipped = [];
    for (const file of sources) {
      if (file.size > MAX_FILE) { skipped.push(file.name); continue; }
      const id = newFileId();
      const h = sha256.create();
      for (let off = 0; off < file.size || off === 0; off += CHUNK) {
        const bytes = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
        h.update(bytes);
        await appendBytes(`${FILES_DIR}/${id}`, bytes, off === 0);
        if (file.size === 0) break;
      }
      const now = Date.now();
      added.push({ id, name: file.name, folderId, size: file.size, mtime: file.lastModified || now, hash: hex(h.digest()), createdAt: now, deletedAt: null });
    }
    return { added, skipped };
  },
  // Contents are stored by id, so only sync-related changes touch the disk.
  async materialize(before, after, preserve = []) {
    for (const p of preserve) {
      try { await Filesystem.copy({ from: `${FILES_DIR}/${p.fromId}`, to: `${FILES_DIR}/${p.toId}`, directory: DIR, toDirectory: DIR }); } catch { /* none */ }
    }
    for (const f of after.files || []) {
      if (await exists(`${INCOMING_DIR}/${f.id}`)) await moveFile(`${INCOMING_DIR}/${f.id}`, `${FILES_DIR}/${f.id}`);
    }
    const keep = new Set((after.files || []).map((f) => f.id));
    for (const f of before.files || []) if (!keep.has(f.id)) await remove(`${FILES_DIR}/${f.id}`);
    return { renamed: {} };
  },
  // Share to another app (LINE, e-mail, a PDF reader…). Android needs the file
  // in the app cache with its real name; that temporary copy is removed on the
  // next share or app start, so no second copy stays on the phone.
  async share(_folders, file) {
    await filesApi.clearShareCache();
    const path = `share/${file.name}`;
    await Filesystem.mkdir({ path: 'share', directory: Directory.Cache, recursive: true }).catch(() => {});
    await Filesystem.copy({ from: `${FILES_DIR}/${file.id}`, to: path, directory: DIR, toDirectory: Directory.Cache });
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
    try {
      await Share.share({ title: file.name, files: [uri], dialogTitle: '分享檔案' });
    } catch (err) {
      if (!/cancel/i.test(String(err && err.message))) throw err;
    }
  },
  // Copy to the phone's public 文件 (Documents)/DeskNotes folder, where the file
  // manager and other apps can see it. Returns the folder shown to the user.
  async copyToPhone(_folders, file) {
    try { await Filesystem.requestPermissions(); } catch { /* not needed on Android 11+ */ }
    const dir = 'DeskNotes';
    await Filesystem.mkdir({ path: dir, directory: Directory.Documents, recursive: true }).catch(() => {});
    const dot = file.name.lastIndexOf('.');
    const base = dot > 0 ? file.name.slice(0, dot) : file.name;
    const ext = dot > 0 ? file.name.slice(dot) : '';
    let name = file.name;
    for (let i = 2; ; i++) {
      try { await Filesystem.stat({ path: `${dir}/${name}`, directory: Directory.Documents }); } catch { break; }
      name = `${base} (${i})${ext}`;
    }
    await Filesystem.copy({ from: `${FILES_DIR}/${file.id}`, to: `${dir}/${name}`, directory: DIR, toDirectory: Directory.Documents });
    return `文件（Documents）/DeskNotes/${name}`;
  },
  async clearShareCache() {
    try { await Filesystem.rmdir({ path: 'share', directory: Directory.Cache, recursive: true }); } catch { /* none */ }
  },
  // A URL the WebView can play/show for in-app preview.
  async previewUrl(_folders, file) {
    const path = `${FILES_DIR}/${file.id}`;
    if (NATIVE) {
      const { uri } = await Filesystem.getUri({ path, directory: DIR });
      return Capacitor.convertFileSrc(uri);
    }
    return URL.createObjectURL(new Blob([await readBytes(path)]));
  },
  // sync transfer
  hasContent: (id) => exists(`${FILES_DIR}/${id}`),
  readChunk: async (id, offset, length) => toB64(await readChunk(`${FILES_DIR}/${id}`, offset, length)),
  async writeIncoming(id, offset, dataB64, final) {
    const part = `${INCOMING_DIR}/${id}.part`;
    await appendBytes(part, fromB64(dataB64), offset === 0);
    if (final) await moveFile(part, `${INCOMING_DIR}/${id}`);
  },
  async clearIncoming() {
    for (const f of await listFiles(INCOMING_DIR)) await remove(`${INCOMING_DIR}/${f}`);
  },
};

// ---------- public API ----------

const api = {
  platform: 'android',
  mobile: true,
  version: __APP_VERSION__,

  async load() {
    await mkdirp(IMG_DIR);
    await mkdirp(VAULT_IMG_DIR);
    await mkdirp(FILES_DIR);
    await mkdirp(INCOMING_DIR);
    try {
      return { version: 1, folders: [], notes: [], ...JSON.parse(await readText(DB_FILE)) };
    } catch {
      return { version: 1, folders: [], notes: [] };
    }
  },
  async save(db, opts) { await writeTextSafe(DB_FILE, JSON.stringify(db), opts); return true; },
  async cleanupImages() {
    const db = await api.load();
    const used = new Set();
    for (const n of db.notes) for (const r of refs(n.html, 'img')) used.add(r);
    for (const f of await listFiles(IMG_DIR)) if (!used.has(f)) await remove(`${IMG_DIR}/${f}`);
    return true;
  },

  saveImage: (buffer, mime, inVault = false) => saveImage(new Uint8Array(buffer), mime, inVault),
  pickImages(inVault = false) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.onchange = async () => {
        const urls = [];
        for (const f of input.files) urls.push(await saveImage(new Uint8Array(await f.arrayBuffer()), f.type, inVault));
        resolve(urls);
      };
      input.oncancel = () => resolve([]);
      input.click();
    });
  },

  // Image bytes for the drawing editor (same as the computer's image:read).
  async readImage(url) {
    const m = /^note-img:\/\/(img|vault)\/([\w.-]+)$/.exec(url || '');
    if (!m) return null;
    try {
      if (m[1] === 'img') return await readBytes(`${IMG_DIR}/${m[2]}`);
      if (!vault.key) return null;
      return await unpackImage(vault.key, await readBytes(`${VAULT_IMG_DIR}/${m[2]}`));
    } catch {
      return null;
    }
  },

  // Turn a stored note-img:// URL into something the WebView can display.
  async resolveImage(url) {
    const m = /^note-img:\/\/(img|vault)\/([\w.-]+)$/.exec(url);
    if (!m) return url;
    if (blobCache.has(url)) return blobCache.get(url);
    const [, host, name] = m;
    let bytes;
    try {
      if (host === 'img') {
        if (NATIVE) {
          const { uri } = await Filesystem.getUri({ path: `${IMG_DIR}/${name}`, directory: DIR });
          return Capacitor.convertFileSrc(uri);
        }
        bytes = await readBytes(`${IMG_DIR}/${name}`);
      } else {
        if (!vault.key) return '';
        bytes = await unpackImage(vault.key, await readBytes(`${VAULT_IMG_DIR}/${name}`));
      }
    } catch {
      return '';
    }
    const obj = URL.createObjectURL(new Blob([bytes], { type: mimeOf(name) }));
    blobCache.set(url, obj);
    return obj;
  },

  vault: {
    async status() { return { exists: await exists(VAULT_FILE), unlocked: !!vault.key }; },
    async create(password) {
      if (await exists(VAULT_FILE)) throw new Error('vault already exists');
      const meta = { ...KDF, salt: crypto.getRandomValues(new Uint8Array(16)) };
      const key = await deriveKey(password, meta.salt, meta);
      await writeVault({}, key, meta);
      Object.assign(vault, { key, meta, password });
      return { notes: [], folders: [] };
    },
    async unlock(password) {
      const res = await unlockWith(password);
      if (!res) return null;
      Object.assign(vault, { key: res.key, meta: res.meta, password });
      return res.payload;
    },
    async save(payload) {
      if (!vault.key) throw new Error('vault is locked');
      await writeVault(payload);
      vault.lastNotes = payload.notes || [];
      return true;
    },
    async lock() {
      if (vault.key && vault.lastNotes) {
        const used = new Set();
        for (const n of vault.lastNotes) for (const r of refs(n.html, 'vault')) used.add(r);
        for (const f of await listFiles(VAULT_IMG_DIR)) if (!used.has(f)) await remove(`${VAULT_IMG_DIR}/${f}`);
      }
      for (const [url, obj] of blobCache) if (url.startsWith('note-img://vault/')) { URL.revokeObjectURL(obj); blobCache.delete(url); }
      Object.assign(vault, { key: null, meta: null, lastNotes: null, password: null });
      foreign.key = null;
      foreign.meta = null;
      return true;
    },
    async changePassword(oldPw, newPw) {
      const res = await unlockWith(oldPw);
      if (!res) return false;
      const meta = { ...KDF, salt: crypto.getRandomValues(new Uint8Array(16)) };
      const key = await deriveKey(newPw, meta.salt, meta);
      for (const f of await listFiles(VAULT_IMG_DIR)) {
        const path = `${VAULT_IMG_DIR}/${f}`;
        await writeBytes(path, await packImage(key, await unpackImage(res.key, await readBytes(path))));
      }
      await writeVault(res.payload, key, meta);
      await remove(`${VAULT_FILE}.bak`);
      Object.assign(vault, { key, meta, password: newPw });
      foreign.key = null;
      foreign.meta = null;
      return true;
    },
    // Re-store a note's images encrypted (moving into the vault) or plain (moving out).
    async importImages(html) {
      let out = html;
      for (const name of refs(html, 'img')) {
        try {
          const bytes = await readBytes(`${IMG_DIR}/${name}`);
          await writeBytes(`${VAULT_IMG_DIR}/${name}`, await packImage(vault.key, bytes));
          out = out.split(`note-img://img/${name}`).join(`note-img://vault/${name}`);
        } catch { /* missing file: keep reference */ }
      }
      return out;
    },
    async exportImages(html) {
      let out = html;
      for (const name of refs(html, 'vault')) {
        try {
          const plain = await unpackImage(vault.key, await readBytes(`${VAULT_IMG_DIR}/${name}`));
          const url = await saveImage(plain, mimeOf(name), false);
          out = out.split(`note-img://vault/${name}`).join(url);
        } catch { /* keep */ }
      }
      return out;
    },
  },

  sync: syncApi,
  files: filesApi,

  // Desktop-only features: the renderer hides their buttons on mobile.
  importOutlook: async () => null,
  exportNote: async () => false,
  startVoice: async () => false,
  toggleOnTop: async () => false,
  editCommand: async () => {},
  onNewNote: () => {},

  // Save when the app goes to the background.
  onFlush(cb) { App.addListener('pause', () => { cb(); }); },
  // Android back button: the renderer returns true when it handled it.
  onBack(cb) {
    App.addListener('backButton', () => { if (!cb()) App.minimizeApp(); });
  },
};

window.notesAPI = api;
filesApi.clearShareCache();
document.documentElement.classList.add('mobile');
