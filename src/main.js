const {
  app, BrowserWindow, ipcMain, protocol, net, Tray, Menu, nativeImage,
  globalShortcut, dialog, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const { Vault } = require('./vault');
const { readOutlookCsv } = require('./outlook-import');
const { SyncServer } = require('./sync-server');
const { FileStore, safeSegment } = require('./files-store');
const { Backups } = require('./backup');

const IMG_SCHEME = 'note-img';
const QUICK_NOTE_SHORTCUT = 'CommandOrControl+Alt+N';

protocol.registerSchemesAsPrivileged([
  { scheme: IMG_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let dataDir;
let imagesDir;
let dbFile;
let vault;
let syncServer;
let fileStore;
let backups;
const backupVaults = new Map(); // backup id → opened Vault (while finding notes)
let mainWindow = null;
let tray = null;
let quitting = false;

// ---------- storage ----------

function emptyDb() {
  return { version: 1, folders: [], notes: [] };
}

function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    return { ...emptyDb(), ...db };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Keep the unreadable file around instead of silently overwriting it.
      fs.copyFileSync(dbFile, `${dbFile}.broken-${Date.now()}`);
    }
    return emptyDb();
  }
}

// `scrub` also overwrites the backup, used after notes are moved into the
// vault so no plaintext copy of them is left in notes.json.bak.
function saveDb(db, { scrub = false } = {}) {
  const tmp = `${dbFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  if (fs.existsSync(dbFile)) fs.copyFileSync(dbFile, `${dbFile}.bak`);
  fs.renameSync(tmp, dbFile);
  if (scrub) fs.copyFileSync(dbFile, `${dbFile}.bak`);
}

const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
};

const mimeOf = (file) => Object.keys(EXT_BY_MIME).find((k) => EXT_BY_MIME[k] === path.extname(file).slice(1)) || 'image/png';

function saveImage(buffer, mime, inVault = false) {
  const ext = EXT_BY_MIME[mime] || 'png';
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  if (inVault) return vault.saveImage(name, buffer);
  fs.writeFileSync(path.join(imagesDir, name), Buffer.from(buffer));
  return `${IMG_SCHEME}://img/${name}`;
}

const safeTitle = (title) => (title || '未命名筆記').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || '未命名筆記';

// A note as a self-contained HTML page (pictures inlined), for 匯出 and for
// dragging a note out to the desktop.
function noteHtmlDoc(title, html) {
  const safe = safeTitle(title).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inlined = (html || '').replace(new RegExp(`${IMG_SCHEME}://img/([\\w.-]+)`, 'g'), (all, file) => {
    const p = path.join(imagesDir, file);
    if (!fs.existsSync(p)) return all;
    return `data:${mimeOf(file)};base64,${fs.readFileSync(p).toString('base64')}`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safe}</title>
<style>body{font-family:"Microsoft JhengHei",sans-serif;max-width:860px;margin:40px auto;line-height:1.6}img{max-width:100%}</style>
</head><body><h1>${safe}</h1>${inlined}</body></html>`;
}

function imageRefs(html) {
  const refs = new Set();
  const re = new RegExp(`${IMG_SCHEME}://img/([\\w.-]+)`, 'g');
  let m;
  while ((m = re.exec(html || ''))) refs.add(m[1]);
  return refs;
}

// Remove image files no longer referenced by any note (including trashed ones).
function cleanupImages(db) {
  const used = new Set();
  for (const n of db.notes) for (const r of imageRefs(n.html)) used.add(r);
  for (const file of fs.readdirSync(imagesDir)) {
    if (!used.has(file)) fs.rmSync(path.join(imagesDir, file), { force: true });
  }
}

// ---------- window / tray ----------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#000000',
    title: `DeskNotes ${app.getVersion()}  —  作者: ArchieKUO`,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open external links in the default browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  // Closing the window hides it to the tray so notes stay one hotkey away.
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quickNote() {
  showWindow();
  mainWindow.webContents.send('app:new-note');
}

function buildTrayMenu() {
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    { label: '開啟 DeskNotes', click: showWindow },
    { label: '新增筆記\tCtrl+Alt+N', click: quickNote },
    { type: 'separator' },
    {
      label: '開機時自動啟動',
      type: 'checkbox',
      checked: openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    },
    { label: '開啟資料夾位置', click: () => shell.openPath(dataDir) },
    { type: 'separator' },
    { label: '結束', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'))
    .resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('DeskNotes');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', showWindow);
  tray.on('right-click', () => tray.setContextMenu(buildTrayMenu()));
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.on('app:version', (e) => { e.returnValue = app.getVersion(); });
  ipcMain.handle('db:load', () => loadDb());
  ipcMain.handle('db:save', (_e, db, opts) => { saveDb(db, opts); return true; });
  ipcMain.handle('db:cleanup-images', () => { cleanupImages(loadDb()); return true; });

  ipcMain.handle('image:save', (_e, { buffer, mime, inVault }) => saveImage(buffer, mime, inVault));
  // Image bytes for the drawing editor (a canvas can't export images loaded
  // from note-img:// directly, so the renderer draws a blob: copy instead).
  ipcMain.handle('image:read', async (_e, url) => {
    const m = new RegExp(`^${IMG_SCHEME}://(img|vault)/([\\w.-]+)$`).exec(url || '');
    if (m && m[1] === 'vault') return vault.readImage(m[2]);
    if (m) {
      const p = path.join(imagesDir, m[2]);
      return fs.existsSync(p) ? fs.readFileSync(p) : null;
    }
    if (/^(https?:|data:image\/)/i.test(url || '')) {
      const res = await net.fetch(url);
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    }
    return null;
  });
  ipcMain.handle('image:pick', async (_e, inVault) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '選擇圖片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '圖片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }],
    });
    if (res.canceled) return [];
    return res.filePaths.map((p) => {
      const ext = path.extname(p).slice(1).toLowerCase();
      const mime = Object.keys(EXT_BY_MIME).find((k) => EXT_BY_MIME[k] === ext)
        || (ext === 'jpeg' ? 'image/jpeg' : 'image/png');
      return saveImage(fs.readFileSync(p), mime, inVault);
    });
  });

  // ----- locked notes
  ipcMain.handle('vault:status', () => ({ exists: vault.exists(), unlocked: vault.unlocked }));
  ipcMain.handle('vault:create', (_e, password) => vault.create(password));
  ipcMain.handle('vault:unlock', (_e, password) => vault.unlock(password));
  ipcMain.handle('vault:save', (_e, payload) => { vault.save(payload); return true; });
  ipcMain.handle('vault:lock', () => { vault.lock(); return true; });
  ipcMain.handle('vault:change-password', (_e, oldPw, newPw) => vault.changePassword(oldPw, newPw));
  // Moving a note in/out of the vault re-stores its images encrypted/plain.
  ipcMain.handle('vault:import-images', (_e, html) => html.replace(
    new RegExp(`${IMG_SCHEME}://img/([\\w.-]+)`, 'g'),
    (all, file) => {
      const p = path.join(imagesDir, file);
      return fs.existsSync(p) ? vault.saveImage(file, fs.readFileSync(p)) : all;
    },
  ));
  ipcMain.handle('vault:export-images', (_e, html) => html.replace(
    new RegExp(`${IMG_SCHEME}://vault/([\\w.-]+)`, 'g'),
    (all, file) => {
      const plain = vault.readImage(file);
      return plain ? saveImage(plain, mimeOf(file)) : all;
    },
  ));

  ipcMain.handle('import:outlook', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '選擇 Outlook 匯出的記事 CSV 檔',
      properties: ['openFile'],
      filters: [{ name: 'CSV（逗點分隔值）', extensions: ['csv'] }],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const file = res.filePaths[0];
    return { file: path.basename(file), ...readOutlookCsv(fs.readFileSync(file)) };
  });

  ipcMain.handle('note:export', async (_e, { title, html }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '匯出筆記',
      defaultPath: path.join(app.getPath('desktop'), `${safeTitle(title)}.html`),
      filters: [{ name: 'HTML', extensions: ['html'] }],
    });
    if (res.canceled || !res.filePath) return false;
    fs.writeFileSync(res.filePath, noteHtmlDoc(title, html), 'utf8');
    return true;
  });
  // 複製到桌面…: save a copy of a file from a folder (desktop suggested).
  ipcMain.handle('files:save-copy', async (_e, folders, file) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '複製到…',
      defaultPath: path.join(app.getPath('desktop'), file.name),
    });
    if (res.canceled || !res.filePath) return false;
    fs.copyFileSync(fileStore.contentPath(folders, file), res.filePath);
    return true;
  });

  ipcMain.handle('edit:cmd', (e, cmd) => {
    if (['cut', 'copy', 'paste', 'selectAll', 'undo', 'redo'].includes(cmd)) e.sender[cmd]();
  });

  // Voice input uses Windows' built-in voice typing (Win+H), which types the
  // recognized speech into whatever has focus, i.e. the note editor.
  ipcMain.handle('voice:start', () => {
    if (process.platform !== 'win32') return false;
    const script = `
Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);'
[W.K]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
[W.K]::keybd_event(0x48, 0, 0, [UIntPtr]::Zero)
[W.K]::keybd_event(0x48, 0, 2, [UIntPtr]::Zero)
[W.K]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
        { windowsHide: true }, (err) => resolve(!err));
    });
  });

  // ----- backups (see backup.js)
  ipcMain.handle('backups:list', () => backups.list());
  ipcMain.handle('backups:create', (_e, kind) => backups.create(kind));
  ipcMain.handle('backups:read-db', (_e, id) => backups.readDb(id));
  ipcMain.handle('backups:restore-images', (_e, id, names) => { backups.restoreImages(id, names, imagesDir); return true; });
  // Locked notes of a backup: with the open vault's key (same password), or a password.
  ipcMain.handle('backups:open-vault', async (_e, id, password) => {
    const bv = new Vault(backups.pathOf(id));
    if (!bv.exists()) return { notes: [], folders: [] };
    let payload = vault.unlocked ? bv.unlockWithKey(vault.key) : null;
    if (!payload && password) payload = await bv.unlock(password);
    if (!payload) return { needPassword: true };
    backupVaults.set(id, bv);
    return payload;
  });
  // Pictures of found locked notes: decrypt from the backup, encrypt into the open vault.
  ipcMain.handle('backups:restore-vault-images', (_e, id, names) => {
    const bv = backupVaults.get(id);
    if (!bv || !vault.unlocked) throw new Error('上鎖筆記沒有開啟');
    for (const name of names) {
      const file = path.basename(name);
      if (fs.existsSync(path.join(vault.imagesDir, file))) continue;
      const plain = bv.readImage(file);
      if (plain) vault.saveImage(file, plain);
    }
    return true;
  });
  ipcMain.handle('backups:close', (_e, id) => {
    const bv = backupVaults.get(id);
    if (bv) { bv.lastNotes = null; bv.lock(); backupVaults.delete(id); }
    return true;
  });
  // 備份全部…: everything into a folder the user picks (e.g. a USB stick):
  //   筆記/        every note as a readable .html page, in its folders
  //   檔案/        the files of the folders
  //   還原用資料/   what 從備份找回筆記 reads (locked notes stay encrypted)
  ipcMain.handle('backup:all', async () => {
    const res = await dialog.showOpenDialog(mainWindow, { title: '選擇要備份到哪裡（例如隨身碟）', properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths.length) return null;
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    let dest = path.join(res.filePaths[0], `DeskNotes 備份 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`);
    for (let i = 2; fs.existsSync(dest); i++) dest = dest.replace(/( \(\d+\))?$/, ` (${i})`);
    const db = loadDb();
    const notesDir = path.join(dest, '筆記');
    const dirOf = (id) => {
      const f = db.folders.find((x) => x.id === id);
      if (!f) return notesDir;
      const p = f.parentId && db.folders.find((x) => x.id === f.parentId);
      return p ? path.join(notesDir, safeSegment(p.name), safeSegment(f.name)) : path.join(notesDir, safeSegment(f.name));
    };
    let count = 0;
    for (const n of db.notes.filter((x) => !x.deletedAt)) {
      const title = (n.title || '').trim() || (n.text || '').split('\n').find((l) => l.trim())?.trim() || '未命名筆記';
      const dir = dirOf(n.folderId);
      fs.mkdirSync(dir, { recursive: true });
      let name = `${safeTitle(title)}.html`;
      for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${safeTitle(title)} (${i}).html`;
      fs.writeFileSync(path.join(dir, name), noteHtmlDoc(title, n.html), 'utf8');
      count++;
    }
    if (fs.existsSync(fileStore.root)) await fs.promises.cp(fileStore.root, path.join(dest, '檔案'), { recursive: true });
    backups.copyNotesData(path.join(dest, '還原用資料'), false);
    fs.writeFileSync(path.join(dest, '說明.txt'), [
      `DeskNotes 備份（${count} 則筆記）`,
      '',
      '筆記：每則筆記一個 .html 檔，用瀏覽器打開就能看（含圖片）。上鎖筆記不在這裡。',
      '檔案：資料夾裡的檔案。',
      '還原用資料：給 DeskNotes「從備份找回筆記…」→「從其他位置選擇備份」用的，上鎖筆記在裡面，一樣加密。請不要修改。',
      '',
    ].join('\r\n'), 'utf8');
    return { dest, count };
  });
  // A backup made by 備份全部… (e.g. on a USB stick), for 從備份找回筆記.
  ipcMain.handle('backups:pick-external', async () => {
    const res = await dialog.showOpenDialog(mainWindow, { title: '選擇「DeskNotes 備份」資料夾', properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths.length) return null;
    const dir = Backups.externalDir(res.filePaths[0]);
    if (!dir) return { error: '這個資料夾裡沒有 DeskNotes 的備份。請選擇「DeskNotes 備份 …」那個資料夾。' };
    let notes = 0;
    try { notes = JSON.parse(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8')).notes.filter((n) => !n.deletedAt).length; } catch { /* empty */ }
    return { id: `ext:${res.filePaths[0]}`, label: path.basename(res.filePaths[0]), notes, hasVault: fs.existsSync(path.join(dir, 'vault.enc')) };
  });

  // ----- file folders (see files-store.js)
  ipcMain.handle('files:scan', (_e, folders, files) => fileStore.scan(folders, files));
  ipcMain.handle('files:pick', async () => {
    const res = await dialog.showOpenDialog(mainWindow, { title: '加入檔案', properties: ['openFile', 'multiSelections'] });
    return res.canceled ? [] : res.filePaths;
  });
  ipcMain.handle('files:add', (_e, folders, folderId, paths) => fileStore.add(folders, folderId, paths));
  ipcMain.handle('files:read', (_e, folders, file) => fs.readFileSync(fileStore.contentPath(folders, file)));
  ipcMain.handle('files:add-buffer', (_e, folders, folderId, name, buffer) => fileStore.addBuffer(folders, folderId, name, buffer));
  ipcMain.handle('files:materialize', (_e, before, after, preserve) => fileStore.materialize(before, after, preserve));
  ipcMain.handle('files:open', (_e, folders, file) => shell.openPath(fileStore.contentPath(folders, file)));
  ipcMain.handle('files:show', (_e, folders, file) => shell.showItemInFolder(fileStore.contentPath(folders, file)));
  ipcMain.handle('files:open-folder', (_e, folders, folderId) => {
    const dir = folderId ? fileStore.folderDir(folders, folderId) : fileStore.root;
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });

  // ----- phone sync (see sync-server.js)
  ipcMain.handle('sync:status', () => syncServer.status());
  ipcMain.handle('sync:set-enabled', (_e, on) => { syncServer.setEnabled(on); return syncServer.status(); });
  ipcMain.handle('sync:start-pairing', () => syncServer.startPairing());
  ipcMain.handle('sync:cancel-pairing', () => { syncServer.cancelPairing(); return syncServer.status(); });
  ipcMain.handle('sync:remove-device', (_e, id) => { syncServer.removeDevice(id); return syncServer.status(); });
  ipcMain.on('sync:answer', (_e, { id, result, error }) => {
    const p = rendererAsks.get(id);
    if (!p) return;
    rendererAsks.delete(id);
    if (error) p.reject(new Error(error)); else p.resolve(result);
  });

  ipcMain.handle('window:toggle-on-top', () => {
    const next = !mainWindow.isAlwaysOnTop();
    mainWindow.setAlwaysOnTop(next);
    return next;
  });
}

// Ask the renderer (which owns the in-memory notes) to do part of a sync.
const rendererAsks = new Map();
let askSeq = 0;
function askRenderer(op, payload) {
  return new Promise((resolve, reject) => {
    const id = ++askSeq;
    rendererAsks.set(id, { resolve, reject });
    mainWindow.webContents.send('sync:ask', { id, op, payload });
    setTimeout(() => {
      if (rendererAsks.delete(id)) reject(new Error('電腦端沒有回應'));
    }, 60000);
  });
}

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    dataDir = path.join(app.getPath('userData'), 'data');
    imagesDir = path.join(dataDir, 'images');
    dbFile = path.join(dataDir, 'notes.json');
    fs.mkdirSync(imagesDir, { recursive: true });

    vault = new Vault(dataDir);
    fileStore = new FileStore(dataDir);
    backups = new Backups(dataDir);
    const daily = () => { try { backups.ensureDaily(); } catch (err) { console.error('backup failed', err); } };
    daily();
    setInterval(daily, 60 * 60 * 1000); // DeskNotes often stays open in the tray for days
    syncServer = new SyncServer({
      dataDir,
      fileStore,
      imagesDir,
      vaultImagesDir: vault.imagesDir,
      vaultFile: vault.file,
      askRenderer,
      // Every phone sync can delete or replace notes: back up first.
      beforeApply: () => { try { backups.create('sync'); } catch (err) { console.error('backup failed', err); } },
      onEvent: (evt) => mainWindow && mainWindow.webContents.send('sync:event', evt),
    });

    protocol.handle(IMG_SCHEME, (req) => {
      const url = new URL(req.url);
      const file = path.basename(decodeURIComponent(url.pathname));
      // Dragging a note / file out of the window: Windows fetches it from here.
      if (url.host === 'drag-note' || url.host === 'drag-file') {
        const db = loadDb();
        if (url.host === 'drag-note') {
          const n = db.notes.find((x) => x.id === file);
          if (!n) return new Response('not found', { status: 404 });
          return new Response(noteHtmlDoc(n.title || (n.text || '').split('\n')[0], n.html), { headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        const f = (db.files || []).find((x) => x.id === file);
        const p = f && fileStore.contentPath(db.folders, f);
        if (!p || !fs.existsSync(p)) return new Response('not found', { status: 404 });
        return net.fetch(pathToFileURL(p).toString());
      }
      if (url.host === 'vault') {
        const plain = vault.readImage(file);
        if (!plain) return new Response('locked', { status: 403 });
        return new Response(plain, { headers: { 'content-type': mimeOf(file), 'cache-control': 'no-store' } });
      }
      return net.fetch(pathToFileURL(path.join(imagesDir, file)).toString());
    });

    registerIpc();
    createWindow();
    createTray();
    globalShortcut.register(QUICK_NOTE_SHORTCUT, quickNote);
    if (syncServer.config.enabled) syncServer.start();

    if (!process.argv.includes('--hidden')) mainWindow.show();
  });

  // Give the renderer a chance to write any pending edit before quitting.
  let flushed = false;
  app.on('before-quit', (e) => {
    quitting = true;
    if (flushed || !mainWindow || mainWindow.isDestroyed()) return;
    e.preventDefault();
    flushed = true;
    const done = () => app.quit();
    ipcMain.once('app:flushed', done);
    mainWindow.webContents.send('app:flush');
    setTimeout(done, 1500);
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    // Quitting always locks; this also removes unused encrypted images.
    if (vault) vault.lock();
  });
  app.on('window-all-closed', () => {});
}
