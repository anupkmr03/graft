# Graft

A fast, offline Git client for Windows (Electron), in the same glass style as Reel Library, Lumen and Pulse.
It uses the Git installed on the PC, so sign-in for GitHub and others goes through Git's own credential manager.

## Build

```
npm install
npm run dist        # → dist/Graft-Setup-1.0.0.exe and dist/Graft-Portable-1.0.0.exe
npm start           # run from source
```

Needs Git for Windows on the PC that runs it (https://git-scm.com/download/win). Without it, Graft shows a download link.

## Features

1. **Repositories**: open, clone (with progress), create; a recent list showing each repo's branch, changes and ahead/behind; drag a folder onto the window to open it.
2. **Commit graph**: lanes painted on one canvas for only the rows on screen. More history loads as you scroll, and 50,000 commits scroll smoothly.
3. **Changes**: stage or unstage a file, a hunk, or just the lines you pick (click, Shift+click, or drag). Then commit or amend. Ctrl+Enter commits.
4. **Diffs**: syntax colours, changed words highlighted, before/after for images, an "Ignore spaces" option, and a choice of how many context lines to show.
5. **Branches**: create, switch, rename, delete (warns if unmerged), merge (fast-forward options), rebase, track a remote branch.
6. **Remotes**: fetch, pull and push with live progress and Cancel. Ahead/behind counts appear on Pull/Push. A rejected push offers "Pull now" or "Force push" (Graft always force-pushes with lease). Optional auto-fetch.
7. **Conflicts**: a 3-way view (yours | result | theirs) per block, where you pick a side, take both in either order, or edit by hand. A banner shows Continue / Skip / Abort.
8. **History tools**:
   - Search by message, author, changed text, path or hash.
   - File history and blame.
   - Cherry-pick, revert, and reset (soft/mixed/hard; hard first saves your changes as a stash).
9. **Stash**: save (optionally with new files, or keeping staged changes), apply, pop, drop, and preview the stashed changes.
10. **Tags**: create (plain or annotated), push, delete locally or on the server.
11. **Edit commits** (interactive rebase): reorder by dragging, and per commit choose reword, squash, fixup or drop.
12. **Command palette** (Ctrl+P) plus keyboard shortcuts (listed in Settings).
13. **Undo** (Ctrl+Z): reverses the last action this session, including commit, amend, discard, branch or tag delete, merge, rebase, reset, pull and stash drop. Reflog lists every earlier position of HEAD.

## Code map

- `electron/git.js`: runs `git` with an argument list (never a shell) and parses porcelain v2, `-z` and `%x1f` output.
- `electron/ops.js`: every action the page may call, with undo recipes.
- `electron/main.js`: window, IPC, network actions with progress, Recycle Bin.
- `js/repo.js`: repo state, refresh, actions, undo stack, network.
- `js/diffparse.js`: diff parser, partial patches for line staging, word diff.
- `js/graph.js`: lane layout and canvas painting.
- `js/highlight.js`: one-line syntax colouring, with no library.
- `js/ui/*`: sidebar, toolbar, welcome, changes, diffview, conflict, history, blame, rebase, palette, settings, actions.

## Performance notes

- Status refreshes every 4 s, only while the window is focused (configurable). It uses `GIT_OPTIONAL_LOCKS=0`, so Graft never blocks other Git tools.
- The scrolling panels use a tinted background instead of a live blur, because re-blurring on every scroll frame was expensive without a strong GPU.
- Diffs draw the first 4,000 lines, with "Show everything" for the rest.
