/**
 * Changes: conflicted, unstaged and staged files on the left with the commit box below them;
 * the diff (or the 3-way conflict view) on the right.
 *   click = show · double-click / Space = stage or unstage · right-click = more
 *   ↑ ↓ move between files · Ctrl+Enter commits
 */
(function () {
  const U = Graft.utils;
  const R = Graft.repo;
  const A = Graft.actions;
  const I = Graft.icon;
  const BADGE = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', untracked: '+', conflict: '!' };

  let host; let listEl; let rightEl; let msgEl; let amendEl; let commitBtn; let countEl;
  let diff = null;
  let sel = null;      // { group, path, index }
  let shown = false;

  const groups = () => {
    const s = R.status || { staged: [], unstaged: [], untracked: [], conflicts: [] };
    return { conflict: s.conflicts, unstaged: [...s.unstaged, ...s.untracked.map((f) => ({ ...f, untracked: true }))], staged: s.staged };
  };
  const whereOf = (group, f) => (group === 'staged' ? 'staged' : f.untracked ? 'untracked' : 'unstaged');

  function build() {
    listEl = U.el('div', { class: 'ch-lists', tabindex: '0', onkeydown: onKey });
    msgEl = U.el('textarea', { class: 'field ch-msg', rows: 4, placeholder: 'Summary of the change\n\nMore detail (optional)', spellcheck: 'true', oninput: onMsg, onkeydown: (e) => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); doCommit(); } } });
    amendEl = U.el('input', { type: 'checkbox', onchange: onAmend });
    countEl = U.el('span', { class: 'ch-count muted small mono' });
    commitBtn = U.el('button', { type: 'button', class: 'btn btn-primary ch-commit', onclick: doCommit });
    const left = U.el('div', { class: 'glass ch-left' }, listEl,
      U.el('div', { class: 'ch-box' }, msgEl,
        U.el('div', { class: 'ch-row' }, U.el('label', { class: 'check-line small' }, amendEl, U.el('span', { text: 'Amend last commit' })), countEl),
        commitBtn));
    left.style.width = Graft.prefs.get('splitChanges') + 'px';
    const handle = U.el('div', { class: 'resizer resizer-v' });
    dragResize(handle, left, 'splitChanges', 260, 640);
    rightEl = U.el('div', { class: 'glass ch-right' });
    diff = Graft.ui.diffview.create(rightEl);
    host.replaceChildren(left, handle, rightEl);
  }

  function dragResize(handle, el, pref, min, max) {
    handle.addEventListener('pointerdown', (e) => {
      const x0 = e.clientX; const w0 = el.offsetWidth;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => { el.style.width = U.clamp(w0 + ev.clientX - x0, min, max) + 'px'; };
      const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); Graft.prefs.set(pref, el.offsetWidth); };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  function fileRow(group, f, i) {
    const isSel = sel && sel.group === group && sel.path === f.path;
    const dir = Graft.ui.diffview.dirName(f.path);
    const st = f.untracked ? 'untracked' : f.status;
    return U.el('div', { class: 'ch-file' + (isSel ? ' is-selected' : ''), role: 'option', 'aria-selected': String(!!isSel), title: f.from ? `${f.from} → ${f.path}` : f.path,
      onclick: () => select(group, f.path, i), ondblclick: () => toggle(group, f), oncontextmenu: (e) => { e.preventDefault(); select(group, f.path, i); fileMenu(e, group, f); } },
    U.el('span', { class: 'st st-' + st, text: BADGE[st] || 'M', title: st }),
    U.el('span', { class: 'ch-name' }, U.el('span', { text: Graft.ui.diffview.baseName(f.path) }), dir ? U.el('span', { class: 'muted small', text: ' ' + dir }) : null),
    group === 'conflict' ? null : U.el('button', { type: 'button', class: 'icon-btn icon-btn-xs ch-quick', title: group === 'staged' ? 'Unstage' : 'Stage', text: group === 'staged' ? '−' : '+', onclick: (e) => { e.stopPropagation(); toggle(group, f); } }));
  }

  function groupBlock(group, title, files, actions) {
    if (!files.length && group === 'conflict') return null;
    return U.el('section', { class: 'ch-group' },
      U.el('div', { class: 'ch-group-head' }, U.el('span', { class: 'section-label', text: `${title} · ${files.length}` }), U.el('span', { class: 'spacer' }), ...actions),
      files.length ? U.el('div', { class: 'ch-files', role: 'listbox' }, ...files.map((f, i) => fileRow(group, f, i))) : U.el('p', { class: 'muted small ch-none', text: group === 'staged' ? 'Nothing staged. Stage files or lines to commit them.' : 'No changes.' }));
  }

  function renderList() {
    if (!listEl) return;
    const g = groups();
    const lb = (text, title, fn, cls) => U.el('button', { type: 'button', class: 'link-btn small' + (cls ? ' ' + cls : ''), text, title, onclick: fn });
    const top = listEl.scrollTop;
    listEl.replaceChildren(...[
      groupBlock('conflict', 'Conflicts', g.conflict, []),
      groupBlock('unstaged', 'Unstaged', g.unstaged, g.unstaged.length ? [lb('Stage all', 'Stage every change (Ctrl+Shift+A)', A.stageAll), lb('Discard all', 'Throw away all unstaged changes', A.discardAll, 'is-danger')] : []),
      groupBlock('staged', 'Staged', g.staged, g.staged.length ? [lb('Unstage all', 'Move everything back to unstaged', A.unstageAll)] : []),
    ].filter(Boolean));
    listEl.scrollTop = top;
    renderCommitBox();
  }

  function renderCommitBox() {
    const s = R.status || { staged: [] };
    const n = s.staged.length;
    const amend = amendEl.checked;
    const branch = (R.info && R.info.headName) || 'detached HEAD';
    const merging = R.info && R.info.state === 'merge';
    commitBtn.textContent = amend ? `Amend last commit${n ? ` (+${n} file${n > 1 ? 's' : ''})` : ''}` : merging ? 'Commit merge' : `Commit ${n || ''} file${n === 1 ? '' : 's'} to ${branch}`.replace('  ', ' ');
    commitBtn.disabled = (!n && !amend && !merging) || !msgEl.value.trim() || (R.status && R.status.conflicts.length > 0);
    commitBtn.title = commitBtn.disabled ? (R.status && R.status.conflicts.length ? 'Resolve conflicts first' : !n && !amend ? 'Stage something first' : 'Write a message first') : 'Ctrl+Enter';
    const first = msgEl.value.split('\n')[0].length;
    countEl.textContent = first ? String(first) : '';
    countEl.classList.toggle('is-long', first > 72);
    countEl.title = first > 72 ? 'Summaries are easiest to read under 72 characters' : 'Summary length';
  }

  const draftKey = () => 'draft:' + R.path;
  function onMsg() { Graft.store.set(draftKey(), msgEl.value); renderCommitBox(); }
  async function onAmend() {
    if (amendEl.checked && !msgEl.value.trim()) { msgEl.value = await R.call('lastMessage'); onMsg(); }
    renderCommitBox();
  }
  let committing = false;
  async function doCommit() {
    if (commitBtn.disabled || committing) return;
    committing = true;
    commitBtn.disabled = true;
    try {
      const res = await A.commit(msgEl.value, amendEl.checked);
      if (res) { msgEl.value = ''; amendEl.checked = false; onMsg(); }
    } finally { committing = false; renderCommitBox(); }
  }

  function flat() { const g = groups(); return [...g.conflict.map((f) => ['conflict', f]), ...g.unstaged.map((f) => ['unstaged', f]), ...g.staged.map((f) => ['staged', f])]; }

  function select(group, path, index) {
    sel = { group, path, index: index || 0 };
    renderList();
    showSel();
    listEl.focus({ preventScroll: true });
  }

  function showSel(keepScroll) {
    if (!sel) { diff.clear(flat().length ? 'Select a file to see its changes.' : 'Nothing to commit — your files match the last commit.'); return; }
    const g = groups()[sel.group];
    const f = g.find((x) => x.path === sel.path);
    if (!f) return;
    if (sel.group === 'conflict') { Graft.ui.conflict.show(rightEl, f.path, () => { diff = Graft.ui.diffview.create(rightEl); }); return; }
    if (rightEl.classList.contains('is-conflict')) { rightEl.classList.remove('is-conflict'); diff = Graft.ui.diffview.create(rightEl); }
    diff.show({ file: f, where: whereOf(sel.group, f) }, keepScroll);
  }

  /** After a refresh: keep the same file, or the next one where it was. */
  function reconcile() {
    if (!sel) { const all = flat(); if (all.length && shown) { const [grp, f] = all[0]; sel = { group: grp, path: f.path, index: 0 }; } renderList(); showSel(); return; }
    const g = groups();
    if (g[sel.group].some((f) => f.path === sel.path)) { renderList(); showSel(true); return; }
    const list = g[sel.group];
    if (list.length) { const i = Math.min(sel.index, list.length - 1); sel = { group: sel.group, path: list[i].path, index: i }; } else {
      const other = Object.entries(g).find(([, l]) => l.some((f) => f.path === sel.path));
      if (other) sel = { group: other[0], path: sel.path, index: other[1].findIndex((f) => f.path === sel.path) };
      else { const all = flat(); sel = all.length ? { group: all[0][0], path: all[0][1].path, index: 0 } : null; }
    }
    renderList();
    showSel();
  }

  function toggle(group, f) {
    if (group === 'staged') A.unstage([f]);
    else if (group === 'unstaged') A.stage([f]);
  }

  function onKey(e) {
    if (e.target !== listEl) return;
    const all = flat();
    const i = sel ? all.findIndex(([g, f]) => g === sel.group && f.path === sel.path) : -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const j = U.clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, all.length - 1);
      if (all[j]) { const [g, f] = all[j]; select(g, f.path, groups()[g].indexOf(f)); listEl.querySelector('.is-selected') && listEl.querySelector('.is-selected').scrollIntoView({ block: 'nearest' }); }
    } else if ((e.key === ' ' || e.key === 'Enter') && i >= 0) { e.preventDefault(); toggle(all[i][0], all[i][1]); }
    else if (e.key === 'Delete' && i >= 0 && all[i][0] === 'unstaged') { e.preventDefault(); A.discard([all[i][1]]); }
  }

  function fileMenu(e, group, f) {
    const items = [];
    if (group === 'unstaged') items.push({ label: 'Stage', hint: 'Space', onClick: () => A.stage([f]) }, { label: f.untracked ? 'Delete (to Recycle Bin)…' : 'Discard changes…', hint: 'Del', danger: true, onClick: () => A.discard([f]) });
    if (group === 'staged') items.push({ label: 'Unstage', hint: 'Space', onClick: () => A.unstage([f]) });
    if (group === 'conflict') items.push({ label: 'Use my version (ours)', onClick: () => Graft.act('resolveWith', [f.path, 'ours']) }, { label: 'Use their version (theirs)', onClick: () => Graft.act('resolveWith', [f.path, 'theirs']) }, { label: 'Mark as resolved', onClick: () => Graft.act('resolve', [f.path, null]) });
    items.push({ separator: true },
      { label: 'Open file', onClick: () => window.graftDesktop.openFile(R.path, f.path) },
      { label: 'Show in Explorer', onClick: () => window.graftDesktop.showFile(R.path, f.path) },
      { label: 'File history', onClick: () => Graft.ui.history.fileHistory(f.path) });
    if (!f.untracked && f.status !== 'added') items.push({ label: 'Blame', onClick: () => Graft.ui.blame.open(f.path) });
    items.push({ label: 'Copy path', onClick: () => A.copy(f.path) });
    if (f.untracked) items.push({ separator: true }, { label: 'Ignore…', onClick: () => A.ignore(f.path) });
    Graft.ui.menu.open(e.clientX, e.clientY, items, f.path);
  }

  function onOpen() {
    sel = null;
    if (!msgEl) return;
    msgEl.value = Graft.store.get(draftKey(), '');
    amendEl.checked = false;
  }

  Graft.bus.on('repo:open', onOpen);
  Graft.bus.on('repo:status', () => {
    if (!msgEl) return;
    if (R.info && R.info.state === 'merge' && !msgEl.value.trim() && R.info.mergeMsg) { msgEl.value = R.info.mergeMsg.split('\n').filter((l) => !l.startsWith('#')).join('\n').trim(); onMsg(); }
    if (shown) reconcile(); else renderList();
  });
  Graft.bus.on('prefs:change', ({ key }) => { if (shown && ['wordDiff', 'syntax', 'tabSize', 'wrap', 'context', 'ignoreWhitespace'].includes(key)) showSel(true); });
  Graft.bus.on('theme:change', () => {});

  Graft.ui.changes = {
    init(h) { host = h; build(); onOpen(); },
    show() { shown = true; reconcile(); },
    hide() { shown = false; },
    focusMessage() { if (msgEl) msgEl.focus(); },
    commit: doCommit,
    selectPath(path) { const g = groups(); const e = Object.entries(g).find(([, l]) => l.some((f) => f.path === path)); if (e) select(e[0], path, e[1].findIndex((f) => f.path === path)); },
  };
})();
