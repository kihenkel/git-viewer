mod git;

use git::{ChangeAction, GitService};

#[tauri::command]
async fn check_git() -> git::GitVersion {
    match tauri::async_runtime::spawn_blocking(GitService::check).await {
        Ok(version) => version,
        Err(error) => git::GitVersion {
            available: false,
            version: None,
            error: Some(format!("Could not check Git: {error}")),
        },
    }
}

#[tauri::command]
async fn load_repository(path: String) -> Result<git::Repository, String> {
    run_blocking(move || GitService::repository(&path)).await?
}

#[tauri::command]
async fn load_history(
    path: String,
    skip: usize,
    limit: usize,
) -> Result<Vec<git::CommitSummary>, String> {
    run_blocking(move || GitService::history(&path, skip, limit.min(250))).await?
}

#[tauri::command]
async fn load_commit(path: String, oid: String) -> Result<git::CommitDetails, String> {
    run_blocking(move || GitService::commit(&path, &oid)).await?
}

#[tauri::command]
async fn load_diff(
    path: String,
    file: String,
    old_file: Option<String>,
    section: String,
    oid: Option<String>,
) -> Result<String, String> {
    run_blocking(move || {
        GitService::diff(&path, &file, &section, oid.as_deref(), old_file.as_deref())
    })
    .await?
}

#[tauri::command]
async fn change_file(
    path: String,
    file: String,
    old_file: Option<String>,
    section: String,
    action: ChangeAction,
) -> Result<(), String> {
    run_blocking(move || {
        GitService::change_file(&path, &file, old_file.as_deref(), &section, action)
    })
    .await?
}

#[tauri::command]
async fn reset_repository(path: String) -> Result<(), String> {
    run_blocking(move || GitService::reset_repository(&path)).await?
}

#[tauri::command]
async fn trash_info(path: String, file: String) -> Result<git::TrashInfo, String> {
    run_blocking(move || GitService::trash_info(&path, &file)).await?
}

#[tauri::command]
async fn apply_patch(
    path: String,
    file: String,
    old_file: Option<String>,
    section: String,
    expected_diff: String,
    patch: String,
    reverse: bool,
) -> Result<(), String> {
    run_blocking(move || {
        GitService::apply_patch(
            &path,
            &file,
            old_file.as_deref(),
            &section,
            &expected_diff,
            patch.as_bytes(),
            reverse,
        )
    })
    .await?
}

async fn run_blocking<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("Background task failed: {error}"))
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
            reset_repository,
            trash_info,
            apply_patch
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Git Tempo");
}
