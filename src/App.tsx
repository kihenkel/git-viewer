import {
  Children,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArchiveRestore, Box, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft,
  CircleAlert, CircleDot, Clipboard, Code2, Eye, EyeOff, File, FileCode2, GitBranch,
  History, Inbox, LoaderCircle, Menu, Minus, Moon, Plus, RefreshCw, Search, Settings, Sun,
  Trash2, X,
} from "lucide-react";
import * as api from "./api";
import { parseDiff, patchForHunks, patchForLines } from "./diff";
import { clearHideRules, compilePatterns, compileRules, isHidden, loadHideRules, saveHideRules } from "./hideRules";
import type { RuleError } from "./hideRules";
import { sampleCommitDetails, sampleCommits, sampleDiff, sampleRepositories } from "./sample";
import type {
  ChangedFile, CommitDetails, CommitSummary, DiffDocument, GitVersion, Repository, Theme,
} from "./types";

const browserDemo = !("__TAURI_INTERNALS__" in window);
const HISTORY_PAGE_SIZE = 100;
const DIFF_CACHE_LIMIT = 20;
// Cached diffs above this size (raw characters) are kept, marked stale, on auto-refresh.
const AUTO_REFRESH_DIFF_LIMIT = 200_000;
const COMMIT_CACHE_LIMIT = 50;
const SCROLL_PANE_SELECTOR = ".repository-list,.file-panel,.diff-scroll,.commit-scroll,.commit-detail";
type View = "changes" | "history" | "settings";
type LoadingState = {
  status: boolean;
  history: boolean;
  diff: boolean;
  commit: boolean;
  commitDiff: boolean;
  action: boolean;
};

interface RepositorySession {
  view: View;
  fileFilter: string;
  commitFilter: string;
  selectedFileKey: string | null;
  workingDiffKey: string | null;
  selectedHunks: Set<string>;
  selectedLines: Set<string>;
  diffSelections: Record<string, { hunks: Set<string>; lines: Set<string> }>;
  diffCache: Record<string, DiffDocument>;
  diffOrder: string[];
  staleDiffKeys: string[];
  commits: CommitSummary[];
  historyHead: string | null | undefined;
  historyHasMore: boolean;
  selectedCommitOid: string | null;
  commitDetails: Record<string, CommitDetails>;
  commitOrder: string[];
  selectedCommitFile: ChangedFile | null;
  commitDiffKey: string | null;
  commitDiffCache: Record<string, DiffDocument>;
  commitDiffOrder: string[];
  changesPaneSizes: number[];
  historyPaneSizes: number[];
  historyDiffPaneSizes: number[];
  fileScrollTop: number;
  historyScrollTop: number;
  loading: LoadingState;
  actionError: string | null;
  hidePatterns: string[];
  hideEnabled: boolean;
  hideDraft: string;
  hideErrors: RuleError[];
}

const idleLoading = (): LoadingState => ({
  status: false,
  history: false,
  diff: false,
  commit: false,
  commitDiff: false,
  action: false,
});

function changedFileKey(file: ChangedFile) {
  return `${file.section}:${file.path}`;
}

function commitFileKey(oid: string, file: ChangedFile) {
  return `${oid}:${file.oldPath ?? ""}:${file.path}`;
}

