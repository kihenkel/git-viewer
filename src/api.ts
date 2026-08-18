import { invoke } from "@tauri-apps/api/core";
import type { ChangeSection, CommitDetails, CommitSummary, GitVersion, Repository, TrashInfo } from "./types";

const inTauri = () => "__TAURI_INTERNALS__" in window;

export async function checkGit(): Promise<GitVersion> {
  return inTauri() ? invoke("check_git") : { available: true, version: "git version 2.45.2" };
}

export async function loadRepository(path: string): Promise<Repository> {
  return invoke("load_repository", { path });
}

export async function loadHistory(path: string, skip = 0, limit = 100): Promise<CommitSummary[]> {
  return invoke("load_history", { path, skip, limit });
}

export async function loadCommit(path: string, oid: string): Promise<CommitDetails> {
  return invoke("load_commit", { path, oid });
}

export async function loadDiff(path: string, file: string, section: ChangeSection, oid?: string, oldFile?: string): Promise<string> {
  return invoke("load_diff", { path, file, oldFile: oldFile ?? null, section, oid: oid ?? null });
}

export async function changeFile(path: string, file: string, oldFile: string | undefined, section: ChangeSection, action: "stage" | "unstage" | "discard" | "trash"): Promise<void> {
  return invoke("change_file", { path, file, oldFile: oldFile ?? null, section, action });
}

export async function resetRepository(path: string): Promise<void> {
  return invoke("reset_repository", { path });
}

export async function trashInfo(path: string, file: string): Promise<TrashInfo> {
  return invoke("trash_info", { path, file });
}

export async function applyPatch(path: string, file: string, oldFile: string | undefined, section: ChangeSection, expectedDiff: string, patch: string, reverse: boolean): Promise<void> {
  return invoke("apply_patch", { path, file, oldFile: oldFile ?? null, section, expectedDiff, patch, reverse });
}
