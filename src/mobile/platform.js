// Android (Capacitor) implementation of window.notesAPI — the same interface
// the Electron preload provides, so src/renderer runs unchanged on the phone.
//
// Data lives in the app's private storage (Directory.Data/desknotes), with the
// same layout and formats as the desktop app:
//   notes.json, images/, vault.enc, vault-images/
// Locked notes use the same crypto as src/vault.js: scrypt(N=2^17, r=8, p=1)
// → AES-256-GCM, so the files are interchangeable with the Windows version.

import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { App } from '@capacitor/app';
import { scryptAsync } from '@noble/hashes/scrypt.js';

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

const vault = { key: null, meta: null, lastNotes: null };
const blobCache = new Map(); // note-img URL → object URL

async function writeVault(payload, key = vault.key, meta = vault.meta) {
  const body = { notes: payload.notes || [], folders: payload.folders || [] };
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
    return { key, meta, payload: { notes: body.notes || [], folders: body.folders || [] } };
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

// ---------- public API ----------

const api = {
  platform: 'android',
  mobile: true,

  async load() {
    await mkdirp(IMG_DIR);
    await mkdirp(VAULT_IMG_DIR);
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
      Object.assign(vault, { key, meta });
      return { notes: [], folders: [] };
    },
    async unlock(password) {
      const res = await unlockWith(password);
      if (!res) return null;
      Object.assign(vault, { key: res.key, meta: res.meta });
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
      Object.assign(vault, { key: null, meta: null, lastNotes: null });
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
      Object.assign(vault, { key, meta });
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
document.documentElement.classList.add('mobile');
