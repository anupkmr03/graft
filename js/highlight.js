/**
 * Light syntax colouring, one line at a time (fast enough for 100k-line diffs; no library).
 *   Graft.hl.lang(path) → language family or null
 *   Graft.hl.render(text, lang, changes, tabSize) → HTML for one line
 *       changes: [[start, end], …] character ranges to mark as changed words (word diff)
 */
(function () {
  const EXT = {};
  const fam = (name, exts) => exts.split(' ').forEach((e) => { EXT[e] = name; });
  fam('c', 'js mjs cjs jsx ts tsx java c h cc cpp hpp cxx cs go rs swift kt kts scala dart php groovy gradle m mm css scss less sass json5 jsonc vue svelte zig v');
  fam('hash', 'py pyw rb sh bash zsh fish ps1 psm1 yml yaml toml conf ini cfg r pl pm tcl cmake mk makefile dockerfile gitignore gitattributes env properties nim cr ex exs coffee');
  fam('json', 'json lock webmanifest');
  fam('tag', 'html htm xml svg xaml xhtml plist csproj vcxproj props targets resx config');
  fam('sql', 'sql lua hs elm');
  fam('md', 'md markdown rst txt');

  const KW = new Set(('abstract and as assert async await bool boolean break byte case catch char class const constructor continue debugger def default defer del delete do double elif else enum except export extends extern false final finally float fn for foreach from func function get global go goto if impl implements import in include instanceof int interface internal is lambda let long loop match mod module mut namespace new nil none not null object of operator or override package pass private protected pub public raise readonly ref return self select set short signed sizeof static string struct super switch template then this throw throws trait true try type typedef typeof uint union unless unsafe unsigned until use using val var virtual void volatile when where while with yield None True False elsif end begin module require local fi esac done echo export function SELECT FROM WHERE INSERT INTO UPDATE DELETE CREATE TABLE ALTER DROP JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER LIMIT AND OR NOT NULL AS VALUES SET PRIMARY KEY INDEX').split(' '));

  function lang(p) {
    if (!p) return null;
    const base = p.split('/').pop().toLowerCase();
    if (base === 'makefile' || base === 'dockerfile' || base.startsWith('.')) return EXT[base.replace(/^\./, '')] || 'hash';
    const ext = base.includes('.') ? base.split('.').pop() : '';
    return EXT[ext] || null;
  }

  const RULES = {
    c: /(\/\/.*$|\/\*.*?(?:\*\/|$)|^\s*\*.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b(?:0x[\da-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)[a-z]*\b)|(@?[A-Za-z_$][\w$]*)/gi,
    hash: /(#.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$-]*)/g,
    json: /()("(?:[^"\\]|\\.)*"(?=\s*:)|"(?:[^"\\]|\\.)*"?)|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|(\b(?:true|false|null)\b)/gi,
    sql: /(--.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w]*)/g,
    tag: /(<!--.*?(?:-->|$))|("[^"]*"?|'[^']*'?)|(&\w+;)|(<\/?[\w:.-]+|\/?>|\b[\w:-]+(?==))/g,
    md: /(^\s*>.*$)|(`[^`]*`?)|(^#{1,6} .*$)|(\*\*[^*]+\*\*|\[[^\]]*\]\([^)]*\))/g,
  };

  function tokens(text, family) {
    const re = RULES[family];
    if (!re || text.length > 2000) return [];
    const out = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (!m[0]) { re.lastIndex++; continue; }
      const s = m.index;
      const e = s + m[0].length;
      if (m[1]) out.push([s, e, 'tk-com']);
      else if (m[2]) out.push([s, e, family === 'md' ? 'tk-str' : 'tk-str']);
      else if (m[3]) out.push([s, e, family === 'md' ? 'tk-kw' : family === 'tag' ? 'tk-num' : 'tk-num']);
      else if (m[4]) {
        if (family === 'tag') out.push([s, e, m[4][0] === '<' || m[4][0] === '/' || m[4][0] === '>' ? 'tk-kw' : 'tk-attr']);
        else if (family === 'json') out.push([s, e, 'tk-kw']);
        else if (family === 'md') out.push([s, e, 'tk-attr']);
        else if (KW.has(m[4])) out.push([s, e, 'tk-kw']);
        else if (/^[A-Z][a-z]/.test(m[4])) out.push([s, e, 'tk-type']);
        else if (text[e] === '(') out.push([s, e, 'tk-fn']);
      }
    }
    if (family === 'json') out.forEach((t) => { if (t[2] === 'tk-str' && /^\s*:/.test(text.slice(t[1]))) t[2] = 'tk-attr'; });
    return out;
  }

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /** Text → HTML with syntax spans and changed-word marks. Tabs expand to tabSize. */
  function render(text, family, changes, tabSize) {
    if (text.length > 5000) text = text.slice(0, 5000) + ' …';
    const tk = family && Graft.prefs.get('syntax') ? tokens(text, family) : [];
    const ch = changes || [];
    if (!tk.length && !ch.length) return esc(expand(text, tabSize));
    const cuts = new Set([0, text.length]);
    tk.forEach((t) => { cuts.add(t[0]); cuts.add(t[1]); });
    ch.forEach((c) => { cuts.add(Math.min(c[0], text.length)); cuts.add(Math.min(c[1], text.length)); });
    const pts = [...cuts].sort((a, b) => a - b);
    let html = '';
    let ti = 0;
    let ci = 0;
    let col = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const s = pts[i];
      const e = pts[i + 1];
      if (e <= s) continue;
      while (ti < tk.length && tk[ti][1] <= s) ti++;
      while (ci < ch.length && ch[ci][1] <= s) ci++;
      const cls = [];
      if (ti < tk.length && tk[ti][0] <= s) cls.push(tk[ti][2]);
      if (ci < ch.length && ch[ci][0] <= s) cls.push('wd');
      let seg = text.slice(s, e);
      if (seg.includes('\t')) { const r = expandFrom(seg, tabSize, col); seg = r.text; col = r.col; } else col += seg.length;
      html += cls.length ? `<span class="${cls.join(' ')}">${esc(seg)}</span>` : esc(seg);
    }
    return html;
  }
  function expand(t, size) { return t.includes('\t') ? expandFrom(t, size, 0).text : t; }
  function expandFrom(t, size, col) {
    let out = '';
    for (const ch of t) {
      if (ch === '\t') { const n = size - (col % size); out += ' '.repeat(n); col += n; } else { out += ch; col++; }
    }
    return { text: out, col };
  }

  Graft.hl = { lang, render, esc, tokens };
})();
