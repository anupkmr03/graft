/**
 * App shell: views (welcome, changes, history, blame, settings), keyboard shortcuts, sidebar
 * width, drag-a-folder-to-open, and start-up (reopens the last repository).
 */
(function () {
  const U = Graft.utils;
  const R = Graft.repo;
  const A = Graft.actions;
  const D = window.graftDesktop;

  const views = {};
  let current = null;

  function go(id) {
    if (!R.path && (id === 'changes' || id === 'history' || id === 'blame')) id = 'welcome';
    if (current === id) return;
    if (current && views[current]) { views[current].hide(); U.$('#view-' + current).hidden = true; }
    current = id;
    U.$('#view-' + id).hidden = false;
    views[id].show();
    if (id === 'changes' || id === 'history') Graft.store.set('view', id);
    Graft.bus.emit('view:change', id);
  }

  function typing(e) { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); }

  function onKey(e) {
    if (Graft.ui.dialog.isOpen() || Graft.ui.palette.isOpen()) return;
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const run = (fn) => { e.preventDefault(); fn(); };
    if (ctrl && !e.shiftKey && k === 'p') return run(() => Graft.ui.palette.open());
    if (ctrl && e.shiftKey && k === 'p') return run(() => (R.path ? A.push() : null));
    if (ctrl && k === 'o') return run(A.open);
    if (ctrl && k === ',') return run(() => go('settings'));
    if (ctrl && k === 'b') return run(toggleSidebar);
    if (k === 'f5') return run(() => R.refresh().then(() => Graft.toast('Refreshed', 1200)));
    if (!R.path) return;
    if (ctrl && k === '1') return run(() => go('changes'));
    if (ctrl && k === '2') return run(() => go('history'));
    if (ctrl && e.shiftKey && k === 'f') return run(A.fetch);
    if (ctrl && e.shiftKey && k === 'l') return run(A.pull);
    if (ctrl && e.shiftKey && k === 'n') return run(() => A.newBranch());
    if (ctrl && e.shiftKey && k === 's') return run(A.stashSave);
    if (ctrl && e.shiftKey && k === 'a') return run(A.stageAll);
    if (ctrl && !e.shiftKey && k === 'f') return run(() => { go('history'); Graft.ui.history.focusSearch(); });
    if (ctrl && k === 'enter' && current === 'changes') return run(() => Graft.ui.changes.commit());
    if (ctrl && !e.shiftKey && k === 'z' && !typing(e)) return run(Graft.undo.run);
    if (k === 'escape' && current === 'blame') return run(() => go(Graft.store.get('view', 'changes')));
  }

  function toggleSidebar() {
    const on = !document.documentElement.classList.contains('side-hidden');
    document.documentElement.classList.toggle('side-hidden', on);
    Graft.store.set('sideHidden', on ? '1' : '0');
  }

  function sidebarResize() {
    const side = U.$('#sidebar');
    const handle = U.$('#sideResize');
    side.style.width = Graft.prefs.get('sidebarWidth') + 'px';
    handle.addEventListener('pointerdown', (e) => {
      const x0 = e.clientX; const w0 = side.offsetWidth;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => { side.style.width = U.clamp(w0 + ev.clientX - x0, 190, 420) + 'px'; };
      const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); Graft.prefs.set('sidebarWidth', side.offsetWidth); };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  function dropToOpen() {
    window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); document.documentElement.classList.add('is-dropping'); } });
    window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.documentElement.classList.remove('is-dropping'); });
    window.addEventListener('drop', (e) => {
      document.documentElement.classList.remove('is-dropping');
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      const p = D.pathForFile(e.dataTransfer.files[0]);
      if (p) R.open(p);
    });
  }

  async function start() {
    if (!D) { document.body.innerHTML = '<p style="padding:40px;font-family:sans-serif">Graft runs as a desktop app.</p>'; return; }
    document.documentElement.classList.add('has-titlebar');
    if (Graft.store.get('sideHidden', '0') === '1') document.documentElement.classList.add('side-hidden');
    views.welcome = Graft.ui.welcome;
    views.changes = Graft.ui.changes;
    views.history = Graft.ui.history;
    views.settings = Graft.ui.settings;
    views.blame = Graft.ui.blame;
    Object.entries(views).forEach(([id, m]) => m.init(U.$('#view-' + id)));
    Graft.ui.sidebar.init(U.$('#sidebar'));
    Graft.ui.toolbar.init(U.$('#toolbar'), U.$('#banner'), U.$('#netbar'));
    sidebarResize();
    dropToOpen();
    document.addEventListener('keydown', onKey);
    Graft.bus.on('repo:open', (p) => {
      U.$('#titleRepo').textContent = p ? '· ' + p : '';
      if (!p) { current = null; ['changes', 'history', 'blame', 'settings'].forEach((v) => { U.$('#view-' + v).hidden = true; }); go('welcome'); }
      else if (!current || current === 'welcome' || current === 'blame' || current === 'settings') {
        if (current) { views[current].hide(); U.$('#view-' + current).hidden = true; current = null; }
        go(Graft.store.get('view', 'changes'));
      }
    });
    Graft.bus.on('repo:refs', () => { U.$('#titleRepo').textContent = R.path ? `· ${R.info.name} · ${R.info.headName || 'detached'}` : ''; });
    D.onOpenRepo((dir) => R.open(dir));
    go('welcome');
    const given = await D.initialRepo();
    const last = given || Graft.store.get('lastRepo', '');
    if (last && (await D.op('version', null))) {
      const ok = await D.checkRepo(last);
      if (ok.ok) R.open(last);
    }
  }

  Graft.app = { go, view: () => current, start };
  start();
})();
