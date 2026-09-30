'use strict';

const api = window.notesAPI;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const TRASH_DAYS = 30;
// The Android build (src/mobile/platform.js) sets api.mobile.
const IS_MOBILE = !!api.mobile;

// 外觀: black (default) or white background, remembered on this device only.
function applyTheme(theme) {
  document.documentElement.classList.toggle('light', theme === 'light');
  const label = document.querySelector('#btn-theme span');
  if (label) label.textContent = theme === 'light' ? '外觀：白底' : '外觀：黑底';
}
let theme = 'dark';
try { theme = localStorage.getItem('desknotes.theme') || 'dark'; } catch { /* ignore */ }
applyTheme(theme);
document.querySelector('#btn-theme').addEventListener('click', () => {
  theme = theme === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('desknotes.theme', theme); } catch { /* ignore */ }
  applyTheme(theme);
});
const PREFS_KEY = 'desknotes.prefs';

let db = { version: 1, folders: [], notes: [] };
// Locked notes: decrypted copies live here only while the vault is unlocked.
const vault = { exists: false, unlocked: false, notes: [], folders: [], tombstones: {} };
const vaultPayload = () => ({ notes: vault.notes, folders: vault.folders, tombstones: vault.tombstones });
const state = {
  view: 'all',              // 'all' | 'starred' | 'trash' | folder id
  search: '',
  selecting: false,
  selected: new Set(),
  currentId: null,          // note open in the editor
  prefs: { sort: 'updatedAt', dir: 'desc', layout: 'grid', sidebar: true, collapsed: {} },
};

// ---------------------------------------------------------------- utils

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// On Android the WebView can't load note-img:// URLs, so api.resolveImage turns
// them into displayable ones. The stored URL is kept in data-src and restored
// before the HTML is saved. On the desktop both helpers do nothing.
// The src attribute stays in place (with an empty picture until the real one
// is ready), so the saved HTML is exactly the original when nothing was edited;
// otherwise just opening a note on the phone would count as a change.
const BLANK_IMG = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
function hydrateImages(root) {
  if (!api.resolveImage) return;
  for (const img of root.querySelectorAll('img[src^="note-img:"]')) {
    const src = img.getAttribute('src');
    img.dataset.src = src;
    img.setAttribute('src', BLANK_IMG);
    api.resolveImage(src).then((url) => { if (url && img.dataset.src === src) img.src = url; });
  }
}
function dehydrateHtml(html) {
  if (!api.resolveImage || !html.includes('data-src')) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  for (const img of tpl.content.querySelectorAll('img[data-src]')) {
    img.setAttribute('src', img.dataset.src);
    img.removeAttribute('data-src');
  }
  return tpl.innerHTML;
}

function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  }
  const opts = { month: 'long', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('zh-TW', opts);
}

function htmlToText(html) {
  const div = document.createElement('div');
  div.innerHTML = html.replace(/<(br|\/p|\/div|\/li|\/h\d)>/gi, '$&\n');
  return div.textContent.replace(/\n{3,}/g, '\n\n').trim();
}

function firstImage(html) {
  const m = /<img[^>]+src="([^"]+)"/i.exec(html || '');
  return m ? m[1] : null;
}

function noteTitle(n) {
  if (n.title && n.title.trim()) return n.title.trim();
  const firstLine = (n.text || '').split('\n').find((l) => l.trim());
  if (firstLine) return firstLine.trim().slice(0, 40);
  return /<img/i.test(n.html) ? '圖片筆記' : '未命名筆記';
}

const NOTE_COLORS = [
  { value: 'red', label: '紅' },
  { value: 'yellow', label: '黃' },
  { value: 'green', label: '綠' },
];

function setNoteColor(ids, color) {
  for (const n of [...db.notes, ...vault.notes]) if (ids.includes(n.id)) n.color = color || null;
  persist();
}

const inVaultView = () => state.view === 'vault' || folderScope(state.view) === 'vault';
const findNote = (id) => db.notes.find((x) => x.id === id) || vault.notes.find((x) => x.id === id);
const isVaultNote = (n) => vault.notes.includes(n);
const currentInVault = () => { const n = findNote(state.currentId); return !!n && isVaultNote(n); };

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), 2200);
}

