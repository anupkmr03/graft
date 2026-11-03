/**
 * Settings: appearance, diffs, history, behaviour (refresh, auto-fetch, pull mode, confirmations),
 * your Git identity, keyboard shortcuts, about.
 */
(function () {
  const U = Graft.utils;
  const P = Graft.prefs;
  const D = window.graftDesktop;
  let host;

  function row(label, hint, control) {
    return U.el('div', { class: 'set-row' },
      U.el('div', { class: 'set-text' }, U.el('span', { class: 'set-label', text: label }), hint ? U.el('span', { class: 'set-hint muted small', text: hint }) : null),
      control ? U.el('div', { class: 'set-ctl' }, control) : null);
  }
  function segmented(options, current, onPick) {
    return U.el('div', { class: 'segmented', role: 'group' }, ...Object.entries(options).map(([v, l]) => U.el('button', {
      type: 'button', class: 'seg-btn seg-text', 'aria-pressed': String(v) === String(current) ? 'true' : 'false', text: l, onclick: () => { onPick(v); render(); },
    })));
  }
  const pref = (key, options, num) => segmented(options, P.get(key), (v) => P.set(key, num ? Number(v) : v));
  function toggle(key) {
    const b = U.el('input', { type: 'checkbox', class: 'switch', checked: !!P.get(key), role: 'switch' });
    b.addEventListener('change', () => P.set(key, b.checked));
    return b;
  }
  function swatches() {
    const A = Graft.appearance;
    const cur = A.get('accent');
    return U.el('div', { class: 'swatches', role: 'radiogroup' }, ...Object.entries(A.ACCENTS).map(([k, a]) => U.el('button', {
      type: 'button', class: 'swatch', role: 'radio', title: a.label, 'aria-label': a.label, 'aria-checked': k === cur ? 'true' : 'false', style: `--swatch:${a.main}`,
      onclick: () => { A.set({ accent: k }); render(); },
    })));
  }
  const section = (title, ...rows) => U.el('section', { class: 'glass set-section' }, U.el('h3', { class: 'section-label', text: title }), ...rows);

  async function identity() {
    const id = await D.op('identity', Graft.repo.path || null).catch(() => ({}));
    const name = U.el('input', { class: 'field', type: 'text', value: id.globalName || '', placeholder: 'Your Name', spellcheck: 'false' });
    const email = U.el('input', { class: 'field', type: 'text', value: id.globalEmail || '', placeholder: 'you@example.com', spellcheck: 'false' });
    const save = U.el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: 'Save', onclick: async () => {
      if (!name.value.trim() || !email.value.trim()) { Graft.toast('Fill in both.'); return; }
      try { await D.op('setIdentity', null, name.value.trim(), email.value.trim()); Graft.toast('Saved. New commits use this name and email.'); } catch (e) { Graft.toast(Graft.repo.clean(e)); }
    } });
    const repoNote = Graft.repo.path && id.name && (id.name !== id.globalName || id.email !== id.globalEmail) ? `This repository overrides it with ${id.name} <${id.email}>.` : null;
    return section('Your identity',
      row('Name and email on your commits', 'Saved in Git\'s global settings, so other Git tools use it too.' + (repoNote ? ' ' + repoNote : ''), null),
      U.el('div', { class: 'id-form' }, name, email, save));
  }

  async function render() {
    const A = Graft.appearance;
    const info = await D.info().catch(() => ({}));
    const git = await D.op('version', null).catch(() => null);
    const keys = [['Ctrl+P', 'Command palette'], ['Ctrl+1 / Ctrl+2', 'Changes / History'], ['Ctrl+Enter', 'Commit'], ['Ctrl+Z', 'Undo last action'], ['Ctrl+Shift+F / L / P', 'Fetch / Pull / Push'], ['Ctrl+Shift+N', 'New branch'], ['Ctrl+Shift+S', 'Stash'], ['Ctrl+Shift+A', 'Stage all'], ['Ctrl+F', 'Search history'], ['Ctrl+O', 'Open repository'], ['Ctrl+B', 'Hide / show sidebar'], ['F5', 'Refresh'], ['Space / Enter', 'Stage or unstage the selected file'], ['Delete', 'Discard the selected file'], ['↑ ↓', 'Move between files or commits']];
    host.replaceChildren(
      U.el('div', { class: 'page-head' }, U.el('div', {}, U.el('h1', { text: 'Settings' }))),
      section('Appearance',
        row('Theme', 'Dark, light, or follow Windows', segmented(A.THEMES, A.get('theme'), (v) => A.set({ theme: v }))),
        row('Accent colour', null, swatches()),
        row('Background', null, segmented(A.BACKGROUNDS, A.get('bg'), (v) => A.set({ bg: v }))),
        row('Text & UI size', null, segmented(A.SIZES, A.get('size'), (v) => A.set({ size: v })))),
      section('Diffs',
        row('Lines of context', 'Unchanged lines shown around each change', pref('context', { 1: '1', 3: '3', 5: '5', 10: '10' }, true)),
        row('Highlight changed words', 'Marks exactly what changed inside a line', toggle('wordDiff')),
        row('Syntax colours', 'Colours code in diffs, blame and conflicts', toggle('syntax')),
        row('Wrap long lines', null, toggle('wrap')),
        row('Tab width', null, pref('tabSize', { 2: '2', 4: '4', 8: '8' }, true)),
        row('Ignore spaces by default', 'Hide changes that only add or remove spaces (line staging is off while this is on)', toggle('ignoreWhitespace'))),
      section('History',
        row('Show remote branches', 'Include branches from the server in the graph', toggle('remotesInGraph')),
        row('Dates', null, pref('dates', { relative: '3 hours ago', absolute: 'Exact date' }))),
      section('Behaviour',
        row('Refresh', 'Notice file changes made in other apps', pref('refresh', { live: 'Every 4 s while open', focus: 'When I switch back' })),
        row('Fetch automatically', 'Keeps the ↓ pull count current (needs network; sign-in uses Git\'s credential manager)', pref('autoFetch', { 0: 'Off', 5: '5 min', 15: '15 min', 30: '30 min' }, true)),
        row('Pull', 'How incoming commits join yours', pref('pullMode', { merge: 'Merge', rebase: 'Rebase', ff: 'Fast-forward only' })),
        row('Remove deleted remote branches on fetch', null, toggle('pruneOnFetch')),
        row('First push of a branch', 'Create it on the server and link it, without asking (when there\'s one remote)', toggle('pushUpstream')),
        row('Confirm before discarding', 'Discarded changes can still be brought back with Undo', toggle('confirmDiscard')),
        row('Confirm before pushing', null, toggle('confirmPush'))),
      await identity(),
      section('Keyboard', U.el('div', { class: 'keys' }, ...keys.map(([k, l]) => U.el('div', { class: 'key-row' }, U.el('kbd', { text: k }), U.el('span', { class: 'muted', text: l }))))),
      section('About',
        row('Version', `Graft ${Graft.config.APP_VERSION}${info.electron ? ` (Electron ${info.electron})` : ''}`, null),
        row('Git', git || 'Not found', git ? null : U.el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Get Git', onclick: () => D.openUrl(Graft.config.GIT_DOWNLOAD) }))));
  }

  Graft.ui.settings = { init: (h) => { host = h; }, show: render, hide: () => {} };
})();
