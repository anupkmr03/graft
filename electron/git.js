/**
 * Git service (main process). Every operation runs the installed `git` with an argument list
 * (never through a shell) and parses Git's machine-readable formats (porcelain v2, -z, %x1f).
 *
 *   run(repo, args, opts)            → { out, err, code }       (throws GitError on failure unless opts.ok)
 *   status / log / showCommit / diff / blame / branches / stashes / reflog / …
 *   stagePatch / unstagePatch / discardPatch   partial staging with `git apply --recount`
 *   network(repo, args, onProgress)  fetch / pull / push / clone with live progress, cancellable
 *   rebaseInteractive(repo, base, todo)        drives `git rebase -i` with our own editor scripts
 *
 * Environment: GIT_TERMINAL_PROMPT=0 so Git never waits on a hidden prompt; sign-in for
 * push / pull is left to Git's credential manager (its own window on Windows).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const US = '\x1f'; // field separator used in --format strings
const BASE_ARGS = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'log.showSignature=false', '-c', 'diff.noprefix=false'];
const MAX_OUT = 64 * 1024 * 1024;

class GitError extends Error {
  constructor(message, code, err) {
    super(message);
    this.code = code;
    this.stderr = err;
  }
}

function gitEnv(extra) {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',   // status from a GUI shouldn't take locks
    LC_ALL: 'C',               // English messages we can recognise
    LANG: 'C',
    ...extra,
  };
}

/** Friendlier wording for common Git failures. */
function explain(err) {
  const e = String(err || '').trim();
  const rules = [
    [/Please tell me who you are|empty ident name|unable to auto-detect email/i, 'Git doesn\'t know your name and email yet. Set them in Settings → Your identity.'],
    [/Authentication failed|could not read Username|terminal prompts disabled/i, 'Sign-in failed. Git\'s credential manager should ask you to sign in; check your account or token.'],
    [/Could not resolve host|unable to access.*(Could not resolve|Failed to connect)/i, 'Can\'t reach the server. Check your internet connection.'],
    [/\[rejected\].*\(fetch first\)|non-fast-forward|Updates were rejected/i, 'The remote has commits you don\'t have. Pull first, then push again.'],
    [/would be overwritten by (checkout|merge)|Your local changes to the following files would be overwritten/i, 'You have changes that would be overwritten. Commit or stash them first.'],
    [/not something we can merge/i, 'That branch can\'t be found.'],
    [/CONFLICT/i, 'There are conflicts to resolve.'],
    [/nothing to commit/i, 'There\'s nothing staged to commit.'],
    [/index\.lock': File exists/i, 'Another Git program is busy with this repository (index.lock exists). Close it and try again.'],
  ];
  const hit = rules.find(([re]) => re.test(e));
  return hit ? hit[1] : e.split('\n').filter((l) => l && !/^hint:/.test(l)).slice(-3).join('\n') || 'Git failed';
}

function run(repo, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.git || 'git', [...BASE_ARGS, ...args], {
      cwd: repo || undefined, env: gitEnv(opts.env), windowsHide: true,
    });
    const out = [];
    const err = [];
    let size = 0;
    let truncated = false;
    child.stdout.on('data', (d) => {
      if (opts.raw && size + d.length <= (opts.limit || MAX_OUT)) { out.push(d); size += d.length; return; }
      if (size + d.length > (opts.limit || MAX_OUT)) { truncated = true; return; }
      out.push(d);
      size += d.length;
    });
    child.stderr.on('data', (d) => {
      err.push(d);
      if (opts.onStderr) opts.onStderr(d.toString('utf8'));
    });
    child.on('error', (e) => reject(new GitError(e.code === 'ENOENT' ? 'Git isn\'t installed (or not on PATH).' : e.message, -1, '')));
    child.on('close', (code) => {
      const buf = Buffer.concat(out);
      const stderr = Buffer.concat(err).toString('utf8');
      const res = { out: opts.raw ? buf : buf.toString('utf8'), err: stderr, code, truncated };
      if (code !== 0 && !(opts.ok && opts.ok.includes(code))) reject(new GitError(explain(stderr || res.out), code, stderr));
      else resolve(res);
    });
    if (opts.signal) opts.signal.kill = () => { try { child.kill(); } catch (e) { /* gone */ } };
    if (opts.input != null) child.stdin.end(opts.input); else child.stdin.end();
  });
}

const out = async (repo, args, opts) => (await run(repo, args, opts)).out;

// ---------------------------------------------------------------- repository
async function version() {
  try { return (await out(null, ['--version'])).trim(); } catch (e) { return null; }
}

