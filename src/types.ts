export type Theme = "system" | "light" | "dark";
export type ChangeSection = "staged" | "unstaged" | "untracked" | "commit";

export interface Repository {
  path: string;
  name: string;
  branch: string;
  head: string | null;
  ahead: number;
  behind: number;
  changes: ChangedFile[];
  error?: string;
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: string;
  section: ChangeSection;
}

export interface CommitSummary {
  oid: string;
  shortOid: string;
  parents: string[];
  subject: string;
  author: string;
  timestamp: number;
  refs: string[];
}

export interface CommitDetails extends CommitSummary {
  body: string;
  email: string;
  files: ChangedFile[];
}

export interface DiffLine {
  id: string;
  kind: "add" | "delete" | "context" | "meta";
  content: string;
  oldNumber?: number;
  newNumber?: number;
  selectable: boolean;
}

export interface DiffHunk {
  id: string;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffDocument {
  raw: string;
  header: string[];
  hunks: DiffHunk[];
  binary: boolean;
  lineSelectionReason?: string;
}

export interface GitVersion {
  available: boolean;
  version?: string;
  error?: string;
}

export interface TrashInfo {
  isDirectory: boolean;
  entryCount: number;
  containsNestedRepository: boolean;
}
