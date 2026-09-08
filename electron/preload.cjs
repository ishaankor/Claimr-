const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claimrAPI', {
  getAllGames: () => ipcRenderer.invoke('store:get-all-games'),
  checkAuth: (opts) => ipcRenderer.invoke('store:check-auth', opts),
  loginEpic: () => ipcRenderer.invoke('store:login-epic'),
  loginGog: () => ipcRenderer.invoke('store:login-gog'),
  claimAll: () => ipcRenderer.invoke('store:claim-all'),
  claimGame: (gameInfo) => ipcRenderer.invoke('store:claim-game', gameInfo),
  getHistory: () => ipcRenderer.invoke('store:get-history'),
  getAccounts: () => ipcRenderer.invoke('accounts:get'),
  swapAccount: (store, accountId) => ipcRenderer.invoke('accounts:swap', { store, accountId }),
  addAccount: (store) => ipcRenderer.invoke('accounts:add', { store }),
  removeAccount: (store, accountId) => ipcRenderer.invoke('accounts:remove', { store, accountId }),
  getServiceStatus: () => ipcRenderer.invoke('service:get-status'),
  toggleService: (shouldEnable) => ipcRenderer.invoke('service:toggle', shouldEnable),
  onClaimLog: (callback) => {
    const subscription = (_event, value) => callback(value);
    ipcRenderer.on('claim:log', subscription);
    return () => ipcRenderer.removeListener('claim:log', subscription);
  },
  verifyRealLibrary: (params) => ipcRenderer.invoke('store:verify-real-library', params),
  onLibraryUpdated: (callback) => {
    const subscription = () => callback();
    ipcRenderer.on('library:updated', subscription);
    return () => ipcRenderer.removeListener('library:updated', subscription);
  },
});