/** Repository facts: root, git dir, HEAD, operation in progress. */
async function info(repo) {
  const r = (await out(repo, ['rev-parse', '--show-toplevel', '--absolute-git-dir'])).trim().split('\n');
  const root = r[0];
  const gitDir = r[1];
  const exists = (p) => fs.existsSync(path.join(gitDir, p));
  let state = null;
  if (exists('rebase-merge') || exists('rebase-apply')) state = 'rebase';
  else if (exists('MERGE_HEAD')) state = 'merge';
  else if (exists('CHERRY_PICK_HEAD')) state = 'cherry-pick';
  else if (exists('REVERT_HEAD')) state = 'revert';
  let headName = null;
  try { headName = (await out(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { ok: [1] })).trim() || null; } catch (e) { headName = null; }
  let head = null;
  try { head = (await out(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { ok: [1] })).trim() || null; } catch (e) { head = null; }
  let rebaseInfo = null;
  if (state === 'rebase') {
    const dir = exists('rebase-merge') ? 'rebase-merge' : 'rebase-apply';
    const read = (f) => { try { return fs.readFileSync(path.join(gitDir, dir, f), 'utf8').trim(); } catch (e) { return ''; } };
    rebaseInfo = { onto: read('onto'), headName: read('head-name').replace(/^refs\/heads\//, ''), step: Number(read('msgnum') || read('next')) || 0, total: Number(read('end') || read('last')) || 0 };
  }
  let mergeMsg = '';
  try { mergeMsg = fs.readFileSync(path.join(gitDir, 'MERGE_MSG'), 'utf8'); } catch (e) { mergeMsg = ''; }
  return { root, gitDir, name: path.basename(root), head, headName, detached: !headName && !!head, state, rebase: rebaseInfo, mergeMsg };
}

/** porcelain v2: { branch, upstream, ahead, behind, staged[], unstaged[], untracked[], conflicts[] } */
async function status(repo) {
  const raw = await out(repo, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=dirty']);
  return parseStatus(raw);
}

const CODE = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange', U: 'conflict' };

function parseStatus(raw) {
  const s = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicts: [] };
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# ')) {
      const [, key, ...rest] = line.split(' ');
      const val = rest.join(' ');
      if (key === 'branch.head') s.branch = val === '(detached)' ? null : val;
      else if (key === 'branch.oid') s.oid = val === '(initial)' ? null : val;
      else if (key === 'branch.upstream') s.upstream = val;
      else if (key === 'branch.ab') { const m = /\+(\d+) -(\d+)/.exec(val); if (m) { s.ahead = +m[1]; s.behind = +m[2]; } }
      continue;
    }
    const type = line[0];
    if (type === '?') { s.untracked.push({ path: line.slice(2), status: 'untracked' }); continue; }
    if (type === '!') continue;
    if (type === '1' || type === '2') {
      const f = line.split(' ');
      const xy = f[1];
      const p = f.slice(type === '1' ? 8 : 9).join(' ');
      const orig = type === '2' ? parts[++i] : null;
      if (xy[0] !== '.') s.staged.push({ path: p, from: orig, status: CODE[xy[0]] || 'modified' });
      if (xy[1] !== '.') s.unstaged.push({ path: p, from: orig, status: CODE[xy[1]] || 'modified' });
      continue;
    }
    if (type === 'u') {
      const f = line.split(' ');
      s.conflicts.push({ path: f.slice(10).join(' '), status: 'conflict', xy: f[1] });
    }
  }
  return s;
}

// ---------------------------------------------------------------- history
const LOG_FMT = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s'].join('%x1f');

/**
 * Commits in date order (children before parents), all branches + tags + HEAD.
 * Page through with skip / max. opts.search: { text, author, path, kind: 'message' | 'author' | 'content' | 'path' }
 */
async function log(repo, opts = {}) {
  const args = ['log', '--date-order', '-z', '--format=' + LOG_FMT, '--max-count=' + (opts.max || 2000)];
  if (opts.skip) args.push('--skip=' + opts.skip);
  const s = opts.search;
  if (s && s.text) {
    if (s.kind === 'author') args.push('--author=' + s.text, '-i');
    else if (s.kind === 'content') args.push('-S' + s.text);
    else if (s.kind !== 'path') args.push('--grep=' + s.text, '-i', '--fixed-strings');
  }
  if (opts.ref) args.push(opts.ref); else if (opts.file) args.push('HEAD'); else args.push('--branches', ...(opts.noRemotes ? [] : ['--remotes']), '--tags', 'HEAD');
  if (s && s.kind === 'path' && s.text) args.push('--', s.text);
  if (opts.file) args.push('--follow', '--', opts.file);
  let raw;
  try { raw = await out(repo, args); } catch (e) {
    if (/does not have any commits|bad default revision|unknown revision.*HEAD/i.test(e.stderr || e.message)) return [];
    throw e;
  }
  return raw.split('\0').filter(Boolean).map((rec) => {
    const [hash, parents, author, email, at, refs, subject] = rec.replace(/^\n/, '').split(US);
    return { hash, parents: parents ? parents.split(' ') : [], author, email, time: Number(at) * 1000, refs: parseRefs(refs), subject };
  });
}

