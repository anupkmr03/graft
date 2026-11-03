/**
 * Command palette (Ctrl+P): every command, branch, tag, changed file and recent repository,
 * matched as you type (letters in order, e.g. "nb" finds "New branch").
 */
(function () {
  const U = Graft.utils;
  const R = Graft.repo;
  const A = Graft.actions;
  let overlay = null;

  function commands() {
    const go = (v) => () => Graft.app.go(v);
    const list = [
      ['Open repository…', 'Ctrl+O', A.open], ['Clone repository…', '', () => A.clone()], ['New repository…', '', A.init],
      ['Settings', 'Ctrl+,', go('settings')],
      ['Toggle light / dark theme', '', () => Graft.appearance.set({ theme: document.documentElement.dataset.theme === 'light' ? 'dark' : 'light' })],
    ];
    if (R.path) {
      list.push(
        ['Go to Changes', 'Ctrl+1', go('changes')], ['Go to History', 'Ctrl+2', go('history')],
        ['Fetch', 'Ctrl+Shift+F', A.fetch], ['Pull', 'Ctrl+Shift+L', A.pull], ['Push', 'Ctrl+Shift+P', () => A.push()], ['Force push…', '', () => A.push(true)],
        ['New branch…', 'Ctrl+Shift+N', () => A.newBranch()], ['New tag…', '', () => A.newTag()], ['Push all tags', '', A.pushTags],
        ['Stash changes…', 'Ctrl+Shift+S', A.stashSave],
        ['Stage all', 'Ctrl+Shift+A', A.stageAll], ['Unstage all', '', A.unstageAll], ['Discard all changes…', '', A.discardAll],
        ['Commit', 'Ctrl+Enter', () => { Graft.app.go('changes'); Graft.ui.changes.focusMessage(); }],
        ['Undo last action', 'Ctrl+Z', Graft.undo.run], ['Reflog (find lost work)', '', A.reflog],
        ['Search history', 'Ctrl+F', () => { Graft.app.go('history'); Graft.ui.history.focusSearch(); }],
        ['Add remote…', '', A.addRemote], ['Open terminal here', '', A.terminal], ['Show in Explorer', '', A.showFolder],
        ['Close repository', '', R.close],
      );
      if (R.info && R.info.state) list.push([`Continue ${R.info.state}`, '', () => A.sequencer('continue')], [`Abort ${R.info.state}`, '', () => A.sequencer('abort')]);
    }
    const items = list.map(([label, hint, run]) => ({ label, hint, run, kind: 'Command' }));
    if (R.path && R.refs) {
      R.refs.local.forEach((b) => { if (!b.current) items.push({ label: 'Switch to ' + b.name, run: () => A.checkout(b.name), kind: 'Branch' }); });
      R.refs.local.forEach((b) => { if (!b.current && R.info && R.info.headName) items.push({ label: `Merge ${b.name} into ${R.info.headName}`, run: () => A.merge(b.name), kind: 'Merge', weak: true }); });
      R.refs.remote.forEach((b) => items.push({ label: 'Check out ' + b.name, run: () => A.checkoutRemote(b.name), kind: 'Remote', weak: true }));
      R.refs.tags.slice(0, 200).forEach((t) => items.push({ label: 'Show tag ' + t.name, run: () => Graft.ui.history.reveal(t.oid), kind: 'Tag', weak: true }));
      const s = R.status;
      if (s) [...s.conflicts, ...s.unstaged, ...s.untracked, ...s.staged].forEach((f) => items.push({ label: f.path, run: () => { Graft.app.go('changes'); Graft.ui.changes.selectPath(f.path); }, kind: 'Changed file' }));
    }
    R.recent().filter((r) => r.path !== R.path).forEach((r) => items.push({ label: 'Open ' + r.name, hint: r.path, run: () => R.open(r.path), kind: 'Repository' }));
    return items;
  }

  /** Fuzzy score: every typed letter in order; bonus for word starts and runs. -1 = no match. */
  function score(text, q) {
    const t = text.toLowerCase();
    if (!q) return 0;
    const direct = t.indexOf(q);
    if (direct >= 0) return 1000 - direct * 2 - t.length * 0.1 + (direct === 0 || /\W/.test(t[direct - 1]) ? 200 : 0);
    let s = 0; let ti = 0; let run = 0;
    for (const ch of q) {
      const at = t.indexOf(ch, ti);
      if (at < 0) return -1;
      run = at === ti ? run + 1 : 0;
      s += 10 + run * 5 + (at === 0 || /[\s/._-]/.test(t[at - 1]) ? 15 : 0) - (at - ti) * 0.5;
      ti = at + 1;
    }
    return s - t.length * 0.1;
  }

  function open(initial) {
    if (overlay) { close(); }
    const all = commands();
    const input = U.el('input', { class: 'pl-input', type: 'text', placeholder: R.path ? 'Type a command, branch, file, or a commit hash…' : 'Type a command or repository…', spellcheck: 'false', value: initial || '' });
    const list = U.el('div', { class: 'pl-list', role: 'listbox' });
    const box = U.el('div', { class: 'glass pl-box', role: 'dialog', 'aria-label': 'Command palette' }, input, list);
    overlay = U.el('div', { class: 'pl-overlay', onpointerdown: (e) => { if (e.target === overlay) close(); } }, box);
    let shown = [];
    let idx = 0;
    function update() {
      const q = input.value.trim().toLowerCase();
      shown = all.map((it) => ({ it, s: score(it.label, q) - (it.weak && !q ? 1000 : 0) })).filter((x) => x.s >= 0 || (!q && !x.it.weak)).sort((a, b) => b.s - a.s).slice(0, 60).map((x) => x.it);
      if (R.path && /^[0-9a-f]{4,40}$/i.test(q)) shown.unshift({ label: 'Go to commit ' + q, run: () => Graft.ui.history.reveal(q), kind: 'Commit' });
      idx = 0;
      paint();
    }
    function paint() {
      list.replaceChildren(...(shown.length ? shown.map((it, i) => U.el('button', { type: 'button', class: 'pl-item' + (i === idx ? ' is-active' : ''), role: 'option', onclick: () => run(it), onmousemove: () => { if (idx !== i) { idx = i; paint(); } } },
        U.el('span', { class: 'pl-label', text: it.label }), it.hint ? U.el('kbd', { class: 'pl-hint', text: it.hint }) : null, U.el('span', { class: 'pl-kind muted small', text: it.kind }))) : [U.el('div', { class: 'muted small pl-none', text: 'No matches' })]));
      const a = list.querySelector('.is-active');
      if (a) a.scrollIntoView({ block: 'nearest' });
    }
    function run(it) { close(); setTimeout(() => it.run()); }
    input.addEventListener('input', update);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(idx + 1, shown.length - 1); paint(); } else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); paint(); } else if (e.key === 'Enter' && shown[idx]) { e.preventDefault(); run(shown[idx]); }
    });
    document.body.append(overlay);
    input.focus();
    update();
  }
  function close() { if (overlay) { overlay.remove(); overlay = null; } }

  Graft.ui.palette = { open, close, score, isOpen: () => !!overlay };
})();