function repositoryName(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function unavailableRepository(path: string, error: unknown): Repository {
  return {
    path,
    name: repositoryName(path),
    branch: "Unavailable",
    head: null,
    ahead: 0,
    behind: 0,
    changes: [],
    error: String(error),
  };
}

function createSession(repository: Repository): RepositorySession {
  const previewFile = browserDemo && repository.path === sampleRepositories[0].path
    ? repository.changes[0] ?? null
    : null;
  const previewKey = previewFile ? changedFileKey(previewFile) : null;
  const hideRules = loadHideRules(repository.path);
  return {
    view: "changes",
    fileFilter: "",
    commitFilter: "",
    selectedFileKey: previewKey,
    workingDiffKey: previewKey,
    selectedHunks: new Set(),
    selectedLines: new Set(),
    diffSelections: {},
    diffCache: previewKey ? { [previewKey]: parseDiff(sampleDiff) } : {},
    diffOrder: previewKey ? [previewKey] : [],
    staleDiffKeys: [],
    commits: browserDemo ? sampleCommits : [],
    historyHead: browserDemo ? repository.head : undefined,
    historyHasMore: false,
    selectedCommitOid: browserDemo ? sampleCommits[0]?.oid ?? null : null,
    commitDetails: browserDemo ? sampleCommitDetails : {},
    commitOrder: browserDemo ? Object.keys(sampleCommitDetails) : [],
    selectedCommitFile: null,
    commitDiffKey: null,
    commitDiffCache: {},
    commitDiffOrder: [],
    changesPaneSizes: [29, 71],
    historyPaneSizes: [40, 60],
    historyDiffPaneSizes: [28, 30, 42],
    fileScrollTop: 0,
    historyScrollTop: 0,
    loading: idleLoading(),
    actionError: null,
    hidePatterns: hideRules.patterns,
    hideEnabled: hideRules.enabled,
    hideDraft: hideRules.patterns.join("\n"),
    hideErrors: [],
  };
}

function putBounded<T>(
  cache: Record<string, T>,
  order: string[],
  key: string,
  value: T,
  limit: number,
) {
  const nextCache = { ...cache, [key]: value };
  const nextOrder = [...order.filter((item) => item !== key), key];
  while (nextOrder.length > limit) {
    const expired = nextOrder.shift();
    if (expired) delete nextCache[expired];
  }
  return { cache: nextCache, order: nextOrder };
}

function timeAgo(timestamp: number) {
  const seconds = Math.max(1, Date.now() / 1000 - timestamp);
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function statusLabel(status: string) {
  return status === "?" ? "U" : status.startsWith("A") ? "A" : status.startsWith("D") ? "D" : status.startsWith("R") ? "R" : status === "U" ? "!" : "M";
}

function restoreLineSelection(oldDiff: DiffDocument | undefined, selected: Set<string>, nextDiff: DiffDocument) {
  if (!oldDiff || selected.size === 0) return new Set<string>();
  const wanted = new Map<string, number>();
  for (const hunk of oldDiff.hunks) {
    for (const line of hunk.lines) {
      if (!selected.has(line.id)) continue;
      const signature = `${line.kind}:${line.content}`;
      wanted.set(signature, (wanted.get(signature) ?? 0) + 1);
    }
  }
  const restored = new Set<string>();
  for (const hunk of nextDiff.hunks) {
    for (const line of hunk.lines) {
      const signature = `${line.kind}:${line.content}`;
      const remaining = wanted.get(signature) ?? 0;
      if (remaining > 0) {
        restored.add(line.id);
        wanted.set(signature, remaining - 1);
      }
    }
  }
  return restored;
}

function restoreHunkSelection(oldDiff: DiffDocument | undefined, selected: Set<string>, nextDiff: DiffDocument) {
  if (!oldDiff || selected.size === 0) return new Set<string>();
  const headers = new Set(oldDiff.hunks.filter((hunk) => selected.has(hunk.id)).map((hunk) => hunk.header));
  return new Set(nextDiff.hunks.filter((hunk) => headers.has(hunk.header)).map((hunk) => hunk.id));
}

export default function App() {
  const initialRepositories = browserDemo ? sampleRepositories : [];
  const [repositories, setRepositories] = useState<Repository[]>(initialRepositories);
  const [sessions, setSessions] = useState<Record<string, RepositorySession>>(() => Object.fromEntries(
    initialRepositories.map((repository) => [repository.path, createSession(repository)]),
  ));
  const [activePath, setActivePath] = useState(() => localStorage.getItem("active-repository") || initialRepositories[0]?.path || "");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("theme") as Theme) || "system");
  const [notice, setNotice] = useState<string | null>(browserDemo ? "Preview mode · Open the desktop app to browse local repositories" : null);
  const [gitVersion, setGitVersion] = useState<GitVersion | null>(browserDemo ? { available: true } : null);
  const [initializing, setInitializing] = useState(!browserDemo);
  const [restoredRepositories, setRestoredRepositories] = useState(browserDemo);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const repositoriesRef = useRef(repositories);
  const sessionsRef = useRef(sessions);
  const activePathRef = useRef(activePath);
  const requests = useRef(new Map<string, number>());
  const focusTimer = useRef<number | undefined>(undefined);
  const started = useRef(false);
  const appShell = useRef<HTMLDivElement>(null);

  useEffect(() => { repositoriesRef.current = repositories; }, [repositories]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => { activePathRef.current = activePath; }, [activePath]);

  useEffect(() => {
    const shell = appShell.current;
    if (!shell) return;
    const scrollFromWheel = (event: WheelEvent) => {
      if (event.ctrlKey || !(event.target instanceof Element)) return;
      let candidate: Element | null = event.target;
      while (candidate && candidate !== shell) {
        if (candidate.matches(SCROLL_PANE_SELECTOR) && candidate instanceof HTMLElement) {
          const scale = event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
              ? Math.max(1, candidate.clientHeight)
              : 1;
          const deltaX = (event.deltaX || (event.shiftKey ? event.deltaY : 0)) * scale;
          const deltaY = (event.shiftKey ? 0 : event.deltaY) * scale;
          const maxLeft = candidate.scrollWidth - candidate.clientWidth;
          const maxTop = candidate.scrollHeight - candidate.clientHeight;
          const canMoveX = deltaX < 0 ? candidate.scrollLeft > 0 : deltaX > 0 && candidate.scrollLeft < maxLeft;
          const canMoveY = deltaY < 0 ? candidate.scrollTop > 0 : deltaY > 0 && candidate.scrollTop < maxTop;
          if (canMoveX || canMoveY) {
            event.preventDefault();
            if (canMoveX) candidate.scrollLeft = Math.max(0, Math.min(maxLeft, candidate.scrollLeft + deltaX));
            if (canMoveY) candidate.scrollTop = Math.max(0, Math.min(maxTop, candidate.scrollTop + deltaY));
            return;
          }
        }
        candidate = candidate.parentElement;
      }
    };
    shell.addEventListener("wheel", scrollFromWheel, { passive: false });
    return () => shell.removeEventListener("wheel", scrollFromWheel);
  }, [gitVersion?.available, initializing]);

  const updateSession = useCallback((path: string, update: (session: RepositorySession) => RepositorySession) => {
    setSessions((current) => {
      const repository = repositoriesRef.current.find((item) => item.path === path) ?? unavailableRepository(path, "Repository unavailable");
      const next = { ...current, [path]: update(current[path] ?? createSession(repository)) };
      sessionsRef.current = next;
      return next;
    });
  }, []);

  const replaceRepository = useCallback((repository: Repository) => {
    setRepositories((current) => {
      const next = current.some((item) => item.path === repository.path)
        ? current.map((item) => item.path === repository.path ? repository : item)
        : [...current, repository];
      repositoriesRef.current = next;
      return next;
    });
  }, []);

  const beginRequest = useCallback((key: string) => {
    const id = (requests.current.get(key) ?? 0) + 1;
    requests.current.set(key, id);
    return id;
  }, []);

  const isLatestRequest = useCallback((key: string, id: number) => requests.current.get(key) === id, []);

  const loadHistoryPage = useCallback(async (path: string, reset: boolean, head?: string | null) => {
    if (browserDemo) return;
    const requestKey = `history:${path}`;
    const requestId = beginRequest(requestKey);
    updateSession(path, (session) => ({ ...session, loading: { ...session.loading, history: true } }));
    try {
      const session = sessionsRef.current[path];
      const skip = reset ? 0 : session?.commits.length ?? 0;
      const page = await api.loadHistory(path, skip, HISTORY_PAGE_SIZE);
      if (!isLatestRequest(requestKey, requestId)) return;
      updateSession(path, (current) => {
        const commits = reset
          ? page
          : [...current.commits, ...page.filter((commit) => !current.commits.some((existing) => existing.oid === commit.oid))];
        const selectedCommitOid = current.selectedCommitOid && (commits.some((commit) => commit.oid === current.selectedCommitOid) || !!current.commitDetails[current.selectedCommitOid])
          ? current.selectedCommitOid
          : null;
        return {
          ...current,
          commits,
          selectedCommitOid,
          selectedCommitFile: selectedCommitOid ? current.selectedCommitFile : null,
          commitDiffKey: selectedCommitOid ? current.commitDiffKey : null,
          historyHead: reset ? head ?? null : current.historyHead,
          historyHasMore: page.length === HISTORY_PAGE_SIZE,
          loading: { ...current.loading, history: false },
        };
      });
    } catch (error) {
      if (!isLatestRequest(requestKey, requestId)) return;
      updateSession(path, (session) => ({ ...session, loading: { ...session.loading, history: false } }));
      setNotice(String(error));
    }
  }, [beginRequest, isLatestRequest, updateSession]);

  const loadWorkingDiff = useCallback(async (path: string, file: ChangedFile, force = false) => {
    const key = changedFileKey(file);
    const current = sessionsRef.current[path];
    if (!force && current?.diffCache[key]) {
      updateSession(path, (session) => {
        const diffSelections = { ...session.diffSelections };
        if (session.workingDiffKey) {
          diffSelections[session.workingDiffKey] = { hunks: session.selectedHunks, lines: session.selectedLines };
        }
        const restored = diffSelections[key] ?? { hunks: new Set<string>(), lines: new Set<string>() };
        return {
          ...session,
          selectedFileKey: key,
          workingDiffKey: key,
          selectedHunks: new Set(restored.hunks),
          selectedLines: new Set(restored.lines),
          diffSelections,
          actionError: null,
        };
      });
      return;
    }
    const oldDiff = current?.workingDiffKey ? current.diffCache[current.workingDiffKey] : undefined;
    const oldLines = current?.selectedLines ?? new Set<string>();
    const oldHunks = current?.selectedHunks ?? new Set<string>();
    const requestKey = `working-diff:${path}`;
    const requestId = beginRequest(requestKey);
    updateSession(path, (session) => ({
      ...session,
      selectedFileKey: key,
      workingDiffKey: force ? session.workingDiffKey : null,
      selectedHunks: force ? session.selectedHunks : new Set(),
      selectedLines: force ? session.selectedLines : new Set(),
      diffSelections: session.workingDiffKey ? {
        ...session.diffSelections,
        [session.workingDiffKey]: { hunks: session.selectedHunks, lines: session.selectedLines },
      } : session.diffSelections,
      actionError: null,
      loading: { ...session.loading, diff: true },
    }));
    try {
      const raw = browserDemo ? sampleDiff : await api.loadDiff(path, file.path, file.section, undefined, file.oldPath);
      if (!isLatestRequest(requestKey, requestId)) return;
      const document = parseDiff(raw);
      updateSession(path, (session) => {
        const cached = putBounded(session.diffCache, session.diffOrder, key, document, DIFF_CACHE_LIMIT);
        const stillSelected = session.selectedFileKey === key;
        const selectedLines = stillSelected && force ? restoreLineSelection(oldDiff, oldLines, document) : session.selectedLines;
        const selectedHunks = stillSelected && force ? restoreHunkSelection(oldDiff, oldHunks, document) : session.selectedHunks;
        const retainedSelections = Object.fromEntries(
          Object.entries(session.diffSelections).filter(([selectionKey]) => cached.order.includes(selectionKey)),
        );
        return {
          ...session,
          diffCache: cached.cache,
          diffOrder: cached.order,
          staleDiffKeys: session.staleDiffKeys.filter((staleKey) => staleKey !== key),
          workingDiffKey: stillSelected ? key : session.workingDiffKey,
          selectedLines,
          selectedHunks,
          diffSelections: stillSelected ? {
            ...retainedSelections,
            [key]: { hunks: selectedHunks, lines: selectedLines },
          } : retainedSelections,
          loading: { ...session.loading, diff: false },
        };
      });
    } catch (error) {
      if (!isLatestRequest(requestKey, requestId)) return;
      updateSession(path, (session) => ({
        ...session,
        workingDiffKey: null,
        actionError: String(error),
        loading: { ...session.loading, diff: false },
      }));
    }
  }, [beginRequest, isLatestRequest, updateSession]);

  const refreshRepository = useCallback(async (path: string, auto = false) => {
    if (browserDemo) return repositoriesRef.current.find((repository) => repository.path === path) ?? null;
    const requestKey = `status:${path}`;
    const requestId = beginRequest(requestKey);
    updateSession(path, (session) => ({ ...session, loading: { ...session.loading, status: true } }));
    try {
      const repository = await api.loadRepository(path);
      if (!isLatestRequest(requestKey, requestId)) return null;
      replaceRepository(repository);
      const previous = sessionsRef.current[path];
      const selectedFile = previous?.selectedFileKey
        ? repository.changes.find((file) => changedFileKey(file) === previous.selectedFileKey)
        : undefined;
      const selectedKey = selectedFile ? changedFileKey(selectedFile) : null;
      const isLarge = (key: string) => (previous?.diffCache[key]?.raw.length ?? 0) > AUTO_REFRESH_DIFF_LIMIT;
      // Auto-refresh keeps large cached diffs (marked stale) to stay fast; a manual refresh drops everything but the selected file.
      const currentKeys = new Set(repository.changes.map(changedFileKey));
      const keptKeys = (previous?.diffOrder ?? []).filter((key) => currentKeys.has(key) && (key === selectedKey || (auto && isLarge(key))));
      const staleKeys = auto ? keptKeys.filter(isLarge) : [];
      const reloadSelected = !!selectedFile && !(auto && selectedKey && isLarge(selectedKey));
      updateSession(path, (session) => ({
        ...session,
        diffCache: Object.fromEntries(keptKeys.filter((key) => session.diffCache[key]).map((key) => [key, session.diffCache[key]])),
        diffOrder: keptKeys.filter((key) => session.diffCache[key]),
        staleDiffKeys: staleKeys,
        selectedFileKey: selectedKey,
        workingDiffKey: selectedFile ? session.workingDiffKey : null,
        selectedHunks: selectedFile ? session.selectedHunks : new Set(),
        selectedLines: selectedFile ? session.selectedLines : new Set(),
        actionError: null,
        loading: { ...session.loading, status: false },
      }));
      if (previous?.historyHead === undefined || previous.historyHead !== repository.head) {
        void loadHistoryPage(path, true, repository.head);
      }
      if (selectedFile && reloadSelected) void loadWorkingDiff(path, selectedFile, true);
      return repository;
    } catch (error) {
      if (!isLatestRequest(requestKey, requestId)) return null;
      const cached = repositoriesRef.current.find((repository) => repository.path === path);
      if (cached) replaceRepository({ ...cached, error: String(error) });
      updateSession(path, (session) => ({ ...session, loading: { ...session.loading, status: false } }));
      setNotice(String(error));
      return null;
    }
  }, [beginRequest, isLatestRequest, loadHistoryPage, loadWorkingDiff, replaceRepository, updateSession]);

  const loadCommitDetails = useCallback(async (path: string, commit: CommitSummary) => {
    const existing = sessionsRef.current[path]?.commitDetails[commit.oid];
    if (existing) return;
    const requestKey = `commit:${path}`;
    const requestId = beginRequest(requestKey);
    updateSession(path, (session) => ({ ...session, loading: { ...session.loading, commit: true } }));
    try {
      const details = browserDemo ? sampleCommitDetails[commit.oid] : await api.loadCommit(path, commit.oid);
      if (!details || !isLatestRequest(requestKey, requestId)) return;
      updateSession(path, (session) => {
        const cached = putBounded(session.commitDetails, session.commitOrder, commit.oid, details, COMMIT_CACHE_LIMIT);
        return {
          ...session,
          commitDetails: cached.cache,
          commitOrder: cached.order,
          loading: { ...session.loading, commit: false },
        };
      });
    } catch (error) {
      if (!isLatestRequest(requestKey, requestId)) return;
      updateSession(path, (session) => ({ ...session, loading: { ...session.loading, commit: false } }));
      setNotice(String(error));
    }
  }, [beginRequest, isLatestRequest, updateSession]);

  const loadCommitDiff = useCallback(async (path: string, commit: CommitSummary, file: ChangedFile) => {
    const key = commitFileKey(commit.oid, file);
    const current = sessionsRef.current[path];
    if (current?.commitDiffCache[key]) {
      updateSession(path, (session) => ({ ...session, selectedCommitFile: file, commitDiffKey: key }));
      return;
    }
    const requestKey = `commit-diff:${path}`;
    const requestId = beginRequest(requestKey);
    updateSession(path, (session) => ({
      ...session,
      selectedCommitFile: file,
      commitDiffKey: null,
      loading: { ...session.loading, commitDiff: true },
    }));
    try {
      const raw = browserDemo ? sampleDiff : await api.loadDiff(path, file.path, "commit", commit.oid, file.oldPath);
      if (!isLatestRequest(requestKey, requestId)) return;
      const document = parseDiff(raw);
      updateSession(path, (session) => {
        const cached = putBounded(session.commitDiffCache, session.commitDiffOrder, key, document, DIFF_CACHE_LIMIT);
        const stillSelected = session.selectedCommitOid === commit.oid && session.selectedCommitFile?.path === file.path;
        return {
          ...session,
          commitDiffCache: cached.cache,
          commitDiffOrder: cached.order,
          commitDiffKey: stillSelected ? key : session.commitDiffKey,
          loading: { ...session.loading, commitDiff: false },
        };
      });
    } catch (error) {
      if (!isLatestRequest(requestKey, requestId)) return;
      updateSession(path, (session) => ({
        ...session,
        commitDiffKey: null,
        loading: { ...session.loading, commitDiff: false },
      }));
      setNotice(String(error));
    }
  }, [beginRequest, isLatestRequest, updateSession]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    if (browserDemo || started.current) return;
    started.current = true;
    void api.checkGit().then(async (version) => {
      setGitVersion(version);
      if (!version.available) { setInitializing(false); return; }
      let saved: string[] = [];
      try { saved = JSON.parse(localStorage.getItem("repositories") || "[]"); }
      catch { localStorage.removeItem("repositories"); }
      const loaded = await Promise.allSettled(saved.map(api.loadRepository));
      const restored = loaded.map((result, index) => result.status === "fulfilled"
        ? result.value
        : unavailableRepository(saved[index], result.reason));
      repositoriesRef.current = restored;
      setRepositories(restored);
      const restoredSessions = Object.fromEntries(restored.map((repository) => [repository.path, createSession(repository)]));
      sessionsRef.current = restoredSessions;
      setSessions(restoredSessions);
      const preferred = localStorage.getItem("active-repository");
      const active = restored.find((repository) => repository.path === preferred) ?? restored.find((repository) => !repository.error) ?? restored[0];
      if (active) {
        setActivePath(active.path);
        activePathRef.current = active.path;
        if (!active.error) void loadHistoryPage(active.path, true, active.head);
      }
      setRestoredRepositories(true);
      setInitializing(false);
    }).catch((error) => {
      setGitVersion({ available: false, error: String(error) });
      setInitializing(false);
    });
  }, [loadHistoryPage, startupAttempt]);

  useEffect(() => {
    if (!browserDemo && restoredRepositories) localStorage.setItem("repositories", JSON.stringify(repositories.map((repository) => repository.path)));
  }, [repositories, restoredRepositories]);

  useEffect(() => {
    if (browserDemo) return;
    const onFocus = () => {
      window.clearTimeout(focusTimer.current);
      focusTimer.current = window.setTimeout(() => {
        const path = activePathRef.current;
        if (path) void refreshRepository(path, true);
      }, 250);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearTimeout(focusTimer.current);
    };
  }, [refreshRepository]);

  const active = repositories.find((repository) => repository.path === activePath) ?? repositories[0];
  const session = active ? sessions[active.path] ?? createSession(active) : null;
  const selectedFile = active && session?.selectedFileKey
    ? active.changes.find((file) => changedFileKey(file) === session.selectedFileKey) ?? null
    : null;
  const workingDiff = session?.workingDiffKey ? session.diffCache[session.workingDiffKey] : undefined;
  const selectedCommit = session?.selectedCommitOid
    ? session.commits.find((commit) => commit.oid === session.selectedCommitOid) ?? session.commitDetails[session.selectedCommitOid] ?? null
    : null;
  const selectedCommitDetails = selectedCommit ? session?.commitDetails[selectedCommit.oid] : undefined;
  const selectedCommitDiff = session?.commitDiffKey ? session.commitDiffCache[session.commitDiffKey] : undefined;
  const hidePatterns = session?.hidePatterns;
  const hideMatchers = useMemo(() => compilePatterns(hidePatterns ?? []), [hidePatterns]);
  const hiding = !!session?.hideEnabled && hideMatchers.length > 0;
  const hiddenFiles = hiding && active ? active.changes.filter((file) => isHidden(file, hideMatchers)) : [];
  const selectedHidden = hiding && !!selectedFile && isHidden(selectedFile, hideMatchers);

  useEffect(() => {
    if (!selectedHidden || !active) return;
    updateSession(active.path, (current) => ({
      ...current,
      selectedFileKey: null,
      workingDiffKey: null,
      selectedHunks: new Set(),
      selectedLines: new Set(),
    }));
  }, [active, selectedHidden, updateSession]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !active || !session) return;
      if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        void refreshRepository(active.path);
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        const selector = session.view === "changes" ? "[data-file-filter]" : "[data-commit-filter]";
        document.querySelector<HTMLInputElement>(selector)?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, refreshRepository, session]);

  async function addRepository() {
    if (browserDemo) { setNotice("Repository picker is available in the desktop application"); return; }
    const path = await open({ directory: true, multiple: false, title: "Open Git repository" });
    if (!path) return;
    try {
      const repository = await api.loadRepository(path);
      replaceRepository(repository);
      if (!sessionsRef.current[repository.path]) updateSession(repository.path, () => createSession(repository));
      selectRepository(repository);
    } catch (error) { setNotice(String(error)); }
  }

  function selectRepository(repository: Repository) {
    if (repository.path !== activePathRef.current) {
      setActivePath(repository.path);
      activePathRef.current = repository.path;
      localStorage.setItem("active-repository", repository.path);
    }
    if (!sessionsRef.current[repository.path]) updateSession(repository.path, () => createSession(repository));
    if (!repository.error) void refreshRepository(repository.path);
  }

  function removeRepository(path: string) {
    const current = repositoriesRef.current;
    const index = current.findIndex((repository) => repository.path === path);
    const next = current.filter((repository) => repository.path !== path);
    clearHideRules(path);
    repositoriesRef.current = next;
    setRepositories(next);
    setSessions((items) => {
      const remaining = { ...items };
      delete remaining[path];
      sessionsRef.current = remaining;
      return remaining;
    });
    if (activePathRef.current === path) {
      const replacement = next[Math.min(index, Math.max(0, next.length - 1))];
      const replacementPath = replacement?.path ?? "";
      setActivePath(replacementPath);
      activePathRef.current = replacementPath;
      if (replacementPath) localStorage.setItem("active-repository", replacementPath);
      else localStorage.removeItem("active-repository");
    }
  }

  function selectFile(file: ChangedFile) {
    if (!active) return;
    void loadWorkingDiff(active.path, file);
  }

  async function fileAction(action: "stage" | "unstage" | "discard" | "trash") {
    if (!active || !session || !selectedFile) return;
    if (action === "discard" && !window.confirm(`Discard unstaged changes to ${selectedFile.path}? This cannot be undone.`)) return;
    if (action === "trash" && !browserDemo) {
      try {
        const info = await api.trashInfo(active.path, selectedFile.path);
        if (info.containsNestedRepository) {
          setNotice("Git Tempo will not move this directory because it contains a nested Git repository.");
          return;
        }
        const description = info.isDirectory
          ? `${selectedFile.path} and its ${info.entryCount} contained file${info.entryCount === 1 ? "" : "s"}`
          : selectedFile.path;
        if (!window.confirm(`Move ${description} to ${navigator.userAgent.includes("Windows") ? "Recycle Bin" : "Trash"}?`)) return;
      } catch (error) { setNotice(String(error)); return; }
    }
    if (browserDemo) { setNotice(`${action[0].toUpperCase()}${action.slice(1)} is ready in the desktop app`); return; }
    updateSession(active.path, (current) => ({ ...current, actionError: null, loading: { ...current.loading, action: true } }));
    try {
      await api.changeFile(active.path, selectedFile.path, selectedFile.oldPath, selectedFile.section, action);
      await refreshRepository(active.path);
    } catch (error) {
      updateSession(active.path, (current) => ({ ...current, actionError: String(error) }));
    } finally {
      updateSession(active.path, (current) => ({ ...current, loading: { ...current.loading, action: false } }));
    }
  }

  async function discardAllChanges() {
    if (!active || !session) return;
    const hiddenTracked = new Set(hiddenFiles.filter((file) => file.section !== "untracked").map((file) => file.path)).size;
    const hiddenNote = hiddenTracked > 0 ? ` This includes ${hiddenTracked} hidden file${hiddenTracked === 1 ? "" : "s"}.` : "";
    const confirmed = window.confirm(
      `Discard all staged and unstaged changes in ${active.name} and reset to ${active.branch} HEAD? This cannot be undone. Untracked files will be kept.${hiddenNote}`,
    );
    if (!confirmed) return;
    if (browserDemo) { setNotice("Discard all changes is ready in the desktop app"); return; }
    updateSession(active.path, (current) => ({ ...current, actionError: null, loading: { ...current.loading, action: true } }));
    try {
      await api.resetRepository(active.path);
      await refreshRepository(active.path);
      setNotice("All staged and unstaged changes discarded");
    } catch (error) {
      const message = String(error);
      updateSession(active.path, (current) => ({ ...current, actionError: message }));
      setNotice(message);
    } finally {
      updateSession(active.path, (current) => ({ ...current, loading: { ...current.loading, action: false } }));
    }
  }

  async function applySelection(selectedHunks: Set<string>, selectedLines: Set<string>) {
    if (!active || !session || !selectedFile || !workingDiff) return;
    const patch = selectedLines.size
      ? patchForLines(workingDiff, selectedLines, selectedFile.section === "staged")
      : patchForHunks(workingDiff, selectedHunks);
    if (!patch) return;
    if (browserDemo) {
      setNotice(`${selectedFile.section === "staged" ? "Unstaged" : "Staged"} ${selectedLines.size || selectedHunks.size} selected ${selectedLines.size ? "lines" : "hunks"}`);
      return;
    }
    updateSession(active.path, (current) => ({ ...current, actionError: null, loading: { ...current.loading, action: true } }));
    try {
      await api.applyPatch(
        active.path,
        selectedFile.path,
        selectedFile.oldPath,
        selectedFile.section,
        workingDiff.raw,
        patch,
        selectedFile.section === "staged",
      );
      updateSession(active.path, (current) => ({
        ...current,
        selectedHunks: new Set(),
        selectedLines: new Set(),
        diffSelections: current.workingDiffKey ? {
          ...current.diffSelections,
          [current.workingDiffKey]: { hunks: new Set(), lines: new Set() },
        } : current.diffSelections,
      }));
      await refreshRepository(active.path);
    } catch (error) {
      const message = String(error);
      updateSession(active.path, (current) => ({ ...current, actionError: message }));
      if (message.includes("changed after this diff was loaded")) void loadWorkingDiff(active.path, selectedFile, true);
    } finally {
      updateSession(active.path, (current) => ({ ...current, loading: { ...current.loading, action: false } }));
    }
  }

  function applySelected() {
    if (!session) return;
    void applySelection(session.selectedHunks, session.selectedLines);
  }

  function selectCommit(commit: CommitSummary) {
    if (!active) return;
    updateSession(active.path, (current) => ({
      ...current,
      selectedCommitOid: commit.oid,
      selectedCommitFile: null,
      commitDiffKey: null,
    }));
    void loadCommitDetails(active.path, commit);
  }

  function selectCommitFile(file: ChangedFile) {
    if (!active || !selectedCommit) return;
    void loadCommitDiff(active.path, selectedCommit, file);
  }

  function applyHideRules() {
    if (!active || !session) return;
    const { patterns, errors } = compileRules(session.hideDraft);
    if (errors.length) {
      updateSession(active.path, (current) => ({ ...current, hideErrors: errors }));
      return;
    }
    const enabled = patterns.length > 0 && (session.hidePatterns.length === 0 || session.hideEnabled);
    saveHideRules(active.path, { patterns, enabled });
    updateSession(active.path, (current) => ({
      ...current,
      hidePatterns: patterns,
      hideEnabled: enabled,
      hideErrors: [],
    }));
    setNotice(patterns.length ? `Hiding rules applied (${patterns.length} pattern${patterns.length === 1 ? "" : "s"})` : "Hiding rules cleared");
  }

  function toggleHide() {
    if (!active || !session) return;
    const enabled = !session.hideEnabled;
    saveHideRules(active.path, { patterns: session.hidePatterns, enabled });
    updateSession(active.path, (current) => ({ ...current, hideEnabled: enabled }));
  }

  function setView(view: View) {
    if (!active) return;
    updateSession(active.path, (current) => ({ ...current, view }));
    if (view === "history" && session?.historyHead === undefined && !active.error) {
      void loadHistoryPage(active.path, true, active.head);
    }
  }

  const rotateTheme = () => setTheme((current) => current === "system" ? "light" : current === "light" ? "dark" : "system");

  const retryGit = () => {
    setInitializing(true);
    setGitVersion(null);
    started.current = false;
    setStartupAttempt((attempt) => attempt + 1);
  };

  if (gitVersion && !gitVersion.available) return <GitMissing error={gitVersion.error} onRetry={retryGit}/>;
  if (!gitVersion || initializing) return <BootScreen/>;

  const fileQuery = session?.fileFilter.trim().toLocaleLowerCase() ?? "";
  const visibleFiles = active?.changes.filter((file) => !(hiding && isHidden(file, hideMatchers)) && file.path.toLocaleLowerCase().includes(fileQuery)) ?? [];
  const grouped = {
    staged: visibleFiles.filter((file) => file.section === "staged"),
    unstaged: visibleFiles.filter((file) => file.section === "unstaged"),
    untracked: visibleFiles.filter((file) => file.section === "untracked"),
  };

  return <div className="app-shell" ref={appShell}>
    <aside className={`sidebar ${sidebarOpen ? "" : "collapsed"}`}>
      <div className="brand"><div className="brand-mark"><GitBranch size={17}/></div>{sidebarOpen && <><strong>Git Tempo</strong><span className="beta">BETA</span></>}<button className="icon-button collapse" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Toggle sidebar"><ChevronsLeft size={16}/></button></div>
      {sidebarOpen && <div className="side-heading"><span>REPOSITORIES</span><button onClick={addRepository} aria-label="Open repository"><Plus size={15}/></button></div>}
      <div className="repository-list">
        {repositories.map((repository) => {
          const repositorySession = sessions[repository.path];
          const dirty = new Set(repository.changes.map((file) => file.path)).size;
          const tooltip = `${repository.name}\n${repository.path}\n${repository.branch} · ${dirty} changed file${dirty === 1 ? "" : "s"}`;
          return <div className={`repository-entry ${repository.path === active?.path ? "active" : ""}`} key={repository.path}>
            <button title={tooltip} className="repository" onClick={() => selectRepository(repository)}>
              <span className="repo-icon">{repository.error ? <CircleAlert size={14}/> : repository.name.slice(0, 1).toUpperCase()}</span>
              {sidebarOpen && <span className="repo-copy"><strong>{repository.name}</strong><small><GitBranch size={11}/>{repository.branch}</small></span>}
              {repositorySession?.loading.status && <LoaderCircle className="spin repository-loading" size={13}/>}
              {sidebarOpen && !repository.error && dirty > 0 && <span className="count">{dirty}</span>}
            </button>
            {sidebarOpen && <button className="remove-repository" aria-label={`Remove ${repository.name}`} title="Remove from sidebar" onClick={() => removeRepository(repository.path)}><X size={13}/></button>}
          </div>;
        })}
      </div>
      <button className="open-repo" onClick={addRepository}><Plus size={16}/>{sidebarOpen && "Open repository"}</button>
      <div className="sidebar-footer"><div className="user-button"><span>LC</span>{sidebarOpen && <div><strong>Local repositories</strong><small>Stored on this device</small></div>}</div></div>
    </aside>

    <main>
      <header className="topbar">
        <button className="mobile-menu icon-button" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Toggle sidebar"><Menu size={18}/></button>
        <div className="repo-title"><div className="title-icon">{active?.name.slice(0, 1).toUpperCase() || <Box/>}</div><div><h1>{active?.name ?? "Open a repository"}</h1><span>{active?.path ?? "Choose a local Git working tree"}</span></div></div>
        {active && !active.error && <div className="branch-pill"><GitBranch size={14}/><strong>{active.branch === "(detached)" ? "Detached HEAD" : active.branch}</strong>{active.ahead > 0 && <span>↑{active.ahead}</span>}{active.behind > 0 && <span>↓{active.behind}</span>}</div>}
        <div className="top-actions"><button className="icon-button" onClick={rotateTheme} aria-label={`Theme: ${theme}`} title={`Theme: ${theme}`}>{theme === "dark" ? <Moon size={17}/> : theme === "light" ? <Sun size={17}/> : <CircleDot size={17}/>}</button><button className="discard-all-button" disabled={!active || !!active.error || !active.head || !active.changes.some((file) => file.section !== "untracked") || session?.loading.action || session?.loading.status} onClick={() => void discardAllChanges()}><Trash2 size={15}/>Discard all</button><button className="refresh-button" disabled={!active || !!active.error || !selectedFile || session?.loading.diff || session?.loading.action} title="Reload the diff of the selected file" onClick={() => active && selectedFile && void loadWorkingDiff(active.path, selectedFile, true)}><RefreshCw className={session?.loading.diff ? "spin" : ""} size={15}/>Refresh file</button><button className="refresh-button" disabled={!active || !!active.error || session?.loading.status || session?.loading.action} onClick={() => active && void refreshRepository(active.path)}><RefreshCw className={session?.loading.status ? "spin" : ""} size={15}/>Refresh all <kbd>⌘R</kbd></button></div>
      </header>

      <nav className="tabs"><button className={session?.view === "changes" ? "active" : ""} onClick={() => setView("changes")}><Code2 size={16}/>Local changes{active && <span>{new Set(active.changes.map((file) => file.path)).size}</span>}</button><button className={session?.view === "history" ? "active" : ""} onClick={() => setView("history")}><History size={16}/>History</button><button className={`settings-tab ${session?.view === "settings" ? "active" : ""}`} onClick={() => setView("settings")}><Settings size={16}/>Settings{!!session?.hidePatterns.length && <i className="settings-dot" aria-label="Hiding rules configured"/>}</button></nav>

      {!active ? <EmptyState onOpen={addRepository}/>
        : active.error ? <RepositoryUnavailable repository={active} onRetry={() => void refreshRepository(active.path)} onRemove={() => removeRepository(active.path)}/>
        : !session ? <BootScreen/>
        : session.view === "changes" ? <ResizableWorkspace
          className="changes-workspace"
          sizes={session.changesPaneSizes}
          minSizes={[220, 320]}
          onSizesChange={(changesPaneSizes) => updateSession(active.path, (current) => ({ ...current, changesPaneSizes }))}
        >
          <ChangeList
            grouped={grouped}
            staleKeys={session.staleDiffKeys}
            selected={selectedFile}
            filter={session.fileFilter}
            scrollTop={session.fileScrollTop}
            hideAvailable={hideMatchers.length > 0}
            hideEnabled={session.hideEnabled}
            hiddenCount={hiddenFiles.length}
            onToggleHide={toggleHide}
            onOpenSettings={() => setView("settings")}
            onFilter={(fileFilter) => updateSession(active.path, (current) => ({ ...current, fileFilter, fileScrollTop: 0 }))}
            onScroll={(fileScrollTop) => updateSession(active.path, (current) => ({ ...current, fileScrollTop }))}
            onSelect={selectFile}
          />
          <DiffPanel
            stale={!!session.workingDiffKey && session.staleDiffKeys.includes(session.workingDiffKey)}
            diff={workingDiff}
            file={selectedFile}
            loading={session.loading.diff}
            busy={session.loading.action}
            error={session.actionError}
            selectedHunks={session.selectedHunks}
            setSelectedHunks={(selectedHunks) => updateSession(active.path, (current) => ({
              ...current,
              selectedHunks,
              diffSelections: current.workingDiffKey ? {
                ...current.diffSelections,
                [current.workingDiffKey]: { hunks: selectedHunks, lines: current.selectedLines },
              } : current.diffSelections,
            }))}
            selectedLines={session.selectedLines}
            setSelectedLines={(selectedLines) => updateSession(active.path, (current) => ({
              ...current,
              selectedLines,
              diffSelections: current.workingDiffKey ? {
                ...current.diffSelections,
                [current.workingDiffKey]: { hunks: current.selectedHunks, lines: selectedLines },
              } : current.diffSelections,
            }))}
            onApply={applySelected}
            onApplyHunk={(hunkId) => void applySelection(new Set([hunkId]), new Set())}
            onAction={fileAction}
          />
        </ResizableWorkspace> : session.view === "settings" ? <RepositorySettings
          session={session}
          onDraftChange={(hideDraft) => updateSession(active.path, (current) => ({ ...current, hideDraft }))}
          onApply={applyHideRules}
          onRevert={() => updateSession(active.path, (current) => ({ ...current, hideDraft: current.hidePatterns.join("\n"), hideErrors: [] }))}
        /> : <HistoryView
          session={session}
          selected={selectedCommit}
          details={selectedCommitDetails}
          diff={selectedCommitDiff}
          onFilter={(commitFilter) => updateSession(active.path, (current) => ({ ...current, commitFilter, historyScrollTop: 0 }))}
          onScroll={(historyScrollTop) => updateSession(active.path, (current) => ({ ...current, historyScrollTop }))}
          onSelect={selectCommit}
          onSelectFile={selectCommitFile}
          onPaneSizesChange={(historyPaneSizes) => updateSession(active.path, (current) => ({ ...current, historyPaneSizes }))}
          onDiffPaneSizesChange={(historyDiffPaneSizes) => updateSession(active.path, (current) => ({ ...current, historyDiffPaneSizes }))}
          onBackToDetails={() => updateSession(active.path, (current) => ({ ...current, selectedCommitFile: null, commitDiffKey: null }))}
          onLoadMore={() => void loadHistoryPage(active.path, false)}
          onCopyOid={(oid) => void navigator.clipboard.writeText(oid)
            .then(() => setNotice("Commit ID copied"))
            .catch((error) => setNotice(`Could not copy commit ID: ${String(error)}`))}
        />}
    </main>
    {notice && <div className="toast" role="status"><Check size={15}/><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="Dismiss notification"><X size={14}/></button></div>}
  </div>;
}

