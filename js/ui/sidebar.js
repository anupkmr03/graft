/**
 * Sidebar: repository switcher, Changes / History, then branches, remotes, tags and stashes
 * (each foldable, with a filter). Click a branch to find it in History, double-click to switch,
 * right-click for everything else.
 */
(function () {
  const U = Graft.utils;
  const R = Graft.repo;
  const A = Graft.actions;
  const I = Graft.icon;
  let host;
  let filter = '';
  const folded = new Set(JSON.parse(Graft.store.get('folded', '[]')));

  function repoMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const recent = R.recent().filter((x) => x.path !== R.path).slice(0, 10);
    Graft.ui.menu.open(r.left, r.bottom + 6, [
      ...recent.map((x) => ({ label: x.name, hint: shortPath(x.path), onClick: () => R.open(x.path) })),
      ...(recent.length ? [{ separator: true }] : []),
      { label: 'Open repository…', hint: 'Ctrl+O', onClick: A.open },
      { label: 'Clone…', onClick: () => A.clone() },
      { label: 'New repository…', onClick: A.init },
      ...(R.path ? [{ separator: true }, { label: 'Show in Explorer', onClick: A.showFolder }, { label: 'Open terminal here', onClick: A.terminal }, { label: 'Close repository', onClick: R.close }] : []),
    ], 'Repositories');
  }
  const shortPath = (p) => (p.length > 38 ? '…' + p.slice(-37) : p);

  function section(id, title, count, items, extra) {
    const isFolded = folded.has(id);
    return U.el('section', { class: 'side-sec' + (isFolded ? ' is-folded' : '') },
      U.el('div', { class: 'side-sec-head' },
        U.el('button', { type: 'button', class: 'section-fold section-label', onclick: () => { if (folded.has(id)) folded.delete(id); else folded.add(id); Graft.store.set('folded', JSON.stringify([...folded])); render(); } },
          U.el('span', { html: I('chevron') }), title, count != null ? U.el('span', { class: 'side-count', text: count }) : null),
        extra || null),
      isFolded ? null : U.el('div', { class: 'side-list' }, ...items));
  }

  function item({ icon, label, title, active, badges, onclick, ondblclick, oncontextmenu, cls }) {
    return U.el('button', { type: 'button', class: 'side-item' + (active ? ' is-active' : '') + (cls ? ' ' + cls : ''), title: title || label, onclick, ondblclick, oncontextmenu: oncontextmenu ? (e) => { e.preventDefault(); oncontextmenu(e); } : null },
      icon ? U.el('span', { class: 'side-ico', html: I(icon) }) : null,
      U.el('span', { class: 'side-label', text: label }),
      ...(badges || []));
  }
  const badge = (text, cls, title) => U.el('span', { class: 'side-badge ' + (cls || ''), text, title });
  const match = (name) => !filter || name.toLowerCase().includes(filter);

  function localMenu(e, b) {
    const cur = R.info && R.info.headName;
    const isCur = b.name === cur;
    Graft.ui.menu.open(e.clientX, e.clientY, [
      ...(isCur ? [] : [{ label: `Switch to ${b.name}`, onClick: () => A.checkout(b.name) }]),
      ...(isCur || !cur ? [] : [{ label: `Merge ${b.name} into ${cur}`, onClick: () => A.merge(b.name) }, { label: `Rebase ${cur} onto ${b.name}`, onClick: () => A.rebase(b.name) }]),
      { label: 'New branch from here…', onClick: () => A.newBranch(b.name, b.name) },
      { separator: true },
      ...(isCur ? [{ label: 'Push', onClick: () => A.push() }, { label: 'Pull', onClick: () => A.pull() }] : []),
      { label: b.upstream ? `Tracks ${b.upstream}… (change)` : 'Track remote branch…', onClick: () => A.setUpstream(b.name) },
      { label: 'Rename…', onClick: () => A.rename(b.name) },
      { label: 'Copy name', onClick: () => A.copy(b.name) },
      ...(isCur ? [] : [{ separator: true }, { label: 'Delete…', danger: true, onClick: () => A.deleteBranch(b.name) }]),
    ], b.name);
  }
  function remoteMenu(e, b) {
    const cur = R.info && R.info.headName;
    Graft.ui.menu.open(e.clientX, e.clientY, [
      { label: 'Check out as local branch', onClick: () => A.checkoutRemote(b.name) },
      ...(cur ? [{ label: `Merge into ${cur}`, onClick: () => A.merge(b.name) }, { label: `Rebase ${cur} onto this`, onClick: () => A.rebase(b.name) }] : []),
      { label: 'New branch from here…', onClick: () => A.newBranch(b.name, b.name) },
      { label: 'Copy name', onClick: () => A.copy(b.name) },
      { separator: true },
      { label: 'Delete on server…', danger: true, onClick: () => A.deleteRemoteBranch(b.name) },
    ], b.name);
  }
  function tagMenu(e, t) {
    Graft.ui.menu.open(e.clientX, e.clientY, [
      { label: 'Show in History', onClick: () => Graft.ui.history.reveal(t.oid) },
      { label: 'Check out (detached)', onClick: () => A.checkoutCommit(t.oid) },
      { label: 'New branch from tag…', onClick: () => A.newBranch(t.name, t.name) },
      { separator: true },
      { label: 'Push tag', onClick: () => A.pushTag(t.name) },
      { label: 'Copy name', onClick: () => A.copy(t.name) },
      { separator: true },
      { label: 'Delete…', danger: true, onClick: () => A.deleteTag(t.name) },
      { label: 'Delete on server…', danger: true, onClick: () => A.deleteRemoteTag(t.name) },
    ], t.name);
  }
  function stashMenu(e, s) {
    Graft.ui.menu.open(e.clientX, e.clientY, [
      { label: 'Apply (keep the stash)', onClick: () => A.stashApply(s.ref) },
      { label: 'Pop (apply and remove)', onClick: () => A.stashPop(s.ref) },
      { label: 'Show changes', onClick: () => Graft.ui.history.showStash(s) },
      { separator: true },
      { label: 'Drop…', danger: true, onClick: () => A.stashDrop(s.ref) },
    ], s.message || s.ref);
  }

  function render() {
    if (!host) return;
    const view = Graft.app.view();
    if (!R.path) {
      host.replaceChildren(
        U.el('button', { type: 'button', class: 'repo-pick', onclick: repoMenu }, U.el('span', { class: 'repo-pick-text' }, U.el('strong', { text: 'No repository' }), U.el('span', { class: 'muted small', text: 'Open or clone one' })), U.el('span', { html: I('chevron') })),
        U.el('div', { class: 'side-nav' }, item({ icon: 'settings', label: 'Settings', active: view === 'settings', onclick: () => Graft.app.go('settings') })));
      return;
    }
    const s = R.status || { staged: [], unstaged: [], untracked: [], conflicts: [] };
    const refs = R.refs || { local: [], remote: [], tags: [], remotes: [] };
    const changes = s.staged.length + s.unstaged.length + s.untracked.length + s.conflicts.length;
    const info = R.info || {};
    const nodes = [
      U.el('button', { type: 'button', class: 'repo-pick', onclick: repoMenu, title: R.path },
        U.el('span', { class: 'repo-pick-text' }, U.el('strong', { text: info.name || '…' }), U.el('span', { class: 'muted small mono', text: info.headName || (info.head ? 'detached at ' + info.head.slice(0, 7) : 'no commits yet') })),
        U.el('span', { html: I('chevron') })),
      U.el('div', { class: 'side-nav' },
        item({ icon: 'changes', label: 'Changes', active: view === 'changes', onclick: () => Graft.app.go('changes'), badges: changes ? [badge(changes, s.conflicts.length ? 'is-bad' : 'is-accent')] : [] }),
        item({ icon: 'history', label: 'History', active: view === 'history', onclick: () => Graft.app.go('history') })),
    ];
    const total = refs.local.length + refs.remote.length + refs.tags.length;
    if (total > 12) {
      const input = U.el('input', { class: 'side-filter', type: 'search', placeholder: 'Filter branches and tags', value: filter, spellcheck: 'false', oninput: (e) => { filter = e.target.value.trim().toLowerCase(); render(); const f = host.querySelector('.side-filter'); f.focus(); f.setSelectionRange(f.value.length, f.value.length); } });
      nodes.push(input);
    }
    const scroll = U.el('div', { class: 'side-scroll' });
    // Local branches
    scroll.append(section('local', 'Branches', refs.local.length, refs.local.filter((b) => match(b.name)).map((b) => item({
      icon: 'branch', label: b.name, active: b.current, cls: b.current ? 'is-current' : '',
      title: `${b.name}${b.upstream ? ' → ' + b.upstream : ''}\n${b.subject || ''}`,
      badges: [b.ahead ? badge('↑' + b.ahead, '', `${b.ahead} to push`) : null, b.behind ? badge('↓' + b.behind, '', `${b.behind} to pull`) : null, b.gone ? badge('gone', 'is-bad', 'Its remote branch was deleted') : null].filter(Boolean),
      onclick: () => Graft.ui.history.reveal(b.oid), ondblclick: () => { if (!b.current) A.checkout(b.name); }, oncontextmenu: (e) => localMenu(e, b),
    })), U.el('button', { type: 'button', class: 'icon-btn icon-btn-xs', title: 'New branch (Ctrl+Shift+N)', html: I('plus'), onclick: () => A.newBranch() })));
    // Remotes, grouped
    const byRemote = {};
    refs.remotes.forEach((r) => { byRemote[r.name] = []; });
    refs.remote.forEach((b) => { const rn = b.name.split('/')[0]; (byRemote[rn] = byRemote[rn] || []).push(b); });
    const remoteItems = [];
    Object.entries(byRemote).forEach(([rn, list]) => {
      const url = (refs.remotes.find((r) => r.name === rn) || {}).url || '';
      remoteItems.push(item({ icon: 'remote', label: rn, title: url, cls: 'is-group', oncontextmenu: (e) => Graft.ui.menu.open(e.clientX, e.clientY, [{ label: 'Fetch', onClick: A.fetch }, { label: 'Copy address', onClick: () => A.copy(url) }, { separator: true }, { label: 'Remove remote…', danger: true, onClick: () => A.removeRemote(rn) }], rn) }));
      list.filter((b) => match(b.name)).forEach((b) => remoteItems.push(item({ label: b.name.slice(rn.length + 1), title: b.name + '\n' + (b.subject || ''), cls: 'is-sub', onclick: () => Graft.ui.history.reveal(b.oid), ondblclick: () => A.checkoutRemote(b.name), oncontextmenu: (e) => remoteMenu(e, b) })));
    });
    scroll.append(section('remote', 'Remotes', refs.remotes.length, remoteItems, U.el('button', { type: 'button', class: 'icon-btn icon-btn-xs', title: 'Add remote', html: I('plus'), onclick: () => A.addRemote() })));
    // Tags
    const tags = refs.tags.filter((t) => match(t.name));
    scroll.append(section('tags', 'Tags', refs.tags.length, tags.slice(0, 300).map((t) => item({ icon: 'tag', label: t.name, title: t.name + '\n' + (t.subject || ''), onclick: () => Graft.ui.history.reveal(t.oid), oncontextmenu: (e) => tagMenu(e, t) })), U.el('button', { type: 'button', class: 'icon-btn icon-btn-xs', title: 'New tag on the current commit', html: I('plus'), onclick: () => A.newTag() })));
    // Stashes
    scroll.append(section('stash', 'Stashes', R.stashes.length, R.stashes.map((st) => item({ icon: 'stash', label: st.message || st.ref, title: `${st.ref} · ${U.timeAgo(st.time)}\n${st.raw}`, onclick: () => Graft.ui.history.showStash(st), oncontextmenu: (e) => stashMenu(e, st) })), U.el('button', { type: 'button', class: 'icon-btn icon-btn-xs', title: 'Stash changes (Ctrl+Shift+S)', html: I('plus'), onclick: () => A.stashSave() })));
    nodes.push(scroll);
    nodes.push(U.el('div', { class: 'side-foot' }, item({ icon: 'settings', label: 'Settings', active: view === 'settings', onclick: () => Graft.app.go('settings') })));
    const keep = host.querySelector('.side-scroll');
    const top = keep ? keep.scrollTop : 0;
    host.replaceChildren(...nodes);
    const sc = host.querySelector('.side-scroll');
    if (sc) sc.scrollTop = top;
  }

  ['repo:open', 'repo:refs', 'repo:status', 'view:change', 'recent:change'].forEach((ev) => Graft.bus.on(ev, render));
  Graft.ui.sidebar = { init: (h) => { host = h; render(); }, render };
})();