function loadPrefs() {
  try { Object.assign(state.prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch { /* ignore */ }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- persistence

// ----- change tracking for sync
// Before every save, compare notes/folders with how they looked at the last
// save: changed ones get `rev` = now, removed ones leave a tombstone. This way
// every kind of edit is tracked without touching each operation.
const snapshots = { db: new Map(), vault: new Map() };
const scopeData = (scope) => (scope === 'vault' ? vault : db);

function snapshotItems(scope, bump) {
  const data = scopeData(scope);
  const snap = snapshots[scope];
  const now = Date.now();
  const seen = new Set();
  data.tombstones ||= {};
  for (const [prefix, list] of [['n', data.notes], ['f', data.folders], ['x', data.files || []]]) {
    for (const it of list) {
      const key = `${prefix}:${it.id}`;
      const { rev, ...rest } = it;
      const json = JSON.stringify(rest);
      if (!bump) it.rev ||= it.updatedAt || it.createdAt || now;
      else if (!snap.has(key) || snap.get(key) !== json) it.rev = now; // new here, or changed
      snap.set(key, json);
      seen.add(key);
    }
  }
  for (const key of [...snap.keys()]) {
    if (seen.has(key)) continue;
    snap.delete(key);
    if (bump) data.tombstones[key.slice(2)] = now;
  }
}
// Record the current state without marking anything as changed (after loading/syncing).
const resetSnapshot = (scope) => { snapshots[scope].clear(); snapshotItems(scope, false); };
function stamp() {
  snapshotItems('db', true);
  if (vault.unlocked) snapshotItems('vault', true);
}

let saveTimer = null;
function persist(immediate = false) {
  clearTimeout(saveTimer);
  const run = async () => {
    try {
      stamp();
      await api.save(db);
      if (vault.unlocked) await api.vault.save(vaultPayload());
      if (state.currentId) $('#save-state').textContent = '已儲存';
    } catch (err) {
      console.error(err);
      toast('儲存失敗：' + err.message);
    }
  };
  if (immediate) return run();
  saveTimer = setTimeout(run, 400);
  return null;
}

function purgeOldTrash() {
  const cutoff = Date.now() - TRASH_DAYS * 86400000;
  const before = db.notes.length + db.files.length;
  db.notes = db.notes.filter((n) => !n.deletedAt || n.deletedAt > cutoff);
  db.files = db.files.filter((f) => !f.deletedAt || f.deletedAt > cutoff);
  return db.notes.length + db.files.length !== before;
}

// ---------------------------------------------------------------- modal / menus

function openModal({ title, text = '', input = null, options = null, okText = '確定', cancelText = '取消', danger = false, password = false }) {
  $('#modal-cancel').textContent = cancelText;
  return new Promise((resolve) => {
    const modal = $('#modal');
    $('#modal-title').textContent = title;
    $('#modal-text').textContent = text;
    $('#modal-text').classList.toggle('hidden', !text);
    const inp = $('#modal-input');
    inp.classList.toggle('hidden', input === null);
    inp.value = input ?? '';
    inp.type = password ? 'password' : 'text';
    const sel = $('#modal-select');
    sel.classList.toggle('hidden', !options);
    sel.innerHTML = '';
    for (const o of options || []) sel.add(new Option(o.label, o.value));
    const ok = $('#modal-ok');
    ok.textContent = okText;
    ok.style.background = danger ? 'var(--danger)' : '';
    modal.classList.remove('hidden');
    setTimeout(() => (input !== null ? inp.select() : ok.focus()), 0);

    const close = (value) => {
      modal.classList.add('hidden');
      $('#modal-form').onsubmit = null;
      $('#modal-cancel').onclick = null;
      modal.onkeydown = null;
      resolve(value);
    };
    $('#modal-form').onsubmit = (e) => {
      e.preventDefault();
      if (input !== null) close((password ? inp.value : inp.value.trim()) || null);
      else if (options) close(sel.value);
      else close(true);
    };
    $('#modal-cancel').onclick = () => close(null);
    modal.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
  });
}

function showContextMenu(x, y, items) {
  const menu = $('#context-menu');
  menu.innerHTML = '';
  for (const it of items) {
    if (it.swatches) {
      const row = document.createElement('div');
      row.className = 'swatch-row';
      row.innerHTML = '<span>顏色</span>';
      for (const c of [{ value: '', title: '無色' }, ...NOTE_COLORS]) {
        const b = document.createElement('button');
        b.title = c.title || c.label;
        b.innerHTML = `<i class="dot ${c.value || 'none'}"></i>`;
        if ((it.current || '') === c.value) b.className = 'on';
        b.onclick = () => { hideContextMenu(); it.pick(c.value || null); };
        row.appendChild(b);
      }
      menu.appendChild(row);
      continue;
    }
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.danger) b.className = 'danger';
    b.onclick = () => { hideContextMenu(); it.action(); };
    menu.appendChild(b);
  }
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
function hideContextMenu() { $('#context-menu').classList.add('hidden'); }

// ---------------------------------------------------------------- folders
//
// Folders live in db.folders (normal) or vault.folders (inside the encrypted
// vault). At most two levels: a folder's parentId points to a top-level folder
// of the same scope. Siblings are ordered by `order`.

const foldersOf = (scope) => (scope === 'vault' ? vault.folders : db.folders);
const notesOf = (scope) => (scope === 'vault' ? vault.notes : db.notes);
const findFolder = (id) => (id ? db.folders.find((f) => f.id === id) || vault.folders.find((f) => f.id === id) : null);
function folderScope(id) {
  if (!id) return null;
  if (vault.folders.some((f) => f.id === id)) return 'vault';
  return db.folders.some((f) => f.id === id) ? 'db' : null;
}
function setFolders(scope, list) {
  if (scope === 'vault') vault.folders = list; else db.folders = list;
}
const childrenOf = (scope, parentId) => foldersOf(scope)
  .filter((f) => (f.parentId || null) === parentId)
  .sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
const hasChildren = (id) => foldersOf(folderScope(id)).some((f) => f.parentId === id);
// Folders in the normal area hold both notes and files (a folder's old `kind`
// field is ignored); folders in 上鎖筆記 hold notes only.
const isFileFolder = (id) => !!findFolder(id) && folderScope(id) === 'db';
const isNoteId = (id) => db.notes.some((n) => n.id === id) || vault.notes.some((n) => n.id === id);
const hasLiveFiles = (folderIds) => db.files.some((f) => !f.deletedAt && folderIds.includes(f.folderId));
function folderAndChildrenIds(id) {
  return [id, ...foldersOf(folderScope(id)).filter((f) => f.parentId === id).map((f) => f.id)];
}
function normalizeOrders(scope, parentId) {
  childrenOf(scope, parentId).forEach((f, i) => { f.order = i; });
}
// Folders whose parent no longer exists become top-level.
function repairFolders(scope) {
  const list = foldersOf(scope);
  for (const f of list) if (f.parentId && !list.some((p) => p.id === f.parentId && !p.parentId)) f.parentId = null;
}

function folderOptions(scope = 'db', includeNone = true) {
  const opts = includeNone ? [{ value: '', label: scope === 'vault' ? '（上鎖筆記，不分資料夾）' : '（未分類）' }] : [];
  for (const f of childrenOf(scope, null)) {
    opts.push({ value: f.id, label: f.name });
    for (const c of childrenOf(scope, f.id)) opts.push({ value: c.id, label: `　└ ${c.name}` });
  }
  return opts;
}

function folderLabel(id) {
  const f = findFolder(id);
  if (!f) return '';
  const parent = findFolder(f.parentId);
  return parent ? `${parent.name} › ${f.name}` : f.name;
}

// ---------------------------------------------------------------- sidebar

function renderSidebar() {
  const alive = db.notes.filter((n) => !n.deletedAt);
  $('#count-all').textContent = alive.length;
  $('#count-uncat').textContent = alive.filter((n) => !n.folderId).length || '';
  $('#count-starred').textContent = alive.filter((n) => n.starred).length || '';
  $('#count-trash').textContent = db.notes.length - alive.length || '';
  $('#count-vault').textContent = vault.unlocked ? vault.notes.length : '';
  const undoCount = lastImportIds().length;
  $('#btn-undo-import').classList.toggle('hidden', !undoCount);
  $('#btn-undo-import span').textContent = `刪除上次匯入的 ${undoCount} 則`;

  renderFolderTree($('#folder-list'), 'db', alive);
  $('#vault-folder-list').classList.toggle('hidden', !vault.unlocked);
  $('#btn-new-vault-folder').classList.toggle('hidden', !vault.unlocked);
  if (vault.unlocked) renderFolderTree($('#vault-folder-list'), 'vault', vault.notes);
  else $('#vault-folder-list').innerHTML = '';

  $$('#sidebar .nav-item').forEach((a) => a.classList.toggle('active', a.dataset.view === state.view));
  $('#sidebar').classList.toggle('collapsed', !state.prefs.sidebar && !IS_MOBILE);
}

function renderFolderTree(list, scope, notes) {
  list.innerHTML = '';
  const liveFiles = (db.files || []).filter((f) => !f.deletedAt);
  const count = (id) => {
    const ids = folderAndChildrenIds(id);
    return notes.filter((n) => ids.includes(n.folderId)).length + (scope === 'db' ? liveFiles.filter((x) => ids.includes(x.folderId)).length : 0);
  };
  for (const f of childrenOf(scope, null)) {
    const kids = childrenOf(scope, f.id);
    list.appendChild(folderRow(f, count(f.id), kids.length));
    if (kids.length && !state.prefs.collapsed[f.id]) {
      for (const c of kids) list.appendChild(folderRow(c, count(c.id), 0));
    }
  }
}

function folderRow(f, count, kidCount) {
  const a = document.createElement('a');
  a.className = 'nav-item folder-item' + (f.parentId ? ' sub' : '');
  a.dataset.view = f.id;
  a.dataset.folder = f.id;
  a.draggable = !IS_MOBILE;
  const caret = f.parentId ? ''
    : kidCount ? `<button class="caret" data-toggle="${f.id}" title="展開／收合">${state.prefs.collapsed[f.id] ? '▸' : '▾'}</button>`
      : '<i class="caret"></i>';
  const tag = db.defaultFolderId === f.id ? '<small class="default-tag" title="新筆記預設放在這裡">預設</small>' : '';
  a.innerHTML = `${caret}<svg><use href="#i-folder"/></svg><span class="name"></span>${tag}<em>${count}</em>`;
  a.querySelector('.name').textContent = f.name;
  a.title = f.name;
  return a;
}

// On the computer each normal folder is also a real directory, so two folders
// side by side can't share a name.
function nameTaken(scope, parentId, name, exceptId) {
  return scope === 'db' && childrenOf(scope, parentId).some((x) => x.id !== exceptId && x.name.trim().toLowerCase() === name.trim().toLowerCase());
}
async function newFolder(scope = 'db', parentId = null) {
  const title = parentId ? `在「${findFolder(parentId).name}」裡新增子資料夾`
    : scope === 'vault' ? '新增上鎖資料夾' : '新增資料夾';
  const name = await openModal({ title, input: '', okText: '建立' });
  if (!name) return null;
  if (nameTaken(scope, parentId, name)) { toast(`已經有叫「${name}」的資料夾`); return null; }
  const f = { id: uid(), name, createdAt: Date.now(), parentId, order: childrenOf(scope, parentId).length };
  foldersOf(scope).push(f);
  if (parentId && state.prefs.collapsed[parentId]) { delete state.prefs.collapsed[parentId]; savePrefs(); }
  if (scope === 'db') await applyFileChanges(fileLayout());
  persist();
  renderSidebar();
  return f;
}

async function renameFolder(id) {
  const f = findFolder(id);
  const name = await openModal({ title: '重新命名資料夾', input: f.name });
  if (!name) return;
  if (nameTaken(folderScope(id), f.parentId || null, name, id)) { toast(`已經有叫「${name}」的資料夾`); return; }
  const before = fileLayout();
  f.name = name;
  if (folderScope(id) === 'db') await applyFileChanges(before);
  persist();
  render();
}

async function deleteFolder(id) {
  const scope = folderScope(id);
  const f = findFolder(id);
  const ids = folderAndChildrenIds(id);
  const inside = notesOf(scope).filter((n) => ids.includes(n.folderId) && !n.deletedAt);
  const insideFiles = scope === 'db' ? db.files.filter((x) => ids.includes(x.folderId) && !x.deletedAt) : [];
  const filesText = insideFiles.length ? `\n裡面的 ${insideFiles.length} 個檔案會移到垃圾筒，${TRASH_DAYS} 天內可還原。` : '';
  const subs = ids.length - 1;
  const what = subs ? `（含 ${subs} 個子資料夾）` : '';
  let mode = 'keep';
  if (inside.length) {
    const options = scope === 'vault'
      ? [
        { value: 'destroy', label: `連同 ${inside.length} 則筆記永久刪除（上鎖筆記不會進垃圾筒）` },
        { value: 'keep', label: '只刪除資料夾，筆記留在「上鎖筆記」' },
      ]
      : [
        { value: 'trash', label: `連同 ${inside.length} 則筆記一起刪除（移到垃圾筒，30 天內可還原）` },
        { value: 'keep', label: '只刪除資料夾，筆記移到「未分類」' },
      ];
    mode = await openModal({
      title: `刪除資料夾「${f.name}」${what}？`,
      text: `裡面有 ${inside.length} 則筆記，要怎麼處理？${filesText}`,
      options, okText: '刪除', danger: true,
    });
  } else {
    mode = (await openModal({ title: `刪除資料夾「${f.name}」${what}？`, text: filesText.trim() || '資料夾是空的。', okText: '刪除', danger: true })) && 'keep';
  }
  if (!mode) return;
  const beforeFiles = fileLayout();
  const now = Date.now();
  for (const x of insideFiles) x.deletedAt = now;
  if (mode === 'trash') trashNotes(inside.map((n) => n.id));
  if (mode === 'destroy') vault.notes = vault.notes.filter((n) => !inside.includes(n));
  setFolders(scope, foldersOf(scope).filter((x) => !ids.includes(x.id)));
  for (const n of notesOf(scope)) if (ids.includes(n.folderId)) n.folderId = null;
  if (ids.includes(db.defaultFolderId)) db.defaultFolderId = null;
  if (ids.includes(state.view)) state.view = scope === 'vault' ? 'vault' : 'all';
  normalizeOrders(scope, f.parentId || null);
  if (scope === 'db') await applyFileChanges(beforeFiles);
  await persist(true);
  render();
}

async function mergeFolder(id) {
  const scope = folderScope(id);
  const f = findFolder(id);
  const ids = folderAndChildrenIds(id);
  const targets = folderOptions(scope, false).filter((o) => !ids.includes(o.value));
  if (!targets.length) { toast('沒有其他資料夾可以合併'); return; }
  const target = await openModal({
    title: `把「${f.name}」合併到…`,
    text: `「${f.name}」裡的筆記${scope === 'db' ? '和檔案' : ''}會移到選擇的資料夾，然後刪除「${f.name}」。`,
    options: targets, okText: '合併',
  });
  if (!target) return;
  const t = findFolder(target);
  const removed = [id];
  const before = fileLayout();
  const items = scope === 'db' ? [...notesOf(scope), ...db.files] : notesOf(scope);
  if (!t.parentId) {
    // Target is top-level: subfolders keep existing, now under the target.
    for (const k of foldersOf(scope).filter((x) => x.parentId === id)) { k.parentId = t.id; k.order = 1e6 + (k.order || 0); }
    for (const n of items) if (n.folderId === id) n.folderId = t.id;
  } else {
    // Target is a subfolder: everything (including subfolders' notes) goes into it.
    for (const n of items) if (ids.includes(n.folderId)) n.folderId = t.id;
    removed.push(...ids.slice(1));
  }
  setFolders(scope, foldersOf(scope).filter((x) => !removed.includes(x.id)));
  normalizeOrders(scope, t.id);
  normalizeOrders(scope, f.parentId || null);
  if (removed.includes(db.defaultFolderId)) db.defaultFolderId = t.id;
  if (removed.includes(state.view)) state.view = t.id;
  if (scope === 'db') await applyFileChanges(before);
  await persist(true);
  render();
  toast(`已合併到「${t.name}」`);
}

// Move folder `id` under `parentId` (null = top level), before sibling `beforeId` (null = last).
async function placeFolder(id, parentId, beforeId) {
  const scope = folderScope(id);
  const f = findFolder(id);
  const before = fileLayout();
  const oldParent = f.parentId || null;
  f.parentId = parentId;
  const sibs = childrenOf(scope, parentId).filter((x) => x.id !== id);
  const idx = beforeId ? sibs.findIndex((x) => x.id === beforeId) : -1;
  sibs.splice(idx < 0 ? sibs.length : idx, 0, f);
  sibs.forEach((x, i) => { x.order = i; });
  if (oldParent !== parentId) normalizeOrders(scope, oldParent);
  if (parentId && state.prefs.collapsed[parentId]) { delete state.prefs.collapsed[parentId]; savePrefs(); }
  if (scope === 'db') await applyFileChanges(before);
  persist();
  renderSidebar();
}

function folderContextMenu(e, id) {
  const f = findFolder(id);
  const scope = folderScope(id);
  const items = [];
  if (!f.parentId) items.push({ label: '新增子資料夾', action: () => newFolder(scope, id) });
  items.push({ label: '重新命名', action: () => renameFolder(id) });
  items.push({ label: '合併到其他資料夾…', action: () => mergeFolder(id) });
  if (f.parentId) items.push({ label: '移到最外層', action: () => placeFolder(id, null, null) });
  if (scope === 'db') {
    items.push({ label: '加入檔案…', action: async () => addFiles(id, await api.files.pick()) });
    if (!api.files.inApp) items.push({ label: '在檔案總管中開啟', action: () => api.files.openFolder(db.folders, id) });
    items.push({
      label: db.defaultFolderId === id ? '取消「新筆記預設資料夾」' : '設為新筆記預設資料夾',
      action: () => {
        db.defaultFolderId = db.defaultFolderId === id ? null : id;
        persist();
        renderSidebar();
        toast(db.defaultFolderId ? `新筆記會預設放在「${f.name}」` : '已取消預設資料夾');
      },
    });
    items.push({ label: '🔒 移到上鎖筆記', action: () => moveFolderToVault(id) });
  } else {
    items.push({ label: '移出上鎖筆記', action: () => moveFolderOutOfVault(id) });
  }
  items.push({ label: '刪除資料夾', danger: true, action: () => deleteFolder(id) });
  showContextMenu(e.clientX, e.clientY, items);
}

// ---------------------------------------------------------------- file folders
//
// db.files: [{ id, name, folderId, size, mtime, hash, createdAt, deletedAt, rev }]
// The computer keeps them as real files in real folders (src/files-store.js),
// the phone stores them by id (src/mobile/platform.js). After any change to the
// records, applyFileChanges() makes the disk match.

const fileLayout = () => JSON.parse(JSON.stringify({ folders: db.folders, files: db.files }));
async function applyFileChanges(before, preserve = []) {
  const { renamed } = await api.files.materialize(before, fileLayout(), preserve);
  for (const [id, name] of Object.entries(renamed || {})) {
    const f = db.files.find((x) => x.id === id);
    if (f) f.name = name;
  }
}

const EXT_KIND = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic'],
  audio: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac', 'opus'],
  video: ['mp4', 'm4v', 'webm', 'mov', '3gp', 'mkv'],
  text: ['txt', 'md', 'csv', 'log', 'json', 'xml', 'ini'],
};
function fileKind(name) {
  const ext = name.split('.').pop().toLowerCase();
  return Object.keys(EXT_KIND).find((k) => EXT_KIND[k].includes(ext)) || 'other';
}
function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const kind = fileKind(name);
  if (kind !== 'other') return { image: '🖼️', audio: '🎵', video: '🎬', text: '📝' }[kind];
  if (ext === 'pdf') return '📕';
  if (['doc', 'docx', 'odt', 'rtf'].includes(ext)) return '📘';
  if (['xls', 'xlsx', 'ods'].includes(ext)) return '📗';
  if (['ppt', 'pptx', 'odp'].includes(ext)) return '📙';
  if (['zip', 'rar', '7z', 'gz'].includes(ext)) return '📦';
  return '📄';
}
function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Pick up files added, changed or deleted directly in File Explorer (computer only).
// Adding files and scanning the folders on disk must not overlap: dragging
// files in also focuses the window, and a scan running while the files are
// being copied would record them a second time.
let filesLock = Promise.resolve();
function withFilesLock(fn) {
  const run = filesLock.then(fn, fn);
  filesLock = run.catch(() => {});
  return run;
}

let scanning = false;
function refreshFiles() {
  if (!api.files || api.files.inApp || scanning) return Promise.resolve(false);
  scanning = true;
  return withFilesLock(scanFiles).finally(() => { scanning = false; });
}
// Records pointing at the same file (left by the old double-add bug): keep one.
function dropDuplicateFiles() {
  const seen = new Set();
  const before = db.files.length;
  db.files = db.files.filter((f) => {
    if (f.deletedAt) return true;
    const key = `${f.folderId}|${f.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return db.files.length !== before;
}
async function scanFiles() {
  const deduped = dropDuplicateFiles();
  const r = await api.files.scan(db.folders, db.files);
  if (!r.newFolders.length && !r.missingFolderIds.length && !r.newFiles.length && !r.changedFiles.length && !r.missingFileIds.length) {
    if (deduped) { await persist(true); render(); }
    return deduped;
  }
  const relOf = (dir) => dir.replace(/\\/g, '/').split('/files/').pop();
  const dirToId = new Map();
  for (const f of db.folders) {
    const parent = findFolder(f.parentId);
    dirToId.set(parent ? `${parent.name}/${f.name}` : f.name, f.id);
  }
  for (const nf of r.newFolders.sort((a, b) => (a.parentDir ? 1 : 0) - (b.parentDir ? 1 : 0))) {
    const parentId = nf.parentDir ? dirToId.get(relOf(nf.parentDir)) || null : null;
    const f = { id: uid(), name: nf.name, createdAt: Date.now(), parentId, order: childrenOf('db', parentId).length };
    db.folders.push(f);
    dirToId.set(relOf(nf.dir), f.id);
  }
  const now = Date.now();
  for (const nf of r.newFiles) {
    const folderId = dirToId.get(relOf(nf.dir));
    if (folderId) db.files.push({ id: uid(), name: nf.name, folderId, size: nf.size, mtime: nf.mtime, hash: nf.hash, createdAt: now, deletedAt: null });
  }
  for (const c of r.changedFiles) Object.assign(db.files.find((f) => f.id === c.id) || {}, { size: c.size, mtime: c.mtime, hash: c.hash });
  db.files = db.files.filter((f) => !r.missingFileIds.includes(f.id));
  // A folder without a directory (a note folder from before, or one deleted in
  // File Explorer) keeps existing: folders hold notes too, which aren't on
  // disk. Its directory is created again; files that were in it are gone.
  if (r.missingFolderIds.length) await applyFileChanges(fileLayout());
  await persist(true);
  render();
  return true;
}

async function addFiles(folderId, sources) {
  if (!sources.length) return;
  syncOverlay.show('加入檔案中…');
  try {
    const { added, skipped } = await withFilesLock(async () => {
      const res = await api.files.add(db.folders, folderId, sources);
      db.files.push(...res.added);
      await persist(true);
      return res;
    });
    render();
    if (skipped.length) openModal({ title: '有檔案太大', text: `單一檔案上限 200 MB，以下檔案沒有加入：\n${skipped.join('\n')}`, okText: '好' });
    else toast(`已加入 ${added.length} 個檔案`);
  } finally {
    syncOverlay.hide();
  }
}

async function trashFiles(ids) {
  const before = fileLayout();
  const now = Date.now();
  for (const f of db.files) if (ids.includes(f.id)) f.deletedAt = now;
  await applyFileChanges(before);
  await persist(true);
  toast(`已移到垃圾筒（${ids.length} 個檔案）`);
}

async function restoreFiles(ids) {
  const before = fileLayout();
  for (const f of db.files) {
    if (!ids.includes(f.id)) continue;
    if (!isFileFolder(f.folderId)) {
      // Its folder is gone: restore into a 還原的檔案 folder.
      let target = db.folders.find((x) => x.name === '還原的檔案' && !x.parentId);
      if (!target) {
        target = { id: uid(), name: '還原的檔案', createdAt: Date.now(), parentId: null, order: childrenOf('db', null).length };
        db.folders.push(target);
      }
      f.folderId = target.id;
    }
    f.deletedAt = null;
  }
  await applyFileChanges(before);
  await persist(true);
}

async function destroyFiles(ids) {
  const before = fileLayout();
  db.files = db.files.filter((f) => !ids.includes(f.id));
  await applyFileChanges(before);
  await persist(true);
}

async function renameFile(id) {
  const f = db.files.find((x) => x.id === id);
  const name = await openModal({ title: '重新命名', input: f.name, okText: '確定' });
  if (!name || name === f.name) return;
  if (/[\\/:*?"<>|]/.test(name)) { toast('檔名不能包含 \\ / : * ? " < > |'); return; }
  const before = fileLayout();
  f.name = name;
  await applyFileChanges(before);
  await persist(true);
  render();
}

async function moveFiles(ids) {
  const opts = folderOptions('db', false);
  if (!opts.length) { toast('先建立一個資料夾'); return false; }
  const target = await openModal({ title: '移動到資料夾', options: opts, okText: '移動' });
  if (!target) return false;
  const before = fileLayout();
  for (const f of db.files) if (ids.includes(f.id)) f.folderId = target;
  await applyFileChanges(before);
  await persist(true);
  return true;
}

async function openFile(f) {
  if (!api.files.inApp) { api.files.open(db.folders, f); return; }
  const kind = fileKind(f.name);
  if (kind === 'other') { shareFile(f); return; } // pdf, Word…: pick an app that can open it
  const url = await api.files.previewUrl(db.folders, f);
  const body = $('#fp-body');
  body.innerHTML = '';
  $('#fp-name').textContent = f.name;
  fileZoom.show(null);
  if (kind === 'image') {
    body.innerHTML = `<img src="${escapeHtml(url)}" alt="">`;
    fileZoom.show(body.querySelector('img'));
  }
  else if (kind === 'audio') body.innerHTML = `<audio controls autoplay src="${escapeHtml(url)}"></audio>`;
  else if (kind === 'video') body.innerHTML = `<video controls autoplay playsinline src="${escapeHtml(url)}"></video>`;
  else if (kind === 'text') {
    const pre = document.createElement('pre');
    pre.textContent = f.size > 2 * 1024 * 1024 ? '檔案太大，無法在手機上預覽' : await (await fetch(url)).text();
    body.appendChild(pre);
  }
  $('#fp-share').onclick = () => shareFile(f);
  $('#fp-copy').onclick = () => copyFileToPhone(f);
  $('#file-preview').classList.remove('hidden');
}
async function copyFileToPhone(f) {
  syncOverlay.show('複製到手機中…');
  try {
    const where = await api.files.copyToPhone(db.folders, f);
    syncOverlay.hide();
    const open = await openModal({
      title: '已複製到手機',
      text: `${where}\n\n按「打開資料夾」會用手機的檔案 App 打開這個資料夾，可以改名、移動、分享。\n之後如果在 DeskNotes 刪除這個檔案，同步時電腦上的也會移到垃圾筒；複製到手機的這份不受影響。`,
      okText: '打開資料夾',
      cancelText: '關閉',
    });
    if (open) {
      try {
        const r = await api.files.openPhoneFolder();
        // Which way the phone used (helps if nothing shows up).
        toast(`打開方式：${r?.opened || '?'}${r?.failed ? `（${r.failed}）` : ''}`);
      } catch (err) {
        openModal({ title: '無法打開資料夾', text: `請打開手機的「檔案」或「我的檔案」App，到 文件（Documents）→ DeskNotes。\n（${err.message || err}）`, okText: '好' });
      }
    }
  } catch (err) {
    syncOverlay.hide();
    openModal({ title: '無法複製到手機', text: err.message || String(err), okText: '好' });
  }
}
async function shareFile(f) {
  try {
    await api.files.share(db.folders, f);
  } catch (err) {
    openModal({ title: '無法分享', text: err.message || String(err), okText: '好' });
  }
}
const fileZoom = IS_MOBILE ? makeZoomable($('#fp-body')) : { show() {} };
function closeFilePreview() {
  $('#fp-body').innerHTML = ''; // stops audio/video
  $('#file-preview').classList.add('hidden');
}
$('#fp-close').addEventListener('click', closeFilePreview);

function fileContextMenu(e, id) {
  const f = db.files.find((x) => x.id === id);
  const items = f.deletedAt
    ? [
      { label: '還原', action: async () => { await restoreFiles([id]); render(); } },
      { label: '永久刪除', danger: true, action: async () => {
        if (await openModal({ title: `永久刪除「${f.name}」？`, text: '此動作無法復原。', okText: '永久刪除', danger: true })) { await destroyFiles([id]); render(); }
      } },
    ]
    : [
      { label: '開啟', action: () => openFile(f) },
      ...(api.files.inApp
        ? [{ label: '複製到手機', action: () => copyFileToPhone(f) }, { label: '分享…', action: () => shareFile(f) }]
        : [
          { label: '在檔案總管中顯示', action: () => api.files.show(db.folders, f) },
          { label: '複製到桌面…', action: async () => { if (await api.files.saveCopy(db.folders, f)) toast('已存好'); } },
          ...(fileKind(f.name) === 'image' ? [{ label: '畫圖（另存新檔）', action: () => drawOnFile(f) }] : []),
        ]),
      { label: '重新命名', action: () => renameFile(id) },
      { label: '移動到…', action: async () => { if (await moveFiles([id])) render(); } },
      { label: '刪除', danger: true, action: async () => { await trashFiles([id]); render(); } },
    ];
  showContextMenu(e.clientX, e.clientY, items);
}

function visibleFiles() {
  const q = state.search.toLowerCase();
  let files;
  if (state.view === 'trash') files = (db.files || []).filter((f) => f.deletedAt);
  else if (isFileFolder(state.view)) {
    const ids = folderAndChildrenIds(state.view);
    files = (db.files || []).filter((f) => !f.deletedAt && ids.includes(f.folderId));
  } else return [];
  if (q) files = files.filter((f) => f.name.toLowerCase().includes(q));
  const { sort, dir } = state.prefs;
  const mul = dir === 'asc' ? 1 : -1;
  return files.sort((a, b) => {
    if (sort === 'title') return a.name.localeCompare(b.name, 'zh-Hant') * mul;
    if (sort === 'createdAt') return (a.createdAt - b.createdAt) * mul;
    return ((a.mtime || a.createdAt) - (b.mtime || b.createdAt)) * mul;
  });
}

function fileRow(f) {
  const row = document.createElement('div');
  row.className = 'file-row' + (state.selected.has(f.id) ? ' selected' : '');
  row.dataset.fileId = f.id;
  row.draggable = !IS_MOBILE && !f.deletedAt;
  const sub = f.folderId !== state.view && findFolder(f.folderId);
  const when = f.deletedAt
    ? `${Math.max(0, TRASH_DAYS - Math.floor((Date.now() - f.deletedAt) / 86400000))} 天後永久刪除`
    : formatDate(f.mtime || f.createdAt);
  row.innerHTML = `<span class="check"></span><span class="ficon">${fileIcon(f.name)}</span>
    <div class="fname"><b></b><small></small></div><span class="fsize">${formatSize(f.size)}</span><span class="fdate"></span>`;
  row.querySelector('b').textContent = f.name;
  row.querySelector('small').textContent = sub ? sub.name : '';
  row.querySelector('.fdate').textContent = when;
  return row;
}

// ---------------------------------------------------------------- list

function visibleNotes() {
  const inFolder = findFolder(state.view) ? folderAndChildrenIds(state.view) : null;
  if (inVaultView()) {
    let notes = vault.unlocked ? vault.notes : [];
    if (inFolder) notes = notes.filter((n) => inFolder.includes(n.folderId));
    return sortNotes(notes.filter(matchesSearch).filter(matchesColor));
  }
  return sortNotes(db.notes.filter((n) => {
    if (state.view === 'trash') return !!n.deletedAt;
    if (n.deletedAt) return false;
    if (state.view === 'starred') return n.starred;
    if (state.view === 'uncategorized') return !n.folderId;
    if (inFolder) return inFolder.includes(n.folderId);
    return true;
  }).filter(matchesSearch).filter(matchesColor));
}

function matchesColor(n) {
  const f = state.colorFilter;
  return !f || (f === 'none' ? !n.color : n.color === f);
}

function matchesSearch(n) {
  const q = state.search.toLowerCase();
  return !q || (n.title + '\n' + n.text).toLowerCase().includes(q);
}

function sortNotes(notes) {
  const { sort, dir } = state.prefs;
  const mul = dir === 'asc' ? 1 : -1;
  notes.sort((a, b) => {
    if (sort === 'title') return noteTitle(a).localeCompare(noteTitle(b), 'zh-Hant') * mul;
    return (a[sort] - b[sort]) * mul;
  });
  return notes;
}

function viewTitle() {
  if (state.view === 'all') return '所有筆記';
  if (state.view === 'starred') return '我的最愛';
  if (state.view === 'trash') return '垃圾筒';
  if (state.view === 'vault') return '上鎖筆記';
  if (state.view === 'uncategorized') return '未分類';
  return folderLabel(state.view) || '所有筆記';
}

function renderVaultGate(show) {
  const gate = $('#vault-gate');
  gate.classList.toggle('hidden', !show);
  if (!show) return;
  const creating = !vault.exists;
  $('#vault-gate-title').textContent = creating ? '建立上鎖筆記' : '上鎖筆記';
  $('#vault-gate-text').textContent = creating
    ? '設定一組密碼，這裡的筆記與圖片都會用它加密保存。\n⚠ 程式不會保存你的密碼，忘記密碼就無法找回內容，請務必記住。'
    : '輸入密碼以開啟上鎖筆記';
  $('#vault-pw2').classList.toggle('hidden', !creating);
  $('#vault-gate-ok').textContent = creating ? '設定密碼並開啟' : '解鎖';
}

function renderList() {
  const inTrash = state.view === 'trash';
  const inVault = inVaultView();
  const gate = inVault && !vault.unlocked;
  const inFiles = isFileFolder(state.view);
  $('#view-title').textContent = viewTitle();
  $('#btn-add-files').classList.toggle('hidden', !inFiles);
  $('#btn-open-dir').classList.toggle('hidden', !inFiles || !!api.files?.inApp);
  $('#btn-empty-trash').classList.toggle('hidden', !inTrash || state.selecting);
  $('#btn-new-note').classList.toggle('hidden', inTrash || gate);
  $('#btn-new-image-note').classList.toggle('hidden', inTrash || gate);
  $('#btn-new-voice-note').classList.toggle('hidden', inTrash || gate);
  $('#btn-select-mode').classList.toggle('hidden', gate);
  $('#btn-view-mode').classList.toggle('hidden', gate);
  $('#btn-vault-lock').classList.toggle('hidden', !inVault || gate);
  $('#btn-vault-password').classList.toggle('hidden', !inVault || gate);
  $('.search').classList.toggle('hidden', gate);
  $('.sortbar').classList.toggle('hidden', gate);
  $('#notes').classList.toggle('hidden', gate);
  renderVaultGate(gate);
  $('#normal-actions').classList.toggle('hidden', state.selecting);
  $('#select-actions').classList.toggle('hidden', !state.selecting);
  $('.topbar').classList.toggle('selecting', state.selecting);
  $('#btn-sel-restore').classList.toggle('hidden', !inTrash);
  $('#btn-sel-color').classList.toggle('hidden', inTrash);
  $$('#color-filter button').forEach((b) => b.classList.toggle('on', b.dataset.cf === (state.colorFilter || '')));
  $('#btn-sel-move').classList.toggle('hidden', inTrash);
  $('#btn-sel-vault').classList.toggle('hidden', inTrash || inVault);
  $('#btn-sel-unvault').classList.toggle('hidden', !inVault);
  $('#btn-sel-delete').lastChild.textContent = inTrash || inVault ? '永久刪除' : '刪除';
  $('#select-count').textContent = `已選取 ${state.selected.size} ${inFiles || inTrash ? '項' : '則'}`;
  $$('#select-actions .text-btn:not(#btn-select-all):not(#btn-select-done)')
    .forEach((b) => { b.disabled = state.selected.size === 0; });

  $('#sort-field').value = state.prefs.sort;
  $('#btn-sort-dir use').setAttribute('href', state.prefs.dir === 'asc' ? '#i-up' : '#i-down');
  $('#btn-view-mode use').setAttribute('href', { grid: '#i-grid', list: '#i-list', table: '#i-table' }[state.prefs.layout] || '#i-grid');

  const container = $('#notes');
  container.className = state.prefs.layout + (gate ? ' hidden' : '');
  container.classList.toggle('selecting', state.selecting);
  container.innerHTML = '';

  const notes = visibleNotes();
  if (state.prefs.layout === 'table' && notes.length) {
    container.insertAdjacentHTML('beforeend', '<div class="table-head"><span class="check"></span><div>標題</div><div>內容</div></div>');
  }
  for (const n of notes) {
    const card = document.createElement('div');
    card.className = 'note-card' + (n.color ? ` c-${n.color}` : '') + (state.selected.has(n.id) ? ' selected' : '');
    card.dataset.id = n.id;
    card.draggable = !inTrash && !IS_MOBILE;
    const img = firstImage(n.html);
    const snippet = (n.text || '').slice(0, 220);
    const dateText = inTrash
      ? `${Math.max(0, TRASH_DAYS - Math.floor((Date.now() - n.deletedAt) / 86400000))} 天後永久刪除`
      : formatDate(n[state.prefs.sort === 'createdAt' ? 'createdAt' : 'updatedAt']);
    if (state.prefs.layout === 'table') {
      card.innerHTML = '<span class="check"></span><div class="t-title"></div><div class="t-body"></div>';
      card.querySelector('.t-title').textContent = (n.starred && !inTrash ? '★ ' : '') + noteTitle(n);
      card.querySelector('.t-body').textContent = (img && !snippet.trim() ? '［圖片］' : '') + snippet.replace(/\s*\n+\s*/g, '　');
      card.title = dateText;
      container.appendChild(card);
      continue;
    }
    card.innerHTML = `
      <span class="check"></span>
      <div class="thumb">
        ${n.starred && !inTrash ? '<span class="star-badge"><svg><use href="#i-star"/></svg></span>' : ''}
        ${img ? `<img src="${escapeHtml(img)}" alt=""${snippet.trim() ? ' class="with-text"' : ''}>` : ''}
        <div class="snippet"></div>
      </div>
      <div class="meta"><b></b><div class="line"></div><small></small></div>`;
    card.querySelector('.snippet').textContent = snippet;
    card.querySelector('.meta b').textContent = noteTitle(n);
    card.querySelector('.meta .line').textContent = snippet.replace(/\n+/g, ' ');
    card.querySelector('.meta small').textContent = dateText;
    container.appendChild(card);
    if (img) hydrateImages(card);
  }

  // Files (in the trash, or in the open folder) come after the notes.
  const filesList = (inTrash || inFiles) && !state.colorFilter ? visibleFiles() : [];
  if (filesList.length) {
    const box = document.createElement('div');
    box.className = 'trash-files';
    box.innerHTML = '<div class="section-head">檔案</div>';
    for (const f of filesList) box.appendChild(fileRow(f));
    container.appendChild(box);
  }

  const empty = $('#empty');
  empty.classList.toggle('hidden', notes.length + filesList.length > 0 || gate);
  if (!notes.length && !filesList.length) {
    empty.innerHTML = state.search ? '找不到符合的筆記或檔案'
      : inFiles && !state.colorFilter ? `這個資料夾是空的<br><small>按「建立筆記」或「加入檔案」${api.files?.inApp ? '' : '，也可以直接把檔案拖進來'}</small>`
      : state.search ? '找不到符合的筆記'
      : state.colorFilter ? '沒有這個顏色的筆記<br><small>按「全部」可顯示所有筆記</small>'
      : inVault ? '上鎖筆記是空的<br><small>在這裡建立的筆記會加密保存，也可以在其他筆記按右鍵「移到上鎖筆記」</small>'
      : inTrash ? `垃圾筒是空的<br><small>刪除的筆記會保留 ${TRASH_DAYS} 天</small>`
        : '還沒有筆記<br><small>按「建立筆記」、Ctrl+N，或直接 Ctrl+V 貼上截圖開始</small>';
  }
}

function render() {
  renderSidebar();
  renderList();
}

function setView(view) {
  closeEditor();
  state.view = view;
  state.selecting = false;
  state.selected.clear();
  render();
  if (view === 'vault' && !vault.unlocked) setTimeout(() => $('#vault-pw').focus(), 0);
  if (isFileFolder(view)) refreshFiles();
}

// ---------------------------------------------------------------- locked notes

async function lockVault() {
  if (!vault.unlocked) return;
  if (currentInVault()) closeEditor();
  if (inVaultView()) state.view = 'vault';
  clearTimeout(saveTimer);
  stamp();
  await api.save(db);
  await api.vault.save(vaultPayload());
  vault.notes = [];
  vault.folders = [];
  vault.tombstones = {};
  snapshots.vault.clear();
  vault.unlocked = false;
  await api.vault.lock();
  if (inVaultView()) { state.selecting = false; state.selected.clear(); }
  render();
}

// Asks for the password when needed (used when moving notes in from other views).
async function ensureVaultUnlocked() {
  if (vault.unlocked) return true;
  if (!vault.exists) {
    setView('vault');
    toast('請先設定上鎖筆記的密碼');
    return false;
  }
  const pw = await openModal({ title: '輸入上鎖筆記密碼', input: '', password: true, okText: '解鎖' });
  if (!pw) return false;
  const payload = await api.vault.unlock(pw);
  if (!payload) { toast('密碼錯誤'); return false; }
  vault.notes = payload.notes;
  vault.folders = payload.folders;
  vault.tombstones = payload.tombstones || {};
  repairFolders('vault');
  resetSnapshot('vault');
  vault.unlocked = true;
  return true;
}

// folderFor(note) → vault folder id for that note (or null).
async function moveToVault(ids, folderFor = () => null, { silent = false } = {}) {
  if (!(await ensureVaultUnlocked())) return false;
  if (typeof folderFor !== 'function') { const fid = folderFor; folderFor = () => fid; }
  const moving = db.notes.filter((n) => ids.includes(n.id));
  for (const n of moving) {
    const html = await api.vault.importImages(n.html);
    vault.notes.push({ ...n, html, folderId: folderFor(n), starred: false, deletedAt: null });
  }
  db.notes = db.notes.filter((n) => !ids.includes(n.id));
  clearTimeout(saveTimer);
  stamp();
  await api.vault.save(vaultPayload());
  // Overwrite notes.json and its backup so no plaintext copy remains, then
  // remove the now-unused plain image files.
  await api.save(db, { scrub: true });
  await api.cleanupImages();
  if (!silent) toast(`已移到上鎖筆記（${moving.length} 則）`);
  return true;
}

// Copy a folder (and its subfolders) into the other scope; returns old→new id map.
function copyFolderTree(id, toScope) {
  const f = findFolder(id);
  const map = {};
  const top = { id: uid(), name: f.name, createdAt: Date.now(), parentId: null, order: childrenOf(toScope, null).length };
  foldersOf(toScope).push(top);
  map[id] = top.id;
  foldersOf(folderScope(id)).filter((k) => k.parentId === id).forEach((k, i) => {
    const c = { id: uid(), name: k.name, createdAt: Date.now(), parentId: top.id, order: i };
    foldersOf(toScope).push(c);
    map[k.id] = c.id;
  });
  return map;
}

async function moveFolderToVault(id) {
  const f = findFolder(id);
  const ids = folderAndChildrenIds(id);
  if (hasLiveFiles(ids)) {
    openModal({ title: '無法移到上鎖筆記', text: `「${f.name}」裡有檔案。上鎖筆記只能放筆記，請先把檔案移到其他資料夾。`, okText: '好' });
    return;
  }
  const beforeFiles = fileLayout();
  const inside = db.notes.filter((n) => ids.includes(n.folderId) && !n.deletedAt);
  const subs = ids.length - 1;
  const ok = await openModal({
    title: `把資料夾「${f.name}」移到上鎖筆記？`,
    text: `${subs ? `含 ${subs} 個子資料夾、` : ''}共 ${inside.length} 則筆記會加密保存，資料夾結構保留。`,
    okText: '移到上鎖筆記',
  });
  if (!ok || !(await ensureVaultUnlocked())) return;
  const map = copyFolderTree(id, 'vault');
  await moveToVault(inside.map((n) => n.id), (n) => map[n.folderId], { silent: true });
  db.folders = db.folders.filter((x) => !ids.includes(x.id));
  for (const n of db.notes) if (ids.includes(n.folderId)) n.folderId = null; // trashed ones
  if (ids.includes(db.defaultFolderId)) db.defaultFolderId = null;
  normalizeOrders('db', f.parentId || null);
  if (ids.includes(state.view)) state.view = map[state.view];
  await applyFileChanges(beforeFiles); // remove its (empty) directories
  await persist(true);
  stamp();
  await api.save(db, { scrub: true });
  render();
  toast(`已把「${f.name}」移到上鎖筆記`);
}

async function moveFolderOutOfVault(id) {
  const f = findFolder(id);
  const ids = folderAndChildrenIds(id);
  const inside = vault.notes.filter((n) => ids.includes(n.folderId));
  const ok = await openModal({
    title: `把「${f.name}」移出上鎖筆記？`,
    text: `${inside.length} 則筆記會變回一般筆記（不再加密），資料夾結構保留。`,
    okText: '移出',
  });
  if (!ok) return;
  const map = copyFolderTree(id, 'db');
  for (const n of inside) {
    const html = await api.vault.exportImages(n.html);
    db.notes.push({ ...n, html, folderId: map[n.folderId], deletedAt: null });
  }
  vault.notes = vault.notes.filter((n) => !inside.includes(n));
  vault.folders = vault.folders.filter((x) => !ids.includes(x.id));
  normalizeOrders('vault', f.parentId || null);
  if (ids.includes(state.view)) state.view = map[state.view];
  await applyFileChanges(fileLayout()); // its directories on the computer
  await persist(true);
  render();
  toast(`已把「${f.name}」移出上鎖筆記`);
}

async function moveOutOfVault(ids) {
  const moving = vault.notes.filter((n) => ids.includes(n.id));
  for (const n of moving) {
    const html = await api.vault.exportImages(n.html);
    db.notes.push({ ...n, html, folderId: null, deletedAt: null });
  }
  vault.notes = vault.notes.filter((n) => !ids.includes(n.id));
  await persist(true);
  toast(`已移出上鎖筆記（${moving.length} 則），可在「所有筆記」找到`);
}

async function destroyVaultNotes(ids) {
  const ok = await openModal({
    title: `永久刪除 ${ids.length} 則上鎖筆記？`, text: '上鎖筆記不會進垃圾筒，刪除後無法復原。', okText: '永久刪除', danger: true,
  });
  if (!ok) return false;
  vault.notes = vault.notes.filter((n) => !ids.includes(n.id));
  await persist(true);
  return true;
}

async function changeVaultPassword() {
  const oldPw = await openModal({ title: '變更密碼', text: '請輸入目前的密碼', input: '', password: true, okText: '下一步' });
  if (!oldPw) return;
  const newPw = await openModal({ title: '變更密碼', text: '請輸入新密碼（至少 4 個字元）', input: '', password: true, okText: '下一步' });
  if (!newPw) return;
  if (newPw.length < 4) { toast('密碼至少 4 個字元'); return; }
  const again = await openModal({ title: '變更密碼', text: '請再輸入一次新密碼', input: '', password: true, okText: '變更' });
  if (again !== newPw) { toast('兩次輸入的新密碼不一樣'); return; }
  flushEditor();
  await persist(true);
  toast('正在重新加密…');
  if (await api.vault.changePassword(oldPw, newPw)) toast('密碼已變更');
  else toast('目前的密碼錯誤，密碼沒有變更');
}

$('#vault-gate').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#vault-pw').value;
  const err = $('#vault-gate-error');
  const btn = $('#vault-gate-ok');
  err.textContent = '';
  if (!pw) return;
  btn.disabled = true;
  try {
    if (!vault.exists) {
      if (pw.length < 4) { err.textContent = '密碼至少 4 個字元'; return; }
      if (pw !== $('#vault-pw2').value) { err.textContent = '兩次輸入的密碼不一樣'; return; }
      btn.textContent = '建立中…';
      const payload = await api.vault.create(pw);
      vault.notes = payload.notes;
      vault.folders = payload.folders;
      vault.tombstones = {};
      resetSnapshot('vault');
      vault.exists = true;
    } else {
      btn.textContent = '解鎖中…';
      const payload = await api.vault.unlock(pw);
      if (!payload) {
        err.textContent = '密碼錯誤';
        $('#vault-pw').select();
        return;
      }
      vault.notes = payload.notes;
      vault.folders = payload.folders;
      vault.tombstones = payload.tombstones || {};
      repairFolders('vault');
      resetSnapshot('vault');
    }
    vault.unlocked = true;
    $('#vault-pw').value = '';
    $('#vault-pw2').value = '';
    render();
  } finally {
    btn.disabled = false;
    renderVaultGate(inVaultView() && !vault.unlocked);
  }
});

// Once unlocked, locked notes stay open until 「立即上鎖」 or DeskNotes is quit
// (the key only exists in memory, so quitting always locks).

// ---------------------------------------------------------------- note operations

function createNote(html = '') {
  const now = Date.now();
  const toVault = inVaultView() && vault.unlocked;
  if (inVaultView() && !vault.unlocked) state.view = 'all';
  let folderId = null;
  if (findFolder(state.view)) folderId = state.view; // current folder (normal or locked)
  else if (!toVault && state.view !== 'uncategorized' && db.folders.some((f) => f.id === db.defaultFolderId)) {
    folderId = db.defaultFolderId;
  }
  const n = {
    id: uid(), title: '', html, text: htmlToText(html), folderId,
    starred: state.view === 'starred', createdAt: now, updatedAt: now, deletedAt: null,
  };
  (toVault ? vault.notes : db.notes).push(n);
  if (state.view === 'trash') state.view = 'all';
  persist();
  openEditor(n.id);
  return n;
}

async function createImageNote() {
  const urls = await api.pickImages(inVaultView() && vault.unlocked);
  if (!urls.length) return;
  createNote(urls.map((u) => `<p><img src="${u}"></p>`).join('') + '<p><br></p>');
}

function trashNotes(ids) {
  const now = Date.now();
  for (const n of db.notes) if (ids.includes(n.id)) n.deletedAt = now;
  persist();
  toast(`已移到垃圾筒（${ids.length} 則）`);
}

function restoreNotes(ids) {
  for (const n of db.notes) {
    if (!ids.includes(n.id)) continue;
    n.deletedAt = null;
    if (n.folderId && !db.folders.some((f) => f.id === n.folderId)) n.folderId = null;
  }
  persist();
  toast(`已還原 ${ids.length} 則筆記`);
}

async function destroyNotes(ids) {
  const ok = await openModal({
    title: `永久刪除 ${ids.length} 則筆記？`, text: '此動作無法復原。', okText: '永久刪除', danger: true,
  });
  if (!ok) return false;
  db.notes = db.notes.filter((n) => !ids.includes(n.id));
  await persist(true);
  api.cleanupImages();
  return true;
}

async function moveNotes(ids) {
  const scope = vault.notes.some((n) => ids.includes(n.id)) ? 'vault' : 'db';
  const opts = folderOptions(scope);
  opts.push({ value: '__new__', label: '＋ 新增資料夾…' });
  let target = await openModal({ title: '移動到資料夾', options: opts, okText: '移動' });
  if (target === null) return false;
  if (target === '__new__') {
    const f = await newFolder(scope);
    if (!f) return false;
    target = f.id;
  }
  for (const n of notesOf(scope)) if (ids.includes(n.id)) n.folderId = target || null;
  persist();
  return true;
}

function noteContextMenu(e, id) {
  const n = findNote(id);
  if (isVaultNote(n)) {
    showContextMenu(e.clientX, e.clientY, [
      { swatches: true, current: n.color, pick: (c) => { setNoteColor([id], c); render(); } },
      { label: '開啟', action: () => openEditor(id) },
      { label: '移動到資料夾…', action: async () => { if (await moveNotes([id])) render(); } },
      { label: '移出上鎖筆記', action: async () => { await moveOutOfVault([id]); render(); } },
      { label: '永久刪除', danger: true, action: async () => { if (await destroyVaultNotes([id])) render(); } },
    ]);
    return;
  }
  const items = n.deletedAt
    ? [
      { label: '還原', action: () => { restoreNotes([id]); render(); } },
      { label: '永久刪除', danger: true, action: async () => { if (await destroyNotes([id])) render(); } },
    ]
    : [
      { swatches: true, current: n.color, pick: (c) => { setNoteColor([id], c); render(); } },
      { label: '開啟', action: () => openEditor(id) },
      { label: n.starred ? '移除最愛' : '加入我的最愛', action: () => { n.starred = !n.starred; persist(); render(); } },
      { label: '移動到資料夾…', action: async () => { if (await moveNotes([id])) render(); } },
      { label: '🔒 移到上鎖筆記', action: async () => { if (await moveToVault([id])) render(); } },
      ...(IS_MOBILE ? [] : [{ label: '複製到桌面…（存成 .html）', action: () => api.exportNote(noteTitle(n), n.html).then((ok) => ok && toast('已存好')) }]),
      { label: '建立副本', action: () => {
        const now = Date.now();
        db.notes.push({ ...n, id: uid(), title: noteTitle(n) + ' (副本)', createdAt: now, updatedAt: now });
        persist(); render();
      } },
      { label: '刪除', danger: true, action: () => { trashNotes([id]); render(); } },
    ];
  showContextMenu(e.clientX, e.clientY, items);
}

// ---------------------------------------------------------------- editor

const editor = $('#editor');

function openEditor(id) {
  const n = findNote(id);
  if (!n) return;
  if (n.deletedAt) {
    openModal({ title: '這則筆記在垃圾筒中', text: '要還原後再編輯嗎？', okText: '還原並開啟' })
      .then((ok) => { if (ok) { restoreNotes([id]); state.view = 'all'; openEditor(id); } });
    return;
  }
  state.currentId = id;
  $('#list-view').classList.add('hidden');
  $('#editor-view').classList.remove('hidden');
  $('#note-title').value = n.title;
  editor.innerHTML = n.html;
  linkify(editor);
  hydrateImages(editor);
  openedHtml = dehydrateHtml(editor.innerHTML); // linkify alone isn't an edit
  $('#save-state').textContent = '';
  const sel = $('#note-folder');
  sel.innerHTML = '';
  for (const o of folderOptions(isVaultNote(n) ? 'vault' : 'db')) sel.add(new Option(o.label, o.value));
  sel.value = n.folderId || '';
  $('#btn-star').classList.toggle('on', !!n.starred);
  $$('#note-colors button').forEach((b) => b.classList.toggle('on', b.dataset.c === (n.color || '')));
  const locked = isVaultNote(n);
  $('#vault-badge').classList.toggle('hidden', !locked);
  for (const sel of ['#btn-star', '#btn-export']) $(sel).classList.toggle('hidden', locked);
  $('#btn-delete-note').title = locked ? '永久刪除' : '刪除筆記';
  hideImageBar();
  renderSidebar();
  if (!n.html && !n.title) editor.focus();
  else {
    editor.focus();
    placeCaretAtEnd(editor);
  }
  $('.editor-scroll').scrollTop = 0;
}

function closeEditor() {
  if (!state.currentId) return;
  flushEditor();
  const n = findNote(state.currentId);
  // Drop notes that were opened and left completely empty.
  if (n && !n.title.trim() && !n.text.trim() && !/<img/i.test(n.html)) {
    db.notes = db.notes.filter((x) => x !== n);
    vault.notes = vault.notes.filter((x) => x !== n);
  }
  persist(true);
  state.currentId = null;
  editor.blur(); // a hidden editor must not keep the keyboard focus
  $('#note-title').blur();
  hideImageBar();
  closePalette();
  $('#editor-view').classList.add('hidden');
  $('#list-view').classList.remove('hidden');
  render();
}

let openedHtml = ''; // the note's HTML as shown when opened
// Selecting a picture only adds/removes a class; that alone isn't an edit.
const sameHtml = (a, b) => a.replace(/ class="(selected)?"/g, '') === b.replace(/ class="(selected)?"/g, '');

function flushEditor() {
  const n = findNote(state.currentId);
  if (!n) return;
  const html = dehydrateHtml(editor.innerHTML).replace(/ class="selected"/g, '');
  const title = $('#note-title').value;
  if ((sameHtml(n.html, html) || sameHtml(openedHtml, html)) && n.title === title) return;
  n.html = html;
  n.title = title;
  n.text = htmlToText(html);
  n.updatedAt = Date.now();
}

function onEdited() {
  $('#save-state').textContent = '編輯中…';
  flushEditor();
  persist();
}

function placeCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(range);
}

function exec(cmd, value = null) {
  editor.focus();
  document.execCommand(cmd, false, value);
  onEdited();
  updateToolbarState();
}

function updateToolbarState() {
  for (const b of $$('#toolbar [data-cmd]')) {
    const cmd = b.dataset.cmd;
    if (['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'].includes(cmd)) {
      let on = false;
      try { on = document.queryCommandState(cmd); } catch { /* ignore */ }
      b.classList.toggle('active', on);
    }
  }
  let block = '';
  try { block = document.queryCommandValue('formatBlock').toUpperCase(); } catch { /* ignore */ }
  for (const b of $$('#toolbar [data-block]')) b.classList.toggle('active', b.dataset.block === block && block !== 'P');
}

function insertChecklist() {
  editor.focus();
  const s = getSelection();
  const li = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement)?.closest('li');
  const ul = li?.parentElement;
  if (ul && ul.tagName === 'UL' && editor.contains(ul)) {
    ul.classList.toggle('checklist');
  } else {
    document.execCommand('insertUnorderedList');
    const node = getSelection().anchorNode;
    const newUl = (node?.nodeType === 1 ? node : node?.parentElement)?.closest('ul');
    if (newUl) newUl.classList.add('checklist');
  }
  onEdited();
}

// ----- images

async function insertImageFiles(files) {
  const imgs = [...files].filter((f) => f.type.startsWith('image/'));
  if (!imgs.length) return false;
  const html = [];
  for (const f of imgs) {
    const url = await api.saveImage(await f.arrayBuffer(), f.type, currentInVault());
    html.push(`<img src="${url}">`);
  }
  editor.focus();
  document.execCommand('insertHTML', false, html.join('<br>') + '<br>');
  hydrateImages(editor);
  onEdited();
  return true;
}

const ALLOWED_TAGS = new Set(['P', 'DIV', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'H1', 'H2', 'H3', 'H4',
  'UL', 'OL', 'LI', 'A', 'IMG', 'SPAN', 'BLOCKQUOTE', 'PRE', 'CODE', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'SUB', 'SUP']);

// Keep structure from pasted HTML but drop scripts, event handlers and
// foreign colors/fonts that would clash with the dark theme.
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (node) => {
    for (const child of [...node.children]) {
      if (!ALLOWED_TAGS.has(child.tagName)) {
        if (['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'IFRAME', 'OBJECT'].includes(child.tagName)) {
          child.remove();
          continue;
        }
        walk(child);
        child.replaceWith(...child.childNodes);
        continue;
      }
      for (const attr of [...child.attributes]) {
        const keep = (attr.name === 'href' && child.tagName === 'A' && /^https?:/i.test(attr.value))
          || (attr.name === 'src' && child.tagName === 'IMG' && /^(https?:|data:image\/|note-img:)/i.test(attr.value))
          || (attr.name === 'colspan' || attr.name === 'rowspan');
        if (!keep) child.removeAttribute(attr.name);
      }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

// Pasted data: URIs (e.g. from other apps) are stored as files to keep notes.json small.
async function externalizeDataImages() {
  for (const img of editor.querySelectorAll('img[src^="data:image/"]')) {
    const m = /^data:(image\/[\w+.-]+);base64,(.*)$/.exec(img.src);
    if (!m) continue;
    const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    img.src = await api.saveImage(bin.buffer, m[1], currentInVault());
  }
  hydrateImages(editor);
}

editor.addEventListener('paste', async (e) => {
  const cd = e.clipboardData;
  const files = [...cd.files];
  if (files.some((f) => f.type.startsWith('image/'))) {
    e.preventDefault();
    await insertImageFiles(files);
    return;
  }
  const html = cd.getData('text/html');
  if (html) {
    e.preventDefault();
    document.execCommand('insertHTML', false, sanitizeHtml(html));
    await externalizeDataImages();
    onEdited();
    return;
  }
  const text = cd.getData('text/plain');
  if (text) {
    e.preventDefault();
    document.execCommand('insertText', false, text);
    linkifyAtCaret();
  }
});

const scroller = $('.editor-scroll');
scroller.addEventListener('dragover', (e) => {
  if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); scroller.classList.add('dragover'); }
});
scroller.addEventListener('dragleave', () => scroller.classList.remove('dragover'));
scroller.addEventListener('drop', async (e) => {
  scroller.classList.remove('dragover');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (r && editor.contains(r.startContainer)) {
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }
  }
  await insertImageFiles(e.dataTransfer.files);
});

let selectedImg = null;
function showImageBar(img) {
  hideImageBar();
  selectedImg = img;
  img.classList.add('selected');
  const bar = $('#img-bar');
  bar.querySelector('[data-act="restore"]').classList.toggle('hidden', !readDrawing(img)?.base);
  bar.classList.remove('hidden');
  const r = img.getBoundingClientRect();
  const br = bar.getBoundingClientRect();
  bar.style.left = Math.max(8, Math.min(r.left, innerWidth - br.width - 8)) + 'px';
  bar.style.top = Math.max(8, r.top - br.height - 8) + 'px';
}
function hideImageBar() {
  if (selectedImg) selectedImg.classList.remove('selected');
  selectedImg = null;
  $('#img-bar').classList.add('hidden');
}
$('#img-bar').addEventListener('mousedown', (e) => e.preventDefault());
$('#img-bar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !selectedImg) return;
  if (b.dataset.act === 'draw') {
    drawOnImage(selectedImg);
    return;
  }
  if (b.dataset.act === 'restore') {
    restoreOriginalImage(selectedImg);
  } else if (b.dataset.act === 'delete') {
    selectedImg.remove();
  }
  hideImageBar();
  onEdited();
});
scroller.addEventListener('scroll', hideImageBar);

editor.addEventListener('click', (e) => {
  if (e.target.tagName === 'IMG') {
    if (IS_MOBILE) { editor.blur(); openLightbox(e.target); return; }
    showImageBar(e.target);
    return;
  }
  hideImageBar();
  // Toggle checklist items when clicking their checkbox area.
  const li = e.target.closest('ul.checklist > li');
  if (li && e.clientX - li.getBoundingClientRect().left < 26) {
    li.classList.toggle('done');
    onEdited();
  }
});
// Electron has no built-in context menu, so provide the basic edit commands.
editor.addEventListener('contextmenu', (e) => {
  if (IS_MOBILE) return;
  e.preventDefault();
  const cmd = (c) => () => { editor.focus(); api.editCommand(c); };
  showContextMenu(e.clientX, e.clientY, [
    { label: '剪下  (Ctrl+X)', action: cmd('cut') },
    { label: '複製  (Ctrl+C)', action: cmd('copy') },
    { label: '貼上  (Ctrl+V)', action: cmd('paste') },
    { label: '全選  (Ctrl+A)', action: cmd('selectAll') },
  ]);
});
editor.addEventListener('dblclick', (e) => {
  if (e.target.tagName !== 'IMG') return;
  hideImageBar();
  if (!IS_MOBILE && e.target.dataset.drawing) { drawOnImage(e.target); return; }
  openLightbox(e.target);
});

// ----- picture viewer. On the phone pictures can be zoomed like in a photo
// app: pinch to zoom, drag to move, double-tap to switch between fit and zoomed.
// The picture is resized (not CSS-scaled), so it stays sharp at any zoom.
function makeZoomable(box) {
  let img = null;
  let fitW = 0; let fitH = 0;
  let s = 1; let x = 0; let y = 0; // zoom and offset from the centered position
  const pts = new Map();
  let gesture = null;
  let moved = false;
  let lastTap = { t: 0, x: 0, y: 0 };

  const maxZoom = () => Math.max(8, ((img.naturalWidth || fitW) / fitW) * 4); // up to 8x, more for big pictures
  function clamp() {
    s = Math.min(Math.max(s, 1), maxZoom());
    const mx = Math.max(0, (fitW * s - box.clientWidth) / 2);
    const my = Math.max(0, (fitH * s - box.clientHeight) / 2);
    x = Math.min(mx, Math.max(-mx, x));
    y = Math.min(my, Math.max(-my, y));
  }
  function apply() {
    if (!img || !fitW) return;
    const w = fitW * s;
    const h = fitH * s;
    img.style.width = `${w}px`;
    img.style.height = `${h}px`;
    img.style.transform = `translate(${(box.clientWidth - w) / 2 + x}px, ${(box.clientHeight - h) / 2 + y}px)`;
  }
  const ensureFit = () => { if (!fitW) fit(); };
  function fit() {
    if (!img || !img.naturalWidth || !box.clientWidth) return;
    const k = Math.min(box.clientWidth / img.naturalWidth, box.clientHeight / img.naturalHeight);
    fitW = img.naturalWidth * k;
    fitH = img.naturalHeight * k;
    s = 1; x = 0; y = 0;
    apply();
  }
  // Zoom to `ns` keeping the point (px, py) (relative to the box center) in place.
  function zoomAt(ns, px, py, from = { s, x, y }) {
    s = ns;
    x = px - (px - from.x) * (s / from.s);
    y = py - (py - from.y) * (s / from.s);
    clamp();
  }
  const mid = () => { const [a, b] = [...pts.values()]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.hypot(a[0] - b[0], a[1] - b[1]) || 1]; };
  function startGesture() {
    if (pts.size >= 2) gesture = { pinch: true, m: mid(), s, x, y };
    else if (pts.size === 1) gesture = { p: [...pts.values()][0], x, y };
    else gesture = null;
  }

  // Real phones: touch events (with preventDefault) are the most dependable way
  // to get every finger, so the WebView never turns them into scrolling.
  const setTouches = (touches) => {
    const r = box.getBoundingClientRect();
    pts.clear();
    for (const t of [...touches].slice(0, 2)) pts.set(t.identifier, [t.clientX - r.left - r.width / 2, t.clientY - r.top - r.height / 2]);
  };
  box.addEventListener('touchstart', (e) => {
    if (!img || e.target.closest('button')) return;
    e.preventDefault();
    ensureFit();
    if (e.touches.length === 1) moved = false;
    setTouches(e.touches);
    startGesture();
  }, { passive: false });
  box.addEventListener('touchmove', (e) => {
    if (!img || !gesture) return;
    e.preventDefault();
    setTouches(e.touches);
    update();
  }, { passive: false });
  const touchEnd = (e) => {
    if (!img || !gesture) return;
    const t = e.changedTouches[0];
    const r = box.getBoundingClientRect();
    const p = [t.clientX - r.left - r.width / 2, t.clientY - r.top - r.height / 2];
    setTouches(e.touches);
    startGesture();
    if (e.touches.length || moved || e.type === 'touchcancel') return;
    const now = Date.now();
    if (now - lastTap.t < 350 && Math.hypot(p[0] - lastTap.x, p[1] - lastTap.y) < 50) {
      if (s > 1.05) { s = 1; x = 0; y = 0; } else zoomAt(Math.min(3, maxZoom()), p[0], p[1]);
      apply();
      lastTap = { t: 0, x: 0, y: 0 };
    } else {
      lastTap = { t: now, x: p[0], y: p[1] };
    }
  };
  box.addEventListener('touchend', touchEnd);
  box.addEventListener('touchcancel', touchEnd);
  function update() {
    if (gesture.pinch && pts.size >= 2) {
      const [mx, my, d] = mid();
      const [m0x, m0y, d0] = gesture.m;
      zoomAt(gesture.s * (d / d0), m0x, m0y, gesture);
      x += mx - m0x; // moving both fingers also moves the picture
      y += my - m0y;
      clamp();
      moved = true;
    } else if (!gesture.pinch && pts.size) {
      const [px, py] = [...pts.values()][0];
      const dx = px - gesture.p[0];
      const dy = py - gesture.p[1];
      if (Math.hypot(dx, dy) > 8) moved = true;
      x = gesture.x + dx;
      y = gesture.y + dy;
      clamp();
    }
    apply();
  }
  // Computer: mouse wheel (with or without Ctrl) zooms around the pointer,
  // dragging moves the picture.
  box.addEventListener('wheel', (e) => {
    if (!img) return;
    e.preventDefault();
    ensureFit();
    const r = box.getBoundingClientRect();
    zoomAt(s * Math.exp(-e.deltaY * 0.002), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    apply();
  }, { passive: false });
  let drag = null;
  box.addEventListener('mousedown', (e) => {
    if (!img || e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    drag = { cx: e.clientX, cy: e.clientY, x, y };
    moved = false;
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.cx;
    const dy = e.clientY - drag.cy;
    if (Math.hypot(dx, dy) > 4) moved = true;
    x = drag.x + dx;
    y = drag.y + dy;
    clamp();
    apply();
  });
  window.addEventListener('mouseup', () => { drag = null; });

  // ＋ / － buttons: always work, even without gestures.
  box.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!img) return;
    ensureFit();
    zoomAt(b.dataset.zoom === 'in' ? s * 1.6 : s / 1.6, 0, 0);
    apply();
  }));
  window.addEventListener('resize', fit);

  // A pinch that started on the picture in the note continues here.
  return {
    pinchFrom(touches) { ensureFit(); setTouches(touches); startGesture(); },
    pinchTo(touches) { if (!gesture) return; ensureFit(); setTouches(touches); if (pts.size >= 2) update(); },
    pinchEnd() { pts.clear(); gesture = null; },
    zoomBy(k, cx, cy) {
      ensureFit();
      const r = box.getBoundingClientRect();
      zoomAt(s * k, cx - r.left - r.width / 2, cy - r.top - r.height / 2);
      apply();
    },
    zoomed: () => s > 1.02,
    dragged: () => moved,
    show(el) {
      img = el;
      pts.clear();
      gesture = null;
      fitW = 0;
      s = 1; x = 0; y = 0;
      box.classList.toggle('zoom-box', !!img);
      if (!img) return;
      img.draggable = false;
      img.onload = fit;
      if (img.complete && img.naturalWidth) requestAnimationFrame(fit);
    },
  };
}
const lightboxZoom = makeZoomable($('#lightbox'));
// Version and author at the top of the sidebar (the phone's menu) and in the window title.
if (api.version) {
  $('#app-version').textContent = api.version;
  document.title = `DeskNotes ${api.version}  —  作者: ArchieKUO`;
}
let lightboxSource = null; // the picture in the note, for 刪除
function openLightbox(src) {
  const img = $('#lightbox img');
  img.removeAttribute('style');
  img.src = src.src || src;
  lightboxSource = src.tagName === 'IMG' && editor.contains(src) ? src : null;
  $('#lb-delete').classList.toggle('hidden', !lightboxSource);
  $('#lb-draw').classList.toggle('hidden', !lightboxSource);
  $('#lb-restore').classList.toggle('hidden', !readDrawing(lightboxSource || img)?.base || !lightboxSource);
  $('#lightbox').classList.remove('hidden');
  lightboxZoom.show(img);
}
const closeLightbox = () => $('#lightbox').classList.add('hidden');
// Computer: a plain click closes the picture, unless it was zoomed or dragged.
$('#lightbox').addEventListener('click', (e) => {
  if (!IS_MOBILE && !e.target.closest('button') && !lightboxZoom.zoomed() && !lightboxZoom.dragged()) closeLightbox();
});
// Ctrl + mouse wheel on a picture in the note opens it zoomed.
editor.addEventListener('wheel', (e) => {
  if (IS_MOBILE || !e.ctrlKey || e.target.tagName !== 'IMG') return;
  e.preventDefault();
  hideImageBar();
  openLightbox(e.target);
  if (e.deltaY < 0) lightboxZoom.zoomBy(1.5, e.clientX, e.clientY);
}, { passive: false });
$('#lb-close').addEventListener('click', closeLightbox);
$('#lb-draw').addEventListener('click', () => { const img = lightboxSource; closeLightbox(); if (img) drawOnImage(img); });
$('#lb-restore').addEventListener('click', () => { const img = lightboxSource; closeLightbox(); if (img) restoreOriginalImage(img); });
$('#lb-delete').addEventListener('click', async () => {
  const img = lightboxSource;
  closeLightbox();
  if (!img || !(await openModal({ title: '刪除這張圖片？', okText: '刪除', danger: true }))) return;
  img.remove();
  onEdited();
});

// On the phone a picture in the note opens the viewer: tap it, or put two
// fingers on it and spread them (the pinch carries on in the viewer).
if (IS_MOBILE) {
  let handing = false;
  editor.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    const img = [...e.touches].map((t) => t.target).find((t) => t.tagName === 'IMG');
    if (!img) return;
    e.preventDefault();
    handing = true;
    editor.blur();
    openLightbox(img);
    lightboxZoom.pinchFrom(e.touches);
  }, { passive: false });
  editor.addEventListener('touchmove', (e) => {
    if (!handing) return;
    e.preventDefault();
    lightboxZoom.pinchTo(e.touches);
  }, { passive: false });
  const endHandoff = (e) => { if (handing && e.touches.length < 2) { handing = false; lightboxZoom.pinchEnd(); } };
  editor.addEventListener('touchend', endHandoff);
  editor.addEventListener('touchcancel', endHandoff);
}

// ----- drawing (desktop only; the editor itself is in drawing.js)
// A drawing is stored as a normal PNG image in the note, plus data-drawing
// with every stroke, so it can be edited again later. When drawing on a
// picture, data-drawing.base keeps the original picture so it can be restored.

const DRAW_MAX = 4000; // longest side of the canvas, in pixels
const askDrawText = () => openModal({ title: '輸入文字', input: '' });
const imageSrcOf = (img) => img.dataset.src || img.getAttribute('src');
function readDrawing(img) {
  try { return img.dataset.drawing ? JSON.parse(img.dataset.drawing) : null; } catch { return null; }
}
function imageSize(url) {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve({ w: i.naturalWidth || 1000, h: i.naturalHeight || 1000 });
    i.onerror = () => reject(new Error('圖片載入失敗'));
    i.src = url;
  });
}
const imageMime = (name) => (/\.svg$/i.test(name) ? 'image/svg+xml' : '');
// A blob: copy of the picture, which the canvas is allowed to export.
async function imageBlobUrl(src) {
  const bytes = await api.readImage(src);
  if (!bytes) throw new Error(/\/vault\//.test(src) ? '上鎖筆記已上鎖，無法讀取圖片' : '找不到原始圖片');
  return URL.createObjectURL(new Blob([bytes], { type: imageMime(src) }));
}
function fitDrawing({ w, h }) {
  const k = Math.min(1, DRAW_MAX / Math.max(w, h));
  return { w: Math.round(w * k), h: Math.round(h * k) };
}
function setNoteImage(img, src, drawing) {
  img.removeAttribute('data-src');
  img.setAttribute('src', src);
  if (drawing) img.dataset.drawing = JSON.stringify(drawing);
  else img.removeAttribute('data-drawing');
}

async function newDrawing() {
  hideImageBar();
  const noteId = state.currentId;
  if (!noteId) return;
  const s = getSelection();
  const saved = s.rangeCount && editor.contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null;
  if (IS_MOBILE) editor.blur(); // close the keyboard
  const size = IS_MOBILE ? { w: 1000, h: 1400 } : { w: 1600, h: 1000 }; // phone: portrait page
  const res = await DrawingEditor.open({ drawing: { v: 1, ...size, bg: 'white', items: [] }, title: '畫圖', askText: askDrawText });
  if (!res || state.currentId !== noteId) return;
  if (res.error) { toast(res.error); return; }
  try {
    const url = await api.saveImage(await res.blob.arrayBuffer(), 'image/png', currentInVault());
    editor.focus();
    if (saved) { s.removeAllRanges(); s.addRange(saved); } else placeCaretAtEnd(editor);
    document.execCommand('insertHTML', false, `<img src="${url}" data-drawing="${escapeHtml(JSON.stringify(res.drawing))}"><br>`);
    hydrateImages(editor);
    onEdited();
  } catch (err) {
    toast(`無法儲存畫圖：${err.message || err}`);
  }
}
$('#btn-draw').addEventListener('click', newDrawing);
// Phone: the toolbar scrolls sideways, so put 畫圖 first where it's seen.
if (IS_MOBILE) {
  const b = $('#btn-draw');
  b.classList.add('draw-first');
  b.insertAdjacentHTML('beforeend', '<span>畫圖</span>');
  $('#toolbar').prepend(b);
}

// Draw on a picture in the note, or edit an earlier drawing again.
async function drawOnImage(img) {
  hideImageBar();
  const noteId = state.currentId;
  const old = readDrawing(img);
  const base = old ? old.base : imageSrcOf(img);
  let url = null;
  let res;
  try {
    let drawing = old;
    if (base) {
      url = await imageBlobUrl(base);
      if (!drawing) drawing = { v: 1, ...fitDrawing(await imageSize(url)), bg: 'image', base, items: [] };
    }
    res = await DrawingEditor.open({ drawing, baseUrl: url, title: base ? '在圖片上畫' : '畫圖', askText: askDrawText });
  } catch (err) {
    toast(err.message || String(err));
    return;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
  if (!res || state.currentId !== noteId || !editor.contains(img)) return;
  if (res.error) { toast(res.error); return; }
  if (base && !res.drawing.items.length) {
    setNoteImage(img, base, null); // everything erased: back to the original picture
  } else {
    try {
      setNoteImage(img, await api.saveImage(await res.blob.arrayBuffer(), 'image/png', currentInVault()), res.drawing);
    } catch (err) {
      toast(`無法儲存畫圖：${err.message || err}`);
      return;
    }
  }
  hydrateImages(editor);
  onEdited();
}

async function restoreOriginalImage(img) {
  const d = readDrawing(img);
  if (!d?.base) return;
  if (!(await openModal({ title: '還原原圖？', text: '畫在圖片上的內容會被移除。', okText: '還原' }))) return;
  if (!editor.contains(img)) return;
  setNoteImage(img, d.base, null);
  hydrateImages(editor);
  onEdited();
}

// Pictures in file folders: draw, then save as a new file next to the original.
async function drawOnFile(f) {
  let url = null;
  let res;
  try {
    url = URL.createObjectURL(new Blob([await api.files.read(db.folders, f)], { type: imageMime(f.name) }));
    const size = fitDrawing(await imageSize(url));
    res = await DrawingEditor.open({
      drawing: { v: 1, ...size, bg: 'image', items: [] },
      baseUrl: url,
      title: `在「${f.name}」上畫（完成後另存新檔，原檔不變）`,
      askText: askDrawText,
    });
  } catch (err) {
    toast(err.message || String(err));
    return;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
  if (!res) return;
  if (res.error) { toast(res.error); return; }
  try {
    const stem = f.name.replace(/\.[^.]+$/, '');
    const buf = await res.blob.arrayBuffer();
    const rec = await withFilesLock(async () => {
      const r = await api.files.addBuffer(db.folders, f.folderId, `${stem}（標註）.png`, buf);
      db.files.push(r);
      await persist(true);
      return r;
    });
    render();
    toast(`已另存為「${rec.name}」`);
  } catch (err) {
    openModal({ title: '無法儲存', text: err.message || String(err), okText: '好' });
  }
}

editor.addEventListener('input', onEdited);
editor.addEventListener('keyup', updateToolbarState);
editor.addEventListener('mouseup', updateToolbarState);
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const inList = getSelection().anchorNode?.parentElement?.closest('li');
    if (inList) exec(e.shiftKey ? 'outdent' : 'indent');
    else if (!e.shiftKey) exec('insertText', '　　');
  }
  if (e.key === 'Enter') {
    // A new checklist item should start unchecked.
    setTimeout(() => {
      const node = getSelection().anchorNode;
      const li = (node?.nodeType === 1 ? node : node?.parentElement)?.closest('ul.checklist > li');
      if (li && !li.textContent.trim()) li.classList.remove('done');
    });
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedImg) {
    e.preventDefault();
    selectedImg.remove();
    hideImageBar();
    onEdited();
  }
});
// ----- web addresses in notes become links; a click opens them in the browser.
const URL_RE = /https?:\/\/[^\s<>"'，。、「」）]+/g;
const TRAIL_RE = /[.,;:!?)\]}'"]+$/;
// Turn plain-text addresses under `root` into <a> links. An address that the
// caret touches is left alone (it may still be being typed).
function linkify(root, caret = null) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (t) => (t.parentElement.closest('a') || !/https?:\/\//.test(t.data) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let changed = false;
  for (const t of nodes) {
    const text = t.data;
    const frag = document.createDocumentFragment();
    let last = 0;
    let caretAt = null;
    for (const m of text.matchAll(URL_RE)) {
      const url = m[0].replace(TRAIL_RE, '');
      const end = m.index + url.length;
      if (caret && caret.node === t && caret.offset >= m.index && caret.offset <= end) continue;
      frag.append(text.slice(last, m.index));
      const a = document.createElement('a');
      a.href = url;
      a.textContent = url;
      frag.append(a);
      last = end;
    }
    if (!last) continue;
    const rest = document.createTextNode(text.slice(last));
    frag.append(rest);
    if (caret && caret.node === t && caret.offset >= last) caretAt = [rest, caret.offset - last];
    t.replaceWith(frag);
    changed = true;
    if (caretAt) {
      const r = document.createRange();
      r.setStart(...caretAt);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }
  }
  return changed;
}
function linkifyAtCaret() {
  const s = getSelection();
  const caret = s.rangeCount && s.anchorNode && s.anchorNode.nodeType === 3 ? { node: s.anchorNode, offset: s.anchorOffset } : null;
  if (linkify(editor, caret)) onEdited();
}
// After a space or Enter the address before it is complete.
editor.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter' || e.key === 'Tab') linkifyAtCaret(); });
editor.addEventListener('blur', () => { if (state.currentId) linkifyAtCaret(); });
editor.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || !/^https?:/i.test(a.getAttribute('href'))) return;
  e.preventDefault();
  if (IS_MOBILE) location.assign(a.href); // the app opens it in the phone's browser
  else window.open(a.href);
});

$('#note-title').addEventListener('input', onEdited);
$('#note-title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); editor.focus(); }
});

$('#toolbar').addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) e.preventDefault(); // keep editor selection
});
$('#toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.cmd) exec(b.dataset.cmd);
  else if (b.dataset.block) exec('formatBlock', b.dataset.block);
});
$('#btn-checklist').addEventListener('click', insertChecklist);
$('#btn-insert-hr').addEventListener('click', () => exec('insertHorizontalRule'));

async function startVoice() {
  hideImageBar();
  editor.focus();
  const s = getSelection();
  if (!s.rangeCount || !editor.contains(s.anchorNode)) placeCaretAtEnd(editor);
  toast('啟動語音輸入…開始說話，再按一次 Win+H 停止');
  if (!(await api.startVoice())) toast('無法啟動語音輸入，請直接按 Win+H');
}
$('#btn-voice').addEventListener('click', startVoice);
$('#btn-insert-image').addEventListener('click', async () => {
  const s = getSelection();
  const saved = s.rangeCount && editor.contains(s.anchorNode) ? s.getRangeAt(0) : null;
  const urls = await api.pickImages(currentInVault());
  if (!urls.length) return;
  editor.focus();
  if (saved) { s.removeAllRanges(); s.addRange(saved); } else placeCaretAtEnd(editor);
  document.execCommand('insertHTML', false, urls.map((u) => `<img src="${u}">`).join('<br>') + '<br>');
  hydrateImages(editor);
  onEdited();
});

// ----- text color / highlight: one click applies the current color,
// the ▾ opens an in-app palette (with "none" to remove the color).

const COLOR_KINDS = {
  fore: {
    cmd: 'foreColor', prop: 'color', title: '文字顏色', noneLabel: '預設顏色（移除文字顏色）',
    colors: ['#ff5252', '#ff9800', '#ffeb3b', '#66bb6a', '#26c6da', '#42a5f5',
      '#7e57c2', '#ec407a', '#bdbdbd', '#8d6e63', '#ffffff', '#757575'],
  },
  hilite: {
    cmd: 'hiliteColor', prop: 'background-color', title: '螢光筆', noneLabel: '無螢光（移除螢光筆）',
    colors: ['#665c00', '#7a4a00', '#7f1d1d', '#1b5e20', '#004d40', '#0d47a1',
      '#4a148c', '#880e4f', '#3e2723', '#37474f', '#424242', '#1a237e'],
  },
};
const currentColor = { fore: '#ff5252', hilite: '#665c00' };
// Temporary marker color used to find and strip color from the selection.
const MARKER = '#010203';
const MARKER_RGB = 'rgb(1, 2, 3)';
let savedColorRange = null;

try { Object.assign(currentColor, JSON.parse(localStorage.getItem('desknotes.colors') || '{}')); } catch { /* ignore */ }

function updateColorMarks() {
  $('#mark-fore').style.borderBottomColor = currentColor.fore;
  $('#mark-hilite').style.background = currentColor.hilite;
}

function saveEditorRange() {
  const s = getSelection();
  savedColorRange = s.rangeCount && editor.contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null;
}

function restoreEditorRange() {
  if (!savedColorRange) return false;
  editor.focus();
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(savedColorRange);
  return true;
}

function stripMarker(prop) {
  for (const el of editor.querySelectorAll('font[color], [style]')) {
    if (prop === 'color' && el.tagName === 'FONT' && el.getAttribute('color').toLowerCase() === MARKER) {
      el.removeAttribute('color');
    }
    if (el.style && el.style.getPropertyValue(prop) === MARKER_RGB) {
      el.style.removeProperty(prop);
      if (!el.getAttribute('style')) el.removeAttribute('style');
    }
    if ((el.tagName === 'FONT' || el.tagName === 'SPAN') && !el.attributes.length) el.replaceWith(...el.childNodes);
  }
}

function applyColor(kind, color) {
  const k = COLOR_KINDS[kind];
  const s = getSelection();
  if (!s.rangeCount || !editor.contains(s.anchorNode)) return;
  if (s.isCollapsed) { toast('請先選取要上色的文字'); return; }
  document.execCommand('styleWithCSS', false, kind === 'hilite');
  if (color) {
    document.execCommand(k.cmd, false, color);
  } else {
    document.execCommand(k.cmd, false, MARKER);
    stripMarker(k.prop);
  }
  document.execCommand('styleWithCSS', false, false);
  onEdited();
}

function openPalette(kind, anchor) {
  const k = COLOR_KINDS[kind];
  const pal = $('#color-palette');
  pal.dataset.kind = kind;
  pal.querySelector('.palette-title').textContent = k.title;
  pal.querySelector('.none-label').textContent = k.noneLabel;
  const sw = pal.querySelector('.swatches');
  sw.innerHTML = '';
  for (const c of k.colors) {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === currentColor[kind] ? ' current' : '');
    b.style.background = c;
    b.dataset.color = c;
    b.title = c;
    sw.appendChild(b);
  }
  $('#custom-color').value = currentColor[kind];
  pal.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const pr = pal.getBoundingClientRect();
  pal.style.left = Math.max(8, Math.min(r.left - 30, innerWidth - pr.width - 8)) + 'px';
  pal.style.top = r.bottom + 6 + 'px';
}

function closePalette() { $('#color-palette').classList.add('hidden'); }

function pickColor(kind, color) {
  if (color) {
    currentColor[kind] = color;
    try { localStorage.setItem('desknotes.colors', JSON.stringify(currentColor)); } catch { /* ignore */ }
    updateColorMarks();
  }
  if (restoreEditorRange()) applyColor(kind, color);
}

$('#toolbar').addEventListener('click', (e) => {
  const apply = e.target.closest('[data-color-apply]');
  const menu = e.target.closest('[data-color-menu]');
  if (apply) {
    closePalette();
    applyColor(apply.dataset.colorApply, currentColor[apply.dataset.colorApply]);
  } else if (menu) {
    const pal = $('#color-palette');
    if (!pal.classList.contains('hidden') && pal.dataset.kind === menu.dataset.colorMenu) { closePalette(); return; }
    saveEditorRange();
    openPalette(menu.dataset.colorMenu, menu);
  }
});
const palette = $('#color-palette');
palette.addEventListener('mousedown', (e) => { if (e.target.id !== 'custom-color') e.preventDefault(); });
palette.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-color]');
  if (!b) return;
  closePalette();
  pickColor(palette.dataset.kind, b.dataset.color || null);
});
$('#custom-color').addEventListener('change', (e) => {
  closePalette();
  pickColor(palette.dataset.kind, e.target.value);
});
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#color-palette, [data-color-menu]')) closePalette();
});
updateColorMarks();

$('#btn-back').addEventListener('click', closeEditor);
$('#note-colors').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !state.currentId) return;
  setNoteColor([state.currentId], b.dataset.c);
  $$('#note-colors button').forEach((x) => x.classList.toggle('on', x === b));
});
$('#color-filter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.colorFilter = b.dataset.cf || null;
  renderList();
});
$('#btn-sel-color').addEventListener('click', (e) => {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  showContextMenu(r.left, r.bottom + 4, [{
    swatches: true,
    current: '-',
    pick: (c) => {
      setNoteColor([...state.selected], c);
      toast(c ? `已設定 ${state.selected.size} 則的顏色` : `已移除 ${state.selected.size} 則的顏色`);
      state.selected.clear();
      state.selecting = false;
      render();
    },
  }]);
});
$('#note-folder').addEventListener('change', (e) => {
  const n = findNote(state.currentId);
  n.folderId = e.target.value || null;
  persist();
  renderSidebar();
});
$('#btn-star').addEventListener('click', () => {
  const n = findNote(state.currentId);
  n.starred = !n.starred;
  $('#btn-star').classList.toggle('on', n.starred);
  persist();
  renderSidebar();
});
$('#btn-on-top').addEventListener('click', async () => {
  const on = await api.toggleOnTop();
  $('#btn-on-top').classList.toggle('on', on);
  toast(on ? '視窗已置頂' : '已取消置頂');
});
$('#btn-export').addEventListener('click', async () => {
  flushEditor();
  const n = findNote(state.currentId);
  if (isVaultNote(n)) return;
  if (await api.exportNote(noteTitle(n), n.html)) toast('已匯出');
});
$('#btn-delete-note').addEventListener('click', async () => {
  const id = state.currentId;
  flushEditor();
  if (currentInVault()) {
    if (!(await destroyVaultNotes([id]))) return;
  } else {
    trashNotes([id]);
  }
  state.currentId = null;
  $('#editor-view').classList.add('hidden');
  $('#list-view').classList.remove('hidden');
  render();
});

// ---------------------------------------------------------------- list interactions

let lastClickedId = null;
$('#notes').addEventListener('click', (e) => {
  const row = e.target.closest('.file-row');
  if (row) {
    const id = row.dataset.fileId;
    const f = db.files.find((x) => x.id === id);
    if (state.selecting || e.ctrlKey || e.shiftKey) {
      state.selecting = true;
      const order = visibleFiles().map((x) => x.id);
      if (e.shiftKey && lastClickedId && order.includes(lastClickedId)) {
        const [a, b] = [order.indexOf(lastClickedId), order.indexOf(id)].sort((x, y) => x - y);
        for (const x of order.slice(a, b + 1)) state.selected.add(x);
      } else if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      lastClickedId = id;
      renderList();
    } else if (f.deletedAt) {
      fileContextMenu(e, id);
    } else {
      openFile(f);
    }
    return;
  }
  const card = e.target.closest('.note-card');
  if (!card) return;
  const id = card.dataset.id;
  if (state.selecting || e.ctrlKey || e.shiftKey) {
    state.selecting = true;
    const order = visibleNotes().map((n) => n.id);
    if (e.shiftKey && lastClickedId && order.includes(lastClickedId)) {
      // Shift+click selects everything between the last clicked note and this one.
      const [a, b] = [order.indexOf(lastClickedId), order.indexOf(id)].sort((x, y) => x - y);
      for (const x of order.slice(a, b + 1)) state.selected.add(x);
    } else if (state.selected.has(id)) {
      state.selected.delete(id);
    } else {
      state.selected.add(id);
    }
    lastClickedId = id;
    renderList();
  } else {
    openEditor(id);
  }
});
$('#notes').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.file-row');
  if (row) { e.preventDefault(); fileContextMenu(e, row.dataset.fileId); return; }
  const card = e.target.closest('.note-card');
  if (!card) return;
  e.preventDefault();
  noteContextMenu(e, card.dataset.id);
});

// Dropping the item outside the window (desktop, a folder in File Explorer)
// saves a copy there: Windows fetches it from the given URL.
function setDragOut(e, mime, name, url) {
  if (IS_MOBILE) return;
  const safe = name.replace(/[\\/:*?"<>|]/g, '_');
  e.dataTransfer.setData('DownloadURL', `${mime}:${safe}:${url}`);
}

// drag notes onto folders / trash in the sidebar
$('#notes').addEventListener('dragstart', (e) => {
  const row = e.target.closest('.file-row');
  if (row) {
    const ids = state.selected.has(row.dataset.fileId) ? [...state.selected].filter((id) => !isNoteId(id)) : [row.dataset.fileId];
    e.dataTransfer.setData('application/x-file-ids', JSON.stringify(ids));
    const f = db.files.find((x) => x.id === row.dataset.fileId);
    if (ids.length === 1 && f) setDragOut(e, 'application/octet-stream', f.name, `note-img://drag-file/${f.id}`);
    e.dataTransfer.effectAllowed = 'copyMove';
    return;
  }
  const card = e.target.closest('.note-card');
  if (!card) return;
  const ids = state.selected.has(card.dataset.id) ? [...state.selected].filter(isNoteId) : [card.dataset.id];
  e.dataTransfer.setData('application/x-note-ids', JSON.stringify(ids));
  const n = db.notes.find((x) => x.id === card.dataset.id); // not locked notes: they stay encrypted
  if (ids.length === 1 && n) setDragOut(e, 'text/html', `${noteTitle(n)}.html`, `note-img://drag-note/${n.id}`);
  e.dataTransfer.effectAllowed = 'copyMove';
});
// Files dragged in from File Explorer → add to the open file folder (computer).
const scrollerList = $('#notes');
scrollerList.addEventListener('dragover', (e) => {
  if (isFileFolder(state.view) && [...e.dataTransfer.types].includes('Files') && api.files.pathOf) {
    e.preventDefault();
    scrollerList.classList.add('dragover');
  }
});
scrollerList.addEventListener('dragleave', () => scrollerList.classList.remove('dragover'));
scrollerList.addEventListener('drop', (e) => {
  scrollerList.classList.remove('dragover');
  if (!isFileFolder(state.view) || !e.dataTransfer.files.length || !api.files.pathOf) return;
  e.preventDefault();
  addFiles(state.view, [...e.dataTransfer.files].map((f) => api.files.pathOf(f)).filter(Boolean));
});

// Sidebar drag & drop:
//  - notes onto 所有筆記/未分類/a folder/上鎖筆記/a locked folder/垃圾筒
//  - folders: between two folders = reorder; onto a top-level folder = become
//    its subfolder; onto the 資料夾 header = top level; onto 上鎖筆記 = lock it.
let dragFolderId = null;
function clearDropMarks() {
  $$('.drop-target, .drop-before, .drop-after').forEach((x) => x.classList.remove('drop-target', 'drop-before', 'drop-after'));
}

function folderDrop(e, target) {
  const src = findFolder(dragFolderId);
  if (!src) return null;
  const scope = folderScope(src.id);
  const srcHasKids = hasChildren(src.id);
  if (target.classList.contains('nav-section')) {
    return scope === 'db' ? { mark: 'drop-target', run: () => placeFolder(src.id, null, null) } : null;
  }
  const v = target.dataset.view;
  if (v === 'vault') {
    if (scope === 'db' && hasLiveFiles(folderAndChildrenIds(src.id))) return null; // 上鎖筆記 holds notes only
    return scope === 'db'
      ? { mark: 'drop-target', run: () => moveFolderToVault(src.id) }
      : { mark: 'drop-target', run: () => placeFolder(src.id, null, null) };
  }
  const t = findFolder(v);
  if (!t || t.id === src.id || folderScope(t.id) !== scope) return null;
  const r = target.getBoundingClientRect();
  const pos = (e.clientY - r.top) / r.height;
  if (pos > 0.28 && pos < 0.72 && !t.parentId) {
    if (srcHasKids || t.id === src.parentId) return null; // two levels at most
    return { mark: 'drop-target', run: () => placeFolder(src.id, t.id, null) };
  }
  const parent = t.parentId || null;
  if (parent && srcHasKids) return null;
  const sibs = childrenOf(scope, parent).filter((x) => x.id !== src.id);
  const before = pos <= 0.5 ? t.id : (sibs[sibs.findIndex((x) => x.id === t.id) + 1]?.id || null);
  return { mark: pos <= 0.5 ? 'drop-before' : 'drop-after', run: () => placeFolder(src.id, parent, before) };
}

async function dropNotes(ids, v) {
  const fromVault = vault.notes.some((n) => ids.includes(n.id));
  const toVault = v === 'vault' || folderScope(v) === 'vault';
  if (fromVault) {
    if (!toVault) { toast('上鎖筆記要移出，請按右鍵「移出上鎖筆記」'); return; }
    for (const n of vault.notes) if (ids.includes(n.id)) n.folderId = v === 'vault' ? null : v;
    persist();
    toast(`已移動 ${ids.length} 則筆記`);
  } else if (toVault) {
    if (!(await moveToVault(ids, v === 'vault' ? null : v))) return;
  } else if (v === 'trash') {
    trashNotes(ids);
  } else {
    for (const n of db.notes) if (ids.includes(n.id)) n.folderId = v === 'all' || v === 'uncategorized' ? null : v;
    persist();
    toast(`已移動 ${ids.length} 則筆記`);
  }
  state.selected.clear();
  render();
}

$('#sidebar').addEventListener('dragstart', (e) => {
  const row = e.target.closest?.('.folder-item');
  if (!row) return;
  dragFolderId = row.dataset.folder;
  e.dataTransfer.setData('application/x-folder-id', dragFolderId);
  e.dataTransfer.effectAllowed = 'move';
});
$('#sidebar').addEventListener('dragend', () => { dragFolderId = null; clearDropMarks(); });
$('#sidebar').addEventListener('dragover', (e) => {
  const types = [...e.dataTransfer.types];
  const target = e.target.closest?.('.nav-item, .nav-section');
  clearDropMarks();
  if (!target) return;
  if (types.includes('application/x-folder-id')) {
    const act = folderDrop(e, target);
    if (!act) return;
    e.preventDefault();
    target.classList.add(act.mark);
  } else if (types.includes('application/x-note-ids')) {
    const v = target.dataset.view;
    if (!v || v === 'starred') return;
    e.preventDefault();
    target.classList.add('drop-target');
  } else if (types.includes('application/x-file-ids') || (types.includes('Files') && api.files.pathOf)) {
    const v = target.dataset.view;
    if (!isFileFolder(v) && !(v === 'trash' && types.includes('application/x-file-ids'))) return;
    e.preventDefault();
    target.classList.add('drop-target');
  }
});
$('#sidebar').addEventListener('dragleave', (e) => {
  if (!e.relatedTarget || !$('#sidebar').contains(e.relatedTarget)) clearDropMarks();
});
$('#sidebar').addEventListener('drop', (e) => {
  const target = e.target.closest?.('.nav-item, .nav-section');
  if ([...e.dataTransfer.types].includes('application/x-folder-id')) {
    const act = target && folderDrop(e, target);
    clearDropMarks();
    dragFolderId = null;
    if (!act) return;
    e.preventDefault();
    act.run();
    return;
  }
  clearDropMarks();
  const v = target && target.dataset.view;
  const fileIds = e.dataTransfer.getData('application/x-file-ids');
  if (fileIds && v) {
    e.preventDefault();
    const ids = JSON.parse(fileIds);
    (async () => {
      if (v === 'trash') await trashFiles(ids);
      else if (isFileFolder(v)) {
        const before = fileLayout();
        for (const f of db.files) if (ids.includes(f.id)) f.folderId = v;
        await applyFileChanges(before);
        await persist(true);
        toast(`已移動 ${ids.length} 個檔案`);
      }
      state.selected.clear();
      render();
    })();
    return;
  }
  if (isFileFolder(v) && e.dataTransfer.files.length && api.files.pathOf) {
    e.preventDefault();
    addFiles(v, [...e.dataTransfer.files].map((f) => api.files.pathOf(f)).filter(Boolean));
    return;
  }
  const raw = e.dataTransfer.getData('application/x-note-ids');
  if (!target || !raw || !v) return;
  e.preventDefault();
  dropNotes(JSON.parse(raw), v);
});

$('#sidebar').addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    e.preventDefault();
    const id = toggle.dataset.toggle;
    if (state.prefs.collapsed[id]) delete state.prefs.collapsed[id]; else state.prefs.collapsed[id] = true;
    savePrefs();
    renderSidebar();
    return;
  }
  if (e.target.closest('#btn-new-vault-folder')) {
    e.preventDefault();
    newFolder('vault');
    return;
  }
  const item = e.target.closest('.nav-item');
  if (item) {
    // Double-click a folder to rename it. Detected here because the first click
    // re-renders the sidebar, so the browser's dblclick never fires.
    const now = Date.now();
    if (item.dataset.folder && lastFolderClick.id === item.dataset.folder && now - lastFolderClick.at < 400) {
      lastFolderClick.id = null;
      renameFolder(item.dataset.folder);
      return;
    }
    lastFolderClick.id = item.dataset.folder || null;
    lastFolderClick.at = now;
    setView(item.dataset.view);
    closeDrawer();
  }
});
$('#sidebar').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.folder-item');
  if (row) {
    e.preventDefault();
    folderContextMenu(e, row.dataset.folder);
    return;
  }
  if (e.target.closest('.nav-item[data-view="vault"]')) {
    if (!vault.unlocked) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: '新增上鎖資料夾', action: () => newFolder('vault') },
      { label: '立即上鎖', action: () => { lockVault(); toast('已上鎖'); } },
    ]);
    return;
  }
  if (e.target.closest('.nav-section, #folder-list') || e.target.tagName === 'NAV') {
    e.preventDefault();
    newFolderMenu(e);
  }
});
const lastFolderClick = { id: null, at: 0 };
function newFolderMenu(e) {
  newFolder('db', null);
}
$('#btn-new-folder').addEventListener('click', (e) => { e.stopPropagation(); newFolderMenu(e); });
$('#btn-toggle-sidebar').addEventListener('click', () => {
  state.prefs.sidebar = !state.prefs.sidebar;
  savePrefs();
  renderSidebar();
});

