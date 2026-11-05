/**
 * Graft — a fast Git client, desktop app (Electron main process).
 *
 *   git.js   runs the installed Git (no shell) and parses its output
 *   ops.js   every action the page may ask for, with undo recipes
 *   here     window, folder pickers, network actions with progress, files (open / show / Recycle Bin)
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const appProtocol = require('./protocol');
const git = require('./git');
const { ops, configure, editorEnv } = require('./ops');

const APP_ROOT = path.join(__dirname, '..');
appProtocol.registerPrivileged();

let win = null;
let initialDir = null; // folder given on the command line ("Open with Graft")
const TITLEBAR_HEIGHT = 36;

if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', (_e, argv) => { showWindow(); const dir = argv.slice(1).find((a) => !a.startsWith('-') && isDir(a)); if (dir) send('repo:open', dir); });

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }

// ---------- Window ----------
const stateFile = () => path.join(app.getPath('userData'), 'window.json');
function loadWindowState() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (e) { return { width: 1360, height: 880 }; } }
function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch (e) { /* not fatal */ }
}

function createWindow() {
  const state = loadWindowState();
  win = new BrowserWindow({
    x: state.x, y: state.y, width: state.width || 1360, height: state.height || 880,
    minWidth: 960, minHeight: 600,
    backgroundColor: '#0a0d1c',
    title: 'Graft',
    icon: path.join(APP_ROOT, 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#e9edff', height: TITLEBAR_HEIGHT },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: true },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (input.control && input.shift && key === 'r') { win.webContents.reload(); event.preventDefault(); }
    else if (key === 'f11') { win.setFullScreen(!win.isFullScreen()); event.preventDefault(); }
    else if (key === 'f12' || (input.control && input.shift && key === 'i')) { win.webContents.toggleDevTools(); event.preventDefault(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('graft://app/')) event.preventDefault(); });
  ['resize', 'move', 'close'].forEach((ev) => win.on(ev, saveWindowState));
  win.on('focus', () => send('window:focus', true));
  win.on('closed', () => { win = null; });
  win.loadURL('graft://app/index.html');
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
const msg = (e) => String((e && e.message) || e);

/** Only folders the page opened through us (or recent ones it gives back) count as repositories. */
function checkRepo(repo) {
  if (typeof repo !== 'string' || !path.isAbsolute(repo) || !isDir(repo)) throw new Error('That folder no longer exists.');
  return repo;
}

// ---------- Network actions (progress + cancel) ----------
const running = new Map(); // id → { kill }
async function network(id, repo, kind, opts = {}) {
  const signal = {};
  running.set(id, signal);
  const progress = (p) => send('git:progress', { id, ...p });
  try {
    let args;
    const before = repo ? (await git.out(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { ok: [1] }).catch(() => '')).trim() : '';
    if (kind === 'fetch') {
      args = ['fetch', '--progress'];
      if (opts.prune) args.push('--prune');
      args.push(...(opts.remote ? [opts.remote] : ['--all']));
      if (opts.tags) args.push('--tags');
    } else if (kind === 'pull') {
      args = ['pull', '--progress', '--no-edit'];
      if (opts.mode === 'rebase') args.push('--rebase', '--autostash'); else if (opts.mode === 'ff') args.push('--ff-only'); else args.push('--no-rebase');
      if (opts.remote && opts.branch) args.push(opts.remote, opts.branch);
    } else if (kind === 'push') {
      args = ['push', '--progress'];
      if (opts.force) args.push('--force-with-lease');
      if (opts.setUpstream) args.push('-u');
      if (opts.tags) args.push('--follow-tags');
      if (opts.remote) args.push(opts.remote);
      if (opts.refspec) args.push(opts.refspec);
    } else if (kind === 'clone') {
      const dest = path.join(opts.parent, opts.name);
      if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error(`"${opts.name}" already exists in that folder and isn't empty.`);
      await git.network(null, ['clone', '--progress', opts.url, dest], progress, signal);
      return { path: dest };
    } else throw new Error('Unknown action');
    if (typeof args.find((a) => typeof a !== 'string') !== 'undefined') throw new Error('Bad arguments');
    const env = kind === 'pull' ? editorEnv() : undefined;
    try {
      await git.run(repo, args, { onStderr: (chunk) => chunk.split(/[\r\n]+/).forEach((t) => { t = t.trim(); if (!t) return; const m = /^(?:remote: )?([A-Za-z ]+):\s+(\d+)%/.exec(t); progress({ phase: m ? m[1] : null, percent: m ? +m[2] : null, text: t }); }), signal, env });
    } catch (e) {
      if (kind === 'pull') { const i = await git.info(repo).catch(() => ({})); if (i.state) return { conflicts: true, message: e.message, undo: before ? { kind: 'head', label: 'Pull', sha: before, mode: 'keep' } : null }; }
      throw e;
    }
    const after = repo ? (await git.out(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { ok: [1] }).catch(() => '')).trim() : '';
    return { changed: before !== after, undo: kind === 'pull' && before && before !== after ? { kind: 'head', label: 'Pull', sha: before, mode: 'keep' } : null };
  } finally { running.delete(id); }
}

// ---------- Requests from the page ----------
function registerIpc() {
  ipcMain.handle('git:op', async (_e, name, repo, args) => {
    const fn = Object.prototype.hasOwnProperty.call(ops, name) ? ops[name] : null;
    if (!fn) throw new Error('Unknown action ' + name);
    if (name === 'init') { if (typeof repo !== 'string' || !path.isAbsolute(repo)) throw new Error('Bad folder'); } else if (!(['version', 'identity', 'setIdentity'].includes(name) && repo == null)) checkRepo(repo);
    try { return await fn(repo, ...(Array.isArray(args) ? args : [])); } catch (e) {
      if (e.notMerged) throw new Error('NOT_MERGED');
      throw new Error(msg(e));
    }
  });
  ipcMain.handle('git:network', async (_e, id, repo, kind, opts) => {
    if (kind !== 'clone') checkRepo(repo);
    else if (!opts || typeof opts.url !== 'string' || !opts.url.trim() || !isDir(opts.parent) || !/^[^\\/:*?"<>|]+$/.test(opts.name || '')) throw new Error('Choose an address and a folder.');
    try { return await network(String(id), repo, kind, opts || {}); } catch (e) { throw new Error(msg(e)); }
  });
  ipcMain.handle('git:cancel', (_e, id) => { const s = running.get(String(id)); if (s && s.kill) s.kill(); return !!s; });

  ipcMain.handle('repo:check', async (_e, dir) => {
    if (!isDir(dir)) return { ok: false, reason: 'missing' };
    try { const i = await git.info(dir); return { ok: true, root: i.root }; } catch (e) { return { ok: false, reason: 'not-repo' }; }
  });
  ipcMain.handle('dialog:folder', async (_e, title) => {
    const res = await dialog.showOpenDialog(win, { title: title || 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  });

  const inRepo = (repo, rel) => { checkRepo(repo); const full = path.resolve(repo, rel || '.'); if (full !== path.resolve(repo) && !full.startsWith(path.resolve(repo) + path.sep)) throw new Error('Bad path'); return full; };
  ipcMain.handle('file:open', (_e, repo, rel) => shell.openPath(inRepo(repo, rel)));
  ipcMain.handle('file:show', (_e, repo, rel) => { shell.showItemInFolder(inRepo(repo, rel)); return true; });
  ipcMain.handle('repo:terminal', (_e, repo) => {
    checkRepo(repo);
    if (process.platform === 'win32') {
      const gitBash = ['C:\\Program Files\\Git\\git-bash.exe', 'C:\\Program Files (x86)\\Git\\git-bash.exe'].find((p) => fs.existsSync(p));
      if (gitBash) spawn(gitBash, ['--cd=' + repo], { detached: true, stdio: 'ignore' }).unref();
      else spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', 'cd', '/d', repo], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else spawn('x-terminal-emulator', [], { cwd: repo, detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    return true;
  });
  ipcMain.handle('open:url', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return true; });
  ipcMain.handle('app:initial', () => { const d = initialDir; initialDir = null; return d; });
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), electron: process.versions.electron, platform: process.platform }));
  ipcMain.handle('window:titlebar', (_e, color) => {
    if (!win || typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return false;
    try { win.setTitleBarOverlay({ color: '#00000000', symbolColor: color, height: TITLEBAR_HEIGHT }); } catch (e) { return false; }
    return true;
  });
  ipcMain.handle('window:title', (_e, t) => { if (win && typeof t === 'string') win.setTitle(t.slice(0, 200)); return true; });
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.graft.git');
  Menu.setApplicationMenu(null);
  // Tiny "editor" Git calls when it would otherwise open one (continue a rebase, keep the message).
  const noop = path.join(app.getPath('userData'), 'keep-message.js');
  try { fs.writeFileSync(noop, '// Graft: keeps the message Git suggests\n'); } catch (e) { /* read-only profile */ }
  configure({ nodeCmd: process.execPath, noopEditor: noop, trash: (p) => shell.trashItem(p) });
  appProtocol.register(APP_ROOT);
  registerIpc();
  createWindow();
  const dir = process.argv.slice(1).find((a) => !a.startsWith('-') && a !== '.' && isDir(a) && path.resolve(a) !== APP_ROOT);
  initialDir = dir ? path.resolve(dir) : null;
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
