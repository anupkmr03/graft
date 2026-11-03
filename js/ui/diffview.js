/**
 * Diff viewer for one file: syntax colours, changed words, image diff, whitespace ignore, and —
 * for your working changes — staging, unstaging or discarding a hunk or just the lines you pick.
 *
 *   const v = Graft.ui.diffview.create(host)
 *   v.show({ file, where })   where: 'unstaged' | 'staged' | 'untracked' | { base, rev }
 *   v.clear(message)
 *
 * Picking lines: click a changed line, Shift+click for a range, or drag down the lines.
 */
(function () {
  const U = Graft.utils;
  const R = Graft.repo;
  const C = Graft.config;
  const H = Graft.hl;
  const IMG = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i;

  function create(host) {
    let cur = null;          // { file, where, parsed, lang, full }
    let selected = new Set();
    let anchor = null;
    let token = 0;

    host.classList.add('diffview');
    host.addEventListener('mousedown', onDown);
    host.addEventListener('click', onClick);

    function clear(message) {
      cur = null;
      selected = new Set();
      host.replaceChildren(U.el('div', { class: 'dv-empty muted', text: message || 'Select a file to see its changes.' }));
    }

    const editable = () => cur && (cur.where === 'unstaged' || cur.where === 'staged');
    const linesOk = () => editable() && cur.parsed && !cur.parsed.binary && !cur.parsed.isNew && !cur.parsed.isDeleted && !(cur.file.from && cur.file.from !== cur.file.path) && !Graft.prefs.get('ignoreWhitespace');

    async function show(spec, keepScroll) {
      const my = ++token;
      const scroll = keepScroll && cur && cur.file.path === spec.file.path && cur.where === spec.where ? (host.querySelector('.dv-body') || {}).scrollTop : 0;
      if (!keepScroll || !cur || cur.file.path !== spec.file.path) selected = new Set();
      const file = spec.file;
      const opts = { context: Number(Graft.prefs.get('context')), ignoreWhitespace: !!Graft.prefs.get('ignoreWhitespace') };
      let res;
      try { res = await R.call('diff', file, spec.where, opts); } catch (e) { if (my === token) host.replaceChildren(U.el('div', { class: 'dv-empty muted', text: R.clean(e) })); return; }
      if (my !== token) return;
      const parsed = Graft.diff.parse(res.text)[0] || { header: [], hunks: [], binary: false };
      if (Graft.prefs.get('wordDiff')) Graft.diff.markWords(parsed);
      cur = { file, where: spec.where, parsed, lang: H.lang(file.path), full: spec.full, truncated: res.truncated, zero: opts.context === 0 };
      render();
      const body = host.querySelector('.dv-body');
      if (body && scroll) body.scrollTop = scroll;
      if (IMG.test(file.path)) showImages(my);
    }

    function head() {
      const f = cur.file;
      const p = cur.parsed;
      const add = p.hunks.reduce((s, h) => s + h.lines.filter((l) => l.t === '+').length, 0);
      const del = p.hunks.reduce((s, h) => s + h.lines.filter((l) => l.t === '-').length, 0);
      const btn = (label, title, onclick, pressed) => U.el('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: label, title, onclick, 'aria-pressed': pressed == null ? null : String(pressed) });
      const actions = [];
      if (cur.where === 'unstaged' || cur.where === 'untracked') {
        actions.push(btn('Stage file', 'Stage the whole file', () => Graft.actions.stage([f])));
        actions.push(btn('Discard file', 'Throw away the changes in this file', () => Graft.actions.discard([f], cur.where === 'untracked')));
      } else if (cur.where === 'staged') actions.push(btn('Unstage file', 'Move the file back to unstaged', () => Graft.actions.unstage([f])));
      return U.el('div', { class: 'dv-head' },
        U.el('span', { class: 'dv-path', title: f.path },
          f.from && f.from !== f.path ? U.el('span', { class: 'muted', text: f.from + ' → ' }) : null,
          dirName(f.path) ? U.el('span', { class: 'muted', text: dirName(f.path) }) : null,
          U.el('strong', { text: baseName(f.path) })),
        U.el('span', { class: 'dv-stat mono small' }, U.el('span', { class: 'c-add', text: '+' + add }), ' ', U.el('span', { class: 'c-del', text: '−' + del })),
        U.el('span', { class: 'spacer' }),
        btn('Ignore spaces', 'Hide changes that only add or remove spaces (W)', () => { Graft.prefs.set('ignoreWhitespace', !Graft.prefs.get('ignoreWhitespace')); show({ file: cur.file, where: cur.where }); }, !!Graft.prefs.get('ignoreWhitespace')),
        U.el('select', { class: 'select select-xs', title: 'Lines of context around each change', onchange: (e) => { Graft.prefs.set('context', Number(e.target.value)); show({ file: cur.file, where: cur.where }); } },
          ...[0, 1, 3, 5, 10, 25].map((n) => U.el('option', { value: n, text: n + ' lines', selected: Number(Graft.prefs.get('context')) === n }))),
        f.status !== 'deleted' && cur.where !== 'untracked' ? btn('Blame', 'Who changed each line', () => Graft.ui.blame.open(f.path, typeof cur.where === 'object' ? cur.where.rev : null)) : null,
        btn('History', 'Commits that changed this file', () => Graft.ui.history.fileHistory(f.path)),
        btn('Open', 'Open in the default app', () => window.graftDesktop.openFile(R.path, f.path)),
        ...actions);
    }

    function render() {
      const p = cur.parsed;
      const nodes = [head()];
      const lineSel = linesOk();
      if (editable() && !lineSel && !p.binary) {
        const why = Graft.prefs.get('ignoreWhitespace') ? 'Turn off "Ignore spaces" to pick lines.' : p.isNew ? 'New file: it\'s staged as a whole.' : p.isDeleted ? 'Deleted file: it\'s staged as a whole.' : cur.file.from && cur.file.from !== cur.file.path ? 'Renamed file: it\'s staged as a whole.' : '';
        if (why) nodes.push(U.el('div', { class: 'dv-note muted small', text: why }));
      }
      if (cur.where === 'untracked') nodes.push(U.el('div', { class: 'dv-note muted small', text: 'New file, not tracked yet. Stage it to include it in the next commit.' }));
      nodes.push(U.el('div', { class: 'dv-selbar', hidden: true }));
      const body = U.el('div', { class: 'dv-body' + (Graft.prefs.get('wrap') ? ' is-wrap' : '') });
      if (p.binary) body.append(U.el('div', { class: 'dv-empty muted', text: IMG.test(cur.file.path) ? 'Loading images…' : 'Binary file: no text to compare.' }));
      else if (!p.hunks.length) body.append(U.el('div', { class: 'dv-empty muted', text: Graft.prefs.get('ignoreWhitespace') ? 'Only spaces changed (hidden by "Ignore spaces").' : cur.file.status === 'renamed' ? 'Renamed without changes.' : 'No changes to show.' }));
      else body.innerHTML = html(p, lineSel);
      nodes.push(body);
      host.replaceChildren(...nodes);
      updateSel();
    }

    function html(p, lineSel) {
      const tab = Number(Graft.prefs.get('tabSize')) || 4;
      const limit = cur.full ? Infinity : C.DIFF_LINES;
      let count = 0;
      const out = [];
      const verb = cur.where === 'staged' ? ['unstage', 'Unstage hunk'] : ['stage', 'Stage hunk'];
      for (let hi = 0; hi < p.hunks.length; hi++) {
        const h = p.hunks[hi];
        let acts = '';
        if (lineSel) {
          acts = `<span class="dh-acts"><button type="button" class="btn btn-ghost btn-xs" data-act="${verb[0]}-hunk" data-h="${hi}">${verb[1]}</button>`;
          if (cur.where === 'unstaged') acts += `<button type="button" class="btn btn-ghost btn-xs btn-danger" data-act="discard-hunk" data-h="${hi}">Discard hunk</button>`;
          acts += '</span>';
        }
        out.push(`<div class="dh"><span class="mono">${H.esc(h.header.replace(/ @@.*/, ' @@'))}</span><span class="dh-sec">${H.esc(h.section)}</span>${acts}</div>`);
        for (let li = 0; li < h.lines.length; li++) {
          if (count++ >= limit) { out.push(`<div class="dv-more"><button type="button" class="btn btn-ghost btn-sm" data-act="all">Show everything (${p.hunks.reduce((s, x) => s + x.lines.length, 0).toLocaleString()} lines)</button></div>`); return out.join(''); }
          const l = h.lines[li];
          if (l.t === '\\') { out.push(`<div class="dl dl-meta"><span class="ln"></span><span class="ln"></span><span class="code muted">${H.esc(l.s)}</span></div>`); continue; }
          const cls = l.t === '+' ? 'dl-add' : l.t === '-' ? 'dl-del' : 'dl-ctx';
          const pick = lineSel && l.t !== ' ' ? ' is-pickable' : '';
          out.push(`<div class="dl ${cls}${pick}" data-k="${hi}:${li}"><span class="ln">${l.o != null && l.t !== '+' ? l.o : ''}</span><span class="ln">${l.n != null && l.t !== '-' ? l.n : ''}</span><span class="sg">${l.t === ' ' ? '' : l.t === '-' ? '−' : '+'}</span><span class="code">${H.render(l.s, cur.lang, l.w, tab) || ' '}</span></div>`);
        }
      }
      if (cur.truncated) out.push('<div class="dv-more muted small">This diff is very large; only the first part is shown.</div>');
      return out.join('');
    }

    async function showImages(my) {
      const f = cur.file;
      const w = cur.where;
      let a; let b;
      if (w === 'unstaged') { a = ':'; b = ''; } else if (w === 'staged') { a = 'HEAD'; b = ':'; } else if (w === 'untracked') { a = null; b = ''; } else { a = w.base; b = w.rev; }
      const [ia, ib] = await Promise.all([
        a == null || f.status === 'added' || f.status === 'untracked' ? null : R.call('image', a, f.from || f.path).catch(() => null),
        f.status === 'deleted' ? null : R.call('image', b, f.path).catch(() => null),
      ]);
      if (my !== token || (!ia && !ib)) return;
      const pane = (img, label) => U.el('figure', { class: 'img-pane' },
        U.el('figcaption', { class: 'muted small', text: label + (img ? ' · ' + U.fmtBytes(img.size) : '') }),
        img ? U.el('img', { src: img.url, alt: label, onload: (e) => { e.target.nextSibling.textContent = `${e.target.naturalWidth} × ${e.target.naturalHeight}`; } }) : U.el('div', { class: 'img-none muted', text: 'None' }),
        U.el('span', { class: 'muted small mono' }));
      const body = host.querySelector('.dv-body');
      body.replaceChildren(U.el('div', { class: 'img-diff' }, pane(ia, 'Before'), pane(ib, 'After')));
    }

    // ---------------- picking lines
    let dragging = false;
    function keyAt(e) { const row = e.target.closest('.dl.is-pickable'); return row ? row.dataset.k : null; }
    function onDown(e) {
      if (e.button !== 0 || e.target.closest('button')) return;
      const k = keyAt(e);
      if (!k) return;
      e.preventDefault();
      if (e.shiftKey && anchor) range(anchor, k, true);
      else { if (selected.has(k)) selected.delete(k); else selected.add(k); anchor = k; }
      dragging = selected.has(k);
      const move = (ev) => { const kk = keyAt(ev); if (kk && dragging) range(anchor, kk, true); };
      const up = () => { dragging = false; host.removeEventListener('mouseover', move); window.removeEventListener('mouseup', up); };
      host.addEventListener('mouseover', move);
      window.addEventListener('mouseup', up);
      updateSel();
    }
    function range(a, b, on) {
      const rows = [...host.querySelectorAll('.dl.is-pickable')].map((r) => r.dataset.k);
      let i = rows.indexOf(a); let j = rows.indexOf(b);
      if (i < 0 || j < 0) return;
      if (i > j) [i, j] = [j, i];
      rows.slice(i, j + 1).forEach((k) => (on ? selected.add(k) : selected.delete(k)));
      updateSel();
    }
    function updateSel() {
      host.querySelectorAll('.dl.is-picked').forEach((r) => { if (!selected.has(r.dataset.k)) r.classList.remove('is-picked'); });
      selected.forEach((k) => { const r = host.querySelector(`.dl[data-k="${k}"]`); if (r) r.classList.add('is-picked'); });
      const bar = host.querySelector('.dv-selbar');
      if (!bar) return;
      bar.hidden = !selected.size;
      if (!selected.size) return;
      const n = selected.size;
      const label = `${n} line${n > 1 ? 's' : ''}`;
      const b = (text, act, extra) => U.el('button', { type: 'button', class: 'btn btn-xs ' + (extra || 'btn-ghost'), text, 'data-act': act });
      bar.replaceChildren(...[U.el('span', { class: 'small', text: label + ' picked' }),
        cur.where === 'staged' ? b('Unstage ' + label, 'unstage-lines', 'btn-primary') : b('Stage ' + label, 'stage-lines', 'btn-primary'),
        cur.where === 'unstaged' ? b('Discard ' + label, 'discard-lines', 'btn-ghost btn-danger') : null,
        b('Clear', 'clear')].filter(Boolean));
    }

    async function onClick(e) {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'all') { cur.full = true; render(); return; }
      if (act === 'clear') { selected = new Set(); updateSel(); return; }
      const p = cur.parsed;
      let keys = selected;
      if (act.endsWith('-hunk')) {
        const hi = Number(btn.dataset.h);
        keys = new Set(p.hunks[hi].lines.map((l, li) => (l.t === '+' || l.t === '-' ? hi + ':' + li : null)).filter(Boolean));
      }
      const kind = act.split('-')[0];
      if (kind === 'discard' && Graft.prefs.get('confirmDiscard')) {
        const ok = await Graft.ui.dialog.confirm('Discard these changes?', `${keys.size} changed line${keys.size > 1 ? 's' : ''} will be removed from your file. You can bring them back with Undo (Ctrl+Z).`, 'Discard');
        if (!ok) return;
      }
      const patch = Graft.diff.patch(p, keys, kind === 'stage' ? 'forward' : 'reverse');
      if (!patch) return;
      const op = kind === 'stage' ? 'stagePatch' : kind === 'unstage' ? 'unstagePatch' : 'discardPatch';
      selected = new Set();
      const res = await Graft.act(op, [patch, cur.zero], { title: 'Couldn\'t ' + kind + ' those lines' });
      if (res) Graft.bus.emit('diff:applied', { file: cur.file, where: cur.where });
    }

    clear();
    return { show, clear, current: () => cur, refresh: () => cur && show({ file: cur.file, where: cur.where, full: cur.full }, true) };
  }

  const dirName = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); };
  const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);

  Graft.ui = Graft.ui || {};
  Graft.ui.diffview = { create, dirName, baseName };
})();
