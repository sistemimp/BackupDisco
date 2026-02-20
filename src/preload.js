const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('backupApi', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  deleteConfig: (configId) => ipcRenderer.invoke('config:delete', configId),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  runBackupNow: () => ipcRenderer.invoke('backup:runNow'),
  runAllBackups: () => ipcRenderer.invoke('backup:runAll'),
  stopBackup: () => ipcRenderer.invoke('backup:stop'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdateNow: () => ipcRenderer.invoke('update:installNow'),
  startSchedule: (state) => ipcRenderer.invoke('schedule:start', state),
  stopSchedule: () => ipcRenderer.invoke('schedule:stop'),
  stopAllActivity: () => ipcRenderer.invoke('activity:stopAll'),
  onBackupEvent: (handler) => {
    const listener = (_, payload) => handler(payload);
    ipcRenderer.on('backup:event', listener);
    return () => ipcRenderer.removeListener('backup:event', listener);
  }
});
