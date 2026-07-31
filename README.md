# Tempo

Tempo is a fast, focused Git viewer for Windows and macOS. It keeps multiple local repositories in one window and deliberately limits its scope to browsing history, understanding changes, and shaping the staging area.

## Features

- Single-window repository workspace with a collapsible sidebar
- Staged, unstaged, and untracked file groups
- Lazy, line-numbered unified diff rendering
- Whole-file and hunk staging and unstaging
- Safe untracked-file removal through Trash or Recycle Bin
- Incrementally loaded history for all commits reachable from the current branch
- System, light, and dark themes
- Focus refresh with retained UI state
- Native Git behavior through the user's installed `git` executable

Tempo does not commit, push, pull, fetch, merge, rebase, or switch branches.

## Prerequisites

- Node.js 20 or newer
- Rust stable
- Git 2.23 or newer available to graphical applications
- Platform prerequisites from the Tauri documentation

## Development

```bash
npm install
npm run tauri dev
```

The frontend can run independently in a representative preview mode with `npm run dev`.

## Quality checks

```bash
npm run lint
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

## Architecture

The React frontend communicates through a small allowlisted set of Tauri commands. The Rust backend starts Git directly without a shell and requests only the data needed by the active view. Status uses porcelain v2 with NUL-delimited output, history is paginated, and diffs are loaded only after selection.

Immutable commit data can be cached safely, while working-tree state is refreshed when the application regains focus. Partial patches are checked with `git apply --check` before they are applied to the index.