// ----- Outlook 2010 notes (CSV export) → one DeskNotes note per Outlook note

function textToHtml(text) {
  return text.split('\n').map((l) => `<div>${l ? escapeHtml(l) : '<br>'}</div>`).join('');
}

// Outlook puts title and text in one field (記事本文). The title is the text up
// to the first space (half/full width), tab, line break or colon, at most
// TITLE_MAX characters; the rest becomes the content.
const TITLE_MAX = 30;
function splitTitle(text) {
  const t = text.replace(/^[\s\u3000]+/, '');
  const m = /[ \t\n\u3000:：]/.exec(t);
  const end = m && m.index > 0 ? Math.min(m.index, TITLE_MAX) : Math.min(t.length, TITLE_MAX);
  const title = t.slice(0, end).trim();
  let rest = t.slice(end);
  if (m && m.index === end) rest = rest.slice(1); // drop the separator itself
  return { title, body: rest };
}

// Turn CSV rows into {title, body}. With a title column (e.g. English
// "Subject") it is used as is; otherwise the title is split off the content.
function outlookRowsToNotes(rows, titleCol, bodyCol) {
  const out = [];
  for (const r of rows) {
    let raw = (bodyCol >= 0 ? r[bodyCol] || '' : '').replace(/\r\n?/g, '\n');
    let title = titleCol >= 0 ? (r[titleCol] || '').trim() : '';
    if (title) {
      const lines = raw.split('\n');
      while (lines.length && !lines[0].trim()) lines.shift();
      if (lines.length && lines[0].trim() === title) lines.shift(); // Outlook repeats the subject
      raw = lines.join('\n');
    } else {
      ({ title, body: raw } = splitTitle(raw));
    }
    const body = raw.replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, '');
    if (title || body) out.push({ title, body });
  }
  return out;
}

