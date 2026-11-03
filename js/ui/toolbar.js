/**
 * Toolbar (fetch / pull / push with ahead-behind counts, branch, stash, undo, palette),
 * the "merge in progress" banner with Continue / Abort, and the network progress bar.
 */
(function () {
  const U = Graft.utils;
  const R = Graft.repo;
  const A = Graft.actions;
  const I = Graft.icon;
  let bar; let banner; let netbar;

  const tb = (icon, label, title, onclick, extra) => U.el('button', { type: 'button', class: 'tb-btn' + (extra && extra.cls ? ' ' + extra.cls : ''), title, onclick, disabled: extra && extra.disabled },
    U.el('span', { html: I(icon) }), U.el('span', { class: 'tb-label', text: label }), extra && extra.count ? U.el('span', { class: 'tb-count', text: extra.count }) : null);

  function render() {
    if (!bar) return;
    if (!R.path) { bar.replaceChildren(U.el('span', { class: 'tb-title', text: 'Welcome' }), U.el('span', { class: 'spacer' }), tb('command', 'Commands', 'Command palette (Ctrl+P)', () => Graft.ui.palette.open())); renderBanner(); return; }
    const s = R.status || {};
    const busy = !!Graft.net.current;
    const u = Graft.undo.peek();
    bar.replaceChildren(
      tb('fetch', 'Fetch', 'Get the latest from the server without changing your files (Ctrl+Shift+F)', A.fetch, { disabled: busy }),
      tb('pull', 'Pull', `Bring in new commits from ${s.upstream || 'the server'} (Ctrl+Shift+L)`, A.pull, { disabled: busy, count: s.behind ? '↓' + s.behind : null, cls: s.behind ? 'is-due' : '' }),
      tb('push', 'Push', `Send your commits to ${s.upstream || 'the server'} (Ctrl+Shift+P)`, () => A.push(), { disabled: busy, count: s.ahead ? '↑' + s.ahead : (!s.upstream && s.branch && R.refs && R.refs.remotes.length ? 'new' : null), cls: s.ahead ? 'is-due' : '' }),
      U.el('span', { class: 'tb-sep' }),
      tb('branch', 'Branch', 'New branch (Ctrl+Shift+N)', () => A.newBranch()),
      tb('stash', 'Stash', 'Put your changes aside (Ctrl+Shift+S)', A.stashSave),
      tb('undo', 'Undo', u ? `Undo: ${u.label} (Ctrl+Z)` : 'Nothing to undo in this session — see Reflog for older positions', Graft.undo.run, { disabled: !u }),
      U.el('span', { class: 'spacer' }),
      U.el('button', { type: 'button', class: 'tb-btn tb-palette', title: 'Command palette', onclick: () => Graft.ui.palette.open() }, U.el('span', { html: I('search') }), U.el('span', { class: 'tb-label', text: 'Search commands' }), U.el('kbd', { text: 'Ctrl+P' })),
      tb('reflog', 'Reflog', 'Everywhere HEAD has been — find lost work', A.reflog),
      tb('terminal', 'Terminal', 'Open a terminal in this repository', A.terminal));
    renderBanner();
  }

  function renderBanner() {
    if (!banner) return;
    const i = R.info;
    const st = i && i.state;
    if (!st) { banner.hidden = true; return; }
    const s = R.status || { conflicts: [] };
    const n = s.conflicts.length;
    const what = st === 'rebase' ? `Rebasing ${i.rebase && i.rebase.headName ? i.rebase.headName : ''}${i.rebase && i.rebase.total ? ` — step ${i.rebase.step} of ${i.rebase.total}` : ''}` : st === 'merge' ? 'Merging' : st === 'cherry-pick' ? 'Cherry-picking' : 'Reverting';
    const b = (label, act, cls) => U.el('button', { type: 'button', class: 'btn btn-sm ' + (cls || 'btn-ghost'), text: label, onclick: () => A.sequencer(act) });
    banner.hidden = false;
    banner.replaceChildren(...[U.el('span', { class: 'sb-ico', html: I('warn') }),
      U.el('span', {}, U.el('strong', { text: what }), U.el('span', { class: 'muted', text: n ? ` · ${n} conflicted file${n > 1 ? 's' : ''} to resolve` : ' · all conflicts resolved — continue when ready' })),
      U.el('span', { class: 'spacer' }),
      n ? U.el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Show conflicts', onclick: () => Graft.app.go('changes') }) : null,
      st === 'rebase' ? b('Skip this commit', 'skip') : null,
      b('Abort', 'abort', 'btn-ghost btn-danger'),
      b(st === 'merge' ? 'Commit merge' : 'Continue', 'continue', n ? 'btn-ghost' : 'btn-primary')].filter(Boolean));
  }

  function onProgress(p) {
    if (!netbar) return;
    if (!p.running) { netbar.hidden = true; render(); return; }
    netbar.hidden = false;
    const pct = p.percent == null ? null : p.percent;
    netbar.replaceChildren(U.el('div', { class: 'spin spin-sm' }),
      U.el('strong', { text: p.label + '…' }),
      U.el('span', { class: 'muted small nb-text', text: p.text || 'Connecting…' }),
      U.el('div', { class: 'nb-track' }, U.el('div', { class: 'nb-fill' + (pct == null ? ' is-indeterminate' : ''), style: pct == null ? '' : `width:${pct}%` })),
      U.el('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: 'Cancel', onclick: () => Graft.net.cancel() }));
    if (p.text === '' && p.percent == null) render();
  }

  ['repo:open', 'repo:status', 'repo:refs', 'undo:change'].forEach((e) => Graft.bus.on(e, render));
  Graft.bus.on('net:progress', onProgress);
  Graft.ui.toolbar = { init(t, b, n) { bar = t; banner = b; netbar = n; render(); }, render };
})();
