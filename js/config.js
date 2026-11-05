/**
 * App-wide settings. Every script attaches itself to the global namespace `window.Graft`.
 */
window.Graft = window.Graft || {};

Graft.config = {
  APP_VERSION: '1.0.0',
  STORAGE_PREFIX: 'graft:',
  ROW_H: 28,             // history row height (px)
  LANE_W: 14,            // graph lane width (px)
  PAGE: 3000,            // commits loaded per page
  DIFF_LINES: 4000,      // diff lines drawn before "Show everything"
  RECENT_MAX: 16,
  GIT_DOWNLOAD: 'https://git-scm.com/download/win',
};