function openImportDialog(res) {
  return new Promise((resolve) => {
    const dlg = $('#import-dialog');
    const tSel = $('#import-title');
    const bSel = $('#import-body');
    const sample = (c) => {
      const v = (res.rows.find((r) => (r[c] || '').trim()) || [])[c] || '';
      return v.replace(/\s+/g, ' ').trim().slice(0, 24);
    };
    tSel.innerHTML = '';
    bSel.innerHTML = '';
    tSel.add(new Option('（自動：取內容開頭到第一個空格／換行／冒號）', '-1'));
    bSel.add(new Option('（無）', '-1'));
    res.columns.forEach((name, i) => {
      const label = `${name}${sample(i) ? `　例：${sample(i)}` : '　（空白）'}`;
      tSel.add(new Option(label, String(i)));
      bSel.add(new Option(label, String(i)));
    });
    tSel.value = String(res.guess.title);
    bSel.value = String(res.guess.body);

    const existing = new Set(db.notes.filter((n) => !n.deletedAt).map((n) => n.title + '\u0000' + n.text));
    let fresh = [];
    const update = () => {
      const notes = outlookRowsToNotes(res.rows, +tSel.value, +bSel.value);
      fresh = notes.filter((o) => !existing.has(o.title + '\u0000' + htmlToText(textToHtml(o.body))));
      const skipped = notes.length - fresh.length;
      $('#import-summary').textContent = `「${res.file}」共 ${res.rows.length} 列，可匯入 ${notes.length} 則記事`
        + (skipped ? `（其中 ${skipped} 則已匯入過，會略過）` : '')
        + '。\n請確認下方預覽的標題和內容正確；不對的話，換一下上面的欄位。';
      const prev = $('#import-preview');
      prev.innerHTML = '<div class="row head"><div>標題</div><div>內容</div></div>';
      for (const n of notes.slice(0, 5)) {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = '<div></div><div></div>';
        row.children[0].textContent = n.title || '（空白）';
        row.children[1].textContent = n.body || '（空白）';
        if (!n.title) row.children[0].classList.add('empty-cell');
        if (!n.body) row.children[1].classList.add('empty-cell');
        prev.appendChild(row);
      }
      $('#import-ok').textContent = fresh.length ? `匯入 ${fresh.length} 則` : '沒有可匯入的記事';
      $('#import-ok').disabled = !fresh.length;
    };
    tSel.onchange = update;
    bSel.onchange = update;
    update();

    const close = (value) => {
      dlg.classList.add('hidden');
      $('#import-form').onsubmit = null;
      $('#import-cancel').onclick = null;
      dlg.onkeydown = null;
      resolve(value);
    };
    $('#import-form').onsubmit = (e) => { e.preventDefault(); close(fresh); };
    $('#import-cancel').onclick = () => close(null);
    dlg.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    dlg.classList.remove('hidden');
  });
}

