/**
 * User preferences from Settings (localStorage). Graft.prefs.get(key) / set(key, value) → 'prefs:change'.
 */
(function () {
  const store = Graft.store;
  const DEFAULTS = {
    context: 3,              // diff context lines
    ignoreWhitespace: false,
    wordDiff: true,          // highlight the changed words inside a line
    syntax: true,            // colour code in diffs and blame
    tabSize: 4,
    wrap: false,             // wrap long lines in diffs
    remotesInGraph: true,    // show remote branches in the history
    dates: 'relative',       // relative | absolute
    refresh: 'live',         // live (every 4 s while focused) | focus
    autoFetch: 0,            // minutes; 0 = off
    pullMode: 'merge',       // merge | rebase | ff
    pushUpstream: true,      // first push of a new branch sets its upstream
    pruneOnFetch: true,
    confirmDiscard: true,
    confirmPush: false,
    sidebarWidth: 250,
    splitHistory: 0.56,      // history list share of the width
    splitChanges: 340,       // changes file list width
  };
  function get(key) {
    const raw = store.get('pref.' + key, null);
    if (raw == null) return DEFAULTS[key];
    try { return JSON.parse(raw); } catch (e) { return DEFAULTS[key]; }
  }
  function set(key, value) {
    if (!(key in DEFAULTS)) return;
    store.set('pref.' + key, JSON.stringify(value));
    Graft.bus.emit('prefs:change', { key, value });
  }
  Graft.prefs = { get, set, DEFAULTS };
})();
