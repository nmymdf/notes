// Backups of the notes, on the computer only (data/backups/<time>_<kind>/):
//
//   notes.json      the notes, folders and file records
//   vault.enc       locked notes, still encrypted with the vault password
//   images/         pictures in notes (hard links: a picture never changes
//                   once saved, so a backup costs no extra space)
//   vault-images/   encrypted pictures of locked notes (copied)
//
// The files in file folders are not included (they can be big); 備份檔案… copies
// them by hand. Kinds: daily (first start of the day), sync (before every
// phone sync is applied), restore (before 從備份找回筆記).

const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 30;
const KEEP_SYNC = 20;
const KINDS = { daily: '每日', sync: '同步前', restore: '找回前' };

const pad = (n) => String(n).padStart(2, '0');
const stampOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

function linkOrCopy(src, dest) {
  try { fs.linkSync(src, dest); } catch { fs.copyFileSync(src, dest); }
}

class Backups {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dir = path.join(dataDir, 'backups');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  create(kind = 'daily') {
    const now = new Date();
    let id = `${stampOf(now)}_${kind}`;
    for (let i = 2; fs.existsSync(path.join(this.dir, id)); i++) id = `${stampOf(now)}-${i}_${kind}`;
    const dest = path.join(this.dir, id);
    const part = `${dest}.part`;
    fs.rmSync(part, { recursive: true, force: true });
    fs.mkdirSync(part, { recursive: true });
    for (const name of ['notes.json', 'vault.enc']) {
      const src = path.join(this.dataDir, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(part, name));
    }
    for (const [sub, copy] of [['images', linkOrCopy], ['vault-images', fs.copyFileSync]]) {
      const src = path.join(this.dataDir, sub);
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.join(part, sub));
      for (const f of fs.readdirSync(src)) copy(path.join(src, f), path.join(part, sub, f));
    }
    fs.renameSync(part, dest); // a backup only counts once it is complete
    this.prune();
    return id;
  }

  // One backup a day, made on the first start of the day.
  ensureDaily() {
    if (!fs.existsSync(path.join(this.dataDir, 'notes.json'))) return; // nothing written yet
    const today = stampOf(new Date()).slice(0, 10);
    if (!this.ids().some((id) => id.startsWith(today) && id.endsWith('_daily'))) this.create('daily');
  }

  ids() {
    return fs.readdirSync(this.dir).filter((n) => /^\d{4}-\d\d-\d\d_\d{6}(-\d+)?_\w+$/.test(n)).sort().reverse();
  }

  prune() {
    const cutoff = stampOf(new Date(Date.now() - KEEP_DAYS * 86400000));
    let syncs = 0;
    for (const id of this.ids()) {
      const old = id < cutoff;
      const extraSync = id.endsWith('_sync') && ++syncs > KEEP_SYNC;
      if (old || extraSync) fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    }
    for (const n of fs.readdirSync(this.dir)) if (n.endsWith('.part')) fs.rmSync(path.join(this.dir, n), { recursive: true, force: true });
  }

  list() {
    return this.ids().map((id) => {
      const [date, time] = id.split('_');
      const kind = id.slice(id.lastIndexOf('_') + 1);
      let notes = 0;
      try { notes = JSON.parse(fs.readFileSync(path.join(this.dir, id, 'notes.json'), 'utf8')).notes.filter((n) => !n.deletedAt).length; } catch { /* empty */ }
      return {
        id,
        label: `${date.replace(/-/g, '/')} ${time.slice(0, 2)}:${time.slice(2, 4)}（${KINDS[kind] || kind}）`,
        notes,
        hasVault: fs.existsSync(path.join(this.dir, id, 'vault.enc')),
      };
    });
  }

  pathOf(id) {
    if (!this.ids().includes(id)) throw new Error('找不到這個備份');
    return path.join(this.dir, id);
  }

  readDb(id) {
    return JSON.parse(fs.readFileSync(path.join(this.pathOf(id), 'notes.json'), 'utf8'));
  }

  // Put pictures used by found notes back (only those that are missing).
  restoreImages(id, names, imagesDir) {
    const src = path.join(this.pathOf(id), 'images');
    for (const name of names) {
      const from = path.join(src, path.basename(name));
      const to = path.join(imagesDir, path.basename(name));
      if (fs.existsSync(from) && !fs.existsSync(to)) linkOrCopy(from, to);
    }
  }
}

module.exports = { Backups };