async function importOutlook() {
  const res = await api.importOutlook();
  if (!res) return;
  if (!res.rows.length) {
    openModal({ title: '找不到記事', text: `「${res.file}」裡沒有資料。請確認是從 Outlook 的「記事」資料夾匯出的 CSV 檔。`, okText: '知道了' });
    return;
  }
  const fresh = await openImportDialog(res);
  if (!fresh || !fresh.length) return;

  const FOLDER = 'Outlook 記事';
  let folder = db.folders.find((f) => f.name === FOLDER);
  if (!folder) {
    folder = { id: uid(), name: FOLDER, createdAt: Date.now(), parentId: null, order: childrenOf('db', null).length };
    db.folders.push(folder);
  }
  // CSV has no dates; keep the file's order under the default "newest first" sort.
  // Every note remembers its import batch so the whole import can be undone.
  const now = Date.now();
  const batch = uid();
  fresh.forEach((o, i) => {
    const html = textToHtml(o.body);
    const ts = now - i;
    db.notes.push({
      id: uid(), title: o.title, html, text: htmlToText(html), folderId: folder.id,
      starred: false, createdAt: ts, updatedAt: ts, deletedAt: null, importBatch: batch,
    });
  });
  db.lastImport = { batch, file: res.file, at: now };
  await persist(true);
  setView(folder.id);
  toast(`已匯入 ${fresh.length} 則 Outlook 記事`);
}
$('#btn-import-outlook').addEventListener('click', importOutlook);

