// Encrypted storage for locked notes ("上鎖筆記").
//
// - Key: scrypt(password, random salt) -> 256-bit key. The password itself is
//   never stored; a wrong password simply fails GCM authentication.
// - vault.enc: JSON envelope { kdf params, salt, iv, tag, data } where data is
//   AES-256-GCM encrypted JSON of the locked notes.
// - vault-images/<name>: each image encrypted as iv(12) | tag(16) | ciphertext.
// - The derived key lives only in memory while the vault is unlocked.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KDF = { N: 2 ** 17, r: 8, p: 1 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const REF_RE = /note-img:\/\/vault\/([\w.-]+)/g;

class Vault {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'vault.enc');
    this.imagesDir = path.join(dataDir, 'vault-images');
    fs.mkdirSync(this.imagesDir, { recursive: true });
    this.key = null;
    this.meta = null; // { N, r, p, salt }
  }

  exists() { return fs.existsSync(this.file); }
  get unlocked() { return !!this.key; }

  static deriveKey(password, salt, { N, r, p }) {
    return new Promise((resolve, reject) => {
      crypto.scrypt(password.normalize('NFC'), salt, 32, { N, r, p, maxmem: SCRYPT_MAXMEM },
        (err, key) => (err ? reject(err) : resolve(key)));
    });
  }

  static encrypt(key, plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return { iv, tag: cipher.getAuthTag(), data };
  }

  static decrypt(key, iv, tag, data) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  readEnvelope() {
    const env = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    return {
      N: env.N, r: env.r, p: env.p,
      salt: Buffer.from(env.salt, 'base64'),
      iv: Buffer.from(env.iv, 'base64'),
      tag: Buffer.from(env.tag, 'base64'),
      data: Buffer.from(env.data, 'base64'),
    };
  }

  writeNotes(notes, key = this.key, meta = this.meta) {
    const { iv, tag, data } = Vault.encrypt(key, Buffer.from(JSON.stringify({ notes }), 'utf8'));
    const env = {
      version: 1, kdf: 'scrypt', N: meta.N, r: meta.r, p: meta.p,
      salt: meta.salt.toString('base64'),
      iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64'),
    };
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(env));
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    fs.renameSync(tmp, this.file);
  }

  async create(password) {
    if (this.exists()) throw new Error('vault already exists');
    const meta = { ...KDF, salt: crypto.randomBytes(16) };
    const key = await Vault.deriveKey(password, meta.salt, meta);
    this.writeNotes([], key, meta);
    this.key = key;
    this.meta = meta;
    return [];
  }

  // Returns the notes, or null when the password is wrong.
  async unlock(password) {
    const env = this.readEnvelope();
    const key = await Vault.deriveKey(password, env.salt, env);
    let plain;
    try {
      plain = Vault.decrypt(key, env.iv, env.tag, env.data);
    } catch {
      return null;
    }
    this.key = key;
    this.meta = { N: env.N, r: env.r, p: env.p, salt: env.salt };
    return JSON.parse(plain.toString('utf8')).notes || [];
  }

  lock() {
    // Unreferenced images are only removed here, after the renderer's final
    // save, so an image that was just written but not yet saved in a note survives.
    if (this.key && this.lastNotes) this.cleanupImages(this.lastNotes);
    this.lastNotes = null;
    if (this.key) this.key.fill(0);
    this.key = null;
    this.meta = null;
  }

  save(notes) {
    if (!this.key) throw new Error('vault is locked');
    this.writeNotes(notes);
    this.lastNotes = notes;
  }

  async changePassword(oldPassword, newPassword) {
    const notes = await this.unlock(oldPassword);
    if (!notes) return false;
    const oldKey = this.key;
    const meta = { ...KDF, salt: crypto.randomBytes(16) };
    const newKey = await Vault.deriveKey(newPassword, meta.salt, meta);
    for (const file of fs.readdirSync(this.imagesDir)) {
      const p = path.join(this.imagesDir, file);
      const plain = this.readImageWith(oldKey, p);
      fs.writeFileSync(p, Vault.packImage(newKey, plain));
    }
    this.writeNotes(notes, newKey, meta);
    fs.rmSync(`${this.file}.bak`, { force: true });
    this.key = newKey;
    this.meta = meta;
    return true;
  }

  // ----- images

  static packImage(key, plain) {
    const { iv, tag, data } = Vault.encrypt(key, plain);
    return Buffer.concat([iv, tag, data]);
  }

  readImageWith(key, p) {
    const buf = fs.readFileSync(p);
    return Vault.decrypt(key, buf.subarray(0, 12), buf.subarray(12, 28), buf.subarray(28));
  }

  saveImage(name, plain) {
    if (!this.key) throw new Error('vault is locked');
    fs.writeFileSync(path.join(this.imagesDir, name), Vault.packImage(this.key, Buffer.from(plain)));
    return `note-img://vault/${name}`;
  }

  readImage(name) {
    if (!this.key) return null;
    const p = path.join(this.imagesDir, path.basename(name));
    if (!fs.existsSync(p)) return null;
    return this.readImageWith(this.key, p);
  }

  cleanupImages(notes) {
    const used = new Set();
    for (const n of notes) for (const m of (n.html || '').matchAll(REF_RE)) used.add(m[1]);
    for (const file of fs.readdirSync(this.imagesDir)) {
      if (!used.has(file)) fs.rmSync(path.join(this.imagesDir, file), { force: true });
    }
  }
}

module.exports = { Vault };
