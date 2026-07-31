mod git;

use git::{ChangeAction, GitService};

#[tauri::command]
fn check_git() -> git::GitVersion {
    GitService::check()
}

#[tauri::command]
fn load_repository(path: String) -> Result<git::Repository, String> {
    GitService::repository(&path)
}

#[tauri::command]
fn load_history(
    path: String,
    skip: usize,
    limit: usize,
) -> Result<Vec<git::CommitSummary>, String> {
    GitService::history(&path, skip, limit.min(250))
}

#[tauri::command]
fn load_commit(path: String, oid: String) -> Result<git::CommitDetails, String> {
    GitService::commit(&path, &oid)
}

#[tauri::command]
fn load_diff(
    path: String,
    file: String,
    section: String,
    oid: Option<String>,
) -> Result<String, String> {
    GitService::diff(&path, &file, &section, oid.as_deref())
}

#[tauri::command]
fn change_file(path: String, file: String, action: ChangeAction) -> Result<(), String> {
    GitService::change_file(&path, &file, action)
}

#[tauri::command]
fn apply_patch(path: String, patch: String, reverse: bool) -> Result<(), String> {
    GitService::apply_patch(&path, patch.as_bytes(), reverse)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            check_git,
            load_repository,
            load_history,
            load_commit,
            load_diff,
            change_file,
            apply_patch
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Tempo");
}
