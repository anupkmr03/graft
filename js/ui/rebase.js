/**
 * Edit commits (interactive rebase): drag to reorder, and per commit choose Keep, Reword,
 * Squash (join into the commit below, keeping both messages), Fixup (join, drop its message)
 * or Drop. Newest is at the top, like History.
 */
(function () {
  const U = Graft.utils;
  const R = Graft.repo;
  const ACTIONS = [['pick', 'Keep'], ['reword', 'Reword'], ['squash', 'Squash into below'], ['fixup', 'Fixup into below'], ['drop', 'Drop']];

  async function open(hash) {
    let data;
    try { data = await R.call('rebaseList', hash); } catch (e) { Graft.ui.dialog.alert('Can\'t edit these commits', R.clean(e)); return; }
    if (R.info && R.info.state) { Graft.ui.dialog.alert('Finish what\'s in progress first', `A ${R.info.state} is in progress. Continue or abort it before editing commits.`); return; }
    const rows = data.commits.slice().reverse().map((c) => ({ ...c, action: 'pick', newMessage: null }));
    const s = R.status || {};
    const pushed = s.upstream && rows.length > (s.ahead || 0);

    const list = U.el('div', { class: 'rb-list' });
    const warn = U.el('p', { class: 'rb-warn small' });
    let dragFrom = null;

    function validate() {
      const kept = rows.filter((r) => r.action !== 'drop');
      const bottom = kept[kept.length - 1];
      if (!kept.length) return 'At least one commit has to stay.';
      if (bottom && (bottom.action === 'squash' || bottom.action === 'fixup')) return 'The bottom commit can\'t be squashed: there\'s nothing below it to join.';
      if (rows.some((r) => r.action === 'reword' && r.newMessage != null && !r.newMessage.trim())) return 'A reworded commit needs a message.';
      return '';
    }
    function render() {
      list.replaceChildren(...rows.map((r, i) => {
        const sel = U.el('select', { class: 'select select-xs', onchange: (e) => { r.action = e.target.value; if (r.action === 'reword' && r.newMessage == null) r.newMessage = r.message; render(); } }, ...ACTIONS.map(([v, l]) => U.el('option', { value: v, text: l, selected: v === r.action })));
        const row = U.el('div', { class: 'rb-row is-' + r.action, draggable: 'true' },
          U.el('span', { class: 'rb-grip', text: '⋮⋮', title: 'Drag to move' }),
          sel,
          U.el('span', { class: 'mono small muted', text: r.hash.slice(0, 7) }),
          U.el('span', { class: 'rb-subj', text: r.message.split('\n')[0], title: r.message }),
          U.el('span', { class: 'rb-move' },
            U.el('button', { type: 'button', class: 'icon-btn icon-btn-xs', text: '↑', title: 'Move up (newer)', disabled: i === 0, onclick: () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; render(); } }),
            U.el('button', { type: 'button', class: 'icon-btn icon-btn-xs', text: '↓', title: 'Move down (older)', disabled: i === rows.length - 1, onclick: () => { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; render(); } })));
        row.addEventListener('dragstart', (e) => { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; row.classList.add('is-dragging'); });
        row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
        row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('is-over'); });
        row.addEventListener('dragleave', () => row.classList.remove('is-over'));
        row.addEventListener('drop', (e) => { e.preventDefault(); if (dragFrom == null || dragFrom === i) return; const [m] = rows.splice(dragFrom, 1); rows.splice(i, 0, m); dragFrom = null; render(); });
        const wrap = U.el('div', { class: 'rb-item' }, row);
        if (r.action === 'reword') {
          const ta = U.el('textarea', { class: 'field rb-msg', rows: 3, 'data-no-submit': '1', oninput: (e) => { r.newMessage = e.target.value; warn.textContent = validate(); } });
          ta.value = r.newMessage == null ? r.message : r.newMessage;
          wrap.append(ta);
        }
        return wrap;
      }));
      warn.textContent = validate();
    }
    render();

    Graft.ui.dialog.open({
      title: `Edit ${rows.length} commit${rows.length === 1 ? '' : 's'}`,
      wide: true,
      body: U.el('div', { class: 'stack' },
        U.el('p', { class: 'dialog-text small', text: 'Newest at the top. Drag rows (or use the arrows) to reorder. Your uncommitted changes are put aside and brought back afterwards. Undo (Ctrl+Z) restores the branch as it was.' }),
        pushed ? U.el('p', { class: 'rb-warn small', text: 'Some of these commits are already on the server. After editing them you\'ll need to force push, and anyone who pulled them will have to sort it out.' }) : null,
        list, warn),
      actions: [{ label: 'Cancel' }, { label: 'Apply', primary: true, onClick: () => {
        const err = validate();
        if (err) { warn.textContent = err; return false; }
        const todo = rows.slice().reverse().map((r) => ({ hash: r.hash, action: r.action, message: r.action === 'reword' ? r.newMessage : null }));
        const unchanged = todo.every((t, i) => t.action === 'pick' && t.hash === data.commits[i].hash);
        if (unchanged) { Graft.toast('Nothing changed.'); return true; }
        setTimeout(async () => {
          const res = await Graft.act('rebaseInteractive', [data.base, todo], { title: 'Couldn\'t edit the commits' });
          if (res && !res.conflicts) Graft.toast('Commits edited', 4000, { action: { label: 'Undo', onClick: () => Graft.undo.run() } });
        });
        return true;
      } }],
    });
  }

  Graft.ui.rebase = { open };
})();
