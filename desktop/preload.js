// What Payroll's pages may ask the Riyeser Payroll program to do: save PDFs, choose and open folders.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('riyser', {
  pdf: (html, title, folder) => ipcRenderer.invoke('riyser:pdf', html, title, folder),
  pickFolder: () => ipcRenderer.invoke('riyser:pickFolder'),
  payslipsFolder: () => ipcRenderer.invoke('riyser:payslipsFolder'),
  openFolder: folder => ipcRenderer.invoke('riyser:openFolder', folder),
  openFile: file => ipcRenderer.invoke('riyser:openFile', file),
  show: file => ipcRenderer.invoke('riyser:show', file),
  restore: name => ipcRenderer.invoke('riyser:restore', name), // OWNER-RESTORE: pick a backup (or this one from the list), back up, restart
});
