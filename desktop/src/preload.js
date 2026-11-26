const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  call: async (channel, ...args) => {
    const r = await ipcRenderer.invoke(channel, ...args);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
  on: (channel, fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload)),
  // Riyeser Documents: the path of a file dragged onto the window (Electron no longer puts it on File.path)
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
});