function parseRefs(d) {
  if (!d) return [];
  return d.split(', ').map((r) => {
    if (r.startsWith('HEAD -> ')) return { type: 'head', name: r.slice(8) };
    if (r === 'HEAD') return { type: 'detached', name: 'HEAD' };
    if (r.startsWith('tag: ')) return { type: 'tag', name: r.slice(5) };
    if (r.includes('/') && !r.startsWith('refs/')) return { type: 'remote', name: r };
    return { type: 'branch', name: r };
  });
}

/** One commit: details + changed files (+ numstat). Merge commits are compared with their first parent. */
async function showCommit(repo, hash) {
  const fmt = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%D', '%B'].join('%x1f');
  const head = await out(repo, ['show', '-s', '--format=' + fmt, hash]);
  const [h, parents, an, ae, at, cn, ce, ct, refs, body] = head.split(US);
  const ps = parents ? parents.split(' ') : [];
  const base = ps.length ? ps[0] : null;
  const files = await changedFiles(repo, base, h);
  return { hash: h, parents: ps, author: an, email: ae, time: Number(at) * 1000, committer: cn, committerEmail: ce, ctime: Number(ct) * 1000, refs: parseRefs(refs), message: body.replace(/\s+$/, ''), files };
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Files changed between two revisions (base null = root commit). */
async function changedFiles(repo, base, rev) {
  const a = base || EMPTY_TREE;
  const ns = (await out(repo, ['diff', '--name-status', '-M', '-z', a, rev])).split('\0');
  const files = [];
  for (let i = 0; i < ns.length - 1;) {
    const code = ns[i++];
    if (!code) continue;
    if (code[0] === 'R' || code[0] === 'C') { const from = ns[i++]; const to = ns[i++]; files.push({ path: to, from, status: CODE[code[0]] }); }
    else files.push({ path: ns[i++], status: CODE[code[0]] || 'modified' });
  }
  const num = (await out(repo, ['diff', '--numstat', '-M', '-z', a, rev])).split('\0');
  // numstat -z: "add\tdel\tpath" or for renames "add\tdel\t" then from, to
  const stats = new Map();
  for (let i = 0; i < num.length;) {
    const rec = num[i++];
    if (!rec) continue;
    const [add, del, p] = rec.split('\t');
    let key = p;
    if (!p) { i++; key = num[i++]; }
    stats.set(key, { add: add === '-' ? null : Number(add), del: del === '-' ? null : Number(del) });
  }
  files.forEach((f) => Object.assign(f, stats.get(f.path) || {}));
  return files;
}

// ---------------------------------------------------------------- diffs
/**
 * Unified diff text for one file.
 *   where: 'unstaged' | 'staged' | 'untracked' | { base, rev } (commit / stash compare)
 */
async function diff(repo, file, where, opts = {}) {
  const ctx = '-U' + (opts.context == null ? 3 : opts.context);
  const ws = opts.ignoreWhitespace ? ['-w'] : [];
  const common = ['--no-ext-diff', '--no-color', ctx, ...ws, '-M'];
  let args;
  let ok = null;
  if (where === 'unstaged') args = ['diff', ...common, '--', file.path];
  else if (where === 'staged') args = ['diff', '--cached', ...common, '--', ...(file.from ? [file.from] : []), file.path];
  else if (where === 'untracked') { args = ['diff', '--no-index', ...common, '--', '/dev/null', file.path]; ok = [1]; }
  else args = ['diff', ...common, where.base || EMPTY_TREE, where.rev, '--', ...(file.from ? [file.from] : []), file.path];
  const res = await run(repo, args, { ok: ok || undefined, limit: 6 * 1024 * 1024 });
  return { text: res.out, truncated: res.truncated };
}

/** A file's bytes at a revision ('' = working tree, ':' = index, ':1' / ':2' / ':3' = conflict stages). */
async function fileAt(repo, rev, file) {
  if (rev === '' || rev == null) {
    const full = path.join(repo, file);
    return fs.existsSync(full) ? fs.readFileSync(full) : null;
  }
  try {
    const spec = rev.startsWith(':') ? `${rev}:${file}` : `${rev}:${file}`;
    return (await run(repo, ['show', spec], { raw: true, limit: 30 * 1024 * 1024 })).out;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- staging
/** Applies a patch to the index (or the working tree). */
async function applyPatch(repo, patch, { cached = true, reverse = false, zero = false } = {}) {
  const args = ['apply', '--recount', '--whitespace=nowarn'];
  if (zero) args.push('--unidiff-zero');
  if (cached) args.push('--cached');
  if (reverse) args.push('--reverse');
  args.push('-');
  await run(repo, args, { input: patch });
}

const stageFiles = (repo, paths) => run(repo, ['add', '-A', '--', ...paths]);
const unstageFiles = async (repo, paths, hasHead) => {
  if (hasHead) await run(repo, ['restore', '--staged', '--', ...paths]);
  else await run(repo, ['rm', '--cached', '-r', '-q', '--', ...paths]);
};
/** Discards working-tree changes of tracked files (back to the index). Untracked files go to the Recycle Bin (main.js). */
async function discardFiles(repo, tracked) {
  if (tracked.length) await run(repo, ['restore', '--worktree', '--', ...tracked]);
}

async function commit(repo, message, { amend = false, allowEmpty = false } = {}) {
  const args = ['commit', '-F', '-'];
  if (amend) args.push('--amend');
  if (allowEmpty) args.push('--allow-empty');
  const res = await run(repo, args, { input: message });
  return res.out;
}

async function lastMessage(repo) {
  try { return (await out(repo, ['log', '-1', '--format=%B'])).replace(/\s+$/, ''); } catch (e) { return ''; }
}

// ---------------------------------------------------------------- refs
async function branches(repo) {
  const fmt = ['%(refname)', '%(refname:short)', '%(objectname)', '%(upstream:short)', '%(upstream:track)', '%(HEAD)', '%(committerdate:unix)', '%(contents:subject)', '%(*objectname)'].join('%1f');
  const raw = await out(repo, ['for-each-ref', '--format=' + fmt, 'refs/heads', 'refs/remotes', 'refs/tags']);
  const local = [];
  const remote = [];
  const tags = [];
  raw.split('\n').filter(Boolean).forEach((line) => {
    const [ref, short, oid, upstream, track, head, date, subject, peeled] = line.split(US);
    const m = /ahead (\d+)/.exec(track);
    const b = /behind (\d+)/.exec(track);
    const item = { ref, name: short, oid: peeled || oid, upstream: upstream || null, ahead: m ? +m[1] : 0, behind: b ? +b[1] : 0, gone: /gone/.test(track), current: head === '*', time: Number(date) * 1000, subject };
    if (ref.startsWith('refs/heads/')) local.push(item);
    else if (ref.startsWith('refs/remotes/')) { if (!ref.endsWith('/HEAD')) remote.push(item); }
    else tags.push(item);
  });
  tags.sort((a, b) => b.time - a.time);
  const remotes = (await out(repo, ['remote', '-v'])).split('\n').filter((l) => /\(fetch\)$/.test(l)).map((l) => { const [name, url] = l.split(/\s+/); return { name, url }; });
  return { local, remote, tags, remotes };
}

async function stashes(repo) {
  const raw = await out(repo, ['stash', 'list', '-z', '--format=%gd%x1f%H%x1f%at%x1f%gs'], { ok: [1] });
  return raw.split('\0').filter(Boolean).map((r) => {
    const [ref, hash, at, msg] = r.split(US);
    return { ref, hash, time: Number(at) * 1000, message: msg.replace(/^(WIP on|On) [^:]+: /, ''), raw: msg };
  });
}

/** Files in a stash (tracked changes and, if saved with them, untracked files). */
async function stashFiles(repo, hash) {
  const files = await changedFiles(repo, hash + '^1', hash);
  try {
    const u = (await out(repo, ['ls-tree', '-r', '--name-only', '-z', hash + '^3'])).split('\0').filter(Boolean);
    u.forEach((p) => files.push({ path: p, status: 'untracked', untrackedIn: hash + '^3' }));
  } catch (e) { /* no untracked part */ }
  return files;
}

async function reflog(repo, n = 200) {
  const raw = await out(repo, ['reflog', '-z', '--format=%H%x1f%gd%x1f%gs%x1f%ct', '-n', String(n)], { ok: [128] });
  return raw.split('\0').filter(Boolean).map((r) => { const [hash, ref, msg, ct] = r.split(US); return { hash, ref, message: msg, time: Number(ct) * 1000 }; });
}

// ---------------------------------------------------------------- blame
async function blame(repo, file, rev) {
  const args = ['blame', '--porcelain', '-w'];
  if (rev) args.push(rev);
  args.push('--', file);
  const raw = await out(repo, args, { limit: 30 * 1024 * 1024 });
  const commits = {};
  const lines = [];
  let cur = null;
  raw.split('\n').forEach((l) => {
    const head = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(l);
    if (head) { cur = { hash: head[1], line: +head[3] }; if (!commits[cur.hash]) commits[cur.hash] = { hash: cur.hash }; return; }
    if (!cur) return;
    if (l.startsWith('\t')) { lines.push({ hash: cur.hash, text: l.slice(1) }); return; }
    const sp = l.indexOf(' ');
    const k = sp < 0 ? l : l.slice(0, sp);
    const v = sp < 0 ? '' : l.slice(sp + 1);
    const c = commits[cur.hash];
    if (k === 'author') c.author = v;
    else if (k === 'author-time') c.time = Number(v) * 1000;
    else if (k === 'summary') c.summary = v;
  });
  return { lines, commits };
}

// ---------------------------------------------------------------- network (progress)
/** fetch / pull / push / clone with progress events { phase, percent, text }. */
function network(repo, args, onProgress, signal) {
  let last = '';
  const parse = (chunk) => {
    chunk.split(/[\r\n]+/).forEach((line) => {
      const t = line.trim();
      if (!t || t === last) return;
      last = t;
      const m = /^(?:remote: )?([A-Za-z ]+):\s+(\d+)%/.exec(t);
      onProgress({ phase: m ? m[1].trim() : null, percent: m ? Number(m[2]) : null, text: t });
    });
  };
  return run(repo, args, { onStderr: parse, signal });
}

// ---------------------------------------------------------------- interactive rebase
/**
 * Rebases the commits after `base` using our own todo list.
 * todo: [{ action: 'pick' | 'reword' | 'squash' | 'fixup' | 'drop', hash, message? }] oldest first.
 * Git runs two tiny scripts instead of a text editor: one writes our todo list, the other
 * supplies reword / squash messages in order.
 */
async function rebaseInteractive(repo, base, todo, nodeCmd) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-rebase-'));
  const todoFile = path.join(dir, 'todo.txt');
  const queueFile = path.join(dir, 'messages.json');
  const seqScript = path.join(dir, 'seq.js');
  const editScript = path.join(dir, 'edit.js');
  fs.writeFileSync(todoFile, todo.filter((t) => t.action !== 'drop').map((t) => `${t.action} ${t.hash}`).join('\n') + '\n');
  // Editor calls, in order: one per reword; one per run of squashes (fixups don't open it).
  const queue = [];
  for (let i = 0; i < todo.length; i++) {
    const t = todo[i];
    if (t.action === 'reword') queue.push(t.message || null);
    if (t.action === 'squash') {
      const next = todo.slice(i + 1).find((x) => x.action !== 'drop');
      if (!next || (next.action !== 'squash' && next.action !== 'fixup')) queue.push(t.message || null);
    }
  }
  fs.writeFileSync(queueFile, JSON.stringify(queue));
  fs.writeFileSync(seqScript, `require('fs').copyFileSync(${JSON.stringify(todoFile)}, process.argv[2]);\n`);
  fs.writeFileSync(editScript, `const fs = require('fs'); const q = JSON.parse(fs.readFileSync(${JSON.stringify(queueFile)}, 'utf8'));
const msg = q.length ? q.shift() : null; fs.writeFileSync(${JSON.stringify(queueFile)}, JSON.stringify(q));
if (msg != null) fs.writeFileSync(process.argv[2], msg + '\\n');\n`);
  const fwd = (p) => p.replace(/\\/g, '/');
  const cmd = (script) => `"${fwd(nodeCmd)}" "${fwd(script)}"`;
  try {
    await run(repo, ['rebase', '-i', '--autostash', base], {
      env: { GIT_SEQUENCE_EDITOR: cmd(seqScript), GIT_EDITOR: cmd(editScript), ELECTRON_RUN_AS_NODE: '1' },
    });
  } finally {
    setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 2000);
  }
}

module.exports = {
  GitError, run, out, version, info, status, parseStatus, log, parseRefs, showCommit, changedFiles, diff, fileAt,
  applyPatch, stageFiles, unstageFiles, discardFiles, commit, lastMessage, branches, stashes, stashFiles, reflog, blame,
  network, rebaseInteractive, explain, EMPTY_TREE,
};
