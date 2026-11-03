/**
 * Merge conflicts, 3-way: for every conflicting block you see your side, the result and their
 * side next to each other, and pick one, both (in either order) or type your own. Unchanged
 * parts between blocks are folded. Save writes the file and marks it resolved (git add).
 */
(function () {
  const U = Graft.utils;
  const R = Graft.repo;

  /** Working file with conflict markers → [{ text } | { ours, base, theirs, labelOurs, labelTheirs, pick, custom }] */
  function parse(text) {
    const lines = text.split('\n');
    const segs = [];
    let buf = [];
    let block = null;
    let part = null;
    const flush = () => { if (buf.length) { segs.push({ text: buf }); buf = []; } };
    for (const line of lines) {
      const bare = line.replace(/\r$/, '');
      if (!block && bare.startsWith('<<<<<<<')) { flush(); block = { ours: [], base: [], theirs: [], labelOurs: bare.slice(8).trim(), labelTheirs: '', pick: null, custom: null }; part = 'ours'; continue; }
      if (block && bare.startsWith('|||||||') && part === 'ours') { part = 'base'; continue; }
      if (block && bare === '=======' && part !== 'theirs') { part = 'theirs'; continue; }
      if (block && bare.startsWith('>>>>>>>') && part === 'theirs') { block.labelTheirs = bare.slice(8).trim(); segs.push(block); block = null; continue; }
      if (block) block[part].push(line); else buf.push(line);
    }
    if (block) { buf.unshift('<<<<<<< ' + block.labelOurs, ...block.ours, '=======', ...block.theirs); block = null; }
    flush();
    return segs;
  }

  function resultLines(b) {
    if (b.custom != null) return b.custom.split('\n');
    if (b.pick === 'ours') return b.ours;
    if (b.pick === 'theirs') return b.theirs;
    if (b.pick === 'both') return [...b.ours, ...b.theirs];
    if (b.pick === 'both-rev') return [...b.theirs, ...b.ours];
    return null;
  }

  async function show(host, path, restore) {
    host.classList.add('is-conflict');
    host.replaceChildren(U.el('div', { class: 'dv-empty muted', text: 'Loading conflict…' }));
    let data;
    try { data = await R.call('conflict', path); } catch (e) { host.replaceChildren(U.el('div', { class: 'dv-empty muted', text: R.clean(e) })); return; }
    const state = R.info && R.info.state;
    const mine = state === 'rebase' ? 'Upstream (being rebased onto)' : 'Yours';
    const theirs = state === 'rebase' ? 'Your commit being replayed' : state === 'merge' ? 'Incoming' : 'The commit being applied';
    const lang = Graft.hl.lang(path);
    const tab = Number(Graft.prefs.get('tabSize')) || 4;
    const code = (lines, cls) => U.el('div', { class: 'cf-code ' + (cls || ''), html: lines.map((l) => `<div class="cf-line">${Graft.hl.render(l.replace(/\r$/, ''), lang, null, tab) || ' '}</div>`).join('') });

    const head = (extra) => U.el('div', { class: 'dv-head' },
      U.el('span', { class: 'dv-path' }, U.el('span', { class: 'st st-conflict', text: '!' }), U.el('strong', { text: ' ' + path })),
      U.el('span', { class: 'spacer' }), ...extra,
      U.el('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: 'Open file', onclick: () => window.graftDesktop.openFile(R.path, path) }));

    // No markers (deleted on one side, binary, or already edited): whole-file choices.
    const segs = data.working != null ? parse(data.working) : [];
    const blocks = segs.filter((s) => !s.text);
    const choose = async (side) => { if (await Graft.act('resolveWith', [path, side])) Graft.toast('Resolved ' + path); };
    if (!blocks.length) {
      const why = data.ours == null ? 'You deleted this file; the other side changed it.' : data.theirs == null ? 'The other side deleted this file; you changed it.' : data.working == null ? 'The file is missing.' : 'No conflict markers left in the file (maybe you already fixed it in an editor).';
      host.replaceChildren(head([]), U.el('div', { class: 'cf-simple' },
        U.el('p', { class: 'muted', text: why }),
        U.el('div', { class: 'set-btns' },
          data.ours != null ? U.el('button', { type: 'button', class: 'btn btn-ghost', text: `Keep ${mine.toLowerCase()} version`, onclick: () => choose('ours') }) : U.el('button', { type: 'button', class: 'btn btn-ghost', text: 'Delete the file', onclick: () => choose('ours') }),
          data.theirs != null ? U.el('button', { type: 'button', class: 'btn btn-ghost', text: `Keep ${theirs.toLowerCase()} version`, onclick: () => choose('theirs') }) : U.el('button', { type: 'button', class: 'btn btn-ghost', text: 'Delete the file', onclick: () => choose('theirs') }),
          data.working != null ? U.el('button', { type: 'button', class: 'btn btn-primary', text: 'Mark as resolved', onclick: () => Graft.act('resolve', [path, null]) }) : null)));
      return;
    }

    const body = U.el('div', { class: 'cf-body' });
    const counter = U.el('span', { class: 'muted small' });
    const saveBtn = U.el('button', { type: 'button', class: 'btn btn-primary btn-xs', text: 'Save and mark resolved', onclick: save });
    function update() {
      const left = blocks.filter((b) => resultLines(b) == null).length;
      counter.textContent = left ? `${left} of ${blocks.length} conflict${blocks.length > 1 ? 's' : ''} to pick` : 'All picked';
      saveBtn.disabled = left > 0;
    }
    function renderBlock(b, i) {
      const res = resultLines(b);
      const pick = (p) => () => { b.pick = p; b.custom = null; rerender(); };
      const btn = (label, p, title) => U.el('button', { type: 'button', class: 'btn btn-ghost btn-xs' + (b.pick === p && b.custom == null ? ' is-on' : ''), text: label, title, onclick: pick(p) });
      let mid;
      if (b.editing) {
        const ta = U.el('textarea', { class: 'field mono cf-edit', rows: Math.max(3, (res || b.ours).length + 1) });
        ta.value = (res || [...b.ours, ...b.theirs]).join('\n');
        mid = U.el('div', { class: 'cf-mid' }, ta, U.el('div', { class: 'cf-acts' }, U.el('button', { type: 'button', class: 'btn btn-primary btn-xs', text: 'Done', onclick: () => { b.custom = ta.value; b.editing = false; rerender(); } }), U.el('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: 'Cancel', onclick: () => { b.editing = false; rerender(); } })));
        setTimeout(() => ta.focus());
      } else {
        mid = U.el('div', { class: 'cf-mid' + (res == null ? ' is-open' : '') },
          res == null ? U.el('div', { class: 'cf-placeholder muted small', text: 'Pick a side, both, or edit' }) : code(res, 'is-result'),
          U.el('div', { class: 'cf-acts' }, btn('← Mine', 'ours', mine), btn('Theirs →', 'theirs', theirs), btn('Both', 'both', 'Mine, then theirs'), btn('Both (theirs first)', 'both-rev'),
            U.el('button', { type: 'button', class: 'btn btn-ghost btn-xs' + (b.custom != null ? ' is-on' : ''), text: 'Edit', onclick: () => { b.editing = true; rerender(); } })));
      }
      return U.el('div', { class: 'cf-block', 'data-i': i },
        U.el('div', { class: 'cf-side cf-ours' + (b.pick === 'ours' ? ' is-picked' : '') }, b.ours.length ? code(b.ours) : U.el('div', { class: 'muted small cf-placeholder', text: '(nothing)' })),
        mid,
        U.el('div', { class: 'cf-side cf-theirs' + (b.pick === 'theirs' ? ' is-picked' : '') }, b.theirs.length ? code(b.theirs) : U.el('div', { class: 'muted small cf-placeholder', text: '(nothing)' })));
    }
    function renderText(lines) {
      if (lines.length <= 8) return U.el('div', { class: 'cf-ctx' }, code(lines, 'is-ctx'));
      const wrap = U.el('div', { class: 'cf-ctx' }, code(lines.slice(0, 3), 'is-ctx'),
        U.el('button', { type: 'button', class: 'cf-fold link-btn small', text: `… ${lines.length - 6} unchanged lines …`, onclick: () => wrap.replaceWith(U.el('div', { class: 'cf-ctx' }, code(lines, 'is-ctx'))) }),
        code(lines.slice(-3), 'is-ctx'));
      return wrap;
    }
    function rerender() {
      const top = body.scrollTop;
      let bi = 0;
      body.replaceChildren(U.el('div', { class: 'cf-cols' }, U.el('span', { text: mine }), U.el('span', { text: 'Result' }), U.el('span', { text: theirs })),
        ...segs.map((s) => (s.text ? renderText(s.text) : renderBlock(s, bi++))));
      body.scrollTop = top;
      update();
    }
    async function save() {
      const out = [];
      segs.forEach((s) => { if (s.text) out.push(...s.text); else out.push(...resultLines(s)); });
      if (await Graft.act('resolve', [path, out.join('\n')])) Graft.toast('Resolved ' + path);
    }
    host.replaceChildren(head([counter,
      U.el('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: 'All mine', onclick: () => { blocks.forEach((b) => { b.pick = 'ours'; b.custom = null; }); rerender(); } }),
      U.el('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: 'All theirs', onclick: () => { blocks.forEach((b) => { b.pick = 'theirs'; b.custom = null; }); rerender(); } }),
      saveBtn]), body);
    rerender();
    void restore;
  }

  Graft.ui.conflict = { show, parse };
})();
