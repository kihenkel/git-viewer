# Git Tempo

Git Tempo is a fast, focused Git viewer for Windows and macOS. It keeps multiple local repositories in one window and deliberately limits its scope to browsing history, understanding changes, and shaping the staging area.

## Features

- Single-window repository workspace with a collapsible sidebar
- Staged, unstaged, and untracked file groups
- Lazy, line-numbered unified diff rendering
- Whole-file, hunk, and supported individual-line staging and unstaging
- Safe untracked-file removal through Trash or Recycle Bin
- Incrementally loaded history for all commits reachable from the current branch
- System, light, and dark themes
- Focus refresh with retained UI state
- Native Git behavior through the user's installed `git` executable

Git Tempo does not commit, push, pull, fetch, merge, rebase, or switch branches.

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

## Local macOS installation

Git Tempo can be built from source as an optimized macOS application and installed for the current user. In addition to the prerequisites above, install the Xcode Command Line Tools once:

```bash
xcode-select --install
```

After cloning the repository, install the locked JavaScript dependencies, build the release application bundle, and copy it to your personal Applications folder:

```bash
npm ci
npm run tauri build -- --bundles app
mkdir -p "$HOME/Applications"
ditto \
  "src-tauri/target/release/bundle/macos/Git Tempo.app" \
  "$HOME/Applications/Git Tempo.app"
open "$HOME/Applications/Git Tempo.app"
```

The first release build takes longer because Rust compiles the native dependencies. After opening Git Tempo, drag it from `~/Applications` to the Dock. The Dock entry will continue to work when the application is replaced by a later build at the same path.

To install an update, quit Git Tempo and run the following commands from the repository:

```bash
git pull --ff-only
npm ci
npm run tauri build -- --bundles app
ditto \
  "src-tauri/target/release/bundle/macos/Git Tempo.app" \
  "$HOME/Applications/Git Tempo.app"
```

This workflow builds for the processor of the Mac running the command. Code signing, notarization, and a DMG are not required for a personal application built locally from source; they are required when distributing compiled builds to other users.

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