const RESIZE_HANDLE_WIDTH = 6;

function ResizableWorkspace({ className, sizes, minSizes, onSizesChange, children }: {
  className: string;
  sizes: number[];
  minSizes: number[];
  onSizesChange: (sizes: number[]) => void;
  children: ReactNode;
}) {
  const workspace = useRef<HTMLDivElement>(null);
  const panes = Children.toArray(children);
  const paneCount = panes.length;
  const onSizesChangeRef = useRef(onSizesChange);
  const minSizesRef = useRef(minSizes);
  const drag = useRef<{ index: number; startX: number; sizes: number[] } | null>(null);
  const [activeHandle, setActiveHandle] = useState<number | null>(null);
  onSizesChangeRef.current = onSizesChange;
  minSizesRef.current = minSizes;

  const resizePair = useCallback((index: number, original: number[], deltaPercent: number) => {
    const pairTotal = original[index] + original[index + 1];
    const rect = workspace.current?.getBoundingClientRect();
    const availableWidth = Math.max(1, (rect?.width || window.innerWidth) - (paneCount - 1) * RESIZE_HANDLE_WIDTH);
    let leftMinimum = minSizesRef.current[index] / availableWidth * 100;
    let rightMinimum = minSizesRef.current[index + 1] / availableWidth * 100;
    if (leftMinimum + rightMinimum > pairTotal) {
      const scale = pairTotal / (leftMinimum + rightMinimum);
      leftMinimum *= scale;
      rightMinimum *= scale;
    }
    const left = Math.max(leftMinimum, Math.min(pairTotal - rightMinimum, original[index] + deltaPercent));
    const next = [...original];
    next[index] = Math.round(left * 1000) / 1000;
    next[index + 1] = Math.round((pairTotal - left) * 1000) / 1000;
    onSizesChangeRef.current(next);
  }, [paneCount]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (!drag.current) return;
      event.preventDefault();
      const rect = workspace.current?.getBoundingClientRect();
      const availableWidth = Math.max(1, (rect?.width || window.innerWidth) - (paneCount - 1) * RESIZE_HANDLE_WIDTH);
      resizePair(drag.current.index, drag.current.sizes, (event.clientX - drag.current.startX) / availableWidth * 100);
    };
    const finishResize = () => {
      drag.current = null;
      setActiveHandle(null);
      document.body.classList.remove("resizing-columns");
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      document.body.classList.remove("resizing-columns");
    };
  }, [paneCount, resizePair]);

  const onHandleKeyDown = (event: ReactKeyboardEvent, index: number) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    resizePair(index, sizes, event.key === "ArrowLeft" ? -2 : 2);
  };
  const columns = sizes.flatMap((size, index) => index === sizes.length - 1 ? [`${size}fr`] : [`${size}fr`, `${RESIZE_HANDLE_WIDTH}px`]).join(" ");

  return <div className={`workspace resizable-workspace ${className}`} ref={workspace} style={{ gridTemplateColumns: columns }}>
    {panes.flatMap((pane, index) => index === panes.length - 1 ? [pane] : [
      pane,
      <div
        className={`resize-handle ${activeHandle === index ? "active" : ""}`}
        key={`resize-${index}`}
        role="separator"
        aria-label={`Resize panels ${index + 1} and ${index + 2}`}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(sizes[index])}
        tabIndex={0}
        onKeyDown={(event) => onHandleKeyDown(event, index)}
        onPointerDown={(event) => {
          event.preventDefault();
          drag.current = { index, startX: event.clientX, sizes: [...sizes] };
          setActiveHandle(index);
          document.body.classList.add("resizing-columns");
        }}
      ><span/></div>,
    ])}
  </div>;
}