const lastImportIds = () => (db.lastImport
  ? db.notes.filter((n) => !n.deletedAt && n.importBatch === db.lastImport.batch).map((n) => n.id)
  : []);
$('#btn-undo-import').addEventListener('click', async () => {
  const ids = lastImportIds();
  if (!ids.length) return;
  const ok = await openModal({
    title: `刪除上次匯入的 ${ids.length} 則筆記？`,
    text: `來源：${db.lastImport.file}\n筆記會移到垃圾筒，30 天內可以還原。`,
    okText: '刪除', danger: true,
  });
  if (!ok) return;
  closeEditor();
  trashNotes(ids);
  render();
});

$('#btn-new-note').addEventListener('click', () => createNote());
$('#btn-new-image-note').addEventListener('click', createImageNote);
$('#btn-new-voice-note').addEventListener('click', () => { createNote(); startVoice(); });
$('#btn-select-mode').addEventListener('click', () => {
  state.selecting = true;
  state.selected.clear();
  lastClickedId = null;
  renderList();
  toast('點選筆記來選取；按住 Shift 點另一則可一次選取中間全部');
});
$('#btn-select-done').addEventListener('click', () => { state.selecting = false; state.selected.clear(); renderList(); });
$('#btn-select-all').addEventListener('click', () => {
  const ids = [...visibleNotes(), ...visibleFiles()].map((n) => n.id);
  const all = ids.every((id) => state.selected.has(id));
  state.selected = new Set(all ? [] : ids);
  renderList();
});
$('#btn-sel-delete').addEventListener('click', async () => {
  const all = [...state.selected];
  const fileIds = all.filter((id) => db.files.some((f) => f.id === id));
  const ids = all.filter((id) => !fileIds.includes(id));
  if (fileIds.length) {
    if (state.view === 'trash') {
      if (!(await openModal({ title: `永久刪除 ${fileIds.length + ids.length} 項？`, text: '此動作無法復原。', okText: '永久刪除', danger: true }))) return;
      await destroyFiles(fileIds);
      if (ids.length) { db.notes = db.notes.filter((n) => !ids.includes(n.id)); await persist(true); api.cleanupImages(); }
    } else {
      await trashFiles(fileIds);
      if (ids.length) trashNotes(ids);
    }
    state.selected.clear();
    state.selecting = false;
    render();
    return;
  }
  if (state.view === 'trash') { if (!(await destroyNotes(ids))) return; }
  else if (inVaultView()) { if (!(await destroyVaultNotes(ids))) return; }
  else trashNotes(ids);
  state.selected.clear();
  state.selecting = false;
  render();
});
$('#btn-sel-restore').addEventListener('click', async () => {
  const fileIds = [...state.selected].filter((id) => db.files.some((f) => f.id === id));
  if (fileIds.length) await restoreFiles(fileIds);
  restoreNotes([...state.selected].filter((id) => !fileIds.includes(id)));
  state.selected.clear();
  state.selecting = false;
  render();
});
$('#btn-sel-move').addEventListener('click', async () => {
  const fileIds = [...state.selected].filter((id) => !isNoteId(id));
  const noteIds = [...state.selected].filter(isNoteId);
  if (fileIds.length && noteIds.length) {
    // Notes and files together: one folder for both (files need a folder).
    const target = await openModal({ title: '移動到資料夾', options: folderOptions('db', false), okText: '移動' });
    if (!target) return;
    for (const n of db.notes) if (noteIds.includes(n.id)) n.folderId = target;
    const before = fileLayout();
    for (const f of db.files) if (fileIds.includes(f.id)) f.folderId = target;
    await applyFileChanges(before);
    await persist(true);
  } else if (fileIds.length) {
    if (!(await moveFiles(fileIds))) return;
  } else if (!(await moveNotes(noteIds))) return;
  state.selected.clear();
  state.selecting = false;
  render();
});
$('#btn-sel-vault').addEventListener('click', async () => {
  const noteIds = [...state.selected].filter(isNoteId);
  if (noteIds.length < state.selected.size) toast('檔案不能放進上鎖筆記，只移動筆記');
  if (!noteIds.length || !(await moveToVault(noteIds))) return;
  state.selected.clear();
  state.selecting = false;
  render();
});
$('#btn-sel-unvault').addEventListener('click', async () => {
  await moveOutOfVault([...state.selected]);
  state.selected.clear();
  state.selecting = false;
  render();
});
$('#btn-vault-lock').addEventListener('click', () => { lockVault(); toast('已上鎖'); });
$('#btn-vault-password').addEventListener('click', changeVaultPassword);
$('#btn-empty-trash').addEventListener('click', async () => {
  const ids = db.notes.filter((n) => n.deletedAt).map((n) => n.id);
  const fileIds = db.files.filter((f) => f.deletedAt).map((f) => f.id);
  if (!ids.length && !fileIds.length) return;
  if (!(await openModal({ title: `清空垃圾筒（${ids.length + fileIds.length} 項）？`, text: '此動作無法復原。', okText: '清空', danger: true }))) return;
  db.notes = db.notes.filter((n) => !n.deletedAt);
  await destroyFiles(fileIds);
  api.cleanupImages();
  render();
});
$('#btn-add-files').addEventListener('click', async () => addFiles(state.view, await api.files.pick()));
$('#btn-open-dir').addEventListener('click', () => api.files.openFolder(db.folders, state.view));
const LAYOUTS = [
  { value: 'grid', label: '卡片' },
  { value: 'list', label: '清單' },
  { value: 'table', label: '標題＋內容（兩欄）' },
];
$('#btn-view-mode').addEventListener('click', (e) => {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  showContextMenu(r.left, r.bottom + 4, LAYOUTS.map((l) => ({
    label: (state.prefs.layout === l.value ? '✓ ' : '　 ') + l.label,
    action: () => { state.prefs.layout = l.value; savePrefs(); renderList(); },
  })));
});
$('#sort-field').addEventListener('change', (e) => { state.prefs.sort = e.target.value; savePrefs(); renderList(); });
$('#btn-sort-dir').addEventListener('click', () => {
  state.prefs.dir = state.prefs.dir === 'asc' ? 'desc' : 'asc';
  savePrefs();
  renderList();
});
$('#search').addEventListener('input', (e) => { state.search = e.target.value.trim(); renderList(); });

