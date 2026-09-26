const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notesAPI', {
  load: () => ipcRenderer.invoke('db:load'),
  save: (db) => ipcRenderer.invoke('db:save', db),
  cleanupImages: () => ipcRenderer.invoke('db:cleanup-images'),
  saveImage: (buffer, mime) => ipcRenderer.invoke('image:save', { buffer, mime }),
  pickImages: () => ipcRenderer.invoke('image:pick'),
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