function ChangeList({ grouped, staleKeys, selected, filter, scrollTop, hideAvailable, hideEnabled, hiddenCount, onToggleHide, onOpenSettings, onFilter, onScroll, onSelect }: {
  grouped: { staged: ChangedFile[]; unstaged: ChangedFile[]; untracked: ChangedFile[] };
  staleKeys: string[];
  selected: ChangedFile | null;
  filter: string;
  scrollTop: number;
  hideAvailable: boolean;
  hideEnabled: boolean;
  hiddenCount: number;
  onToggleHide: () => void;
  onOpenSettings: () => void;
  onFilter: (value: string) => void;
  onScroll: (value: number) => void;
  onSelect: (file: ChangedFile) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (panel.current && Math.abs(panel.current.scrollTop - scrollTop) > 1) panel.current.scrollTop = scrollTop;
  }, [scrollTop]);
  return <section className="file-panel" ref={panel} onScroll={(event) => onScroll(event.currentTarget.scrollTop)}>
    <div className="panel-toolbar"><div className="search"><Search size={14}/><input data-file-filter aria-label="Filter files" placeholder="Filter files…" value={filter} onChange={(event) => onFilter(event.target.value)}/><kbd>⌘F</kbd></div>{hideAvailable && <button className={`icon-button hide-toggle ${hideEnabled ? "active" : ""}`} aria-pressed={hideEnabled} aria-label="Hide matching files" title={hideEnabled ? "Hiding files matching your rules – click to show all" : "Showing all files – click to hide files matching your rules"} onClick={onToggleHide}>{hideEnabled ? <EyeOff size={15}/> : <Eye size={15}/>}</button>}</div>
    {hideAvailable && hideEnabled && hiddenCount > 0 && <button className="hidden-note" title="Edit hiding rules" onClick={onOpenSettings}><EyeOff size={12}/>{hiddenCount} file{hiddenCount === 1 ? "" : "s"} hidden by rules</button>}
    <ChangeGroup title="Staged changes" files={grouped.staged} selected={selected} staleKeys={staleKeys} onSelect={onSelect} accent="green" filtered={!!filter}/>
    <ChangeGroup title="Changes" files={grouped.unstaged} selected={selected} staleKeys={staleKeys} onSelect={onSelect} accent="amber" filtered={!!filter}/>
    <ChangeGroup title="Untracked files" files={grouped.untracked} selected={selected} staleKeys={staleKeys} onSelect={onSelect} accent="blue" filtered={!!filter}/>
  </section>;
}

