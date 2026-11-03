/**
 * Commit graph: lanes for each row, worked out incrementally as more history loads, and painted
 * on one canvas for just the rows on screen (so 50,000 commits scroll as smoothly as 50).
 *
 *   const g = Graft.graph.create();  g.add(commits)  → rows (same order)
 *   row = { lane, color, before[], after[], parents[] }    before/after: hash expected in each lane
 *   Graft.graph.paint(ctx, rows, first, last, { rowH, laneW, top, width, head })
 */
(function () {
  const COLORS = ['#5ee6d0', '#ff9e80', '#b8a4ff', '#ffcf70', '#7cb4ff', '#ff8fc4', '#c4f06a', '#ff7a8a', '#8be3ff', '#e0a8ff'];

  function create() {
    let lanes = [];      // lane slot → hash it waits for (or null)
    let colors = [];     // lane slot → colour index
    let nextColor = 0;
    const rows = [];

    function freeSlot(from) {
      for (let i = from || 0; i < lanes.length; i++) if (lanes[i] == null) return i;
      return lanes.length;
    }

    function add(commits) {
      const out = [];
      for (const c of commits) {
        const before = lanes.slice();
        let lane = lanes.indexOf(c.hash);
        if (lane < 0) { lane = freeSlot(); lanes[lane] = c.hash; colors[lane] = nextColor++ % COLORS.length; }
        const color = colors[lane];
        // Other lanes waiting for this commit end here (branches that merged into it).
        for (let i = 0; i < lanes.length; i++) if (i !== lane && lanes[i] === c.hash) lanes[i] = null;
        const ps = c.parents;
        const parentLanes = [];
        if (!ps.length) lanes[lane] = null;
        else {
          lanes[lane] = ps[0];
          parentLanes.push(lane);
          for (let k = 1; k < ps.length; k++) {
            let at = lanes.indexOf(ps[k]);
            if (at < 0) { at = freeSlot(lane + 1); lanes[at] = ps[k]; colors[at] = nextColor++ % COLORS.length; }
            parentLanes.push(at);
          }
        }
        // (Two lanes waiting for the same parent both run on and meet at that commit, which
        // keeps the main line straight instead of jumping to the side branch's lane.)
        while (lanes.length && lanes[lanes.length - 1] == null) { lanes.pop(); colors.length = lanes.length; }
        const row = { lane, color, before, after: lanes.slice(), afterColors: colors.slice(), beforeColors: null, parentLanes };
        out.push(row);
        rows.push(row);
      }
      // Colour of each lane before the row = colour after the previous row.
      for (let i = rows.length - out.length; i < rows.length; i++) rows[i].beforeColors = i ? rows[i - 1].afterColors : [];
      return out;
    }

    return { add, rows, width: () => rows.reduce((w, r) => Math.max(w, r.before.length, r.after.length, r.lane + 1), 1) };
  }

  /** Draws rows first..last (inclusive). `top` = y of row `first` relative to the canvas. */
  function paint(ctx, rows, commits, first, last, o) {
    const { rowH, laneW } = o;
    const x = (l) => 10 + l * laneW;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (let r = first; r <= last; r++) {
      const row = rows[r];
      if (!row) break;
      const c = commits[r];
      const y0 = o.top + (r - first) * rowH;
      const ym = y0 + rowH / 2;
      const y1 = y0 + rowH;
      const col = (i) => COLORS[i % COLORS.length];
      // Top half: lanes coming in.
      row.before.forEach((h, i) => {
        if (h == null) return;
        ctx.strokeStyle = col((row.beforeColors[i] != null ? row.beforeColors[i] : i));
        ctx.beginPath();
        if (h === c.hash) { ctx.moveTo(x(i), y0); curve(ctx, x(i), y0, x(row.lane), ym); }
        else { ctx.moveTo(x(i), y0); ctx.lineTo(x(i), ym); }
        ctx.stroke();
      });
      // Bottom half: lanes going on, and lines to this commit's parents.
      row.after.forEach((h, i) => {
        if (h == null) return;
        const isParentLine = row.parentLanes.includes(i);
        const continuing = row.before[i] === h && i !== row.lane;
        ctx.strokeStyle = col(row.afterColors[i] != null ? row.afterColors[i] : i);
        if (continuing) { ctx.beginPath(); ctx.moveTo(x(i), ym); ctx.lineTo(x(i), y1); ctx.stroke(); }
        if (isParentLine) { ctx.beginPath(); ctx.moveTo(x(row.lane), ym); curve(ctx, x(row.lane), ym, x(i), y1); ctx.stroke(); }
      });
      // Parent lines that joined a lane which then ends exactly here are covered above; draw the dot.
      const isHead = o.head && c.hash === o.head;
      const merge = c.parents.length > 1;
      ctx.fillStyle = col(row.color);
      ctx.beginPath();
      ctx.arc(x(row.lane), ym, isHead ? 5.5 : merge ? 3.5 : 4.5, 0, Math.PI * 2);
      ctx.fill();
      if (isHead) { ctx.strokeStyle = o.ring; ctx.lineWidth = 2; ctx.stroke(); }
      if (c.stash) { ctx.fillStyle = o.ring; ctx.beginPath(); ctx.arc(x(row.lane), ym, 2, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  function curve(ctx, x1, y1, x2, y2) {
    if (x1 === x2) { ctx.lineTo(x2, y2); return; }
    const my = (y1 + y2) / 2;
    ctx.bezierCurveTo(x1, my, x2, my, x2, y2);
  }

  Graft.graph = { create, paint, COLORS };
})();