// ---------------------------------------------------------------- global keys & paste

document.addEventListener('click', (e) => {
  if (!e.target.closest('#context-menu')) hideContextMenu();
});

document.addEventListener('keydown', (e) => {
  if (['#modal', '#import-dialog', '#sync-dialog', '#sync-overlay'].some((sel) => !$(sel).classList.contains('hidden'))) return;
  const inEditor = !!state.currentId;
  if (e.key === 'Escape') {
    if (!$('#file-preview').classList.contains('hidden')) { closeFilePreview(); return; }
    if (!$('#color-palette').classList.contains('hidden')) { closePalette(); return; }
    if (!$('#lightbox').classList.contains('hidden')) { closeLightbox(); return; }
    hideContextMenu();
    if (selectedImg) { hideImageBar(); return; }
    if (inEditor) closeEditor();
    else if (state.selecting) { state.selecting = false; state.selected.clear(); renderList(); }
    else if (state.search) { $('#search').value = ''; state.search = ''; renderList(); }
  }
  if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); if (inEditor) closeEditor(); createNote(); }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm') {
    e.preventDefault();
    if (!inEditor) createNote();
    startVoice();
    return;
  }
  if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    if (inEditor) closeEditor();
    $('#search').focus();
  }
  if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); if (inEditor) { flushEditor(); persist(true); } }
  if (!inEditor && e.key === 'Delete' && state.selected.size && document.activeElement.tagName !== 'INPUT') {
    $('#btn-sel-delete').click();
  }
});

// Ctrl+V a screenshot while browsing the list → new note containing it.
document.addEventListener('paste', async (e) => {
  const active = document.activeElement;
  if (state.currentId || (active.closest('input, [contenteditable]') && active.offsetParent !== null)) return;
  const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
  const text = e.clipboardData.getData('text/plain');
  if (!files.length && !text) return;
  e.preventDefault();
  if (files.length) {
    const urls = [];
    for (const f of files) urls.push(await api.saveImage(await f.arrayBuffer(), f.type, inVaultView() && vault.unlocked));
    createNote(urls.map((u) => `<p><img src="${u}"></p>`).join('') + '<p><br></p>');
  } else {
    createNote(escapeHtml(text).split('\n').map((l) => `<div>${l || '<br>'}</div>`).join(''));
  }
});

api.onFlush(async () => { flushEditor(); await persist(true); });
api.onNewNote(() => { if (state.currentId) closeEditor(); createNote(); });

// ---------------------------------------------------------------- phone ⇄ computer sync
//
// The computer runs a sync server (src/sync-server.js, api.sync.role 'server');
// the phone (src/mobile/platform.js, role 'client') connects when the user taps
// 「與電腦同步」, merges both sides with SyncMerge and sends the result back.

const syncApi = api.sync;
const syncOverlay = {
  timer: null,
  show(text) {
    $('#sync-overlay-text').textContent = text;
    $('#sync-overlay').classList.remove('hidden');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.hide(), 120000); // never lock the screen for good
  },
  hide() { clearTimeout(this.timer); $('#sync-overlay').classList.add('hidden'); },
};

function formatWhen(ts) {
  if (!ts) return '尚未同步';
  return `${formatDate(ts)} ${new Date(ts).toDateString() === new Date().toDateString() ? '' : new Date(ts).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`.trim();
}

function adoptMerged(data) {
  db.notes = data.notes;
  db.folders = data.folders;
  db.files = data.files || [];
  db.tombstones = data.tombstones;
  repairFolders('db');
  resetSnapshot('db');
}

// A small dialog whose content is re-rendered by the caller.
const syncDialog = {
  open(html) {
    $('#sync-box').innerHTML = html;
    $('#sync-dialog').classList.remove('hidden');
  },
  close() {
    $('#sync-dialog').classList.add('hidden');
    if (this.onClose) { const cb = this.onClose; this.onClose = null; cb(); }
  },
  get isOpen() { return !$('#sync-dialog').classList.contains('hidden'); },
};
$('#sync-dialog').addEventListener('click', (e) => { if (e.target.id === 'sync-dialog') syncDialog.close(); });
$('#sync-dialog').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); syncDialog.close(); } });

// ----- computer side