function ChangeGroup({ title, files, staleKeys, selected, onSelect, accent, filtered }: { title: string; files: ChangedFile[]; staleKeys: string[]; selected: ChangedFile | null; onSelect: (file: ChangedFile) => void; accent: string; filtered: boolean }) {
  const [expanded, setExpanded] = useState(true);
  return <div className="change-group"><button className="group-title" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? <ChevronDown/> : <ChevronRight/>}<span className={`dot ${accent}`}/><strong>{title}</strong><span className="group-count">{files.length}</span></button>{expanded && <div>{files.length === 0 ? <p className="empty-group">{filtered ? "No matching files" : `No ${title.toLowerCase()}`}</p> : files.map((file) => <button key={changedFileKey(file)} className={`file-row ${selected && changedFileKey(selected) === changedFileKey(file) ? "selected" : ""}`} onClick={() => onSelect(file)}><FileCode2 size={16}/><span><strong>{file.path.split("/").pop()}</strong><small>{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "."}</small></span>{staleKeys.includes(changedFileKey(file)) && <span className="stale-dot" title="Diff may be outdated – use Refresh file" aria-label="Diff may be outdated"/>}<b className={`status ${statusLabel(file.status)}`}>{statusLabel(file.status)}</b></button>)}</div>}</div>;
}

