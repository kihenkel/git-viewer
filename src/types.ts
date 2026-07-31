export type Theme = "system" | "light" | "dark";
export type ChangeSection = "staged" | "unstaged" | "untracked";

export interface Repository {
  path: string;
  name: string;
  branch: string;
  head: string | null;
  ahead: number;
  behind: number;
  changes: ChangedFile[];
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
  lines: DiffLine[];
}

export interface DiffDocument {
  raw: string;
  header: string[];
  hunks: DiffHunk[];
  binary: boolean;
}

export interface GitVersion {
  available: boolean;
  version?: string;
  error?: string;
}
