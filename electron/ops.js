/**
 * Everything the page can ask Git to do. main.js exposes these by name over one IPC channel;
 * nothing else can be run. Each action that changes the repository returns { undo } when it
 * can be undone: a small recipe the page keeps on its undo stack and hands back to `undo`.
 *
 * Undo recipes (kind):
 *   head      move the branch back to a commit (reset --keep, or --soft to keep a commit's changes staged)
 *   checkout  switch back to the previous branch / commit
 *   branch    recreate a deleted branch, delete a created one, rename back
 *   tag       recreate a deleted tag / delete a created one
 *   stash     put a dropped stash back; pop the stash that was just saved
 *   patch     re-apply discarded lines (saved as a patch before discarding)
 */
const fs = require('fs');
const path = require('path');
const git = require('./git');

const IMAGE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif' };

let ctx = { nodeCmd: process.execPath, noopEditor: null, trash: async () => {} };
function configure(c) { ctx = { ...ctx, ...c }; }

const editorEnv = () => ({ GIT_EDITOR: `"${ctx.nodeCmd.replace(/\\/g, '/')}" "${ctx.noopEditor.replace(/\\/g, '/')}"`, ELECTRON_RUN_AS_NODE: '1' });
const head = async (repo) => (await git.out(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { ok: [1] })).trim() || null;
const headName = async (repo) => (await git.out(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { ok: [1] })).trim() || null;
const short = (h) => (h || '').slice(0, 7);
const str = (v, name) => { if (typeof v !== 'string' || !v || v.includes('\0')) throw new Error(`Bad ${name || 'value'}`); return v; };
const refName = (v) => { str(v, 'name'); if (/^-|\.\.|[\s~^:?*[\\]|@\{|\.lock$|\/$|^\//.test(v)) throw new Error(`"${v}" isn't a valid name`); return v; };
const paths = (list) => { if (!Array.isArray(list) || !list.length) throw new Error('No files'); return list.map((p) => str(p, 'path')); };
const moved = (label, before) => ({ kind: 'head', label, sha: before, mode: 'keep' });

/** Runs an action that may stop for conflicts: returns { conflicts: true } instead of failing. */
async function mayConflict(repo, fn) {
  try { await fn(); return { conflicts: false }; } catch (e) {
    const i = await git.info(repo).catch(() => ({}));
    if (i.state || /CONFLICT|conflict/.test(e.stderr || e.message)) return { conflicts: true, message: git.explain(e.stderr || e.message) };
    throw e;
  }
}

const ops = {
  // ---------------- reading
  version: () => git.version(),
  info: (repo) => git.info(repo),
  status: (repo) => git.status(repo),
  log: (repo, opts) => git.log(repo, opts || {}),
  showCommit: (repo, hash) => git.showCommit(repo, str(hash, 'commit')),
  diff: (repo, file, where, opts) => git.diff(repo, file, where, opts || {}),
  branches: (repo) => git.branches(repo),
  stashes: (repo) => git.stashes(repo),
  stashFiles: (repo, hash) => git.stashFiles(repo, str(hash)),
  reflog: (repo, n) => git.reflog(repo, n || 200),
  blame: (repo, file, rev) => git.blame(repo, str(file, 'path'), rev || null),
  lastMessage: (repo) => git.lastMessage(repo),
  async fileText(repo, rev, file) {
    const b = await git.fileAt(repo, rev, str(file, 'path'));
    if (!b) return null;
    if (b.length > 8 * 1024 * 1024 || b.subarray(0, 8000).includes(0)) return { binary: true, size: b.length };
    return { text: b.toString('utf8') };
  },
  /** An image at a revision (or the working tree) as a data: URL for the image diff. */
  async image(repo, rev, file) {
    const mime = IMAGE[path.extname(str(file, 'path')).slice(1).toLowerCase()];
    if (!mime) return null;
    const b = await git.fileAt(repo, rev, file);
    if (!b || b.length > 25 * 1024 * 1024) return null;
    return { url: `data:${mime};base64,${b.toString('base64')}`, size: b.length };
  },
  async summary(repo) {
    const [i, s] = await Promise.all([git.info(repo), git.status(repo)]);
    return { name: i.name, branch: i.headName || (i.head ? short(i.head) : 'no commits'), changes: s.staged.length + s.unstaged.length + s.untracked.length + s.conflicts.length, ahead: s.ahead, behind: s.behind };
  },
  async identity(repo) {
    const get = async (k, scope) => (await git.out(repo, ['config', ...(scope ? [scope] : []), '--get', k], { ok: [1] })).trim();
    return { name: await get('user.name'), email: await get('user.email'), globalName: await get('user.name', '--global'), globalEmail: await get('user.email', '--global') };
  },
  async setIdentity(repo, name, email) {
    await git.run(null, ['config', '--global', 'user.name', str(name, 'name')]);
    await git.run(null, ['config', '--global', 'user.email', str(email, 'email')]);
    return true;
  },
  async mergeBase(repo, a, b) { return (await git.out(repo, ['merge-base', str(a), str(b)], { ok: [1] })).trim() || null; },
  /** Commits between base and HEAD for the interactive rebase list (oldest first); refuses ranges with merges. */
  async rebaseList(repo, hash) {
    const parent = (await git.out(repo, ['rev-parse', '--verify', '-q', str(hash) + '^'], { ok: [1] })).trim() || null;
    const range = parent ? `${parent}..HEAD` : 'HEAD';
    const merges = (await git.out(repo, ['rev-list', '--merges', range])).trim();
    if (merges) throw new Error('These commits include a merge, which can\'t be edited here. Pick a commit after the last merge.');
    const isAnc = await git.run(repo, ['merge-base', '--is-ancestor', hash, 'HEAD'], { ok: [1] });
    if (isAnc.code) throw new Error('That commit isn\'t part of the current branch.');
    const raw = await git.out(repo, ['log', '--reverse', '-z', '--format=%H%x1f%an%x1f%at%x1f%B', range]);
    const list = raw.split('\0').filter(Boolean).map((r) => { const [h, an, at, body] = r.replace(/^\n/, '').split('\x1f'); return { hash: h, author: an, time: Number(at) * 1000, message: body.replace(/\s+$/, '') }; });
    return { base: parent, commits: list };
  },

  // ---------------- staging & committing
  async stage(repo, list) { await git.stageFiles(repo, paths(list)); return {}; },
  async unstage(repo, list) { await git.unstageFiles(repo, paths(list), !!(await head(repo))); return {}; },
  async stagePatch(repo, patch, zero) { await git.applyPatch(repo, str(patch, 'patch'), { cached: true, zero }); return {}; },
  async unstagePatch(repo, patch, zero) { await git.applyPatch(repo, str(patch, 'patch'), { cached: true, reverse: true, zero }); return {}; },
  /** Discards some lines: the patch is kept so Undo can put them back. */
  async discardPatch(repo, patch, zero) {
    await git.applyPatch(repo, str(patch, 'patch'), { cached: false, reverse: true, zero });
    return { undo: { kind: 'patch', label: 'Discard lines', patch, zero } };
  },
  /** Discards whole files: tracked ones are saved as a patch first, untracked ones go to the Recycle Bin. */
  async discard(repo, tracked, untracked) {
    tracked = Array.isArray(tracked) ? tracked.map((p) => str(p)) : [];
    untracked = Array.isArray(untracked) ? untracked.map((p) => str(p)) : [];
    let undo = null;
    if (tracked.length) {
      const patch = await git.out(repo, ['diff', '--binary', '--no-color', '--no-ext-diff', '--', ...tracked]);
      await git.discardFiles(repo, tracked);
      if (patch.trim()) undo = { kind: 'patch', label: `Discard ${tracked.length} file${tracked.length > 1 ? 's' : ''}`, patch, binary: true };
    }
    const root = path.resolve(repo);
    for (const p of untracked) {
      const full = path.resolve(root, p);
      if (full.startsWith(root + path.sep)) await ctx.trash(full);
    }
    return { undo, trashed: untracked.length };
  },
  async commit(repo, message, opts = {}) {
    const before = await head(repo);
    await git.commit(repo, str(message, 'message'), { amend: !!opts.amend });
    const after = await head(repo);
    const subject = message.split('\n')[0];
    return { hash: after, undo: before ? { kind: 'head', label: opts.amend ? `Amend "${subject}"` : `Commit "${subject}"`, sha: before, mode: 'soft' } : { kind: 'unborn', label: `Commit "${subject}"` } };
  },
  async ignore(repo, pattern) {
    const file = path.join(repo, '.gitignore');
    let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (text && !text.endsWith('\n')) text += '\n';
    fs.writeFileSync(file, text + str(pattern) + '\n');
    return {};
  },

  // ---------------- branches
  async checkout(repo, target) {
    const prev = (await headName(repo)) || (await head(repo));
    await git.run(repo, ['switch', str(target, 'branch')]);
    return { undo: prev ? { kind: 'checkout', label: `Switch to ${target}`, target: prev } : null };
  },
  async checkoutDetached(repo, hash) {
    const prev = (await headName(repo)) || (await head(repo));
    await git.run(repo, ['switch', '--detach', str(hash)]);
    return { undo: prev ? { kind: 'checkout', label: `Check out ${short(hash)}`, target: prev } : null };
  },
  /** Remote branch → local branch tracking it ("origin/feature" → "feature"). */
  async checkoutRemote(repo, remoteBranch, localName) {
    const name = refName(localName || remoteBranch.replace(/^[^/]+\//, ''));
    const prev = (await headName(repo)) || (await head(repo));
    const exists = (await git.run(repo, ['rev-parse', '--verify', '-q', 'refs/heads/' + name], { ok: [1] })).code === 0;
    if (exists) await git.run(repo, ['switch', name]);
    else await git.run(repo, ['switch', '-c', name, '--track', str(remoteBranch)]);
    return { name, undo: { kind: 'checkout', label: `Check out ${remoteBranch}`, target: prev, deleteBranch: exists ? null : name } };
  },
  async createBranch(repo, name, start, doCheckout) {
    refName(name);
    const prev = (await headName(repo)) || (await head(repo));
    if (doCheckout) await git.run(repo, ['switch', '-c', name, ...(start ? [str(start)] : [])]);
    else await git.run(repo, ['branch', name, ...(start ? [str(start)] : [])]);
    return { undo: { kind: 'branch', label: `Create branch ${name}`, action: 'delete', name, back: doCheckout ? prev : null } };
  },
  async renameBranch(repo, from, to) {
    refName(to);
    await git.run(repo, ['branch', '-m', str(from), to]);
    return { undo: { kind: 'branch', label: `Rename ${from} → ${to}`, action: 'rename', from: to, to: from } };
  },
  async deleteBranch(repo, name, force) {
    const sha = (await git.out(repo, ['rev-parse', 'refs/heads/' + str(name)])).trim();
    const upstream = (await git.out(repo, ['rev-parse', '--abbrev-ref', name + '@{upstream}'], { ok: [128] })).trim();
    try { await git.run(repo, ['branch', force ? '-D' : '-d', name]); } catch (e) {
      if (/not fully merged/.test(e.stderr || '')) { const err = new Error('NOT_MERGED'); err.notMerged = true; throw err; }
      throw e;
    }
    return { undo: { kind: 'branch', label: `Delete branch ${name}`, action: 'create', name, sha, upstream: upstream && !/HEAD|fatal/.test(upstream) ? upstream : null } };
  },
  async setUpstream(repo, branch, upstream) { await git.run(repo, ['branch', '--set-upstream-to=' + str(upstream), str(branch)]); return {}; },
  async merge(repo, ref, opts = {}) {
    const before = await head(repo);
    const args = ['merge', '--no-edit'];
    if (opts.ff === 'no') args.push('--no-ff'); else if (opts.ff === 'only') args.push('--ff-only');
    args.push(str(ref));
    const r = await mayConflict(repo, () => git.run(repo, args));
    return { ...r, undo: moved(`Merge ${ref}`, before) };
  },
  async rebase(repo, onto) {
    const before = await head(repo);
    const r = await mayConflict(repo, () => git.run(repo, ['rebase', '--autostash', str(onto)], { env: editorEnv() }));
    return { ...r, undo: moved(`Rebase onto ${onto}`, before) };
  },
  async cherryPick(repo, hash) {
    const before = await head(repo);
    const r = await mayConflict(repo, () => git.run(repo, ['cherry-pick', str(hash)]));
    return { ...r, undo: moved(`Cherry-pick ${short(hash)}`, before) };
  },
  async revert(repo, hash, parent) {
    const before = await head(repo);
    const args = ['revert', '--no-edit'];
    if (parent) args.push('-m', String(Number(parent)));
    args.push(str(hash));
    const r = await mayConflict(repo, () => git.run(repo, args));
    return { ...r, undo: moved(`Revert ${short(hash)}`, before) };
  },
  /** Reset the current branch. mode: soft | mixed | hard. Hard first saves uncommitted changes as a stash. */
  async reset(repo, hash, mode) {
    if (!['soft', 'mixed', 'hard'].includes(mode)) throw new Error('Bad mode');
    const before = await head(repo);
    let saved = null;
    if (mode === 'hard') {
      const snap = (await git.out(repo, ['stash', 'create'])).trim();
      if (snap) { await git.run(repo, ['stash', 'store', '-m', `Graft: changes before reset to ${short(hash)}`, snap]); saved = snap; }
    }
    await git.run(repo, ['reset', '--' + mode, str(hash)]);
    return { saved, undo: { kind: 'head', label: `Reset to ${short(hash)}`, sha: before, mode: mode === 'hard' ? 'hard' : 'soft' } };
  },
  /** Continue / abort / skip a merge, rebase, cherry-pick or revert in progress. */
  async sequencer(repo, state, action) {
    if (!['merge', 'rebase', 'cherry-pick', 'revert'].includes(state) || !['continue', 'abort', 'skip'].includes(action)) throw new Error('Bad action');
    if (state === 'merge' && action === 'continue') return mayConflict(repo, () => git.run(repo, ['commit', '--no-edit']));
    if (state === 'merge') { await git.run(repo, ['merge', '--abort']); return {}; }
    return mayConflict(repo, () => git.run(repo, [state, '--' + action], { env: editorEnv() }));
  },
  async rebaseInteractive(repo, base, todo) {
    if (!Array.isArray(todo) || !todo.length) throw new Error('Nothing to do');
    const clean = todo.map((t) => ({ action: ['pick', 'reword', 'squash', 'fixup', 'drop'].includes(t.action) ? t.action : 'pick', hash: str(t.hash), message: typeof t.message === 'string' ? t.message : null }));
    const kept = clean.filter((t) => t.action !== 'drop');
    if (!kept.length) throw new Error('At least one commit has to stay.');
    if (kept[0].action === 'squash' || kept[0].action === 'fixup') throw new Error('The oldest commit can\'t be squashed: there\'s nothing below it to join.');
    const before = await head(repo);
    const r = await mayConflict(repo, () => git.rebaseInteractive(repo, base || '--root', clean, ctx.nodeCmd));
    return { ...r, undo: moved('Edit commits', before) };
  },

  // ---------------- conflicts
  async conflict(repo, file) {
    str(file, 'path');
    const read = async (stage) => { const b = await git.fileAt(repo, ':' + stage, file); return b ? b.toString('utf8') : null; };
    const full = path.join(repo, file);
    return { base: await read(1), ours: await read(2), theirs: await read(3), working: fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null };
  },
  async resolve(repo, file, content) {
    const full = path.resolve(repo, str(file, 'path'));
    if (!full.startsWith(path.resolve(repo) + path.sep)) throw new Error('Bad path');
    if (typeof content === 'string') fs.writeFileSync(full, content);
    await git.run(repo, ['add', '--', file]);
    return {};
  },
  async resolveWith(repo, file, side) {
    if (!['ours', 'theirs'].includes(side)) throw new Error('Bad side');
    try { await git.run(repo, ['checkout', '--' + side, '--', str(file)]); await git.run(repo, ['add', '--', file]); } catch (e) {
      // Deleted on that side: resolving with it means removing the file.
      if (/does not have (our|their) version/.test(e.stderr || '')) await git.run(repo, ['rm', '-q', '--', file]); else throw e;
    }
    return {};
  },

  // ---------------- stash
  async stashSave(repo, message, opts = {}) {
    const args = ['stash', 'push'];
    if (opts.untracked) args.push('--include-untracked');
    if (opts.keepIndex) args.push('--keep-index');
    if (message) args.push('-m', str(message));
    const res = await git.run(repo, args);
    if (/No local changes to save/.test(res.out)) throw new Error('There are no changes to stash.');
    return { undo: { kind: 'stash', label: 'Stash changes', action: 'pop' } };
  },
  async stashApply(repo, ref, pop) { const r = await mayConflict(repo, () => git.run(repo, ['stash', pop ? 'pop' : 'apply', '--index', str(ref)])); return r; },
  async stashDrop(repo, ref) {
    const hash = (await git.out(repo, ['rev-parse', str(ref)])).trim();
    const msg = (await git.out(repo, ['log', '-1', '--format=%gs', '-g', ref])).trim();
    await git.run(repo, ['stash', 'drop', ref]);
    return { undo: { kind: 'stash', label: 'Drop stash', action: 'store', hash, message: msg } };
  },

  // ---------------- tags
  async createTag(repo, name, rev, message) {
    refName(name);
    const args = ['tag'];
    if (message) args.push('-a', name, '-m', str(message)); else args.push(name);
    if (rev) args.push(str(rev));
    await git.run(repo, args);
    return { undo: { kind: 'tag', label: `Create tag ${name}`, action: 'delete', name } };
  },
  async deleteTag(repo, name) {
    const obj = (await git.out(repo, ['rev-parse', 'refs/tags/' + str(name)])).trim();
    await git.run(repo, ['tag', '-d', name]);
    return { undo: { kind: 'tag', label: `Delete tag ${name}`, action: 'create', name, obj } };
  },

  // ---------------- remotes
  async addRemote(repo, name, url) { await git.run(repo, ['remote', 'add', refName(name), str(url)]); return {}; },
  async removeRemote(repo, name) { await git.run(repo, ['remote', 'remove', str(name)]); return {}; },
  async init(repo) { fs.mkdirSync(str(repo), { recursive: true }); await git.run(repo, ['init']); return {}; },

  // ---------------- undo
  async undo(repo, u) {
    if (!u || typeof u !== 'object') throw new Error('Nothing to undo');
    switch (u.kind) {
      case 'head':
        if (u.mode === 'soft') await git.run(repo, ['reset', '--soft', str(u.sha)]);
        else if (u.mode === 'hard') await git.run(repo, ['reset', '--hard', str(u.sha)]);
        else await git.run(repo, ['reset', '--keep', str(u.sha)]);
        return {};
      case 'unborn': await git.run(repo, ['update-ref', '-d', 'HEAD']); return {};
      case 'checkout':
        await git.run(repo, ['switch', ...(/^[0-9a-f]{40}$/.test(u.target) ? ['--detach'] : []), str(u.target)]);
        if (u.deleteBranch) await git.run(repo, ['branch', '-D', u.deleteBranch]);
        return {};
      case 'branch':
        if (u.action === 'delete') { if (u.back) await git.run(repo, ['switch', ...(/^[0-9a-f]{40}$/.test(u.back) ? ['--detach'] : []), u.back]); await git.run(repo, ['branch', '-D', str(u.name)]); }
        else if (u.action === 'rename') await git.run(repo, ['branch', '-m', str(u.from), str(u.to)]);
        else if (u.action === 'create') { await git.run(repo, ['branch', str(u.name), str(u.sha)]); if (u.upstream) await git.run(repo, ['branch', '--set-upstream-to=' + u.upstream, u.name]).catch(() => {}); }
        return {};
      case 'tag':
        if (u.action === 'delete') await git.run(repo, ['tag', '-d', str(u.name)]);
        else await git.run(repo, ['update-ref', 'refs/tags/' + str(u.name), str(u.obj)]);
        return {};
      case 'stash':
        if (u.action === 'pop') await git.run(repo, ['stash', 'pop', '--index']);
        else await git.run(repo, ['stash', 'store', '-m', u.message || 'Restored stash', str(u.hash)]);
        return {};
      case 'patch':
        await git.applyPatch(repo, str(u.patch), { cached: false, zero: !!u.zero });
        return {};
      default: throw new Error('Can\'t undo that');
    }
  },
  /** Reflog: move the current branch back to an earlier position (keeps uncommitted changes). */
  async resetKeep(repo, sha) {
    const before = await head(repo);
    await git.run(repo, ['reset', '--keep', str(sha)]);
    return { undo: moved(`Go back to ${short(sha)}`, before) };
  },
};

module.exports = { ops, configure, editorEnv };
