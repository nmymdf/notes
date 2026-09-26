const {
  app, BrowserWindow, ipcMain, protocol, net, Tray, Menu, nativeImage,
  globalShortcut, dialog, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const IMG_SCHEME = 'note-img';
const QUICK_NOTE_SHORTCUT = 'CommandOrControl+Alt+N';

protocol.registerSchemesAsPrivileged([
  { scheme: IMG_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let dataDir;
let imagesDir;
let dbFile;
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

function saveDb(db) {
  const tmp = `${dbFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  if (fs.existsSync(dbFile)) fs.copyFileSync(dbFile, `${dbFile}.bak`);
  fs.renameSync(tmp, dbFile);
}

const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
};

function saveImage(buffer, mime) {
  const ext = EXT_BY_MIME[mime] || 'png';
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
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
    title: 'DeskNotes',
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
  ipcMain.handle('db:save', (_e, db) => { saveDb(db); return true; });
  ipcMain.handle('db:cleanup-images', () => { cleanupImages(loadDb()); return true; });

  ipcMain.handle('image:save', (_e, { buffer, mime }) => saveImage(buffer, mime));
  ipcMain.handle('image:pick', async () => {
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
      return saveImage(fs.readFileSync(p), mime);
    });
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

    protocol.handle(IMG_SCHEME, (req) => {
      const file = path.basename(decodeURIComponent(new URL(req.url).pathname));
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
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {});
}