function DiffPanel({ stale, diff, file, loading, busy, error, selectedHunks, setSelectedHunks, selectedLines, setSelectedLines, onApply, onApplyHunk, onAction }: {
  stale?: boolean;
  diff?: DiffDocument;
  file: ChangedFile | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  selectedHunks: Set<string>;
  setSelectedHunks: (value: Set<string>) => void;
  selectedLines: Set<string>;
  setSelectedLines: (value: Set<string>) => void;
  onApply: () => void;
  onApplyHunk: (hunkId: string) => void;
  onAction: (action: "stage" | "unstage" | "discard" | "trash") => void;
}) {
  if (!file) return <section className="diff-panel centered"><File size={32}/><h2>Select a changed file</h2><p>Its diff will be loaded only when you need it.</p></section>;
  if (loading && !diff) return <section className="diff-panel"><DiffSkeleton/></section>;
  const verb = file.section === "staged" ? "Unstage" : "Stage";
  const additions = diff?.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === "add").length ?? 0;
  const deletions = diff?.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === "delete").length ?? 0;
  const interactive = file.section !== "untracked";
  const toggleHunk = (id: string) => { const next = new Set(selectedHunks); if (next.has(id)) next.delete(id); else next.add(id); setSelectedLines(new Set()); setSelectedHunks(next); };
  const toggleLine = (id: string) => { const next = new Set(selectedLines); if (next.has(id)) next.delete(id); else next.add(id); setSelectedHunks(new Set()); setSelectedLines(next); };
  return <section className="diff-panel" aria-busy={loading || busy}>
    <div className="diff-toolbar"><div className="file-breadcrumb"><FileCode2 size={16}/><strong>{file.path.split("/").pop()}</strong><span>{file.path}</span>{loading && <LoaderCircle className="spin" size={13}/>}{stale && <em className="stale-badge" title="This large diff was not reloaded automatically. Use Refresh file.">Outdated</em>}</div><div className="diff-actions"><button className="secondary" disabled={busy} onClick={() => onAction(file.section === "staged" ? "unstage" : "stage")}>{file.section === "staged" ? <Minus/> : <Plus/>}{verb} file</button>{interactive && <button className="primary" disabled={busy || (!selectedHunks.size && !selectedLines.size)} onClick={onApply}>{busy && <LoaderCircle className="spin"/>}{verb} selected</button>}{file.section !== "staged" && <button className="icon-button danger" disabled={busy} title={file.section === "untracked" ? "Move to Trash" : "Discard changes"} aria-label={file.section === "untracked" ? "Move to Trash" : "Discard changes"} onClick={() => onAction(file.section === "untracked" ? "trash" : "discard")}><Trash2 size={16}/></button>}</div></div>
    <div className="diff-stats"><span className="additions">+{additions}</span><span className="deletions">−{deletions}</span><span className="stat-bar" aria-hidden="true"><i style={{ width: `${additions + deletions ? additions / (additions + deletions) * 100 : 0}%` }}/><i style={{ width: `${additions + deletions ? deletions / (additions + deletions) * 100 : 0}%` }}/></span><span>{file.section === "staged" ? "Index vs HEAD" : file.section === "unstaged" ? "Worktree vs index" : "Untracked file"}</span></div>
    {diff?.lineSelectionReason && <div className="selection-note"><CircleAlert size={13}/><span>{diff.lineSelectionReason}</span></div>}
    {error && <div className="inline-error" role="alert"><CircleAlert size={14}/><span>{error}</span></div>}
    <div className="diff-scroll">{!diff || diff.binary ? <div className="binary"><ArchiveRestore/><h3>{diff?.binary ? "Binary file" : "No textual diff"}</h3><p>{diff?.binary ? "Git cannot display a textual diff for this file." : "Git reported no textual changes for this file."}</p></div> : diff.hunks.map((hunk) => <div className="hunk" key={hunk.id}><div className="hunk-header">{interactive && <label><input aria-label={`Select hunk ${hunk.header}`} type="checkbox" checked={selectedHunks.has(hunk.id)} onChange={() => toggleHunk(hunk.id)}/><span/></label>}<code>{hunk.header}</code>{interactive && <button disabled={busy} onClick={() => onApplyHunk(hunk.id)}>{verb} hunk</button>}</div>{hunk.lines.map((line) => <div key={line.id} className={`diff-line ${line.kind}`}><span className="line-select">{interactive && line.selectable && <input aria-label={`${line.kind === "add" ? "Select added" : "Select removed"} line ${line.newNumber ?? line.oldNumber}: ${line.content.slice(1, 80)}`} type="checkbox" checked={selectedLines.has(line.id)} onChange={() => toggleLine(line.id)}/>}</span><span className="line-no">{line.oldNumber}</span><span className="line-no">{line.newNumber}</span><code>{line.content || " "}</code></div>)}</div>)}</div>
  </section>;
}

