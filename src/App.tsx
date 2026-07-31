import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArchiveRestore, Box, Check, ChevronDown, ChevronRight, ChevronsLeft, CircleDot,
  Code2, Command, File, FileCode2, GitBranch,
  History, Inbox, LoaderCircle, Menu, Minus, Moon, MoreHorizontal,
  Plus, RefreshCw, Search, Settings, Sun, Trash2, X,
} from "lucide-react";
import * as api from "./api";
import { parseDiff, patchForHunks, patchForLines } from "./diff";
import { sampleCommits, sampleDiff, sampleRepositories } from "./sample";
import type { ChangedFile, CommitSummary, DiffDocument, GitVersion, Repository, Theme } from "./types";

const browserDemo = !("__TAURI_INTERNALS__" in window);
type View = "changes" | "history";

function timeAgo(timestamp: number) {
  const seconds = Math.max(1, Date.now() / 1000 - timestamp);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function statusLabel(status: string) {
  return status === "?" ? "U" : status.includes("A") ? "A" : status.includes("D") ? "D" : status.includes("R") ? "R" : "M";
}

export default function App() {
  const [repositories, setRepositories] = useState<Repository[]>(browserDemo ? sampleRepositories : []);
  const [activePath, setActivePath] = useState(() => localStorage.getItem("active-repository") || (browserDemo ? sampleRepositories[0].path : ""));
  const [view, setView] = useState<View>("changes");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("theme") as Theme) || "system");
  const [selectedFile, setSelectedFile] = useState<ChangedFile | null>(browserDemo ? sampleRepositories[0].changes[0] : null);
  const [diff, setDiff] = useState<DiffDocument>(() => parseDiff(browserDemo ? sampleDiff : ""));
  const [commits, setCommits] = useState<CommitSummary[]>(browserDemo ? sampleCommits : []);
  const [selectedCommit, setSelectedCommit] = useState<CommitSummary | null>(browserDemo ? sampleCommits[0] : null);
  const [loading, setLoading] = useState(false);
  const [selectedHunks, setSelectedHunks] = useState(new Set<string>());
  const [selectedLines, setSelectedLines] = useState(new Set<string>());
  const [notice, setNotice] = useState<string | null>(browserDemo ? "Preview mode · Open the desktop app to browse local repositories" : null);
  const [gitVersion, setGitVersion] = useState<GitVersion | null>(browserDemo ? { available: true } : null);
  const active = repositories.find((repo) => repo.path === activePath) ?? repositories[0];

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    if (browserDemo) return;
    void api.checkGit().then(async (version) => {
      setGitVersion(version);
      if (!version.available) return;
      const saved: string[] = JSON.parse(localStorage.getItem("repositories") || "[]");
      const loaded = await Promise.allSettled(saved.map(api.loadRepository));
      setRepositories(loaded.flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
    });
  }, []);

  useEffect(() => {
    if (!browserDemo && repositories.length) localStorage.setItem("repositories", JSON.stringify(repositories.map((repo) => repo.path)));
  }, [repositories]);

  const refresh = useCallback(async () => {
    if (!active || browserDemo) return;
    setLoading(true);
    try {
      const [repo, history] = await Promise.all([api.loadRepository(active.path), api.loadHistory(active.path)]);
      setRepositories((items) => items.map((item) => item.path === repo.path ? repo : item));
      setCommits(history);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setLoading(false);
    }
  }, [active]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  async function addRepository() {
    if (browserDemo) { setNotice("Repository picker is available in the desktop application"); return; }
    const path = await open({ directory: true, multiple: false, title: "Open Git repository" });
    if (!path) return;
    try {
      const repo = await api.loadRepository(path);
      setRepositories((items) => [...items.filter((item) => item.path !== repo.path), repo]);
      setActivePath(repo.path);
      localStorage.setItem("active-repository", repo.path);
    } catch (error) { setNotice(String(error)); }
  }

  async function selectFile(file: ChangedFile) {
    setSelectedFile(file);
    setSelectedHunks(new Set());
    setSelectedLines(new Set());
    if (browserDemo || !active) return;
    setLoading(true);
    try { setDiff(parseDiff(await api.loadDiff(active.path, file.path, file.section))); }
    catch (error) { setNotice(String(error)); }
    finally { setLoading(false); }
  }

  async function fileAction(action: "stage" | "unstage" | "discard" | "trash") {
    if (!active || !selectedFile) return;
    if ((action === "discard" || action === "trash") && !confirm(`${action === "trash" ? "Move" : "Discard"} ${selectedFile.path}${action === "trash" ? " to Trash" : " changes"}?`)) return;
    if (browserDemo) { setNotice(`${action[0].toUpperCase()}${action.slice(1)} is ready in the desktop app`); return; }
    setLoading(true);
    try { await api.changeFile(active.path, selectedFile.path, action); await refresh(); }
    catch (error) { setNotice(String(error)); }
    finally { setLoading(false); }
  }

  async function applySelected() {
    if (!active || !selectedFile) return;
    const chosen = selectedHunks;
    const patch = selectedLines.size ? patchForLines(diff, selectedLines) : patchForHunks(diff, chosen);
    if (!patch) return;
    if (browserDemo) { setNotice(`${selectedFile.section === "staged" ? "Unstaged" : "Staged"} ${selectedLines.size || chosen.size} selected ${selectedLines.size ? "lines" : "hunks"}`); return; }
    try { await api.applyPatch(active.path, patch, selectedFile.section === "staged"); await refresh(); }
    catch (error) { setNotice(String(error)); }
  }

  const grouped = useMemo(() => ({
    staged: active?.changes.filter((f) => f.section === "staged") ?? [],
    unstaged: active?.changes.filter((f) => f.section === "unstaged") ?? [],
    untracked: active?.changes.filter((f) => f.section === "untracked") ?? [],
  }), [active]);

  const rotateTheme = () => setTheme((current) => current === "system" ? "light" : current === "light" ? "dark" : "system");

  if (gitVersion && !gitVersion.available) return <GitMissing error={gitVersion.error} onRetry={() => void api.checkGit().then(setGitVersion)}/>;
  if (!gitVersion) return <div className="boot-screen"><div className="brand-mark"><GitBranch size={22}/></div><LoaderCircle className="spin"/><span>Finding Git…</span></div>;

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? "" : "collapsed"}`}>
      <div className="brand"><div className="brand-mark"><GitBranch size={17}/></div>{sidebarOpen && <><strong>Tempo</strong><span className="beta">BETA</span></>}<button className="icon-button collapse" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Toggle sidebar"><ChevronsLeft size={16}/></button></div>
      {sidebarOpen && <div className="side-heading"><span>REPOSITORIES</span><button onClick={addRepository} aria-label="Open repository"><Plus size={15}/></button></div>}
      <div className="repository-list">
        {repositories.map((repo) => <button key={repo.path} title={repo.path} className={`repository ${repo.path === active?.path ? "active" : ""}`} onClick={() => { setActivePath(repo.path); localStorage.setItem("active-repository", repo.path); }}>
          <span className="repo-icon">{repo.name.slice(0, 1).toUpperCase()}</span>
          {sidebarOpen && <span className="repo-copy"><strong>{repo.name}</strong><small><GitBranch size={11}/>{repo.branch}</small></span>}
          {sidebarOpen && repo.changes.length > 0 && <span className="count">{repo.changes.length}</span>}
        </button>)}
      </div>
      <button className="open-repo" onClick={addRepository}><Plus size={16}/>{sidebarOpen && "Open repository"}</button>
      <div className="sidebar-footer"><button className="user-button"><span>MC</span>{sidebarOpen && <div><strong>Maya Chen</strong><small>Local workspace</small></div>}{sidebarOpen && <Settings size={15}/>}</button></div>
    </aside>

    <main>
      <header className="topbar">
        <button className="mobile-menu icon-button" onClick={() => setSidebarOpen(!sidebarOpen)}><Menu size={18}/></button>
        <div className="repo-title"><div className="title-icon">{active?.name.slice(0, 1).toUpperCase() || <Box/>}</div><div><h1>{active?.name ?? "Open a repository"}</h1><span>{active?.path ?? "Choose a local Git working tree"}</span></div></div>
        {active && <div className="branch-pill"><GitBranch size={14}/><strong>{active.branch}</strong>{active.ahead > 0 && <span>↑{active.ahead}</span>}{active.behind > 0 && <span>↓{active.behind}</span>}<ChevronDown size={13}/></div>}
        <div className="top-actions"><button className="icon-button" onClick={rotateTheme} title={`Theme: ${theme}`}>{theme === "dark" ? <Moon size={17}/> : theme === "light" ? <Sun size={17}/> : <CircleDot size={17}/>}</button><button className="refresh-button" onClick={() => void refresh()}><RefreshCw className={loading ? "spin" : ""} size={15}/>Refresh <kbd>⌘R</kbd></button><button className="icon-button"><MoreHorizontal size={18}/></button></div>
      </header>

      <nav className="tabs"><button className={view === "changes" ? "active" : ""} onClick={() => setView("changes")}><Code2 size={16}/>Local changes{active && <span>{active.changes.length}</span>}</button><button className={view === "history" ? "active" : ""} onClick={() => setView("history")}><History size={16}/>History</button></nav>

      {!active ? <EmptyState onOpen={addRepository}/> : view === "changes" ? <div className="workspace changes-workspace">
        <section className="file-panel">
          <div className="panel-toolbar"><div className="search"><Search size={14}/><input aria-label="Filter files" placeholder="Filter files…"/><kbd>⌘F</kbd></div><button className="icon-button"><MoreHorizontal size={17}/></button></div>
          <ChangeGroup title="Staged changes" files={grouped.staged} selected={selectedFile} onSelect={selectFile} accent="green"/>
          <ChangeGroup title="Changes" files={grouped.unstaged} selected={selectedFile} onSelect={selectFile} accent="amber"/>
          <ChangeGroup title="Untracked files" files={grouped.untracked} selected={selectedFile} onSelect={selectFile} accent="blue"/>
        </section>
        <DiffPanel diff={diff} file={selectedFile} selectedHunks={selectedHunks} setSelectedHunks={setSelectedHunks} selectedLines={selectedLines} setSelectedLines={setSelectedLines} onApply={applySelected} onAction={fileAction}/>
      </div> : <HistoryView commits={commits} selected={selectedCommit} onSelect={setSelectedCommit}/>}
    </main>
    {notice && <div className="toast"><Check size={15}/><span>{notice}</span><button onClick={() => setNotice(null)}><X size={14}/></button></div>}
  </div>;
}

function ChangeGroup({ title, files, selected, onSelect, accent }: { title: string; files: ChangedFile[]; selected: ChangedFile | null; onSelect: (file: ChangedFile) => void; accent: string }) {
  const [open, setOpen] = useState(true);
  return <div className="change-group"><button className="group-title" onClick={() => setOpen(!open)}>{open ? <ChevronDown/> : <ChevronRight/>}<span className={`dot ${accent}`}/><strong>{title}</strong><span className="group-count">{files.length}</span></button>{open && <div>{files.length === 0 ? <p className="empty-group">No {title.toLowerCase()}</p> : files.map((file) => <button key={`${file.section}-${file.path}`} className={`file-row ${selected?.path === file.path && selected.section === file.section ? "selected" : ""}`} onClick={() => onSelect(file)}><FileCode2 size={16}/><span><strong>{file.path.split("/").pop()}</strong><small>{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "."}</small></span><b className={`status ${statusLabel(file.status)}`}>{statusLabel(file.status)}</b></button>)}</div>}</div>;
}

function DiffPanel({ diff, file, selectedHunks, setSelectedHunks, selectedLines, setSelectedLines, onApply, onAction }: { diff: DiffDocument; file: ChangedFile | null; selectedHunks: Set<string>; setSelectedHunks: (value: Set<string>) => void; selectedLines: Set<string>; setSelectedLines: (value: Set<string>) => void; onApply: () => void; onAction: (action: "stage" | "unstage" | "discard" | "trash") => void }) {
  if (!file) return <section className="diff-panel centered"><File size={32}/><h2>Select a changed file</h2><p>Its diff will be loaded only when you need it.</p></section>;
  const verb = file.section === "staged" ? "Unstage" : "Stage";
  const toggleHunk = (id: string) => { const next = new Set(selectedHunks); next.has(id) ? next.delete(id) : next.add(id); setSelectedHunks(next); };
  const toggleLine = (id: string) => { const next = new Set(selectedLines); next.has(id) ? next.delete(id) : next.add(id); setSelectedLines(next); };
  return <section className="diff-panel">
    <div className="diff-toolbar"><div className="file-breadcrumb"><FileCode2 size={16}/><strong>{file.path.split("/").pop()}</strong><span>{file.path}</span></div><div className="diff-actions">{file.section !== "untracked" && <button className="secondary" onClick={() => onAction(file.section === "staged" ? "unstage" : "stage")}>{file.section === "staged" ? <Minus/> : <Plus/>}{verb} file</button>}<button className="primary" disabled={!selectedHunks.size && !selectedLines.size} onClick={onApply}>{verb} selected</button><button className="icon-button danger" title={file.section === "untracked" ? "Move to Trash" : "Discard changes"} onClick={() => onAction(file.section === "untracked" ? "trash" : "discard")}><Trash2 size={16}/></button></div></div>
    <div className="diff-stats"><span className="additions">+12</span><span className="deletions">−4</span><span className="stat-bar"><i/><i/></span><span>Whitespace</span><button>Ignore<ChevronDown size={12}/></button></div>
    <div className="diff-scroll">{diff.binary ? <div className="binary"><ArchiveRestore/><h3>Binary file</h3><p>Git cannot display a textual diff for this file.</p></div> : diff.hunks.map((hunk) => <div className="hunk" key={hunk.id}><div className="hunk-header"><label><input type="checkbox" checked={selectedHunks.has(hunk.id)} onChange={() => toggleHunk(hunk.id)}/><span/></label><code>{hunk.header}</code><button onClick={() => toggleHunk(hunk.id)}>{selectedHunks.has(hunk.id) ? "Selected" : `${verb} hunk`}</button></div>{hunk.lines.map((line) => <div key={line.id} className={`diff-line ${line.kind}`}><span className="line-select">{line.selectable && <input aria-label={`Select line ${line.newNumber ?? line.oldNumber}`} type="checkbox" checked={selectedLines.has(line.id)} onChange={() => toggleLine(line.id)}/>}</span><span className="line-no">{line.oldNumber}</span><span className="line-no">{line.newNumber}</span><code>{line.content || " "}</code></div>)}</div>)}</div>
  </section>;
}

function HistoryView({ commits, selected, onSelect }: { commits: CommitSummary[]; selected: CommitSummary | null; onSelect: (commit: CommitSummary) => void }) {
  return <div className="workspace history-workspace"><section className="commit-list"><div className="panel-toolbar"><div className="search"><Search size={14}/><input placeholder="Filter commits…"/></div></div><div className="date-label">RECENT</div>{commits.map((commit) => <button className={`commit-row ${selected?.oid === commit.oid ? "selected" : ""}`} key={commit.oid} onClick={() => onSelect(commit)}><span className="commit-node"><i/></span><span className="commit-copy"><strong>{commit.subject}</strong><small>{commit.author} · {timeAgo(commit.timestamp)} ago</small></span><code>{commit.shortOid}</code></button>)}<button className="load-more">Load older commits</button></section><section className="commit-detail">{selected ? <><div className="commit-heading"><div><span className="eyebrow">COMMIT</span><h2>{selected.subject}</h2></div><button className="secondary"><Command size={14}/>{selected.shortOid}</button></div><p className="commit-message">This change improves the working tree experience while keeping repository operations fast and predictable.</p><div className="metadata"><div className="avatar">{selected.author.split(" ").map((s) => s[0]).join("")}</div><div><strong>{selected.author}</strong><small>authored {timeAgo(selected.timestamp)} ago</small></div></div><div className="commit-files-title"><strong>Changed files</strong><span>3 files <b className="additions">+32</b> <b className="deletions">−11</b></span></div>{["src/components/DiffView.tsx", "src/diff.ts", "src/styles.css"].map((file, i) => <button className="commit-file" key={file}><FileCode2 size={16}/><span>{file}</span><b className="additions">+{12 + i * 5}</b><b className="deletions">−{i + 2}</b><ChevronRight size={14}/></button>)}</> : null}</section></div>;
}

function EmptyState({ onOpen }: { onOpen: () => void }) {
  return <div className="empty-state"><div className="empty-art"><Inbox/></div><h2>Open your first repository</h2><p>Tempo keeps Git focused: browse changes, shape the index, and understand history without the noise.</p><button className="primary" onClick={onOpen}><Plus/>Open repository</button></div>;
}

function GitMissing({ error, onRetry }: { error?: string; onRetry: () => void }) {
  return <div className="git-missing"><div className="brand-mark"><GitBranch size={22}/></div><span className="eyebrow">GIT IS REQUIRED</span><h1>Connect Tempo to Git</h1><p>Tempo uses the Git installation already on your computer so it behaves exactly like your terminal. Install Git or make it available on your application PATH, then check again.</p>{error && <code>{error}</code>}<button className="primary" onClick={onRetry}><RefreshCw size={14}/>Check again</button></div>;
}
