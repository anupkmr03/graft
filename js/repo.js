/**
 * The open repository: its state, refreshing, actions with undo, network actions with progress.
 *
 *   Graft.repo.path / info / status / refs / stashes      latest known state
 *   Graft.repo.open(dir)   Graft.repo.refresh()
 *   Graft.act(op, args, { busy, quiet })   runs an action, records its undo, refreshes, shows errors
 *   Graft.undo.run()                         undoes the last recorded action in this repository
 *   Graft.net.run(kind, opts)                fetch / pull / push with live progress (one at a time)
 *
 * Events: repo:open, repo:status (changes), repo:refs (branches / HEAD moved), repo:busy, net:progress
 */
(function () {
  const D = window.graftDesktop;
  const bus = Graft.bus;
  const C = Graft.config;

  const R = { path: null, info: null, status: null, refs: null, stashes: [], sig: { status: '', refs: '' } };
  let refreshing = null;
  let again = false;

  const call = (op, ...args) => D.op(op, R.path, ...args);

  // ---------------- recent repositories
  function recent() { try { return JSON.parse(Graft.store.get('recent', '[]')); } catch (e) { return []; } }
  function remember(dir, name) {
    const list = recent().filter((r) => r.path.toLowerCase() !== dir.toLowerCase());
    list.unshift({ path: dir, name, t: Date.now() });
    Graft.store.set('recent', JSON.stringify(list.slice(0, C.RECENT_MAX)));
  }
  function forget(dir) { Graft.store.set('recent', JSON.stringify(recent().filter((r) => r.path !== dir))); }

  async function open(dir) {
    const check = await D.checkRepo(dir);
    if (!check.ok) {
      if (check.reason === 'not-repo') {
        const ok = await Graft.ui.dialog.confirm('Not a Git repository', `${dir}\n\nThis folder isn't a Git repository yet. Start one here?`, 'Create repository');
        if (!ok) return false;
        await D.op('init', dir);
        return open(dir);
      }
      Graft.toast('That folder no longer exists.');
      forget(dir);
      bus.emit('recent:change');
      return false;
    }
    R.path = check.root;
    R.info = null; R.status = null; R.refs = null; R.stashes = [];
    R.sig = { status: '', refs: '' };
    Graft.store.set('lastRepo', R.path);
    bus.emit('repo:open', R.path);
    await refresh();
    remember(R.path, R.info ? R.info.name : R.path.split(/[\\/]/).pop());
    bus.emit('recent:change');
    return true;
  }

  function close() { R.path = null; R.info = null; R.status = null; R.refs = null; Graft.store.set('lastRepo', ''); bus.emit('repo:open', null); }

  /** Reads HEAD, status, branches and stashes; emits only what changed. */
  function refresh() {
    if (!R.path) return Promise.resolve();
    if (refreshing) { again = true; return refreshing; }
    const repo = R.path;
    refreshing = (async () => {
      try {
        const [info, status, refs, stashes] = await Promise.all([call('info'), call('status'), call('branches'), call('stashes')]);
        if (repo !== R.path) return;
        R.info = info; R.status = status;
        const s1 = JSON.stringify(status) + info.state;
        const s2 = JSON.stringify([info.head, info.headName, info.state, refs, stashes.map((s) => s.hash)]);
        R.refs = refs; R.stashes = stashes;
        if (s2 !== R.sig.refs) { R.sig.refs = s2; bus.emit('repo:refs'); }
        if (s1 !== R.sig.status) { R.sig.status = s1; bus.emit('repo:status'); }
        D.setTitle(`${info.name} — ${info.headName || 'detached'} — Graft`);
      } catch (e) {
        if (repo === R.path) { console.warn(e); if (!/exist/.test(e.message)) Graft.toast(clean(e)); }
      }
    })().finally(() => {
      refreshing = null;
      if (again) { again = false; refresh(); }
    });
    return refreshing;
  }

  const clean = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  // ---------------- undo stack (per repository, this session)
  const stacks = {};
  const undo = {
    push(u) { if (!u || !R.path) return; (stacks[R.path] = stacks[R.path] || []).push(u); if (stacks[R.path].length > 50) stacks[R.path].shift(); bus.emit('undo:change'); },
    peek() { const s = stacks[R.path] || []; return s[s.length - 1] || null; },
    async run() {
      const s = stacks[R.path] || [];
      const u = s.pop();
      bus.emit('undo:change');
      if (!u) { Graft.toast('Nothing to undo. Older positions are in History → Reflog.'); return; }
      try { await call('undo', u); Graft.toast('Undone: ' + u.label); } catch (e) { Graft.ui.dialog.alert('Couldn\'t undo', clean(e)); }
      await refresh();
    },
  };

  // ---------------- actions
  let busy = 0;
  function setBusy(d, label) { busy += d; bus.emit('repo:busy', { busy: busy > 0, label }); }

  /** Runs op(args); records undo; refreshes. Returns the result, or null after showing the error. */
  async function act(op, args = [], opts = {}) {
    if (!R.path) return null;
    setBusy(1, opts.busy);
    try {
      const res = await call(op, ...args);
      if (res && res.undo) undo.push(res.undo);
      if (res && res.conflicts) Graft.toast('Stopped for conflicts. Resolve them in Changes, then Continue.', 6000);
      return res || {};
    } catch (e) {
      if (opts.rethrow) throw e;
      if (!opts.quiet) Graft.ui.dialog.alert(opts.title || 'Git couldn\'t do that', clean(e));
      return null;
    } finally {
      setBusy(-1);
      await refresh();
    }
  }

  // ---------------- network
  let netId = 0;
  const net = {
    current: null,
    async run(kind, opts = {}, label, handlers = {}) {
      if (!R.path && kind !== 'clone') return null;
      if (net.current) { Graft.toast('Wait for ' + net.current.label.toLowerCase() + ' to finish.'); return null; }
      const id = 'n' + (++netId);
      net.current = { id, kind, label: label || kind };
      bus.emit('net:progress', { id, label: net.current.label, text: '', percent: null, running: true });
      const off = D.onProgress((p) => { if (p.id === id) bus.emit('net:progress', { ...p, label: net.current.label, running: true }); });
      try {
        const res = await D.network(id, R.path, kind, opts);
        if (res && res.undo) undo.push(res.undo);
        if (res && res.conflicts) Graft.toast('The pull stopped for conflicts. Resolve them in Changes, then Continue.', 6000);
        return res || {};
      } catch (e) {
        const m = clean(e);
        if (/SIGTERM|killed|code null/i.test(m)) Graft.toast('Stopped.');
        else if (!(handlers.onError && handlers.onError(m))) Graft.ui.dialog.alert(`${label || kind} failed`, m);
        return null;
      } finally {
        off();
        net.current = null;
        bus.emit('net:progress', { id, running: false });
        if (kind !== 'clone') await refresh();
      }
    },
    cancel() { if (net.current) D.cancel(net.current.id); },
  };

  // ---------------- live refresh
  let timer = null;
  function schedule() {
    clearInterval(timer);
    if (Graft.prefs.get('refresh') === 'live') timer = setInterval(() => { if (document.hasFocus() && !document.hidden) refresh(); }, 4000);
  }
  let fetchTimer = null;
  function scheduleFetch() {
    clearInterval(fetchTimer);
    const m = Number(Graft.prefs.get('autoFetch')) || 0;
    if (m > 0) fetchTimer = setInterval(() => { if (R.path && R.refs && R.refs.remotes.length && !net.current) net.run('fetch', { prune: Graft.prefs.get('pruneOnFetch') }, 'Fetch'); }, m * 60000);
  }
  bus.on('prefs:change', ({ key }) => { if (key === 'refresh') schedule(); if (key === 'autoFetch') scheduleFetch(); });
  D.onFocus(() => refresh());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  schedule();
  scheduleFetch();

  Graft.repo = Object.assign(R, { open, close, refresh, recent, forget, call, clean });
  Graft.act = act;
  Graft.undo = undo;
  Graft.net = net;
})();
