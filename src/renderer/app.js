'use strict';

const api = window.notesAPI;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const TRASH_DAYS = 30;
const PREFS_KEY = 'desknotes.prefs';

let db = { version: 1, folders: [], notes: [] };
// Locked notes: decrypted copies live here only while the vault is unlocked.
const vault = { exists: false, unlocked: false, notes: [] };
const VAULT_IDLE_MS = 5 * 60 * 1000;
const state = {
  view: 'all',              // 'all' | 'starred' | 'trash' | folder id
  search: '',
  selecting: false,
  selected: new Set(),
  currentId: null,          // note open in the editor
  prefs: { sort: 'updatedAt', dir: 'desc', layout: 'grid', sidebar: true },
};

// ---------------------------------------------------------------- utils

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

const inVaultView = () => state.view === 'vault';
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

let saveTimer = null;
function persist(immediate = false) {
  clearTimeout(saveTimer);
  const run = async () => {
    try {
      await api.save(db);
      if (vault.unlocked) await api.vault.save(vault.notes);
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
  const before = db.notes.length;
  db.notes = db.notes.filter((n) => !n.deletedAt || n.deletedAt > cutoff);
  return db.notes.length !== before;
}

// ---------------------------------------------------------------- modal / menus

function openModal({ title, text = '', input = null, options = null, okText = '確定', danger = false, password = false }) {
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

function folderOptions(includeNone = true) {
  const opts = includeNone ? [{ value: '', label: '（未分類）' }] : [];
  for (const f of db.folders) opts.push({ value: f.id, label: f.name });
  return opts;
}

// ---------------------------------------------------------------- sidebar

function renderSidebar() {
  const alive = db.notes.filter((n) => !n.deletedAt);
  $('#count-all').textContent = alive.length;
  $('#count-starred').textContent = alive.filter((n) => n.starred).length || '';
  $('#count-trash').textContent = db.notes.length - alive.length || '';
  $('#count-vault').textContent = vault.unlocked ? vault.notes.length : '';

  const list = $('#folder-list');
  list.innerHTML = '';
  for (const f of db.folders) {
    const a = document.createElement('a');
    a.className = 'nav-item';
    a.dataset.view = f.id;
    a.innerHTML = `<svg><use href="#i-folder"/></svg><span></span><em>${alive.filter((n) => n.folderId === f.id).length}</em>`;
    a.querySelector('span').textContent = f.name;
    a.title = f.name;
    list.appendChild(a);
  }
  $$('#sidebar .nav-item').forEach((a) => a.classList.toggle('active', a.dataset.view === state.view));
  $('#sidebar').classList.toggle('collapsed', !state.prefs.sidebar);
}

async function newFolder() {
  const name = await openModal({ title: '新增資料夾', input: '' , okText: '建立' });
  if (!name) return null;
  const f = { id: uid(), name, createdAt: Date.now() };
  db.folders.push(f);
  persist();
  renderSidebar();
  return f;
}

async function renameFolder(id) {
  const f = db.folders.find((x) => x.id === id);
  const name = await openModal({ title: '重新命名資料夾', input: f.name });
  if (!name) return;
  f.name = name;
  persist();
  render();
}

async function deleteFolder(id) {
  const f = db.folders.find((x) => x.id === id);
  const ok = await openModal({
    title: `刪除資料夾「${f.name}」？`,
    text: '資料夾裡的筆記不會被刪除，會移到「所有筆記」（未分類）。',
    okText: '刪除', danger: true,
  });
  if (!ok) return;
  db.folders = db.folders.filter((x) => x.id !== id);
  for (const n of db.notes) if (n.folderId === id) n.folderId = null;
  if (state.view === id) state.view = 'all';
  persist();
  render();
}

// ---------------------------------------------------------------- list

function visibleNotes() {
  if (inVaultView()) return sortNotes((vault.unlocked ? vault.notes : []).filter(matchesSearch));
  return sortNotes(db.notes.filter((n) => {
    if (state.view === 'trash') return !!n.deletedAt;
    if (n.deletedAt) return false;
    if (state.view === 'starred') return n.starred;
    if (state.view !== 'all') return n.folderId === state.view;
    return true;
  }).filter(matchesSearch));
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
  return db.folders.find((f) => f.id === state.view)?.name || '所有筆記';
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
  $('#view-title').textContent = viewTitle();
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
  $('#btn-sel-restore').classList.toggle('hidden', !inTrash);
  $('#btn-sel-move').classList.toggle('hidden', inTrash || inVault);
  $('#btn-sel-vault').classList.toggle('hidden', inTrash || inVault);
  $('#btn-sel-unvault').classList.toggle('hidden', !inVault);
  $('#btn-sel-delete').lastChild.textContent = inTrash || inVault ? '永久刪除' : '刪除';
  $('#select-count').textContent = `已選取 ${state.selected.size} 則`;
  $$('#select-actions .text-btn:not(#btn-select-all):not(#btn-select-done)')
    .forEach((b) => { b.disabled = state.selected.size === 0; });

  $('#sort-field').value = state.prefs.sort;
  $('#btn-sort-dir use').setAttribute('href', state.prefs.dir === 'asc' ? '#i-up' : '#i-down');
  $('#btn-view-mode use').setAttribute('href', state.prefs.layout === 'grid' ? '#i-grid' : '#i-list');

  const container = $('#notes');
  container.className = state.prefs.layout + (gate ? ' hidden' : '');
  container.classList.toggle('selecting', state.selecting);
  container.innerHTML = '';

  const notes = visibleNotes();
  for (const n of notes) {
    const card = document.createElement('div');
    card.className = 'note-card' + (state.selected.has(n.id) ? ' selected' : '');
    card.dataset.id = n.id;
    card.draggable = !inTrash && !inVault;
    const img = firstImage(n.html);
    const snippet = (n.text || '').slice(0, 220);
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
    card.querySelector('.meta small').textContent = inTrash
      ? `${Math.max(0, TRASH_DAYS - Math.floor((Date.now() - n.deletedAt) / 86400000))} 天後永久刪除`
      : formatDate(n[state.prefs.sort === 'createdAt' ? 'createdAt' : 'updatedAt']);
    container.appendChild(card);
  }

  const empty = $('#empty');
  empty.classList.toggle('hidden', notes.length > 0 || gate);
  if (!notes.length) {
    empty.innerHTML = state.search ? '找不到符合的筆記'
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
  const leavingVault = state.view === 'vault' && view !== 'vault';
  closeEditor();
  state.view = view;
  state.selecting = false;
  state.selected.clear();
  if (leavingVault && vault.unlocked) lockVault();
  render();
  if (view === 'vault' && !vault.unlocked) setTimeout(() => $('#vault-pw').focus(), 0);
}

// ---------------------------------------------------------------- locked notes

async function lockVault() {
  if (!vault.unlocked) return;
  if (currentInVault()) closeEditor();
  clearTimeout(saveTimer);
  await api.vault.save(vault.notes);
  vault.notes = [];
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
  const notes = await api.vault.unlock(pw);
  if (!notes) { toast('密碼錯誤'); return false; }
  vault.notes = notes;
  vault.unlocked = true;
  return true;
}

async function moveToVault(ids) {
  const wasUnlocked = vault.unlocked;
  if (!(await ensureVaultUnlocked())) return false;
  const moving = db.notes.filter((n) => ids.includes(n.id));
  for (const n of moving) {
    const html = await api.vault.importImages(n.html);
    vault.notes.push({ ...n, html, folderId: null, starred: false, deletedAt: null });
  }
  db.notes = db.notes.filter((n) => !ids.includes(n.id));
  clearTimeout(saveTimer);
  await api.vault.save(vault.notes);
  // Overwrite notes.json and its backup so no plaintext copy remains, then
  // remove the now-unused plain image files.
  await api.save(db, { scrub: true });
  await api.cleanupImages();
  if (!wasUnlocked && !inVaultView()) await lockVault();
  toast(`已移到上鎖筆記（${moving.length} 則）`);
  return true;
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
      vault.notes = await api.vault.create(pw);
      vault.exists = true;
    } else {
      btn.textContent = '解鎖中…';
      const notes = await api.vault.unlock(pw);
      if (!notes) {
        err.textContent = '密碼錯誤';
        $('#vault-pw').select();
        return;
      }
      vault.notes = notes;
    }
    vault.unlocked = true;
    $('#vault-pw').value = '';
    $('#vault-pw2').value = '';
    lastActivity = Date.now();
    render();
  } finally {
    btn.disabled = false;
    renderVaultGate(inVaultView() && !vault.unlocked);
  }
});

// Auto-lock after inactivity and whenever the window is hidden/minimized.
let lastActivity = Date.now();
for (const ev of ['mousedown', 'mousemove', 'keydown', 'wheel']) {
  document.addEventListener(ev, () => { lastActivity = Date.now(); }, { capture: true, passive: true });
}
setInterval(() => {
  if (vault.unlocked && Date.now() - lastActivity > VAULT_IDLE_MS) {
    lockVault();
    toast('閒置超過 5 分鐘，上鎖筆記已自動上鎖');
  }
}, 15000);
api.onHidden(() => { if (vault.unlocked) lockVault(); });

// ---------------------------------------------------------------- note operations

function createNote(html = '') {
  const now = Date.now();
  const toVault = inVaultView() && vault.unlocked;
  if (inVaultView() && !vault.unlocked) state.view = 'all';
  const folderId = db.folders.some((f) => f.id === state.view) ? state.view : null;
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
  const opts = folderOptions();
  opts.push({ value: '__new__', label: '＋ 新增資料夾…' });
  let target = await openModal({ title: '移動到資料夾', options: opts, okText: '移動' });
  if (target === null) return false;
  if (target === '__new__') {
    const f = await newFolder();
    if (!f) return false;
    target = f.id;
  }
  for (const n of db.notes) if (ids.includes(n.id)) n.folderId = target || null;
  persist();
  return true;
}

function noteContextMenu(e, id) {
  const n = findNote(id);
  if (isVaultNote(n)) {
    showContextMenu(e.clientX, e.clientY, [
      { label: '開啟', action: () => openEditor(id) },
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
      { label: '開啟', action: () => openEditor(id) },
      { label: n.starred ? '移除最愛' : '加入我的最愛', action: () => { n.starred = !n.starred; persist(); render(); } },
      { label: '移動到資料夾…', action: async () => { if (await moveNotes([id])) render(); } },
      { label: '🔒 移到上鎖筆記', action: async () => { if (await moveToVault([id])) render(); } },
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
  $('#save-state').textContent = '';
  const sel = $('#note-folder');
  sel.innerHTML = '';
  for (const o of folderOptions()) sel.add(new Option(o.label, o.value));
  sel.value = n.folderId || '';
  $('#btn-star').classList.toggle('on', !!n.starred);
  const locked = isVaultNote(n);
  $('#vault-badge').classList.toggle('hidden', !locked);
  for (const sel of ['#note-folder', '#btn-star', '#btn-export']) $(sel).classList.toggle('hidden', locked);
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
  hideImageBar();
  closePalette();
  $('#editor-view').classList.add('hidden');
  $('#list-view').classList.remove('hidden');
  render();
}

function flushEditor() {
  const n = findNote(state.currentId);
  if (!n) return;
  const html = editor.innerHTML;
  const title = $('#note-title').value;
  if (n.html === html && n.title === title) return;
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
  if (b.dataset.act === 'delete') {
    selectedImg.remove();
  } else {
    selectedImg.style.width = b.dataset.w ? b.dataset.w + '%' : '';
  }
  hideImageBar();
  onEdited();
});
scroller.addEventListener('scroll', hideImageBar);

editor.addEventListener('click', (e) => {
  if (e.target.tagName === 'IMG') {
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
  $('#lightbox img').src = e.target.src;
  $('#lightbox').classList.remove('hidden');
});
$('#lightbox').addEventListener('click', () => $('#lightbox').classList.add('hidden'));

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
editor.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (a && (e.ctrlKey || e.metaKey)) window.open(a.href);
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

$('#notes').addEventListener('click', (e) => {
  const card = e.target.closest('.note-card');
  if (!card) return;
  const id = card.dataset.id;
  if (state.selecting || e.ctrlKey) {
    state.selecting = true;
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    renderList();
  } else {
    openEditor(id);
  }
});
$('#notes').addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.note-card');
  if (!card) return;
  e.preventDefault();
  noteContextMenu(e, card.dataset.id);
});

// drag notes onto folders / trash in the sidebar
$('#notes').addEventListener('dragstart', (e) => {
  const card = e.target.closest('.note-card');
  if (!card) return;
  const ids = state.selected.has(card.dataset.id) ? [...state.selected] : [card.dataset.id];
  e.dataTransfer.setData('application/x-note-ids', JSON.stringify(ids));
  e.dataTransfer.effectAllowed = 'move';
});
$('#sidebar').addEventListener('dragover', (e) => {
  const item = e.target.closest('.nav-item');
  if (!item || !e.dataTransfer.types.includes('application/x-note-ids') || item.dataset.view === 'starred') return;
  e.preventDefault();
  $$('.nav-item.drop-target').forEach((x) => x.classList.remove('drop-target'));
  item.classList.add('drop-target');
});
$('#sidebar').addEventListener('dragleave', (e) => {
  e.target.closest?.('.nav-item')?.classList.remove('drop-target');
});
$('#sidebar').addEventListener('drop', (e) => {
  $$('.nav-item.drop-target').forEach((x) => x.classList.remove('drop-target'));
  const item = e.target.closest('.nav-item');
  const raw = e.dataTransfer.getData('application/x-note-ids');
  if (!item || !raw) return;
  e.preventDefault();
  const ids = JSON.parse(raw);
  const v = item.dataset.view;
  if (v === 'vault') {
    moveToVault(ids).then(() => { state.selected.clear(); render(); });
    return;
  }
  if (v === 'trash') trashNotes(ids);
  else {
    for (const n of db.notes) if (ids.includes(n.id)) n.folderId = v === 'all' ? null : v;
    persist();
    toast(`已移動 ${ids.length} 則筆記`);
  }
  state.selected.clear();
  render();
});

$('#sidebar').addEventListener('click', (e) => {
  const item = e.target.closest('.nav-item');
  if (item) setView(item.dataset.view);
});
$('#folder-list').addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.nav-item');
  if (!item) return;
  e.preventDefault();
  const id = item.dataset.view;
  showContextMenu(e.clientX, e.clientY, [
    { label: '重新命名', action: () => renameFolder(id) },
    { label: '刪除資料夾', danger: true, action: () => deleteFolder(id) },
  ]);
});
$('#folder-list').addEventListener('dblclick', (e) => {
  const item = e.target.closest('.nav-item');
  if (item) renameFolder(item.dataset.view);
});
$('#btn-new-folder').addEventListener('click', (e) => { e.stopPropagation(); newFolder(); });
$('#btn-toggle-sidebar').addEventListener('click', () => {
  state.prefs.sidebar = !state.prefs.sidebar;
  savePrefs();
  renderSidebar();
});

