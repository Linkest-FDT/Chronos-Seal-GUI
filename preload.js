const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__TAURI__', {
  window: { getCurrentWindow: () => ({ minimize: () => ipcRenderer.send('window-minimize'), close: () => ipcRenderer.send('window-close') }) }
});

contextBridge.exposeInMainWorld('chronosSeal', {
  // OAuth 相关
  githubLogin: () => ipcRenderer.invoke('github-login'),
  deviceFlowStart: () => ipcRenderer.invoke('github-device-flow-start'),
  deviceFlowPoll: (deviceCode, interval) => ipcRenderer.invoke('github-device-flow-poll', { deviceCode, interval }),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  githubLogout: () => ipcRenderer.invoke('github-logout'),
  githubGetStatus: () => ipcRenderer.invoke('github-get-status'),

  // Node 相关
  detectNode: () => ipcRenderer.invoke('detect-node'),
  installNode: (version) => ipcRenderer.invoke('install-node', { version }),

  // 配置相关
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (patch) => ipcRenderer.invoke('save-config', patch),

  // 开发者模式
  toggleDevMode: (enabled) => ipcRenderer.invoke('toggle-dev-mode', enabled),
  saveDevConfig: (data) => ipcRenderer.invoke('save-dev-config', data),

  // 文件与目录操作
  selectFolder: (type) => ipcRenderer.invoke('select-folder', type),
  forkTemplateRepo: (opts) => ipcRenderer.invoke('fork-template-repo', opts),

  // 内核与加密
  fetchKernel: (engine) => ipcRenderer.invoke('fetch-kernel', engine),
  sealProject: (opts) => ipcRenderer.invoke('seal-project', opts),

  // 事件监听
  onSealLog: (cb) => ipcRenderer.on('seal-log', (e, msg) => cb(msg)),
  onSealProgress: (cb) => ipcRenderer.on('seal-progress', (e, data) => cb(data))
});
