const { contextBridge, ipcRenderer } = require('electron');

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
    save: (notes) => ipcRenderer.invoke('vault:save', notes),
    lock: () => ipcRenderer.invoke('vault:lock'),
    changePassword: (oldPw, newPw) => ipcRenderer.invoke('vault:change-password', oldPw, newPw),
    importImages: (html) => ipcRenderer.invoke('vault:import-images', html),
    exportImages: (html) => ipcRenderer.invoke('vault:export-images', html),
  },
  exportNote: (title, html) => ipcRenderer.invoke('note:export', { title, html }),
  startVoice: () => ipcRenderer.invoke('voice:start'),
  toggleOnTop: () => ipcRenderer.invoke('window:toggle-on-top'),
  editCommand: (cmd) => ipcRenderer.invoke('edit:cmd', cmd),
  onFlush: (cb) => ipcRenderer.on('app:flush', async () => {
    await cb();
    ipcRenderer.send('app:flushed');
  }),
  onNewNote: (cb) => ipcRenderer.on('app:new-note', () => cb()),
});