function RepositorySettings({ session, onDraftChange, onApply, onRevert }: {
  session: RepositorySession;
  onDraftChange: (value: string) => void;
  onApply: () => void;
  onRevert: () => void;
}) {
  const dirty = session.hideDraft.trim() !== session.hidePatterns.join("\n").trim();
  return <section className="settings-panel">
    <div className="settings-section">
      <h2>Hidden files</h2>
      <p>Files matching these patterns are hidden from <strong>Local changes</strong> while hiding is on. Use the eye toggle next to the file filter to show everything again. One gitignore-style glob per line, and lines starting with <code>#</code> are ignored.</p>
      <p className="settings-examples"><code>*.test.ts*</code> matches at any depth · <code>tests/**</code> is relative to the repository root · <code>**/__snapshots__/</code> matches a directory at any depth</p>
      <textarea aria-label="Hidden file patterns" spellCheck={false} placeholder={"*.test.ts*\ntests/**"} value={session.hideDraft} onChange={(event) => onDraftChange(event.target.value)}/>
      {session.hideErrors.length > 0 && <div className="inline-error settings-errors" role="alert"><CircleAlert size={14}/><ul>{session.hideErrors.map((error) => <li key={error.line}>Line {error.line}: {error.message}</li>)}</ul></div>}
      <div className="settings-actions">
        {dirty && <span className="settings-dirty">Unapplied changes</span>}
        {dirty && <button className="secondary" onClick={onRevert}>Revert</button>}
        <button className="primary" disabled={!dirty} onClick={onApply}>Apply</button>
      </div>
    </div>
  </section>;
}

function HistoryView({ session, selected, details, diff, onFilter, onScroll, onSelect, onSelectFile, onPaneSizesChange, onDiffPaneSizesChange, onBackToDetails, onLoadMore, onCopyOid }: {
  session: RepositorySession;
  selected: CommitSummary | null;
  details?: CommitDetails;
  diff?: DiffDocument;
  onFilter: (value: string) => void;
  onScroll: (value: number) => void;
  onSelect: (commit: CommitSummary) => void;
  onSelectFile: (file: ChangedFile) => void;
  onPaneSizesChange: (sizes: number[]) => void;
  onDiffPaneSizesChange: (sizes: number[]) => void;
  onBackToDetails: () => void;
  onLoadMore: () => void;
  onCopyOid: (oid: string) => void;
}) {
  const query = session.commitFilter.trim().toLocaleLowerCase();
  const commits = useMemo(() => session.commits.filter((commit) => `${commit.subject} ${commit.author} ${commit.oid}`.toLocaleLowerCase().includes(query)), [query, session.commits]);
  const showingDiff = !!session.selectedCommitFile && !!selected;
  return <ResizableWorkspace
    className={`history-workspace ${showingDiff ? "showing-diff" : ""}`}
    sizes={showingDiff ? session.historyDiffPaneSizes : session.historyPaneSizes}
    minSizes={showingDiff ? [180, 210, 260] : [260, 320]}
    onSizesChange={showingDiff ? onDiffPaneSizesChange : onPaneSizesChange}
  ><section className="commit-list" aria-busy={session.loading.history}><div className="panel-toolbar"><div className="search"><Search size={14}/><input data-commit-filter aria-label="Filter commits" placeholder="Filter commits…" value={session.commitFilter} onChange={(event) => onFilter(event.target.value)}/></div></div><div className="date-label">ALL REACHABLE COMMITS</div>
    {session.loading.history && session.commits.length === 0 ? <ListSkeleton/> : commits.length === 0 ? <p className="empty-list">{query ? "No matching commits" : "No commits reachable from this branch"}</p> : <VirtualCommitList commits={commits} selected={selected} scrollTop={session.historyScrollTop} hasMore={session.historyHasMore && !query} loading={session.loading.history} onScroll={onScroll} onSelect={onSelect} onLoadMore={onLoadMore}/>}
  </section><CommitDetailsPane session={session} selected={selected} details={details} selectedFile={session.selectedCommitFile} onSelectFile={onSelectFile} onCopyOid={onCopyOid}/>
    {showingDiff && session.selectedCommitFile && selected && <section className="commit-diff-panel"><CommitDiffView commit={selected} file={session.selectedCommitFile} diff={diff} loading={session.loading.commitDiff} onBack={onBackToDetails}/></section>}
  </ResizableWorkspace>;
}

