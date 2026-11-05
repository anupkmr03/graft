/**
 * History: the commit graph (virtual list: only rows on screen exist, more history loads as you
 * scroll), search by message / author / changed text / path / hash, file history, and the
 * commit (or stash) details with its files and diffs on the right.
 */
(function () {
  const U = Graft.utils;
  const R = Graft.repo;
  const A = Graft.actions;
  const C = Graft.config;
  const I = Graft.icon;

  let host; let viewEl; let scroller; let spacer; let rowsEl; let canvas; let detailEl; let listWrap; let filterBar; let pendingRow;
  let commits = [];
  let rowsGraph = [];
  let graph = null;
  let hasMore = false;
  let loading = false;
  let filter = null;      // null | { kind, text } | { file }
  let selected = null;    // hash
  let shown = false;
  let stale = true;
  let laneCols = 1;
  let detail = null;      // { kind: 'commit' | 'stash', data }
  let detailDiff = null;
  let detailFile = null;
  let loadToken = 0;
  let searchKind = 'message';

  const short = (h) => h.slice(0, 7);
  const when = (t) => (Graft.prefs.get('dates') === 'absolute' ? new Date(t).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : U.timeAgo(t));

  function build() {
    const input = U.el('input', { class: 'hl-search-input', type: 'search', placeholder: 'Search history', spellcheck: 'false', onkeydown: (e) => { if (e.key === 'Enter') runSearch(e.target.value.trim()); if (e.key === 'Escape') { e.target.value = ''; setFilter(null); } } });
    const kind = U.el('select', { class: 'select select-xs', title: 'Search in', onchange: (e) => { searchKind = e.target.value; if (input.value.trim()) runSearch(input.value.trim()); } },
      ...[['message', 'Message'], ['author', 'Author'], ['content', 'Changed text'], ['path', 'File path'], ['hash', 'Commit hash']].map(([v, l]) => U.el('option', { value: v, text: l })));
    filterBar = U.el('div', { class: 'hl-filter', hidden: true });
    scroller = U.el('div', { class: 'hl-scroll', tabindex: '0', onscroll: () => requestAnimationFrame(draw), onkeydown: onKey });
    spacer = U.el('div', { class: 'hl-spacer' });
    canvas = U.el('canvas', { class: 'hl-canvas' });
    rowsEl = U.el('div', { class: 'hl-rows' });
    // A small viewport stuck to the top of the scroll area holds the visible rows; the spacer
    // under it only gives the scrollbar its length (a 1.4-million-pixel layer paints slowly).
    viewEl = U.el('div', { class: 'hl-view' }, canvas, rowsEl);
    spacer.append(viewEl);
    scroller.append(spacer);
    pendingRow = U.el('button', { type: 'button', class: 'hl-pending', hidden: true, onclick: () => Graft.app.go('changes') });
    listWrap = U.el('div', { class: 'glass hl-left' },
      U.el('div', { class: 'hl-top' }, U.el('label', { class: 'hl-search' }, U.el('span', { html: I('search') }), input), kind),
      filterBar, pendingRow, scroller);
    listWrap.style.flexBasis = (Graft.prefs.get('splitHistory') * 100) + '%';
    const handle = U.el('div', { class: 'resizer resizer-v' });
    handle.addEventListener('pointerdown', (e) => {
      handle.setPointerCapture(e.pointerId);
      const total = host.offsetWidth;
      const left = host.getBoundingClientRect().left;
      const move = (ev) => { listWrap.style.flexBasis = (U.clamp((ev.clientX - left) / total, 0.3, 0.8) * 100) + '%'; draw(); };
      const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); Graft.prefs.set('splitHistory', listWrap.offsetWidth / total); };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    detailEl = U.el('div', { class: 'glass hl-right' });
    host.replaceChildren(listWrap, handle, detailEl);
    rowsEl.addEventListener('click', (e) => { const r = e.target.closest('.hl-row'); if (r) select(r.dataset.h); });
    rowsEl.addEventListener('dblclick', (e) => { const r = e.target.closest('.hl-row'); if (r) { const c = commits[Number(r.dataset.i)]; const b = c && c.refs.find((x) => x.type === 'branch'); if (b) A.checkout(b.name); } });
    rowsEl.addEventListener('contextmenu', (e) => { const r = e.target.closest('.hl-row'); if (r) { e.preventDefault(); select(r.dataset.h); commitMenu(e, commits[Number(r.dataset.i)]); } });
    new ResizeObserver(() => draw()).observe(scroller);
    renderDetail();
  }

  // ---------------- loading
  async function load(reset) {
    if (!R.path) return;
    const my = reset ? ++loadToken : loadToken;
    if (loading && !reset) return;
    loading = true;
    const opts = { max: C.PAGE, skip: reset ? 0 : commits.length, noRemotes: !Graft.prefs.get('remotesInGraph') };
    if (filter && filter.file) opts.file = filter.file;
    else if (filter) opts.search = filter;
    let page = [];
    try { page = await R.call('log', opts); } catch (e) { Graft.toast(R.clean(e)); }
    if (my !== loadToken) return;
    loading = false;
    if (reset) { commits = []; graph = Graft.graph.create(); rowsGraph = []; }
    commits = commits.concat(page);
    if (!filter) { rowsGraph = rowsGraph.concat(graph.add(page)); laneCols = Math.min(graph.width(), 14); }
    hasMore = page.length === C.PAGE;
    stale = false;
    spacer.style.height = commits.length * C.ROW_H + 'px';
    draw();
    renderPending();
    if (reset && !commits.length) rowsEl.replaceChildren(U.el('div', { class: 'hl-empty muted', text: filter ? 'No commits match.' : 'No commits yet. Make your first one in Changes.' }));
    if (reset && commits.length && (!selected || !commits.some((c) => c.hash === selected)) && !detail) select(commits[0].hash, true);
  }

  function renderPending() {
    const s = R.status;
    const n = s ? s.staged.length + s.unstaged.length + s.untracked.length + s.conflicts.length : 0;
    pendingRow.hidden = !n || !!filter;
    pendingRow.replaceChildren(U.el('span', { class: 'hl-pending-dot' }), U.el('span', { text: `Uncommitted changes · ${n} file${n === 1 ? '' : 's'}` }), U.el('span', { class: 'muted small', text: 'Open Changes →' }));
  }

  // ---------------- drawing (only what's on screen)
  function draw() {
    if (!scroller || !shown) return;
    const H = C.ROW_H;
    const top = scroller.scrollTop;
    const height = scroller.clientHeight;
    const first = Math.max(0, Math.floor(top / H) - 4);
    const last = Math.min(commits.length - 1, Math.ceil((top + height) / H) + 4);
    const gw = filter ? 0 : 14 + laneCols * C.LANE_W;
    host.style.setProperty('--graph-w', gw + 'px');
    // Graph canvas covers the visible rows.
    const dpr = window.devicePixelRatio || 1;
    const ch = (last - first + 1) * H;
    if (gw && commits.length) {
      canvas.hidden = false;
      canvas.style.top = (first * H - top) + 'px';
      canvas.style.width = gw + 'px';
      canvas.style.height = ch + 'px';
      if (canvas.width !== gw * dpr || canvas.height !== ch * dpr) { canvas.width = gw * dpr; canvas.height = ch * dpr; }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, gw, ch);
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, gw - 4, ch); ctx.clip();
      Graft.graph.paint(ctx, rowsGraph, commits, first, last, { rowH: H, laneW: C.LANE_W, top: 0, head: R.info && R.info.head, ring: getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#fff' });
      ctx.restore();
    } else canvas.hidden = true;
    // Rows
    viewEl.style.height = height + 'px';
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) frag.append(rowEl(commits[i], i, top));
    rowsEl.replaceChildren(frag);
    if (hasMore && !loading && last > commits.length - 300) load(false);
  }

  function refPill(r) {
    const cur = R.info && R.info.headName;
    const cls = r.type === 'head' || (r.type === 'branch' && r.name === cur) ? 'is-head' : r.type;
    return `<span class="ref ref-${cls}" title="${Graft.hl.esc(r.name)}">${r.type === 'tag' ? '◆ ' : ''}${Graft.hl.esc(r.name)}</span>`;
  }
  function rowEl(c, i, off) {
    const div = document.createElement('div');
    div.className = 'hl-row' + (c.hash === selected ? ' is-selected' : '') + (c.hash === (R.info && R.info.head) ? ' is-head' : '');
    div.style.transform = `translateY(${i * C.ROW_H - off}px)`;
    div.dataset.h = c.hash;
    div.dataset.i = i;
    const refs = c.refs.filter((r) => r.type !== 'detached').map(refPill).join('');
    div.innerHTML = `<span class="hl-g"></span><span class="hl-subj">${refs}<span class="hl-text">${Graft.hl.esc(c.subject)}</span></span><span class="hl-author">${Graft.hl.esc(c.author)}</span><span class="hl-date">${when(c.time)}</span><span class="hl-hash mono">${short(c.hash)}</span>`;
    div.title = `${c.subject}\n${c.author} · ${new Date(c.time).toLocaleString()}`;
    return div;
  }

  // ---------------- selection & details
  async function select(hash, quiet) {
    selected = hash;
    draw();
    try { detail = { kind: 'commit', data: await R.call('showCommit', hash) }; } catch (e) { detail = null; if (!quiet) Graft.toast(R.clean(e)); }
    detailFile = detail && detail.data.files.length ? detail.data.files[0] : null;
    if (detail && filter && filter.file) detailFile = detail.data.files.find((f) => f.path === filter.file) || detail.data.files.find((f) => f.path.endsWith('/' + filter.file.split('/').pop())) || detailFile;
    renderDetail();
  }

  function renderDetail() {
    if (!detailEl) return;
    if (!detail) { detailEl.replaceChildren(U.el('div', { class: 'dv-empty muted', text: 'Select a commit.' })); return; }
    const d = detail.data;
    const isStash = detail.kind === 'stash';
    const lines = (d.message || '').split('\n');
    const subject = lines[0];
    const body = lines.slice(1).join('\n').trim();
    const parentLinks = (d.parents || []).map((p) => U.el('button', { type: 'button', class: 'link-btn mono small', text: short(p), title: 'Show parent', onclick: () => reveal(p) }));
    const meta = U.el('div', { class: 'cd-meta' },
      U.el('h2', { class: 'cd-subject', text: subject }),
      body ? U.el('pre', { class: 'cd-body', text: body }) : null,
      U.el('div', { class: 'cd-facts small' },
        U.el('span', {}, U.el('strong', { text: d.author }), U.el('span', { class: 'muted', text: ` <${d.email}>` })),
        U.el('span', { class: 'muted', text: new Date(d.time).toLocaleString() + ' · ' + U.timeAgo(d.time) }),
        d.committer && d.committer !== d.author ? U.el('span', { class: 'muted', text: `Committed by ${d.committer}` }) : null,
        U.el('span', {}, U.el('button', { type: 'button', class: 'link-btn mono small', text: isStash ? d.ref : short(d.hash), title: 'Copy full hash', onclick: () => A.copy(d.hash) }),
          parentLinks.length && !isStash ? U.el('span', { class: 'muted', text: parentLinks.length > 1 ? ' · merge of ' : ' · parent ' }) : null, ...(isStash ? [] : parentLinks.flatMap((b, i) => (i ? [' ', b] : [b])))),
        d.refs && d.refs.length ? U.el('span', { html: d.refs.filter((r) => r.type !== 'detached').map(refPill).join('') }) : null),
      isStash ? U.el('div', { class: 'set-btns' },
        U.el('button', { type: 'button', class: 'btn btn-primary btn-xs', text: 'Apply', onclick: () => A.stashApply(d.ref) }),
        U.el('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: 'Pop', onclick: () => A.stashPop(d.ref) }),
        U.el('button', { type: 'button', class: 'btn btn-ghost btn-xs btn-danger', text: 'Drop', onclick: () => A.stashDrop(d.ref) })) : null);
    const add = d.files.reduce((s, f) => s + (f.add || 0), 0);
    const del = d.files.reduce((s, f) => s + (f.del || 0), 0);
    const files = U.el('div', { class: 'cd-files' },
      U.el('div', { class: 'section-label cd-files-head' }, `${d.files.length} file${d.files.length === 1 ? '' : 's'} changed `, U.el('span', { class: 'c-add', text: '+' + add }), ' ', U.el('span', { class: 'c-del', text: '−' + del })),
      ...d.files.map((f) => U.el('button', { type: 'button', class: 'cd-file' + (detailFile && f.path === detailFile.path && f.untrackedIn === detailFile.untrackedIn ? ' is-selected' : ''), title: f.from ? `${f.from} → ${f.path}` : f.path, onclick: () => { detailFile = f; renderDetail(); }, oncontextmenu: (e) => { e.preventDefault(); fileMenu(e, f, d); } },
        U.el('span', { class: 'st st-' + (f.untrackedIn ? 'untracked' : f.status), text: f.untrackedIn ? '+' : ({ modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T' }[f.status] || 'M') }),
        U.el('span', { class: 'ch-name' }, U.el('span', { text: Graft.ui.diffview.baseName(f.path) }), U.el('span', { class: 'muted small', text: ' ' + Graft.ui.diffview.dirName(f.path) })),
        f.add != null ? U.el('span', { class: 'cd-stat mono small' }, U.el('span', { class: 'c-add', text: '+' + f.add }), ' ', U.el('span', { class: 'c-del', text: '−' + f.del })) : U.el('span', { class: 'muted small', text: 'binary' }))));
    const diffHost = U.el('div', { class: 'cd-diff' });
    detailEl.replaceChildren(U.el('div', { class: 'cd-top' }, meta, files), diffHost);
    detailDiff = Graft.ui.diffview.create(diffHost);
    if (detailFile) {
      const where = detailFile.untrackedIn ? { base: null, rev: detailFile.untrackedIn } : isStash ? { base: d.hash + '^1', rev: d.hash } : { base: d.parents[0] || null, rev: d.hash };
      detailDiff.show({ file: detailFile, where });
    } else detailDiff.clear(d.files.length ? '' : 'No file changes (empty commit).');
  }

  function fileMenu(e, f, d) {
    Graft.ui.menu.open(e.clientX, e.clientY, [
      { label: 'File history', onClick: () => fileHistory(f.path) },
      ...(f.status !== 'deleted' ? [{ label: 'Blame at this commit', onClick: () => Graft.ui.blame.open(f.path, d.hash) }] : []),
      { label: 'Open current file', onClick: () => window.graftDesktop.openFile(R.path, f.path) },
      { label: 'Copy path', onClick: () => A.copy(f.path) },
    ], f.path);
  }

  function commitMenu(e, c) {
    if (!c) return;
    const cur = (R.info && R.info.headName) || 'HEAD';
    const branches = c.refs.filter((r) => r.type === 'branch' || r.type === 'remote' || r.type === 'head').map((r) => r.name);
    const isHead = R.info && c.hash === R.info.head;
    const items = [
      ...branches.filter((b) => b !== cur).slice(0, 3).map((b) => ({ label: `Switch to ${b}`, onClick: () => (b.includes('/') && R.refs.remote.some((x) => x.name === b) ? A.checkoutRemote(b) : A.checkout(b)) })),
      { label: 'Check out this commit…', onClick: () => A.checkoutCommit(c.hash) },
      { label: 'New branch here…', onClick: () => A.newBranch(c.hash) },
      { label: 'New tag here…', onClick: () => A.newTag(c.hash) },
      { separator: true },
      ...branches.filter((b) => b !== cur).slice(0, 2).map((b) => ({ label: `Merge ${b} into ${cur}`, onClick: () => A.merge(b) })),
      ...(!isHead ? [{ label: `Cherry-pick onto ${cur}`, onClick: () => A.cherryPick(c.hash) }] : []),
      { label: 'Revert this commit…', onClick: () => A.revert(c.hash, c.parents.length > 1) },
      ...(!isHead ? [{ label: `Reset ${cur} to here…`, onClick: () => A.reset(c.hash) }] : []),
      { label: 'Edit commits from here… (reorder, squash, reword)', onClick: () => A.editCommits(c.hash) },
      { separator: true },
      { label: 'Copy hash', onClick: () => A.copy(c.hash) },
      { label: 'Copy message', onClick: async () => { const d = await R.call('showCommit', c.hash); A.copy(d.message); } },
    ];
    Graft.ui.menu.open(e.clientX, e.clientY, items, short(c.hash) + ' · ' + c.subject);
  }

  function onKey(e) {
    const i = commits.findIndex((c) => c.hash === selected);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'PageDown' || e.key === 'PageUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const page = Math.floor(scroller.clientHeight / C.ROW_H) - 1;
      const step = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page, Home: -1e9, End: 1e9 }[e.key];
      const j = U.clamp(i + step, 0, commits.length - 1);
      if (commits[j]) { selected = commits[j].hash; ensureVisible(j); debouncedSelect(commits[j].hash); }
    } else if (e.key === 'ContextMenu' && i >= 0) {
      const r = rowsEl.querySelector('.is-selected');
      if (r) { const b = r.getBoundingClientRect(); commitMenu({ clientX: b.left + 80, clientY: b.bottom }, commits[i]); }
    }
  }
  const debouncedSelect = U.debounce((h) => select(h), 120);
  function ensureVisible(i) {
    const y = i * C.ROW_H;
    if (y < scroller.scrollTop) scroller.scrollTop = y;
    else if (y + C.ROW_H > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + C.ROW_H - scroller.clientHeight;
    draw();
  }

  // ---------------- search / filters
  function setFilter(f) {
    filter = f;
    filterBar.hidden = !f;
    if (f) {
      const label = f.file ? `History of ${f.file}` : `${{ message: 'Message', author: 'Author', content: 'Changed text', path: 'Path' }[f.kind]} contains "${f.text}"`;
      filterBar.replaceChildren(U.el('span', { class: 'small', text: label }), U.el('span', { class: 'spacer' }), U.el('button', { type: 'button', class: 'link-btn small', text: 'Show all commits', onclick: () => { const inp = host.querySelector('.hl-search-input'); if (inp) inp.value = ''; setFilter(null); } }));
    }
    scroller.scrollTop = 0;
    load(true);
  }
  async function runSearch(text) {
    if (!text) { setFilter(null); return; }
    if (searchKind === 'hash') {
      if (!/^[0-9a-f]{4,40}$/i.test(text)) { Graft.toast('A commit hash is 4–40 characters of 0-9 and a-f.'); return; }
      reveal(text);
      return;
    }
    setFilter({ kind: searchKind, text });
  }

  /** Scrolls to a commit (loading more history if needed) and selects it. */
  async function reveal(hash) {
    if (Graft.app.view() !== 'history') Graft.app.go('history');
    if (filter) setFilter(null);
    if (stale || loading) await load(true);
    let full = hash;
    if (hash.length < 40) { const m = commits.find((c) => c.hash.startsWith(hash)); if (m) full = m.hash; }
    let i = commits.findIndex((c) => c.hash === full);
    let guard = 0;
    while (i < 0 && hasMore && guard++ < 20) { await load(false); i = commits.findIndex((c) => c.hash === full || c.hash.startsWith(hash)); }
    if (i >= 0) { scroller.scrollTop = Math.max(0, i * C.ROW_H - scroller.clientHeight / 3); select(commits[i].hash); scroller.focus({ preventScroll: true }); }
    else showCommit(hash);
  }
  async function showCommit(hash) {
    if (Graft.app.view() !== 'history') Graft.app.go('history');
    try { detail = { kind: 'commit', data: await R.call('showCommit', hash) }; selected = detail.data.hash; detailFile = detail.data.files[0] || null; renderDetail(); draw(); } catch (e) { Graft.toast('Commit not found'); }
  }
  async function showStash(st) {
    if (Graft.app.view() !== 'history') Graft.app.go('history');
    try {
      const [d, files] = await Promise.all([R.call('showCommit', st.hash), R.call('stashFiles', st.hash)]);
      detail = { kind: 'stash', data: { ...d, message: st.message || st.raw, ref: st.ref, files, parents: d.parents } };
      selected = null; detailFile = files[0] || null; renderDetail(); draw();
    } catch (e) { Graft.toast(R.clean(e)); }
  }
  function fileHistory(path) { if (Graft.app.view() !== 'history') Graft.app.go('history'); const inp = host.querySelector('.hl-search-input'); if (inp) inp.value = ''; detail = null; selected = null; setFilter({ file: path }); }

  Graft.bus.on('repo:open', () => { commits = []; rowsGraph = []; selected = null; detail = null; filter = null; stale = true; if (filterBar) { filterBar.hidden = true; } if (scroller) { scroller.scrollTop = 0; renderDetail(); } if (shown) load(true); });
  Graft.bus.on('repo:refs', () => { stale = true; if (shown) load(true).then(() => { if (detail && detail.kind === 'commit' && selected) select(selected, true); }); });
  Graft.bus.on('repo:status', () => { if (shown && pendingRow) renderPending(); });
  Graft.bus.on('prefs:change', ({ key }) => { if (key === 'remotesInGraph') { stale = true; if (shown) load(true); } if (key === 'dates' && shown) draw(); if (shown && ['wordDiff', 'syntax', 'tabSize', 'wrap'].includes(key) && detailDiff) detailDiff.refresh(); });
  Graft.bus.on('theme:change', () => draw());

  Graft.ui.history = {
    init(h) { host = h; build(); },
    show() { shown = true; if (stale) load(true); else draw(); renderPending(); },
    hide() { shown = false; },
    reveal, showCommit, showStash, fileHistory,
    focusSearch() { const i = host.querySelector('.hl-search-input'); if (i) { i.focus(); i.select(); } },
    selected: () => selected,
  };
})();
