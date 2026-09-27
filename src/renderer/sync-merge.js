// Merge rules for phone ⇄ computer sync (shared by both apps, also loadable in Node).
//
// Data: { notes: [], folders: [], tombstones: { id: deletedAt } }. Every note and
// folder carries `rev`, the time of its last change of any kind (see stamp() in
// app.js); tombstones record items that were removed for good.
//
// Rules:
//  - identical on both sides → nothing to do
//  - different → the newer (higher rev) wins
//  - both sides changed the *content* of a note since the last sync → the
//    newer one wins and the older version is kept in the trash (垃圾筒)
//  - a tombstone newer than an item's last change removes it everywhere
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SyncMerge = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const revOf = (x) => x.rev || x.updatedAt || x.createdAt || 0;
  const strip = (x) => { const { rev, ...rest } = x; return JSON.stringify(rest); };
  const contentDiffers = (a, b) => (a.title || '') !== (b.title || '') || (a.html || '') !== (b.html || '');
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function mergeData(local, remote, { lastSync = 0, now = Date.now() } = {}) {
    const tombstones = { ...(local.tombstones || {}) };
    for (const [id, t] of Object.entries(remote.tombstones || {})) {
      if (!tombstones[id] || t > tombstones[id]) tombstones[id] = t;
    }
    const conflicts = [];

    function mergeList(la = [], ra = [], isNote) {
      const L = new Map(la.map((x) => [x.id, x]));
      const R = new Map(ra.map((x) => [x.id, x]));
      const out = [];
      for (const id of new Set([...L.keys(), ...R.keys()])) {
        const l = L.get(id);
        const r = R.get(id);
        let win = l || r;
        if (l && r && strip(l) !== strip(r)) {
          const localNewer = revOf(l) >= revOf(r);
          win = localNewer ? l : r;
          const lose = localNewer ? r : l;
          const bothChanged = revOf(l) > lastSync && revOf(r) > lastSync;
          if (isNote && bothChanged && contentDiffers(l, r) && !lose.deletedAt) {
            // Keep the overwritten version in the trash so nothing is lost.
            conflicts.push({ ...lose, id: newId(), deletedAt: now, rev: now, importBatch: undefined });
          }
        }
        if (tombstones[id] && tombstones[id] >= revOf(win)) continue; // deleted for good
        out.push({ ...win });
      }
      return out;
    }

    const folders = mergeList(local.folders, remote.folders, false);
    const notes = mergeList(local.notes, remote.notes, true).concat(conflicts);

    // Repair references broken by the merge.
    const byId = new Map(folders.map((f) => [f.id, f]));
    for (const f of folders) {
      const p = f.parentId && byId.get(f.parentId);
      if (f.parentId && (!p || p.parentId)) f.parentId = null;
    }
    for (const n of notes) if (n.folderId && !byId.has(n.folderId)) n.folderId = null;

    // Forget tombstones older than a year.
    const cutoff = now - 365 * 86400000;
    for (const [id, t] of Object.entries(tombstones)) if (t < cutoff) delete tombstones[id];

    const data = { notes, folders, tombstones };
    return {
      data,
      conflicts: conflicts.length,
      toLocal: countChanges(local, data),
      toRemote: countChanges(remote, data),
    };
  }

  // How many notes/folders differ between `before` and `after` (added, changed or removed).
  function countChanges(before, after) {
    let n = 0;
    for (const key of ['notes', 'folders']) {
      const B = new Map((before[key] || []).map((x) => [x.id, strip(x)]));
      const A = new Map((after[key] || []).map((x) => [x.id, strip(x)]));
      for (const [id, s] of A) if (B.get(id) !== s) n++;
      for (const id of B.keys()) if (!A.has(id)) n++;
    }
    return n;
  }

  // note-img://<host>/<name> references used by a set of notes.
  function imageRefs(notes, host) {
    const out = new Set();
    const re = new RegExp(`note-img://${host}/([\\w.-]+)`, 'g');
    for (const n of notes) {
      let m;
      while ((m = re.exec(n.html || ''))) out.add(m[1]);
    }
    return out;
  }

  return { mergeData, countChanges, imageRefs, revOf };
}));
