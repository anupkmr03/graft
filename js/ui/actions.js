/**
 * Every command in Graft, in one place: the toolbar, sidebar, context menus, palette and
 * keyboard shortcuts all call these. Risky ones explain what will happen first.
 */
(function () {
  const U = Graft.utils;
  const R = Graft.repo;
  const D = window.graftDesktop;
  const dlg = () => Graft.ui.dialog;
  const short = (h) => (h || '').slice(0, 7);

  /** Small form dialog. fields: [{ key, label, type: text|textarea|check|select, value, options, hint, placeholder }] → values | null */
  function form(title, fields, okLabel, intro) {
    return new Promise((resolve) => {
      let result = null;
      const inputs = {};
      const body = U.el('div', { class: 'stack form' }, intro ? U.el('p', { class: 'dialog-text', text: intro }) : null,
        ...fields.map((f) => {
          let input;
          if (f.type === 'check') {
            input = U.el('input', { type: 'checkbox', checked: !!f.value });
            inputs[f.key] = input;
            return U.el('label', { class: 'check-line' }, input, U.el('span', {}, f.label, f.hint ? U.el('span', { class: 'muted small block', text: f.hint }) : null));
          }
          if (f.type === 'select') input = U.el('select', { class: 'select' }, ...f.options.map(([v, l]) => U.el('option', { value: v, text: l, selected: v === f.value })));
          else if (f.type === 'textarea') input = U.el('textarea', { class: 'field mono', rows: f.rows || 5, placeholder: f.placeholder || '', 'data-no-submit': '1' });
          else input = U.el('input', { class: 'field', type: 'text', value: f.value || '', placeholder: f.placeholder || '', spellcheck: 'false' });
          if (f.type === 'textarea') input.value = f.value || '';
          inputs[f.key] = input;
          return U.el('label', { class: 'stack-tight' }, U.el('span', { class: 'muted small', text: f.label }), input, f.hint ? U.el('span', { class: 'muted small', text: f.hint }) : null);
        }));
      dlg().open({
        title, body,
        actions: [{ label: 'Cancel' }, { label: okLabel || 'OK', primary: true, onClick: () => {
          const v = {};
          for (const f of fields) {
            const el = inputs[f.key];
            v[f.key] = f.type === 'check' ? el.checked : f.type === 'textarea' ? el.value : el.value.trim();
            if (f.required && !v[f.key]) { el.focus(); return false; }
          }
          result = v;
          return true;
        } }],
        onClose: () => resolve(result),
      });
      const first = Object.values(inputs).find((i) => i.type === 'text');
      if (first) first.select();
    });
  }

  const A = {
    form,

    // ---------------- repositories
    async open() { const dir = await D.pickFolder('Open a repository'); if (dir) await R.open(dir); },
    async init() {
      const dir = await D.pickFolder('Choose a folder for the new repository');
      if (!dir) return;
      try { await D.op('init', dir); } catch (e) { dlg().alert('Couldn\'t create the repository', R.clean(e)); return; }
      await R.open(dir);
    },
    async clone(url) {
      const v = await form('Clone a repository', [
        { key: 'url', label: 'Address', value: url || '', placeholder: 'https://github.com/owner/project.git', required: true },
        { key: 'name', label: 'Folder name', placeholder: 'Taken from the address' },
      ], 'Choose where…', 'Copies a repository from GitHub, GitLab or any Git server to this PC. Sign-in, if needed, is handled by Git\'s credential manager.');
      if (!v) return;
      const parent = await D.pickFolder('Clone into which folder?');
      if (!parent) return;
      const name = v.name || v.url.replace(/[\\/]+$/, '').split(/[\\/:]/).pop().replace(/\.git$/, '') || 'repository';
      const res = await Graft.net.run('clone', { url: v.url, parent, name }, 'Clone');
      if (res && res.path) await R.open(res.path);
    },

    // ---------------- working changes
    stage: (files) => Graft.act('stage', [files.map((f) => f.path)]),
    unstage: (files) => Graft.act('unstage', [files.map((f) => f.path)]),
    async discard(files, untracked) {
      const s = R.status;
      const isNew = (f) => untracked || f.status === 'untracked' || (s && s.untracked.some((u) => u.path === f.path));
      const tracked = files.filter((f) => !isNew(f)).map((f) => f.path);
      const fresh = files.filter(isNew).map((f) => f.path);
      if (Graft.prefs.get('confirmDiscard') || fresh.length) {
        const parts = [];
        if (tracked.length) parts.push(`Changes in ${tracked.length === 1 ? tracked[0] : tracked.length + ' files'} will be thrown away (Undo can bring them back).`);
        if (fresh.length) parts.push(`${fresh.length === 1 ? fresh[0] : fresh.length + ' new files'} will go to the Recycle Bin.`);
        const ok = await dlg().confirm('Discard changes?', parts.join('\n\n'), 'Discard');
        if (!ok) return;
      }
      const res = await Graft.act('discard', [tracked, fresh]);
      if (res) Graft.toast(res.trashed ? `Discarded · ${res.trashed} file${res.trashed > 1 ? 's' : ''} moved to the Recycle Bin` : 'Discarded');
    },
    stageAll() { const s = R.status; if (s) return A.stage([...s.unstaged, ...s.untracked]); },
    unstageAll() { const s = R.status; if (s && s.staged.length) return A.unstage(s.staged); },
    discardAll() { const s = R.status; if (s && (s.unstaged.length || s.untracked.length)) return A.discard([...s.unstaged, ...s.untracked]); },
    async commit(message, amend) {
      if (!message.trim()) { Graft.toast('Write a commit message first.'); return null; }
      const res = await Graft.act('commit', [message, { amend }], { title: 'Couldn\'t commit' });
      if (res) Graft.toast((amend ? 'Amended ' : 'Committed ') + short(res.hash), 3500, { action: { label: 'Undo', onClick: () => Graft.undo.run() } });
      return res;
    },
    async ignore(file) {
      const ext = file.includes('.') ? '*.' + file.split('.').pop() : null;
      const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : null;
      const v = await form('Ignore files', [{ key: 'pat', label: 'Add this line to .gitignore', type: 'select', value: file, options: [[file, file], ...(ext ? [[ext, `${ext}  (all files of this type)`]] : []), ...(dir ? [[dir, `${dir}  (the whole folder)`]] : [])] }], 'Ignore');
      if (v) await Graft.act('ignore', [v.pat]);
    },

    // ---------------- branches
    async newBranch(start, startLabel) {
      const v = await form('New branch', [
        { key: 'name', label: 'Name', placeholder: 'feature/my-change', required: true },
        { key: 'go', label: 'Switch to it now', type: 'check', value: true },
      ], 'Create', start ? `Starts at ${startLabel || short(start)}.` : `Starts at ${R.info && R.info.headName ? R.info.headName : 'the current commit'}.`);
      if (!v) return;
      const name = v.name.replace(/\s+/g, '-');
      const res = await Graft.act('createBranch', [name, start || null, v.go]);
      if (res) Graft.toast(`Created ${name}`);
    },
    async checkout(name) { const res = await Graft.act('checkout', [name], { title: 'Couldn\'t switch branch' }); if (res) Graft.toast('On ' + name); },
    async checkoutRemote(remoteBranch) {
      const local = remoteBranch.replace(/^[^/]+\//, '');
      const res = await Graft.act('checkoutRemote', [remoteBranch, local], { title: 'Couldn\'t check out' });
      if (res) Graft.toast('On ' + res.name + ` (tracking ${remoteBranch})`);
    },
    async checkoutCommit(hash) {
      const ok = await dlg().confirm('Check out this commit?', `You'll be looking at ${short(hash)} without a branch ("detached"). New commits made here aren't on any branch unless you create one. Switch back to a branch any time.`, 'Check out');
      if (ok) await Graft.act('checkoutDetached', [hash]);
    },
    async rename(name) {
      const to = await dlg().prompt('Rename branch', { label: `New name for ${name}`, value: name, okLabel: 'Rename' });
      if (to && to !== name) await Graft.act('renameBranch', [name, to.replace(/\s+/g, '-')]);
    },
    async deleteBranch(name) {
      if (R.info && name === R.info.headName) { Graft.toast('Switch to another branch first.'); return; }
      const ok = await dlg().confirm('Delete branch?', `Delete the local branch ${name}? Its commits stay reachable from Undo and the Reflog.`, 'Delete');
      if (!ok) return;
      try { await Graft.act('deleteBranch', [name, false], { rethrow: true }); Graft.toast('Deleted ' + name, 4000, { action: { label: 'Undo', onClick: () => Graft.undo.run() } }); } catch (e) {
        if (/NOT_MERGED/.test(e.message)) {
          const force = await dlg().confirm('Branch not merged', `${name} has commits that aren't in any other branch. Delete it anyway? (Undo can still bring it back during this session.)`, 'Delete anyway');
          if (force) await Graft.act('deleteBranch', [name, true]);
        } else dlg().alert('Couldn\'t delete', R.clean(e));
      }
    },
    async merge(ref) {
      const cur = R.info && R.info.headName;
      const v = await form(`Merge ${ref}`, [{ key: 'ff', label: 'How', type: 'select', value: 'auto', options: [['auto', 'Fast-forward when possible'], ['no', 'Always create a merge commit'], ['only', 'Only fast-forward (stop if not possible)']] }], 'Merge', `Brings the commits of ${ref} into ${cur || 'the current commit'}.`);
      if (v) { const res = await Graft.act('merge', [ref, { ff: v.ff }]); if (res && !res.conflicts) Graft.toast('Merged ' + ref, 3500, { action: { label: 'Undo', onClick: () => Graft.undo.run() } }); }
    },
    async rebase(onto) {
      const ok = await dlg().confirm(`Rebase onto ${onto}?`, `Your commits on ${R.info && R.info.headName} are replayed on top of ${onto}, as if you'd started from there. This rewrites those commits: avoid it for commits others already pulled.`, 'Rebase');
      if (ok) { const res = await Graft.act('rebase', [onto]); if (res && !res.conflicts) Graft.toast('Rebased onto ' + onto, 3500, { action: { label: 'Undo', onClick: () => Graft.undo.run() } }); }
    },
    async deleteRemoteBranch(remoteBranch) {
      const [remote, ...rest] = remoteBranch.split('/');
      const name = rest.join('/');
      const ok = await dlg().confirm('Delete from the server?', `Delete ${name} on ${remote}? Everyone using ${remote} loses this branch. This can't be undone here.`, 'Delete on ' + remote);
      if (ok) await Graft.net.run('push', { remote, refspec: ':refs/heads/' + name }, 'Delete remote branch');
    },
    async setUpstream(branch) {
      const remotes = (R.refs && R.refs.remote) || [];
      if (!remotes.length) { Graft.toast('No remote branches yet. Fetch or push first.'); return; }
      const v = await form('Track a remote branch', [{ key: 'up', label: `${branch} pulls from and pushes to`, type: 'select', value: remotes.find((r) => r.name.endsWith('/' + branch)) ? remotes.find((r) => r.name.endsWith('/' + branch)).name : remotes[0].name, options: remotes.map((r) => [r.name, r.name]) }], 'Set');
      if (v) await Graft.act('setUpstream', [branch, v.up]);
    },

    // ---------------- remotes
    async fetch() { if (!needRemote()) return; const res = await Graft.net.run('fetch', { prune: Graft.prefs.get('pruneOnFetch'), tags: true }, 'Fetch'); if (res) Graft.toast('Fetched'); },
    async pull() {
      if (!needRemote()) return;
      const s = R.status;
      if (!s.branch) { Graft.toast('Switch to a branch first (you\'re on a detached commit).'); return; }
      if (!s.upstream) { Graft.toast(`${s.branch} doesn't track a remote branch yet. Push it first, or right-click it → Track remote branch.`, 6000); return; }
      const res = await Graft.net.run('pull', { mode: Graft.prefs.get('pullMode') }, 'Pull');
      if (res && !res.conflicts) Graft.toast(res.changed ? 'Pulled' : 'Already up to date', 3500, res.changed ? { action: { label: 'Undo', onClick: () => Graft.undo.run() } } : {});
    },
    async push(force) {
      if (!needRemote()) return;
      const s = R.status;
      if (!s.branch) { Graft.toast('Switch to a branch first (you\'re on a detached commit).'); return; }
      let opts = {};
      if (!s.upstream) {
        const remotes = R.refs.remotes;
        let remote = remotes[0].name;
        if (remotes.length > 1 || !Graft.prefs.get('pushUpstream')) {
          const v = await form(`Push ${s.branch}`, [{ key: 'remote', label: 'To', type: 'select', value: remotes.some((r) => r.name === 'origin') ? 'origin' : remote, options: remotes.map((r) => [r.name, `${r.name}  (${r.url})`]) }], 'Push', `${s.branch} isn't on the server yet. It will be created there and linked to this branch.`);
          if (!v) return;
          remote = v.remote;
        }
        opts = { remote, refspec: `refs/heads/${s.branch}:refs/heads/${s.branch}`, setUpstream: true };
      } else if (Graft.prefs.get('confirmPush') && !force) {
        if (!(await dlg().confirm('Push?', `Send ${s.ahead} commit${s.ahead === 1 ? '' : 's'} on ${s.branch} to ${s.upstream}?`, 'Push'))) return;
      }
      if (force) {
        const ok = await dlg().confirm('Force push?', `Replace ${s.upstream || 'the remote branch'} with your version of ${s.branch}. Commits on the server that you don't have will be removed. Graft uses "force with lease": it stops if someone pushed since your last fetch.`, 'Force push');
        if (!ok) return;
        opts.force = true;
      }
      const res = await Graft.net.run('push', opts, force ? 'Force push' : 'Push', {
        onError: (m) => {
          if (!/Pull first/.test(m)) return false;
          dlg().open({ title: 'Push was rejected', body: U.el('p', { class: 'dialog-text', text: 'The server has commits you don\'t have yet. Pull them first, then push again. If you rewrote your commits on purpose (amend, rebase), force push instead.' }),
            actions: [{ label: 'Cancel' }, { label: 'Force push…', onClick: () => { setTimeout(() => A.push(true)); } }, { label: 'Pull now', primary: true, onClick: () => { setTimeout(() => A.pull()); } }] });
          return true;
        },
      });
      if (res) Graft.toast('Pushed');
    },
    async addRemote() {
      const v = await form('Add a remote', [{ key: 'name', label: 'Name', value: R.refs && R.refs.remotes.length ? '' : 'origin', required: true }, { key: 'url', label: 'Address', placeholder: 'https://github.com/owner/project.git', required: true }], 'Add');
      if (v && await Graft.act('addRemote', [v.name, v.url])) A.fetch();
    },
    async removeRemote(name) { if (await dlg().confirm('Remove remote?', `Forget ${name} and its branches on this PC? Nothing changes on the server.`, 'Remove')) await Graft.act('removeRemote', [name]); },

    // ---------------- history
    cherryPick: async (hash) => { const res = await Graft.act('cherryPick', [hash]); if (res && !res.conflicts) Graft.toast('Copied ' + short(hash) + ' onto ' + (R.info.headName || 'HEAD'), 3500, { action: { label: 'Undo', onClick: () => Graft.undo.run() } }); },
    async revert(hash, isMerge) {
      const ok = await dlg().confirm('Revert this commit?', `Creates a new commit that undoes the changes made in ${short(hash)}. History isn't rewritten, so it's safe for shared branches.${isMerge ? ' (Merge commit: it\'s undone relative to its first parent.)' : ''}`, 'Revert');
      if (ok) await Graft.act('revert', [hash, isMerge ? 1 : null]);
    },
    async reset(hash) {
      const name = (R.info && R.info.headName) || 'HEAD';
      const v = await form(`Move ${name} to ${short(hash)}`, [{ key: 'mode', label: 'What happens to the commits after it', type: 'select', value: 'mixed', options: [
        ['soft', 'Soft — keep their changes, staged'],
        ['mixed', 'Mixed — keep their changes, unstaged'],
        ['hard', 'Hard — throw their changes away'],
      ] }], 'Reset', `${name} will point at ${short(hash)}. With Hard, your uncommitted changes are saved as a stash first, just in case.`);
      if (!v) return;
      if (v.mode === 'hard' && !(await dlg().confirm('Throw changes away?', 'The commits after this one and your uncommitted changes disappear from your files. (Uncommitted changes are kept as a stash; Undo moves the branch back.)', 'Reset hard'))) return;
      const res = await Graft.act('reset', [hash, v.mode]);
      if (res) Graft.toast(`Reset to ${short(hash)}${res.saved ? ' · your changes were saved as a stash' : ''}`, 4500, { action: { label: 'Undo', onClick: () => Graft.undo.run() } });
    },
    editCommits: (hash) => Graft.ui.rebase.open(hash),
    async sequencer(action) {
      const st = R.info && R.info.state;
      if (!st) return;
      if (action === 'abort' && !(await dlg().confirm(`Abort the ${st}?`, `Everything goes back to how it was before the ${st} started.`, 'Abort'))) return;
      if (action === 'continue' && R.status && R.status.conflicts.length) { Graft.toast('Resolve the conflicts first.'); return; }
      const res = await Graft.act('sequencer', [st, action], { title: `Couldn't ${action}` });
      if (res && !res.conflicts) Graft.toast(action === 'abort' ? 'Aborted' : 'Done');
    },

    // ---------------- stash
    async stashSave() {
      const s = R.status;
      if (s && !s.staged.length && !s.unstaged.length && !s.untracked.length) { Graft.toast('No changes to stash.'); return; }
      const v = await form('Stash changes', [
        { key: 'msg', label: 'Description (optional)', placeholder: 'What were you working on?' },
        { key: 'untracked', label: 'Include new files', type: 'check', value: true },
        { key: 'keep', label: 'Keep staged changes in place too', type: 'check', value: false },
      ], 'Stash', 'Puts your uncommitted changes aside so you get a clean working copy. Bring them back any time from Stashes.');
      if (v) { const res = await Graft.act('stashSave', [v.msg, { untracked: v.untracked, keepIndex: v.keep }]); if (res) Graft.toast('Stashed'); }
    },
    stashApply: async (ref) => { const res = await Graft.act('stashApply', [ref, false]); if (res && !res.conflicts) Graft.toast('Applied ' + ref); },
    stashPop: async (ref) => { const res = await Graft.act('stashApply', [ref, true]); if (res && !res.conflicts) Graft.toast('Applied and removed ' + ref); },
    async stashDrop(ref) { if (await dlg().confirm('Drop stash?', `Delete ${ref}? Undo can bring it back during this session.`, 'Drop')) await Graft.act('stashDrop', [ref]); },

    // ---------------- tags
    async newTag(rev) {
      const v = await form('New tag', [
        { key: 'name', label: 'Name', placeholder: 'v1.0.0', required: true },
        { key: 'msg', label: 'Message (optional — makes an annotated tag)', type: 'textarea', rows: 3 },
        { key: 'push', label: 'Push it to the server too', type: 'check', value: false },
      ], 'Create', `On ${rev ? short(rev) : 'the current commit'}.`);
      if (!v) return;
      const res = await Graft.act('createTag', [v.name, rev || null, v.msg.trim() || null]);
      if (res && v.push) A.pushTag(v.name);
    },
    async deleteTag(name) { if (await dlg().confirm('Delete tag?', `Delete ${name} on this PC? (Tags already pushed stay on the server.)`, 'Delete')) await Graft.act('deleteTag', [name]); },
    async pushTag(name) { const r = remoteName(); if (r && await Graft.net.run('push', { remote: r, refspec: 'refs/tags/' + name }, 'Push tag')) Graft.toast('Pushed ' + name); },
    async pushTags() { const r = remoteName(); if (r && await Graft.net.run('push', { remote: r, refspec: '--tags' }, 'Push tags')) Graft.toast('Pushed tags'); },
    async deleteRemoteTag(name) {
      const r = remoteName();
      if (r && await dlg().confirm('Delete tag on the server?', `Delete ${name} on ${r}? This can't be undone here.`, 'Delete')) await Graft.net.run('push', { remote: r, refspec: ':refs/tags/' + name }, 'Delete remote tag');
    },

    // ---------------- misc
    copy(text) { navigator.clipboard.writeText(text).then(() => Graft.toast('Copied')); },
    terminal: () => R.path && D.terminal(R.path),
    showFolder: () => R.path && D.showFile(R.path, '.'),
    async reflog() {
      let list = [];
      try { list = await R.call('reflog', 200); } catch (e) { dlg().alert('Reflog', R.clean(e)); return; }
      const rows = list.map((r) => U.el('div', { class: 'rl-row' },
        U.el('span', { class: 'mono small rl-hash', text: short(r.hash) }),
        U.el('span', { class: 'rl-msg', text: r.message, title: r.message }),
        U.el('span', { class: 'muted small', text: U.timeAgo(r.time) }),
        U.el('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: 'Show', onclick: () => { dlg().close(); Graft.ui.history.showCommit(r.hash); } }),
        U.el('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: 'Go back here', title: 'Move the current branch to this point (keeps uncommitted changes)', onclick: async () => {
          dlg().close();
          if (await dlg().confirm('Go back here?', `Move ${(R.info && R.info.headName) || 'HEAD'} to ${short(r.hash)} ("${r.message}")? Uncommitted changes are kept. Undo moves it forward again.`, 'Go back')) await Graft.act('resetKeep', [r.hash]);
        } }),
        U.el('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: 'Branch', title: 'New branch here', onclick: () => { dlg().close(); A.newBranch(r.hash); } })));
      dlg().open({ title: 'Reflog — everywhere HEAD has been', wide: true, body: U.el('div', { class: 'stack' }, U.el('p', { class: 'dialog-text small', text: 'Every commit, checkout, reset and rebase moves HEAD and is listed here, newest first, so lost work can always be found again.' }), U.el('div', { class: 'rl-list' }, ...(rows.length ? rows : [U.el('p', { class: 'muted', text: 'Empty.' })]))) });
    },
  };

  function needRemote() {
    if (!R.refs || !R.refs.remotes.length) {
      dlg().open({ title: 'No remote yet', body: U.el('p', { class: 'dialog-text', text: 'This repository isn\'t connected to a server. Add one (for example the address of an empty GitHub repository) to fetch, pull and push.' }), actions: [{ label: 'Cancel' }, { label: 'Add remote…', primary: true, onClick: () => { setTimeout(() => A.addRemote()); } }] });
      return false;
    }
    return true;
  }
  function remoteName() {
    if (!needRemote()) return null;
    const rs = R.refs.remotes;
    const up = R.status && R.status.upstream;
    return (up && rs.find((r) => up.startsWith(r.name + '/')) || rs.find((r) => r.name === 'origin') || rs[0]).name;
  }

  Graft.actions = A;
})();