$('#btn-new-note').addEventListener('click', () => createNote());
$('#btn-new-image-note').addEventListener('click', createImageNote);
$('#btn-new-voice-note').addEventListener('click', () => { createNote(); startVoice(); });
$('#btn-select-mode').addEventListener('click', () => { state.selecting = true; state.selected.clear(); renderList(); });
$('#btn-select-done').addEventListener('click', () => { state.selecting = false; state.selected.clear(); renderList(); });
$('#btn-select-all').addEventListener('click', () => {
  const ids = visibleNotes().map((n) => n.id);
  const all = ids.every((id) => state.selected.has(id));
  state.selected = new Set(all ? [] : ids);
  renderList();
});
$('#btn-sel-delete').addEventListener('click', async () => {
  const ids = [...state.selected];
  if (state.view === 'trash') { if (!(await destroyNotes(ids))) return; }
  else if (inVaultView()) { if (!(await destroyVaultNotes(ids))) return; }
  else trashNotes(ids);
  state.selected.clear();
  state.selecting = false;
  render();
});
$('#btn-sel-restore').addEventListener('click', () => {
  restoreNotes([...state.selected]);
  state.selected.clear();
  state.selecting = false;
  render();
});
$('#btn-sel-move').addEventListener('click', async () => {
  if (!(await moveNotes([...state.selected]))) return;
  state.selected.clear();
  state.selecting = false;
  render();
});
$('#btn-sel-vault').addEventListener('click', async () => {
  if (!(await moveToVault([...state.selected]))) return;
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
  if (ids.length && (await destroyNotes(ids))) render();
});
$('#btn-view-mode').addEventListener('click', () => {
  state.prefs.layout = state.prefs.layout === 'grid' ? 'list' : 'grid';
  savePrefs();
  renderList();
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
  if (!$('#modal').classList.contains('hidden')) return;
  const inEditor = !!state.currentId;
  if (e.key === 'Escape') {
    if (!$('#color-palette').classList.contains('hidden')) { closePalette(); return; }
    if (!$('#lightbox').classList.contains('hidden')) { $('#lightbox').classList.add('hidden'); return; }
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
  if (state.currentId || document.activeElement.closest('input, [contenteditable]')) return;
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

// ---------------------------------------------------------------- boot

(async function init() {
  loadPrefs();
  db = await api.load();
  db.folders ||= [];
  db.notes ||= [];
  vault.exists = (await api.vault.status()).exists;
  if (purgeOldTrash()) { await persist(true); api.cleanupImages(); }
  render();
})();
