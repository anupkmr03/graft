/**
 * Preload: the small, safe bridge between the page and the desktop side (window.graftDesktop).
 */
const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('graftDesktop', {
  op: (name, repo, ...args) => ipcRenderer.invoke('git:op', name, repo, args),
  network: (id, repo, kind, opts) => ipcRenderer.invoke('git:network', id, repo, kind, opts),
  cancel: (id) => ipcRenderer.invoke('git:cancel', id),
  onProgress: on('git:progress'),
  onOpenRepo: on('repo:open'),
  onFocus: on('window:focus'),
  checkRepo: (dir) => ipcRenderer.invoke('repo:check', dir),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (e) { return ''; } },
  pickFolder: (title) => ipcRenderer.invoke('dialog:folder', title),
  openFile: (repo, rel) => ipcRenderer.invoke('file:open', repo, rel),
  showFile: (repo, rel) => ipcRenderer.invoke('file:show', repo, rel),
  terminal: (repo) => ipcRenderer.invoke('repo:terminal', repo),
  openUrl: (url) => ipcRenderer.invoke('open:url', url),
  info: () => ipcRenderer.invoke('app:info'),
  initialRepo: () => ipcRenderer.invoke('app:initial'),
  setTitle: (t) => ipcRenderer.invoke('window:title', t),
  setZoom: (factor) => { const f = Number(factor); if (f >= 0.5 && f <= 2) webFrame.setZoomFactor(f); },
  setTitleBarSymbols: (color) => ipcRenderer.invoke('window:titlebar', color),
  titleBarHeight: 36,
  platform: process.platform,
});