let pairTimer = null;
async function renderServerDialog() {
  const st = await syncApi.status();
  const devices = st.devices.length
    ? st.devices.map((d) => `<div class="row"><div class="grow"><b>${escapeHtml(d.name)}</b><small>上次同步：${escapeHtml(formatWhen(d.lastSync))}</small></div>
        <button class="text-btn danger" data-remove="${escapeHtml(d.id)}">移除</button></div>`).join('')
    : '<div class="row"><div class="grow"><small>還沒有配對的手機</small></div></div>';
  const addr = st.addresses[0] || '（找不到網路，請確認電腦有連上 Wi-Fi 或網路線）';
  let pairing = '';
  if (st.pairing) {
    const left = Math.max(0, Math.round((st.pairing.expires - Date.now()) / 1000));
    pairing = `<div class="pair-box">
        <div>在手機的 DeskNotes 按「與電腦同步」，輸入：</div>
        <small>電腦位址</small><div class="addr">${escapeHtml(addr)}</div>
        ${st.addresses.length > 1 ? `<small>（也可能是：${escapeHtml(st.addresses.slice(1).join('、'))}）</small>` : ''}
        <small>配對碼</small><div class="big">${st.pairing.code.slice(0, 3)} ${st.pairing.code.slice(3)}</div>
        <small>${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 後失效</small>
        <div><button class="text-btn" id="sync-cancel-pair">取消配對</button></div>
      </div>`;
  }
  $('#sync-box').innerHTML = `
    <h3>手機同步</h3>
    <p>手機和電腦連在同一個 Wi-Fi 時，在手機的 DeskNotes 按「與電腦同步」，兩邊的筆記就會合併成一樣的內容。</p>
    <label class="check-row"><input type="checkbox" id="sync-enabled" ${st.enabled ? 'checked' : ''}>允許手機同步（電腦會在家裡網路上等待手機連線）</label>
    ${st.error ? `<div class="err">${escapeHtml(st.error)}</div>` : ''}
    ${st.enabled && st.running ? `<small style="color:var(--muted)">電腦位址：${escapeHtml(addr)}</small>` : ''}
    <h4>已配對的手機</h4>
    ${devices}
    ${pairing || '<div class="modal-actions" style="justify-content:flex-start"><button class="text-btn primary" id="sync-start-pair">＋ 配對新手機</button></div>'}
    <div class="modal-actions"><button class="text-btn" id="sync-close">關閉</button></div>`;
  $('#sync-enabled').onchange = async (e) => { await syncApi.setEnabled(e.target.checked); renderServerDialog(); };
  $('#sync-close').onclick = () => syncDialog.close();
  if ($('#sync-start-pair')) $('#sync-start-pair').onclick = async () => { await syncApi.startPairing(); renderServerDialog(); };
  if ($('#sync-cancel-pair')) $('#sync-cancel-pair').onclick = async () => { await syncApi.cancelPairing(); renderServerDialog(); };
  $$('#sync-box [data-remove]').forEach((b) => {
    b.onclick = async () => {
      if (await openModal({ title: '移除這支手機？', text: '移除後，這支手機要重新配對才能同步。', okText: '移除', danger: true })) {
        await syncApi.removeDevice(b.dataset.remove);
        renderServerDialog();
      }
    };
  });
  clearTimeout(pairTimer);
  if (st.pairing && syncDialog.isOpen) pairTimer = setTimeout(renderServerDialog, 1000);
}

function initServerSync() {
  $('#btn-sync span').textContent = '手機同步…';
  $('#btn-sync').onclick = () => {
    syncDialog.onClose = () => { clearTimeout(pairTimer); syncApi.cancelPairing(); };
    syncDialog.open('');
    renderServerDialog();
  };
  syncApi.onEvent((evt) => {
    if (evt.type === 'paired') { toast(`已和「${evt.name}」配對`); if (syncDialog.isOpen) renderServerDialog(); }
    if (evt.type === 'status' && syncDialog.isOpen) renderServerDialog();
    if (evt.type === 'sync-done' && syncDialog.isOpen) renderServerDialog();
  });
  syncApi.onAsk(async (op, payload) => {
    if (op === 'state') {
      syncOverlay.show('手機同步中，請稍候…');
      flushEditor();
      if (vault.unlocked) await lockVault();
      await refreshFiles();
      await persist(true);
      return { notes: db.notes, folders: db.folders, files: db.files, tombstones: db.tombstones };
    }
    if (op === 'apply') {
      const openId = state.currentId;
      const before = fileLayout();
      adoptMerged(payload.db);
      await applyFileChanges(before, payload.preserve);
      if (payload.vaultChanged) vault.exists = true;
      await api.save(db);
      api.cleanupImages();
      syncOverlay.hide();
      if (openId) {
        const n = db.notes.find((x) => x.id === openId && !x.deletedAt);
        state.currentId = null;
        if (n) openEditor(openId);
        else { $('#editor-view').classList.add('hidden'); $('#list-view').classList.remove('hidden'); }
      }
      render();
      toast('已和手機同步完成');
      return true;
    }
    if (op === 'abort') { syncOverlay.hide(); return true; }
    throw new Error(`unknown ${op}`);
  });
}

// ----- phone side

async function updateSyncLast() {
  const p = await syncApi.getPairing();
  $('#sync-last').textContent = p ? `${p.pcName || '電腦'}・上次同步：${formatWhen(p.lastSync)}` : '';
  $('#btn-sync-settings').classList.toggle('hidden', !p);
}

function pairDialog(message = '') {
  return new Promise((resolve) => {
    syncDialog.onClose = () => resolve(null);
    syncDialog.open(`
      <h3>和電腦配對</h3>
      <p>1. 在電腦的 DeskNotes 點左下角「📱 手機同步…」→「配對新手機」<br>2. 輸入電腦上顯示的位址和配對碼</p>
      ${message ? `<div class="err">${escapeHtml(message)}</div>` : ''}
      <form id="pair-form" autocomplete="off">
        <label class="field">電腦位址</label>
        <input id="pair-addr" placeholder="例如 192.168.1.23" inputmode="decimal">
        <label class="field">配對碼（6 位數字）</label>
        <input id="pair-code" placeholder="例如 482913" inputmode="numeric" maxlength="7">
        <div class="err" id="pair-err"></div>
        <div class="modal-actions">
          <button type="button" class="text-btn" id="pair-cancel">取消</button>
          <button type="submit" class="text-btn primary" id="pair-ok">配對</button>
        </div>
      </form>`);
    syncApi.getPairing().then((p) => { if (p) $('#pair-addr').value = p.address; });
    $('#pair-cancel').onclick = () => syncDialog.close();
    $('#pair-form').onsubmit = async (e) => {
      e.preventDefault();
      const addr = $('#pair-addr').value.trim();
      const code = $('#pair-code').value.replace(/\D/g, '');
      if (!addr || code.length !== 6) { $('#pair-err').textContent = '請輸入電腦位址和 6 位數配對碼'; return; }
      $('#pair-ok').disabled = true;
      $('#pair-ok').textContent = '配對中…';
      try {
        const p = await syncApi.pair(addr, code);
        syncDialog.onClose = null;
        syncDialog.close();
        toast(`已和「${p.pcName}」配對`);
        resolve(p);
      } catch (err) {
        $('#pair-err').textContent = err.message;
        $('#pair-ok').disabled = false;
        $('#pair-ok').textContent = '配對';
      }
    };
  });
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function runPhoneSync() {
  let pairing = await syncApi.getPairing();
  if (!pairing) {
    pairing = await pairDialog();
    if (!pairing) return;
  }
  if (state.currentId) closeEditor();
  const step = (t) => syncOverlay.show(t);
  let connected = false;
  try {
    step('連線到電腦…');
    await persist(true);
    const remote = await syncApi.request('state');
    connected = true;
    const lastSync = pairing.lastSync || 0;
    const merged = SyncMerge.mergeData({ notes: db.notes, folders: db.folders, files: db.files, tombstones: db.tombstones }, remote.db, { lastSync });
    const lines = [];

    // plain images
    step('同步圖片…');
    const need = SyncMerge.imageRefs(merged.data.notes, 'img');
    const mine = new Set(await syncApi.localImages(false));
    const theirs = new Set(remote.images);
    const down = [...need].filter((n) => theirs.has(n) && !mine.has(n));
    const up = [...need].filter((n) => mine.has(n) && !theirs.has(n));
    for (const names of chunk(down, 8)) await syncApi.writeImages((await syncApi.request('getImages', { names, vault: false })).files, false);
    for (const names of chunk(up, 8)) await syncApi.request('putImages', { files: await syncApi.readImages(names, false), vault: false });

    // file folders: move contents that one side is missing, in 2 MB pieces
    const FILE_CHUNK = 2 * 1024 * 1024;
    const localFiles = new Map((db.files || []).map((f) => [f.id, f]));
    const remoteFiles = new Map((remote.db.files || []).map((f) => [f.id, f]));
    const fileDown = [];
    const fileUp = [];
    const preserveLocal = [];
    const preserveRemote = [];
    const now = Date.now();
    for (const f of [...merged.data.files]) {
      if (f.deletedAt) continue;
      const l = localFiles.get(f.id);
      const r = remoteFiles.get(f.id);
      const localHas = l && l.hash === f.hash && await api.files.hasContent(f.id);
      const remoteHas = r && r.hash === f.hash;
      if (!localHas && remoteHas) fileDown.push(f);
      else if (localHas && !remoteHas) fileUp.push(f);
      // Both sides changed this file since the last sync: keep the older one in the trash.
      if (l && r && l.hash !== r.hash && SyncMerge.revOf(l) > lastSync && SyncMerge.revOf(r) > lastSync) {
        const lose = f.hash === l.hash ? r : l;
        const copy = { ...lose, id: `${f.id}-old${now.toString(36)}`, deletedAt: now, rev: now };
        merged.data.files.push(copy);
        (lose === l ? preserveLocal : preserveRemote).push({ fromId: f.id, toId: copy.id });
        merged.conflicts++;
      }
    }
    await api.files.clearIncoming();
    let fileNo = 0;
    for (const f of [...fileDown, ...fileUp]) {
      fileNo++;
      const upload = fileUp.includes(f);
      for (let off = 0; off < f.size || off === 0; off += FILE_CHUNK) {
        const len = Math.min(FILE_CHUNK, f.size - off);
        step(`${upload ? '傳送' : '接收'}檔案 ${fileNo}/${fileDown.length + fileUp.length}：${f.name}（${f.size ? Math.round((off / f.size) * 100) : 100}%）`);
        const final = off + len >= f.size;
        if (upload) {
          await syncApi.request('putFileChunk', { id: f.id, offset: off, data: await api.files.readChunk(f.id, off, len), final });
        } else {
          const { data } = await syncApi.request('getFileChunk', { id: f.id, offset: off, length: len });
          await api.files.writeIncoming(f.id, off, data, final);
        }
        if (final) break;
      }
    }

    // locked notes
    let vaultEnvelope = null;
    let vaultMerged = null;
    if (remote.vault && !vault.exists) {
      step('取得上鎖筆記…');
      const files = {};
      for (const names of chunk(remote.vault.images, 8)) Object.assign(files, (await syncApi.request('getImages', { names, vault: true })).files);
      await syncApi.adoptVault(remote.vault.envelope, files);
      vault.exists = true;
      lines.push('已從電腦取得上鎖筆記，請用電腦上的上鎖密碼解鎖。');
    } else if (vault.unlocked) {
      let theirsVault = { notes: [], folders: [], tombstones: {} };
      let ok = true;
      if (remote.vault) {
        step('解開電腦的上鎖筆記…');
        const opened = await syncApi.openForeignVault(remote.vault.envelope);
        if (opened) theirsVault = opened;
        else { ok = false; lines.push('⚠ 電腦的上鎖筆記密碼和手機不同，上鎖筆記沒有同步。'); }
      }
      if (ok) {
        step('同步上鎖筆記…');
        vaultMerged = SyncMerge.mergeData(vaultPayload(), theirsVault, { lastSync });
        const vNeed = SyncMerge.imageRefs(vaultMerged.data.notes, 'vault');
        const vMine = new Set(await syncApi.localImages(true));
        const vTheirs = new Set(remote.vault ? remote.vault.images : []);
        for (const names of chunk([...vNeed].filter((n) => vTheirs.has(n) && !vMine.has(n)), 8)) {
          await syncApi.importForeignVaultImages((await syncApi.request('getImages', { names, vault: true })).files);
        }
        for (const names of chunk([...vNeed].filter((n) => vMine.has(n) && !vTheirs.has(n)), 8)) {
          await syncApi.request('putImages', { files: await syncApi.exportVaultImagesForForeign(names), vault: true });
        }
        vaultEnvelope = await syncApi.sealForeignVault(vaultMerged.data);
      }
    } else if (vault.exists && remote.vault) {
      lines.push('上鎖筆記沒有同步（手機的上鎖筆記尚未解鎖）。');
    }

    step('寫入電腦…');
    await syncApi.request('apply', { db: merged.data, vault: vaultEnvelope, preserve: preserveRemote });
    const filesBefore = fileLayout();
    adoptMerged(merged.data);
    await applyFileChanges(filesBefore, preserveLocal);
    if (vaultMerged) {
      vault.notes = vaultMerged.data.notes;
      vault.folders = vaultMerged.data.folders;
      vault.tombstones = vaultMerged.data.tombstones;
      repairFolders('vault');
      resetSnapshot('vault');
      await api.vault.save(vaultPayload());
    }
    await api.save(db);
    api.cleanupImages();
    await syncApi.update({ lastSync: Date.now() });
    syncApi.endSync();
    syncOverlay.hide();
    render();
    updateSyncLast();

    const conflicts = merged.conflicts + (vaultMerged ? vaultMerged.conflicts : 0);
    const summary = [
      `電腦 → 手機：${merged.toLocal + (vaultMerged ? vaultMerged.toLocal : 0)} 項更新${down.length ? `、${down.length} 張圖片` : ''}${fileDown.length ? `、${fileDown.length} 個檔案` : ''}`,
      `手機 → 電腦：${merged.toRemote + (vaultMerged ? vaultMerged.toRemote : 0)} 項更新${up.length ? `、${up.length} 張圖片` : ''}${fileUp.length ? `、${fileUp.length} 個檔案` : ''}`,
    ];
    if (conflicts) summary.push(`${conflicts} 項兩邊都修改過：保留較新的版本，舊版已放到垃圾筒。`);
    openModal({ title: '同步完成', text: summary.concat(lines).join('\n'), okText: '好' });
  } catch (err) {
    syncApi.endSync();
    syncOverlay.hide();
    api.files.clearIncoming();
    if (connected) { try { await syncApi.request('abort'); } catch { /* ignore */ } }
    if (['not-paired', 'bad-key'].includes(err.code)) {
      if (await pairDialog(`${err.message}`)) runPhoneSync();
    } else if (err.code === 'unreachable') {
      const choice = await openModal({
        title: '連不到電腦', text: err.message,
        options: [{ value: 'retry', label: '再試一次' }, { value: 'addr', label: '電腦位址變了，重新輸入' }],
        okText: '確定',
      });
      if (choice === 'retry') runPhoneSync();
      if (choice === 'addr') { const addr = await openModal({ title: '電腦位址', text: '在電腦的「手機同步」視窗可以看到位址', input: pairing.address }); if (addr) { await syncApi.update({ address: addr }); runPhoneSync(); } }
    } else {
      openModal({ title: '同步失敗', text: err.message, okText: '好' });
    }
  }
}

function initClientSync() {
  $('#btn-sync span').textContent = '與電腦同步';
  $('#btn-sync').onclick = () => { closeDrawer(); runPhoneSync(); };
  $('#btn-sync-settings').onclick = async () => {
    closeDrawer();
    const p = await syncApi.getPairing();
    const choice = await openModal({
      title: '同步設定',
      text: `已配對：${p.pcName || '電腦'}（${p.address}）\n上次同步：${formatWhen(p.lastSync)}`,
      options: [{ value: 'addr', label: '修改電腦位址' }, { value: 'repair', label: '重新配對' }, { value: 'unpair', label: '取消配對' }],
      okText: '確定',
    });
    if (choice === 'addr') { const addr = await openModal({ title: '電腦位址', input: p.address }); if (addr) await syncApi.update({ address: addr }); }
    if (choice === 'repair') await pairDialog();
    if (choice === 'unpair' && await openModal({ title: '取消和電腦的配對？', text: '筆記不會被刪除；之後要同步需重新配對。', okText: '取消配對', danger: true })) await syncApi.unpair();
    updateSyncLast();
  };
  updateSyncLast();
}

if (syncApi && syncApi.role === 'server') initServerSync();
else if (syncApi && syncApi.role === 'client') initClientSync();
else $('.sync-row').classList.add('hidden');

// ---------------------------------------------------------------- mobile

// On phones the sidebar is a drawer opened from the ☰ button.
const openDrawer = () => document.documentElement.classList.add('drawer-open');
const closeDrawer = () => document.documentElement.classList.remove('drawer-open');
$('#btn-mobile-menu').addEventListener('click', openDrawer);
$('#drawer-backdrop').addEventListener('click', closeDrawer);

// Android back button: close the top-most thing; false lets the app go to the background.
function handleBack() {
  const shown = (sel) => !$(sel).classList.contains('hidden');
  if (shown('#sync-overlay')) return true;
  if (shown('#modal')) { $('#modal-cancel').click(); return true; }
  if ($('.draw-view')) { $('.draw-view .text-btn:not(.primary)').click(); return true; } // 取消
  if (shown('#file-preview')) { closeFilePreview(); return true; }
  if (shown('#sync-dialog')) { syncDialog.close(); return true; }
  if (shown('#import-dialog')) { $('#import-cancel').click(); return true; }
  if (shown('#modal')) { $('#modal-cancel').click(); return true; }
  if (document.documentElement.classList.contains('drawer-open')) { closeDrawer(); return true; }
  if (shown('#lightbox')) { closeLightbox(); return true; }
  if (shown('#context-menu')) { hideContextMenu(); return true; }
  if (shown('#color-palette')) { closePalette(); return true; }
  if (selectedImg) { hideImageBar(); return true; }
  if (state.currentId) { closeEditor(); return true; }
  if (state.selecting) { state.selecting = false; state.selected.clear(); renderList(); return true; }
  if (state.search) { $('#search').value = ''; state.search = ''; renderList(); return true; }
  if (state.view !== 'all') { setView('all'); return true; }
  return false;
}
if (api.onBack) api.onBack(handleBack);

// ---------------------------------------------------------------- boot

(async function init() {
  loadPrefs();
  db = await api.load();
  db.folders ||= [];
  db.notes ||= [];
  db.files ||= [];
  db.tombstones ||= {};
  repairFolders('db');
  resetSnapshot('db');
  const filesBefore = fileLayout();
  state.prefs.collapsed ||= {};
  vault.exists = (await api.vault.status()).exists;
  if (purgeOldTrash()) { await applyFileChanges(filesBefore); await persist(true); api.cleanupImages(); }
  render();
  // Files added/removed in File Explorer while DeskNotes was closed or in the background.
  refreshFiles();
  let focusTimer = null;
  window.addEventListener('focus', () => { clearTimeout(focusTimer); focusTimer = setTimeout(refreshFiles, 500); });
})();
