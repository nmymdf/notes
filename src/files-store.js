// File folders on the computer: real directories under data/files with the
// files' original names, so they can be opened in File Explorer.
//
//   data/files/<folder>/<subfolder>/<name>   live files
//   data/.files-trash/<fileId>               files in the DeskNotes trash
//   data/.sync-incoming/<fileId>             content received from the phone
//
// Every folder in the normal area (db.folders) has a directory; it holds that
// folder's files (notes are not on disk). The renderer owns the records and
// calls materialize(before, after) after every change; this module moves the
// real files so the disk matches the records. scan() does the reverse: it
// picks up files added, changed or deleted directly in File Explorer.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE = 200 * 1024 * 1024;
const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
const safeSegment = (name) => (String(name).replace(BAD_CHARS, '_').replace(/[. ]+$/, '').trim() || '未命名');
const newId = () => Date.now().toString(36) + crypto.randomBytes(5).toString('hex');

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// Pick a free name in `dir` ("報價單.pdf" → "報價單 (2).pdf"), ignoring `except`.
function uniqueName(dir, name, except) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 2; fs.existsSync(path.join(dir, candidate)) && path.join(dir, candidate) !== except; i++) {
    candidate = `${base} (${i})${ext}`;
  }
  return candidate;
}

class FileStore {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'files');
    this.trashDir = path.join(dataDir, '.files-trash');
    this.incomingDir = path.join(dataDir, '.sync-incoming');
    for (const d of [this.root, this.trashDir, this.incomingDir]) fs.mkdirSync(d, { recursive: true });
  }

  // ---------- paths ----------

  folderDir(folders, folderId) {
    const f = folders.find((x) => x.id === folderId);
    if (!f) return null;
    const parent = f.parentId && folders.find((x) => x.id === f.parentId);
    return parent
      ? path.join(this.root, safeSegment(parent.name), safeSegment(f.name))
      : path.join(this.root, safeSegment(f.name));
  }
  filePath(folders, file) {
    const dir = this.folderDir(folders, file.folderId);
    return dir && path.join(dir, file.name);
  }
  trashPath(id) { return path.join(this.trashDir, id); }
  incomingPath(id) { return path.join(this.incomingDir, id); }

  // Where the content of a record currently is (live path or trash).
  contentPath(folders, file) {
    return file.deletedAt ? this.trashPath(file.id) : this.filePath(folders, file);
  }

  // ---------- adding / opening ----------

  async add(folders, folderId, sources) {
    const dir = this.folderDir(folders, folderId);
    fs.mkdirSync(dir, { recursive: true });
    const added = [];
    const skipped = [];
    for (const src of sources) {
      const st = fs.statSync(src);
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE) { skipped.push(path.basename(src)); continue; }
      const name = uniqueName(dir, safeSegment(path.basename(src)));
      const dest = path.join(dir, name);
      fs.copyFileSync(src, dest);
      const now = Date.now();
      added.push({ id: newId(), name, folderId, size: st.size, mtime: fs.statSync(dest).mtimeMs, hash: await hashFile(dest), createdAt: now, deletedAt: null });
    }
    return { added, skipped };
  }

  // A new file made inside DeskNotes (e.g. an annotated copy of a picture).
  async addBuffer(folders, folderId, name, buffer) {
    const dir = this.folderDir(folders, folderId);
    fs.mkdirSync(dir, { recursive: true });
    const finalName = uniqueName(dir, safeSegment(name));
    const dest = path.join(dir, finalName);
    fs.writeFileSync(dest, Buffer.from(buffer));
    const st = fs.statSync(dest);
    return { id: newId(), name: finalName, folderId, size: st.size, mtime: st.mtimeMs, hash: await hashFile(dest), createdAt: Date.now(), deletedAt: null };
  }

  // ---------- keep the disk in sync with the records ----------

  // before/after: { folders, files }. preserve: [{ fromId, toId }] — keep the
  // current content of fromId in the trash as toId (older version of a file
  // that the sync is about to overwrite). Returns { renamed: { id: name } }.
  materialize(before, after, preserve = []) {
    const oldById = new Map((before.files || []).map((f) => [f.id, f]));
    const renamed = {};
    for (const p of preserve) {
      const o = oldById.get(p.fromId);
      const src = o && this.contentPath(before.folders, o);
      if (src && fs.existsSync(src)) fs.copyFileSync(src, this.trashPath(p.toId));
    }
    for (const f of after.folders || []) fs.mkdirSync(this.folderDir(after.folders, f.id), { recursive: true });
    for (const n of after.files || []) {
      const o = oldById.get(n.id);
      const src = o ? this.contentPath(before.folders, o) : null;
      const incoming = this.incomingPath(n.id);
      const hasIncoming = fs.existsSync(incoming);
      if (n.deletedAt) {
        if (src && src !== this.trashPath(n.id) && fs.existsSync(src)) fs.renameSync(src, this.trashPath(n.id));
        if (hasIncoming) fs.rmSync(incoming, { force: true });
        continue;
      }
      const dir = this.folderDir(after.folders, n.folderId);
      if (!dir) continue;
      fs.mkdirSync(dir, { recursive: true });
      const wanted = path.join(dir, n.name);
      const name = uniqueName(dir, n.name, src === wanted ? wanted : undefined);
      const dest = path.join(dir, name);
      if (name !== n.name) renamed[n.id] = name;
      if (hasIncoming) {
        if (src && fs.existsSync(src) && src !== dest) fs.rmSync(src, { force: true });
        fs.rmSync(dest, { force: true });
        fs.renameSync(incoming, dest);
        // Keep the recorded modification time, so the next scan doesn't see a change.
        if (n.mtime) fs.utimesSync(dest, new Date(), new Date(n.mtime));
      } else if (src && src !== dest && fs.existsSync(src)) {
        fs.renameSync(src, dest);
      }
    }
    // Records that disappeared entirely (emptied trash, deleted on the other device).
    const newIds = new Set((after.files || []).map((f) => f.id));
    for (const o of before.files || []) {
      if (newIds.has(o.id)) continue;
      const p = this.contentPath(before.folders, o);
      if (p) fs.rmSync(p, { force: true });
    }
    this.removeEmptyDirs(after.folders || []);
    return { renamed };
  }

  // Remove directories that no longer belong to any folder (only if empty).
  removeEmptyDirs(folders) {
    const keep = new Set(folders.map((f) => this.folderDir(folders, f.id)));
    const walk = (dir, depth) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const p = path.join(dir, e.name);
        if (depth < 1) walk(p, depth + 1);
        if (!keep.has(p) && fs.readdirSync(p).length === 0) fs.rmdirSync(p);
      }
    };
    walk(this.root, 0);
  }

  // Compare the disk with the records: files/folders created, changed or
  // deleted directly in File Explorer.
  async scan(folders, files) {
    const byDir = new Map(folders.map((f) => [this.folderDir(folders, f.id), f]));
    const byPath = new Map(files.filter((f) => !f.deletedAt).map((f) => [this.filePath(folders, f), f]));
    const result = { newFolders: [], missingFolderIds: [], newFiles: [], changedFiles: [], missingFileIds: [] };
    const seenDirs = new Set();
    const seenFiles = new Set();

    const visitDir = async (dir, parentDir, depth) => {
      seenDirs.add(dir);
      const rel = path.relative(this.root, dir).split(path.sep);
      if (!byDir.has(dir)) result.newFolders.push({ dir, name: rel[rel.length - 1], parentDir: depth ? parentDir : null });
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth === 0) await visitDir(p, dir, 1); continue; }
        if (!e.isFile() || e.name.startsWith('~$') || e.name === 'desktop.ini' || e.name === 'Thumbs.db') continue;
        seenFiles.add(p);
        const st = fs.statSync(p);
        const rec = byPath.get(p);
        if (!rec) {
          if (st.size <= MAX_FILE) result.newFiles.push({ dir, name: e.name, size: st.size, mtime: st.mtimeMs, hash: await hashFile(p) });
        } else if (rec.size !== st.size || Math.abs((rec.mtime || 0) - st.mtimeMs) > 1) {
          result.changedFiles.push({ id: rec.id, size: st.size, mtime: st.mtimeMs, hash: await hashFile(p) });
        }
      }
    };
    for (const e of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (e.isDirectory()) await visitDir(path.join(this.root, e.name), null, 0);
    }
    for (const [dir, f] of byDir) if (!seenDirs.has(dir)) result.missingFolderIds.push(f.id);
    for (const [p, f] of byPath) if (!seenFiles.has(p)) result.missingFileIds.push(f.id);
    return result;
  }

  // ---------- sync transfer ----------

  readChunk(folders, file, offset, length) {
    const p = this.contentPath(folders, file);
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(length);
      const n = fs.readSync(fd, buf, 0, length, offset);
      return buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  }

  writeIncoming(id, offset, data, final) {
    const part = `${this.incomingPath(id)}.part`;
    if (offset === 0) fs.rmSync(part, { force: true });
    fs.appendFileSync(part, data);
    if (final) fs.renameSync(part, this.incomingPath(id));
  }

  clearIncoming() {
    for (const f of fs.readdirSync(this.incomingDir)) fs.rmSync(path.join(this.incomingDir, f), { force: true });
  }
}

module.exports = { FileStore, MAX_FILE, safeSegment };
