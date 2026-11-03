/**
 * Blame: who last changed each line, and in which commit. Newer changes have a brighter bar.
 * Click a commit to open it in History.
 */
(function () {
  const U = Graft.utils;
  const R = Graft.repo;
  let host;
  let back = 'changes';

  async function open(path, rev) {
    back = Graft.app.view() === 'blame' ? back : Graft.app.view() || 'history';
    Graft.app.go('blame');
    host.replaceChildren(U.el('div', { class: 'glass bl-wrap' }, U.el('div', { class: 'dv-empty muted', text: 'Reading who changed what…' })));
    let data;
    try { data = await R.call('blame', path, rev || null); } catch (e) { host.replaceChildren(U.el('div', { class: 'glass bl-wrap' }, head(path, rev), U.el('div', { class: 'dv-empty muted', text: R.clean(e) }))); return; }
    const times = Object.values(data.commits).map((c) => c.time || 0);
    const min = Math.min(...times);
    const max = Math.max(...times);
    const lang = Graft.hl.lang(path);
    const tab = Number(Graft.prefs.get('tabSize')) || 4;
    const esc = Graft.hl.esc;
    const out = [];
    let prev = null;
    data.lines.forEach((l, i) => {
      const c = data.commits[l.hash];
      const first = l.hash !== prev;
      prev = l.hash;
      const age = max > min ? (c.time - min) / (max - min) : 1;
      const notYet = /^0+$/.test(l.hash);
      const g = first ? `<span class="bl-hash mono">${notYet ? 'not committed' : l.hash.slice(0, 7)}</span><span class="bl-author">${esc(c.author || '')}</span><span class="bl-date">${c.time ? U.timeAgo(c.time) : ''}</span>` : '';
      out.push(`<div class="bl-line${first ? ' is-first' : ''}" data-h="${notYet ? '' : l.hash}" title="${first ? esc((c.summary || '') + ' — ' + (c.author || '')) : ''}"><span class="bl-gutter" style="--age:${(0.15 + age * 0.85).toFixed(2)}">${g}</span><span class="ln">${i + 1}</span><span class="code">${Graft.hl.render(l.text, lang, null, tab) || ' '}</span></div>`);
    });
    const body = U.el('div', { class: 'bl-body' });
    body.innerHTML = out.join('');
    body.addEventListener('click', (e) => { const g = e.target.closest('.bl-gutter'); if (!g) return; const h = g.parentElement.dataset.h; if (h) Graft.ui.history.reveal(h); });
    host.replaceChildren(U.el('div', { class: 'glass bl-wrap' }, head(path, rev, data), body));
  }

  function head(path, rev, data) {
    const n = data ? Object.keys(data.commits).length : 0;
    return U.el('div', { class: 'dv-head' },
      U.el('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: '← Back', onclick: () => Graft.app.go(back) }),
      U.el('span', { class: 'dv-path' }, U.el('span', { class: 'muted', text: 'Blame ' }), U.el('strong', { text: path }), rev ? U.el('span', { class: 'muted mono', text: ' at ' + rev.slice(0, 7) }) : null),
      U.el('span', { class: 'spacer' }),
      data ? U.el('span', { class: 'muted small', text: `${data.lines.length.toLocaleString()} lines · ${n} commit${n === 1 ? '' : 's'}` }) : null,
      U.el('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: 'File history', onclick: () => Graft.ui.history.fileHistory(path) }));
  }

  Graft.ui.blame = { init: (h) => { host = h; }, open, show() {}, hide() {} };
})();
