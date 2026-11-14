const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  call: async (channel, ...args) => {
    const r = await ipcRenderer.invoke(channel, ...args);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
  on: (channel, fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload)),
});
