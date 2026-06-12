const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronBridge', {
  retry: () => ipcRenderer.send('retry-connection'),
});
