/**
 * Start screen: open / clone / new, and recent repositories with their branch, changes and
 * ahead / behind counts. Shows how to get Git when it isn't installed.
 */
(function () {
  const U = Graft.utils;
  const R = Graft.repo;
  const A = Graft.actions;
  const I = Graft.icon;
  let host;
  let gitVersion = null;

  function bigBtn(icon, title, text, onclick) {
    return U.el('button', { type: 'button', class: 'glass wl-action', onclick }, U.el('span', { class: 'wl-ico', html: I(icon) }), U.el('span', {}, U.el('strong', { text: title }), U.el('span', { class: 'muted small block', text })));
  }

  function noGit() {
    host.replaceChildren(U.el('div', { class: 'glass empty wl-nogit' },
      U.el('span', { class: 'wl-ico big', html: I('warn') }),
      U.el('h2', { text: 'Git isn\'t installed' }),
      U.el('p', { class: 'muted', text: 'Graft works with the Git you install on this PC (that also gives you Git\'s credential manager for signing in to GitHub and others). Install Git for Windows with the default options, then press Check again.' }),
      U.el('div', { class: 'set-btns' },
        U.el('button', { type: 'button', class: 'btn btn-primary', text: 'Download Git for Windows', onclick: () => window.graftDesktop.openUrl(Graft.config.GIT_DOWNLOAD) }),
        U.el('button', { type: 'button', class: 'btn btn-ghost', text: 'Check again', onclick: () => location.reload() }))));
  }

  async function render() {
    if (gitVersion === null) { gitVersion = await window.graftDesktop.op('version', null); }
    if (!gitVersion) { noGit(); return; }
    const recent = R.recent();
    const list = U.el('div', { class: 'wl-recent' });
    recent.forEach((r) => {
      const meta = U.el('span', { class: 'muted small wl-meta', text: '…' });
      const row = U.el('button', { type: 'button', class: 'wl-repo', title: r.path, onclick: () => R.open(r.path), oncontextmenu: (e) => { e.preventDefault(); Graft.ui.menu.open(e.clientX, e.clientY, [{ label: 'Open', onClick: () => R.open(r.path) }, { label: 'Remove from list', onClick: () => { R.forget(r.path); render(); } }], r.name); } },
        U.el('span', { class: 'wl-repo-ico', html: I('folder') }),
        U.el('span', { class: 'wl-repo-text' }, U.el('strong', { text: r.name }), U.el('span', { class: 'muted small mono', text: r.path })),
        meta);
      list.append(row);
      window.graftDesktop.op('summary', r.path).then((s) => {
        meta.replaceChildren(...[U.el('span', { class: 'chip chip-static mono', text: s.branch }),
          s.changes ? U.el('span', { class: 'wl-pill is-accent', text: `${s.changes} change${s.changes > 1 ? 's' : ''}` }) : U.el('span', { class: 'wl-pill', text: 'clean' }),
          s.ahead ? U.el('span', { class: 'wl-pill', text: '↑' + s.ahead }) : null, s.behind ? U.el('span', { class: 'wl-pill', text: '↓' + s.behind }) : null].filter(Boolean));
      }).catch(() => { meta.textContent = 'not found'; row.classList.add('is-missing'); });
    });
    host.replaceChildren(U.el('div', { class: 'wl' },
      U.el('div', { class: 'wl-hero' }, U.el('h1', { text: 'Graft' }), U.el('p', { class: 'muted', text: `A fast, friendly Git client · ${gitVersion}` })),
      U.el('div', { class: 'wl-actions' },
        bigBtn('folder', 'Open repository', 'A folder on this PC (Ctrl+O)', A.open),
        bigBtn('clone', 'Clone', 'Copy one from GitHub, GitLab…', () => A.clone()),
        bigBtn('plus', 'New repository', 'Start tracking a folder', A.init)),
      recent.length ? U.el('section', { class: 'glass wl-recent-box' }, U.el('h3', { class: 'section-label', text: 'Recent' }), list) : U.el('p', { class: 'muted small wl-tip', text: 'Tip: drag a folder onto this window to open it.' })));
  }

  Graft.bus.on('recent:change', () => { if (!R.path && host && !host.hidden) render(); });
  Graft.ui.welcome = { init: (h) => { host = h; }, show: render, hide() {}, gitOk: () => gitVersion };
})();
