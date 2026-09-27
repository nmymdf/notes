const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('notesAPI', {
  load: () => ipcRenderer.invoke('db:load'),
  save: (db, opts) => ipcRenderer.invoke('db:save', db, opts),
  cleanupImages: () => ipcRenderer.invoke('db:cleanup-images'),
  saveImage: (buffer, mime, inVault = false) => ipcRenderer.invoke('image:save', { buffer, mime, inVault }),
  pickImages: (inVault = false) => ipcRenderer.invoke('image:pick', inVault),
  vault: {
    status: () => ipcRenderer.invoke('vault:status'),
    create: (password) => ipcRenderer.invoke('vault:create', password),
    unlock: (password) => ipcRenderer.invoke('vault:unlock', password),
    save: (payload) => ipcRenderer.invoke('vault:save', payload),
    lock: () => ipcRenderer.invoke('vault:lock'),
    changePassword: (oldPw, newPw) => ipcRenderer.invoke('vault:change-password', oldPw, newPw),
    importImages: (html) => ipcRenderer.invoke('vault:import-images', html),
    exportImages: (html) => ipcRenderer.invoke('vault:export-images', html),
  },
  importOutlook: () => ipcRenderer.invoke('import:outlook'),
  exportNote: (title, html) => ipcRenderer.invoke('note:export', { title, html }),
  startVoice: () => ipcRenderer.invoke('voice:start'),
  toggleOnTop: () => ipcRenderer.invoke('window:toggle-on-top'),
  editCommand: (cmd) => ipcRenderer.invoke('edit:cmd', cmd),
  onFlush: (cb) => ipcRenderer.on('app:flush', async () => {
    await cb();
    ipcRenderer.send('app:flushed');
  }),
  // File folders: real directories on disk (src/files-store.js).
  files: {
    scan: (folders, files) => ipcRenderer.invoke('files:scan', folders, files),
    pick: () => ipcRenderer.invoke('files:pick'),
    add: (folders, folderId, paths) => ipcRenderer.invoke('files:add', folders, folderId, paths),
    materialize: (before, after, preserve) => ipcRenderer.invoke('files:materialize', before, after, preserve),
    open: (folders, file) => ipcRenderer.invoke('files:open', folders, file),
    show: (folders, file) => ipcRenderer.invoke('files:show', folders, file),
    openFolder: (folders, folderId) => ipcRenderer.invoke('files:open-folder', folders, folderId),
    pathOf: (file) => webUtils.getPathForFile(file),
  },
  // Phone sync: the computer side (server) — see src/sync-server.js.
  sync: {
    role: 'server',
    status: () => ipcRenderer.invoke('sync:status'),
    setEnabled: (on) => ipcRenderer.invoke('sync:set-enabled', on),
    startPairing: () => ipcRenderer.invoke('sync:start-pairing'),
    cancelPairing: () => ipcRenderer.invoke('sync:cancel-pairing'),
    removeDevice: (id) => ipcRenderer.invoke('sync:remove-device', id),
    onEvent: (cb) => ipcRenderer.on('sync:event', (_e, evt) => cb(evt)),
    // The server asks the renderer for its notes / to adopt merged notes.
    onAsk: (cb) => ipcRenderer.on('sync:ask', async (_e, { id, op, payload }) => {
      try {
        ipcRenderer.send('sync:answer', { id, result: await cb(op, payload) });
      } catch (err) {
        ipcRenderer.send('sync:answer', { id, error: err.message });
      }
    }),
  },
  onNewNote: (cb) => ipcRenderer.on('app:new-note', () => cb()),
});
