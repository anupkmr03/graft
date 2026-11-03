/**
 * Unified diffs: parse, build partial patches for line staging, and find changed words.
 *
 *   Graft.diff.parse(text) → [{ header[], oldPath, newPath, binary, isNew, isDeleted, hunks: [{ header, oldStart, newStart, lines: [{ t, s, o, n }] }] }]
 *   Graft.diff.patch(file, selected, direction)  selected: Set of "hunk:line"; direction 'forward' (stage) | 'reverse' (unstage, discard)
 *   Graft.diff.words(a, b) → [rangesA, rangesB] or null when the lines are too different
 */
(function () {
  function parse(text) {
    const files = [];
    let f = null;
    let h = null;
    let o = 0;
    let n = 0;
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) {
      if (line.startsWith('diff --git ') || (line.startsWith('diff --cc ')) || (!f && line.startsWith('--- '))) {
        f = { header: [], oldPath: null, newPath: null, binary: false, isNew: false, isDeleted: false, hunks: [] };
        files.push(f);
        h = null;
        if (!line.startsWith('--- ')) { f.header.push(line); continue; }
      }
      if (!f) continue;
      if (!h || (line.startsWith('@@') && h)) {
        if (line.startsWith('@@')) {
          const m = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+ ?(.*)$/.exec(line);
          if (m) {
            h = { header: line, oldStart: +m[1], oldLines: m[2] == null ? 1 : +m[2], newStart: +m[3], newLines: m[4] == null ? 1 : +m[4], section: m[5] || '', lines: [] };
            f.hunks.push(h);
            o = h.oldStart; n = h.newStart;
            continue;
          }
        }
        if (!h) {
          f.header.push(line);
          if (line.startsWith('--- ')) f.oldPath = line.slice(4).replace(/^a\//, '');
          else if (line.startsWith('+++ ')) f.newPath = line.slice(4).replace(/^b\//, '');
          else if (line.startsWith('new file mode')) f.isNew = true;
          else if (line.startsWith('deleted file mode')) f.isDeleted = true;
          else if (line.startsWith('Binary files') || line === 'GIT binary patch') f.binary = true;
          continue;
        }
      }
      const t = line[0];
      const s = line.slice(1);
      if (t === '+') h.lines.push({ t, s, n: n++ });
      else if (t === '-') h.lines.push({ t, s, o: o++ });
      else if (t === '\\') h.lines.push({ t, s: line });
      else h.lines.push({ t: ' ', s, o: o++, n: n++ });
    }
    files.forEach((x) => { if (x.oldPath === '/dev/null') x.isNew = true; if (x.newPath === '/dev/null') x.isDeleted = true; });
    return files;
  }

  /**
   * A patch with only the selected lines.
   *  forward (applied as is):   unselected '+' left out, unselected '-' become context
   *  reverse (applied --reverse): unselected '+' become context, unselected '-' left out
   */
  function patch(file, selected, direction) {
    const out = file.header.filter((l) => !/^(similarity|rename|copy|dissimilarity) /.test(l)).slice();
    // Renames: refer to the new path on both sides (the rename itself is staged with the whole file).
    let any = false;
    file.hunks.forEach((h, hi) => {
      const body = [];
      let changed = false;
      let prevKept = false;
      h.lines.forEach((l, li) => {
        const sel = selected.has(hi + ':' + li);
        if (l.t === '\\') { if (prevKept) body.push(l.s); return; }
        if (l.t === ' ') { body.push(' ' + l.s); prevKept = true; return; }
        if (sel) { body.push(l.t + l.s); changed = true; prevKept = true; return; }
        const keepAsContext = direction === 'forward' ? l.t === '-' : l.t === '+';
        if (keepAsContext) { body.push(' ' + l.s); prevKept = true; } else prevKept = false;
      });
      if (!changed) return;
      any = true;
      const oldCount = body.filter((l) => l[0] === ' ' || l[0] === '-').length;
      const newCount = body.filter((l) => l[0] === ' ' || l[0] === '+').length;
      out.push(`@@ -${h.oldStart},${oldCount} +${h.newStart},${newCount} @@`);
      out.push(...body);
    });
    return any ? out.join('\n') + '\n' : null;
  }

  // ---------------- word diff
  const TOKEN = /\w+|\s+|[^\w\s]/g;
  function words(a, b) {
    if (a.length > 600 || b.length > 600) return null;
    const ta = a.match(TOKEN) || [];
    const tb = b.match(TOKEN) || [];
    const n = ta.length;
    const m = tb.length;
    if (!n || !m || n * m > 60000) return null;
    // LCS table (lengths), then walk back.
    const dp = new Array((n + 1) * (m + 1)).fill(0);
    const W = m + 1;
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * W + j] = ta[i] === tb[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    const ra = [];
    const rb = [];
    let i = 0; let j = 0; let pa = 0; let pb = 0;
    let same = 0;
    const add = (r, s, e) => { if (e <= s) return; const last = r[r.length - 1]; if (last && last[1] === s) last[1] = e; else r.push([s, e]); };
    while (i < n && j < m) {
      if (ta[i] === tb[j]) { same += ta[i].trim() ? ta[i].length : 0; pa += ta[i++].length; pb += tb[j++].length; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { add(ra, pa, pa + ta[i].length); pa += ta[i++].length; }
      else { add(rb, pb, pb + tb[j].length); pb += tb[j++].length; }
    }
    while (i < n) { add(ra, pa, pa + ta[i].length); pa += ta[i++].length; }
    while (j < m) { add(rb, pb, pb + tb[j].length); pb += tb[j++].length; }
    const solid = Math.max(a.replace(/\s/g, '').length, b.replace(/\s/g, '').length) || 1;
    if (same / solid < 0.35) return null; // mostly different: highlighting words would just be noise
    return [ra, rb];
  }

  /** For each hunk: pairs "-" runs with the "+" run after them and stores word ranges on the lines (l.w). */
  function markWords(file) {
    file.hunks.forEach((h) => {
      const L = h.lines;
      for (let i = 0; i < L.length;) {
        if (L[i].t !== '-') { i++; continue; }
        let j = i;
        while (j < L.length && L[j].t === '-') j++;
        let k = j;
        while (k < L.length && L[k].t === '+') k++;
        const dels = L.slice(i, j);
        const adds = L.slice(j, k);
        if (adds.length && dels.length <= 40 && adds.length <= 40) {
          for (let x = 0; x < Math.min(dels.length, adds.length); x++) {
            const w = words(dels[x].s, adds[x].s);
            if (w) { dels[x].w = w[0]; adds[x].w = w[1]; }
          }
        }
        i = k > i ? k : i + 1;
      }
    });
  }

  Graft.diff = { parse, patch, words, markWords };
})();
