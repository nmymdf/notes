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

const IMG_SCHEME = 'note-img';
const QUICK_NOTE_SHORTCUT = 'CommandOrControl+Alt+N';

protocol.registerSchemesAsPrivileged([
  { scheme: IMG_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let dataDir;
let imagesDir;
let dbFile;
let vault;
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
    title: 'DeskNotes  —  designer: ArchieKuo',
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
  ipcMain.handle('db:load', () => loadDb());
  ipcMain.handle('db:save', (_e, db, opts) => { saveDb(db, opts); return true; });
  ipcMain.handle('db:cleanup-images', () => { cleanupImages(loadDb()); return true; });

  ipcMain.handle('image:save', (_e, { buffer, mime, inVault }) => saveImage(buffer, mime, inVault));
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
  ipcMain.handle('vault:save', (_e, notes) => { vault.save(notes); return true; });
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
    const safe = (title || '未命名筆記').replace(/[\\/:*?"<>|]/g, '_');
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '匯出筆記',
      defaultPath: `${safe}.html`,
      filters: [{ name: 'HTML', extensions: ['html'] }],
    });
    if (res.canceled || !res.filePath) return false;
    // Inline images so the exported file is self-contained.
    const inlined = html.replace(new RegExp(`${IMG_SCHEME}://img/([\\w.-]+)`, 'g'), (all, file) => {
      const p = path.join(imagesDir, file);
      if (!fs.existsSync(p)) return all;
      const ext = path.extname(file).slice(1);
      const mime = Object.keys(EXT_BY_MIME).find((k) => EXT_BY_MIME[k] === ext) || 'image/png';
      return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
    });
    const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${safe}</title>
<style>body{font-family:"Microsoft JhengHei",sans-serif;max-width:860px;margin:40px auto;line-height:1.6}img{max-width:100%}</style>
</head><body><h1>${safe}</h1>${inlined}</body></html>`;
    fs.writeFileSync(res.filePath, doc, 'utf8');
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

  ipcMain.handle('window:toggle-on-top', () => {
    const next = !mainWindow.isAlwaysOnTop();
    mainWindow.setAlwaysOnTop(next);
    return next;
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

    protocol.handle(IMG_SCHEME, (req) => {
      const url = new URL(req.url);
      const file = path.basename(decodeURIComponent(url.pathname));
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