function CommitDetailsPane({ session, selected, details, selectedFile, onSelectFile, onCopyOid }: {
  session: RepositorySession;
  selected: CommitSummary | null;
  details?: CommitDetails;
  selectedFile: ChangedFile | null;
  onSelectFile: (file: ChangedFile) => void;
  onCopyOid: (oid: string) => void;
}) {
  return <section className="commit-detail">
    {!selected ? <div className="commit-placeholder"><History size={32}/><h2>Select a commit</h2><p>Metadata and changed files load only after selection.</p></div>
      : session.loading.commit && !details ? <DetailsSkeleton/>
        : details ? <><div className="commit-heading"><div><span className="eyebrow">COMMIT</span><h2>{details.subject}</h2></div><button className="secondary" onClick={() => onCopyOid(details.oid)} title="Copy full commit ID"><Clipboard size={14}/>{details.shortOid}</button></div>{details.parents.length > 1 && <div className="merge-note"><GitBranch size={13}/>Merge commit · files and diffs are compared with first parent {details.parents[0].slice(0, 7)}</div>}<p className={`commit-message ${details.body ? "" : "muted"}`}>{details.body || "No additional commit message."}</p><div className="metadata"><div className="avatar">{details.author.split(" ").map((part) => part[0]).join("").slice(0, 2)}</div><div><strong>{details.author}</strong><small>{details.email} · {new Date(details.timestamp * 1000).toLocaleString()}</small></div></div><div className="commit-files-title"><strong>Changed files</strong><span>{details.files.length} file{details.files.length === 1 ? "" : "s"}</span></div>{details.files.length === 0 ? <p className="empty-list">No files changed against the first parent.</p> : details.files.map((file) => {
          const isSelected = !!selectedFile && commitFileKey(details.oid, selectedFile) === commitFileKey(details.oid, file);
          return <button className={`commit-file ${isSelected ? "selected" : ""}`} aria-pressed={isSelected} key={`${file.status}:${file.oldPath ?? ""}:${file.path}`} onClick={() => onSelectFile(file)}><FileCode2 size={16}/><span>{file.path}{file.oldPath && <small>renamed from {file.oldPath}</small>}</span><b className={`status ${statusLabel(file.status)}`}>{statusLabel(file.status)}</b><ChevronRight size={14}/></button>;
        })}</> : <div className="inline-error"><CircleAlert size={14}/>Commit details could not be loaded.</div>}
  </section>;
}

function VirtualCommitList({ commits, selected, scrollTop, hasMore, loading, onScroll, onSelect, onLoadMore }: {
  commits: CommitSummary[];
  selected: CommitSummary | null;
  scrollTop: number;
  hasMore: boolean;
  loading: boolean;
  onScroll: (value: number) => void;
  onSelect: (commit: CommitSummary) => void;
  onLoadMore: () => void;
}) {
  const rowHeight = 58;
  const overscan = 6;
  const viewport = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(scrollTop);
  const [height, setHeight] = useState(500);
  useLayoutEffect(() => {
    if (!viewport.current) return;
    viewport.current.scrollTop = scrollTop;
    setHeight(viewport.current.clientHeight || 500);
  }, [scrollTop]);
  useEffect(() => {
    if (!viewport.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  const start = Math.max(0, Math.floor(position / rowHeight) - overscan);
  const end = Math.min(commits.length, Math.ceil((position + height) / rowHeight) + overscan);
  return <div className="commit-scroll" ref={viewport} onScroll={(event) => { const value = event.currentTarget.scrollTop; setPosition(value); onScroll(value); }}><div className="commit-virtual" style={{ height: commits.length * rowHeight }}>{commits.slice(start, end).map((commit, offset) => <button style={{ transform: `translateY(${(start + offset) * rowHeight}px)` }} className={`commit-row ${selected?.oid === commit.oid ? "selected" : ""}`} key={commit.oid} onClick={() => onSelect(commit)}><span className="commit-copy"><strong>{commit.subject}</strong><small>{commit.author} · {timeAgo(commit.timestamp)} ago</small></span><code>{commit.shortOid}</code></button>)}</div>{hasMore && <button className="load-more" disabled={loading} onClick={onLoadMore}>{loading ? <><LoaderCircle className="spin" size={13}/>Loading commits…</> : "Load older commits"}</button>}</div>;
}

function CommitDiffView({ commit, file, diff, loading, onBack }: { commit: CommitSummary; file: ChangedFile; diff?: DiffDocument; loading: boolean; onBack: () => void }) {
  const additions = diff?.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === "add").length ?? 0;
  const deletions = diff?.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === "delete").length ?? 0;
  return <div className="commit-diff"><div className="diff-toolbar"><button className="icon-button" aria-label="Back to commit details" title="Back to commit details" onClick={onBack}><ChevronLeft size={16}/></button><div className="file-breadcrumb"><FileCode2 size={16}/><strong>{file.path.split("/").pop()}</strong><span>{file.path}</span></div><code>{commit.shortOid}</code></div>{commit.parents.length > 1 && <div className="merge-note"><GitBranch size={13}/>Compared with first parent {commit.parents[0].slice(0, 7)}</div>}<div className="diff-stats"><span className="additions">+{additions}</span><span className="deletions">−{deletions}</span><span>Commit diff</span></div>{loading && !diff ? <DiffSkeleton/> : <ReadOnlyDiff diff={diff}/>}</div>;
}

function ReadOnlyDiff({ diff }: { diff?: DiffDocument }) {
  if (!diff || diff.binary || diff.hunks.length === 0) return <div className="binary"><ArchiveRestore/><h3>{diff?.binary ? "Binary file" : "No textual diff"}</h3><p>{diff?.binary ? "Git cannot display a textual diff for this file." : "Git reported no textual changes for this file."}</p></div>;
  return <div className="diff-scroll">{diff.hunks.map((hunk) => <div className="hunk" key={hunk.id}><div className="hunk-header readonly"><code>{hunk.header}</code></div>{hunk.lines.map((line) => <div key={line.id} className={`diff-line readonly ${line.kind}`}><span className="line-no">{line.oldNumber}</span><span className="line-no">{line.newNumber}</span><code>{line.content || " "}</code></div>)}</div>)}</div>;
}

function BootScreen() {
  return <div className="boot-screen"><div className="brand-mark"><GitBranch size={22}/></div><LoaderCircle className="spin"/><span>Finding Git and restoring repositories…</span></div>;
}

function EmptyState({ onOpen }: { onOpen: () => void }) {
  return <div className="empty-state"><div className="empty-art"><Inbox/></div><h2>Open your first repository</h2><p>Git Tempo keeps Git focused: browse changes, shape the index, and understand history without the noise.</p><button className="primary" onClick={onOpen}><Plus/>Open repository</button></div>;
}

function RepositoryUnavailable({ repository, onRetry, onRemove }: { repository: Repository; onRetry: () => void; onRemove: () => void }) {
  return <div className="empty-state"><div className="empty-art error"><CircleAlert/></div><h2>Repository unavailable</h2><p>{repository.error}</p><div className="empty-actions"><button className="primary" onClick={onRetry}><RefreshCw size={14}/>Try again</button><button className="secondary" onClick={onRemove}>Remove from sidebar</button></div></div>;
}

function GitMissing({ error, onRetry }: { error?: string; onRetry: () => void }) {
  const mac = navigator.userAgent.includes("Mac");
  return <div className="git-missing"><div className="brand-mark"><GitBranch size={22}/></div><span className="eyebrow">GIT 2.23+ IS REQUIRED</span><h1>Connect Git Tempo to Git</h1><p>Git Tempo uses the Git installation already on your computer. {mac ? "On macOS, install Xcode Command Line Tools or Git and ensure graphical applications can find it." : "On Windows, install Git for Windows and make it available on PATH."}</p>{error && <code>{error}</code>}<button className="primary" onClick={onRetry}><RefreshCw size={14}/>Check again</button></div>;
}

function ListSkeleton() {
  return <div className="skeleton-list" aria-label="Loading commits">{Array.from({ length: 7 }, (_, index) => <div className="skeleton-row" key={index}><i/><span/></div>)}</div>;
}

function DetailsSkeleton() {
  return <div className="details-skeleton" aria-label="Loading commit details"><i/><i/><i/><i/></div>;
}

function DiffSkeleton() {
  return <div className="diff-skeleton" aria-label="Loading diff"><div/><div/><div/><div/><div/></div>;
}
