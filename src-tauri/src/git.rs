use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::OnceLock,
};

const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';
static GIT_EXECUTABLE: OnceLock<PathBuf> = OnceLock::new();

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitVersion {
    pub available: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub path: String,
    pub name: String,
    pub branch: String,
    pub head: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changes: Vec<ChangedFile>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub section: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub oid: String,
    pub short_oid: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author: String,
    pub timestamp: i64,
    pub refs: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    #[serde(flatten)]
    pub summary: CommitSummary,
    pub body: String,
    pub email: String,
    pub files: Vec<ChangedFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashInfo {
    pub is_directory: bool,
    pub entry_count: u64,
    pub contains_nested_repository: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeAction {
    Stage,
    Unstage,
    Discard,
    Trash,
}

pub struct GitService;

impl GitService {
    pub fn check() -> GitVersion {
        let executable = resolve_git_executable();
        match Command::new(&executable).arg("--version").output() {
            Ok(output) if output.status.success() => {
                let _ = GIT_EXECUTABLE.set(executable);
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                match parse_git_version(&version) {
                    Some(found) if found >= (2, 23, 0) => GitVersion {
                        available: true,
                        version: Some(version),
                        error: None,
                    },
                    Some((major, minor, patch)) => GitVersion {
                        available: false,
                        version: Some(version),
                        error: Some(format!(
                            "Git Tempo requires Git 2.23 or newer; found {major}.{minor}.{patch}"
                        )),
                    },
                    None => GitVersion {
                        available: false,
                        version: Some(version.clone()),
                        error: Some(format!(
                            "Could not determine the Git version from: {version}"
                        )),
                    },
                }
            }
            Ok(output) => GitVersion {
                available: false,
                version: None,
                error: Some(String::from_utf8_lossy(&output.stderr).trim().into()),
            },
            Err(error) => GitVersion {
                available: false,
                version: None,
                error: Some(error.to_string()),
            },
        }
    }

    pub fn repository(path: &str) -> Result<Repository, String> {
        let root = Self::text(path, &["rev-parse", "--show-toplevel"])?;
        let root = root.trim();
        let output = Self::run(
            root,
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=normal",
            ],
        )?;
        let mut branch = "HEAD".to_string();
        let mut head = None;
        let mut ahead = 0;
        let mut behind = 0;
        for entry in output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|item| !item.is_empty())
        {
            let entry = String::from_utf8_lossy(entry);
            if let Some(value) = entry.strip_prefix("# branch.head ") {
                branch = value.to_string();
                continue;
            }
            if let Some(value) = entry.strip_prefix("# branch.oid ") {
                if value != "(initial)" {
                    head = Some(value.to_string());
                }
                continue;
            }
            if let Some(value) = entry.strip_prefix("# branch.ab ") {
                for part in value.split_whitespace() {
                    if let Some(v) = part.strip_prefix('+') {
                        ahead = v.parse().unwrap_or(0);
                    }
                    if let Some(v) = part.strip_prefix('-') {
                        behind = v.parse().unwrap_or(0);
                    }
                }
                continue;
            }
        }
        let changes = parse_status(&output.stdout);
        let canonical = Path::new(root).canonicalize().map_err(|e| e.to_string())?;
        let name = canonical
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or(root)
            .to_string();
        Ok(Repository {
            path: canonical.to_string_lossy().into(),
            name,
            branch,
            head,
            ahead,
            behind,
            changes,
        })
    }

    pub fn history(path: &str, skip: usize, limit: usize) -> Result<Vec<CommitSummary>, String> {
        if !Self::has_head(path)? {
            return Ok(Vec::new());
        }
        let format = format!("%H{FIELD}%h{FIELD}%P{FIELD}%s{FIELD}%an{FIELD}%at{FIELD}%D{RECORD}");
        let count = format!("--max-count={limit}");
        let skip = format!("--skip={skip}");
        let text = Self::text(
            path,
            &[
                "log",
                &count,
                &skip,
                "--date-order",
                &format!("--format={format}"),
            ],
        )?;
        Ok(text.split(RECORD).filter_map(parse_commit).collect())
    }

    pub fn commit(path: &str, oid: &str) -> Result<CommitDetails, String> {
        validate_oid(oid)?;
        let format = format!(
            "%H{FIELD}%h{FIELD}%P{FIELD}%s{FIELD}%an{FIELD}%at{FIELD}%D{FIELD}%ae{FIELD}%b{RECORD}"
        );
        let text = Self::text(
            path,
            &["show", "--no-patch", &format!("--format={format}"), oid],
        )?;
        let fields: Vec<_> = text.trim_end_matches(['\n', RECORD]).split(FIELD).collect();
        if fields.len() < 9 {
            return Err("Git returned incomplete commit metadata".into());
        }
        let summary = commit_from_fields(&fields[..7])?;
        let names = if let Some(parent) = summary.parents.first() {
            Self::run(
                path,
                &["diff", "--name-status", "--find-renames", "-z", parent, oid],
            )?
        } else {
            Self::run(
                path,
                &[
                    "diff-tree",
                    "--root",
                    "--no-commit-id",
                    "--name-status",
                    "--find-renames",
                    "-r",
                    "-z",
                    oid,
                ],
            )?
        };
        if !names.status.success() {
            return Err(git_error(&names));
        }
        let files = parse_name_status(&names.stdout);
        Ok(CommitDetails {
            summary,
            email: fields[7].into(),
            body: fields[8..].join(&FIELD.to_string()).trim().into(),
            files,
        })
    }

    pub fn diff(
        path: &str,
        file: &str,
        section: &str,
        oid: Option<&str>,
        old_file: Option<&str>,
    ) -> Result<String, String> {
        let file = safe_file(path, file)?;
        let file = file.to_string_lossy();
        let old_file = old_file
            .map(|old| safe_file(path, old))
            .transpose()?
            .map(|old| old.to_string_lossy().into_owned());
        let diff = if let Some(oid) = oid {
            validate_oid(oid)?;
            let parents = Self::commit_parents(path, oid)?;
            if let Some(parent) = parents.first() {
                let mut args = vec![
                    "diff",
                    "--no-ext-diff",
                    "--no-color",
                    "--find-renames",
                    parent,
                    oid,
                    "--",
                ];
                if let Some(old) = old_file.as_deref().filter(|old| *old != file) {
                    args.push(old);
                }
                args.push(&file);
                Self::text(path, &args)?
            } else {
                let mut args = vec![
                    "show",
                    "--format=",
                    "--no-ext-diff",
                    "--no-color",
                    "--find-renames",
                    oid,
                    "--",
                ];
                if let Some(old) = old_file.as_deref().filter(|old| *old != file) {
                    args.push(old);
                }
                args.push(&file);
                Self::text(path, &args)?
            }
        } else if section == "staged" {
            let mut args = vec!["diff", "--cached", "--no-ext-diff", "--no-color", "--"];
            if let Some(old) = old_file.as_deref().filter(|old| *old != file) {
                args.push(old);
            }
            args.push(&file);
            Self::text(path, &args)?
        } else if section == "untracked" {
            return synthetic_untracked_diff(path, &file);
        } else {
            let mut args = vec!["diff", "--no-ext-diff", "--no-color", "--"];
            if let Some(old) = old_file.as_deref().filter(|old| *old != file) {
                args.push(old);
            }
            args.push(&file);
            Self::text(path, &args)?
        };
        if diff.len() > 10 * 1024 * 1024 {
            Err("Diff exceeds the 10 MB display safety limit".into())
        } else {
            Ok(diff)
        }
    }

    pub fn change_file(
        path: &str,
        file: &str,
        old_file: Option<&str>,
        section: &str,
        action: ChangeAction,
    ) -> Result<(), String> {
        let file = safe_file(path, file)?;
        let file = file.to_string_lossy();
        let old_file = old_file
            .map(|old| safe_file(path, old))
            .transpose()?
            .map(|old| old.to_string_lossy().into_owned());
        match action {
            ChangeAction::Stage => {
                let mut args = vec!["add", "--"];
                if let Some(old) = old_file.as_deref().filter(|old| *old != file) {
                    args.push(old);
                }
                args.push(&file);
                Self::success(path, &args)
            }
            ChangeAction::Unstage if Self::has_head(path)? => {
                let mut args = vec!["restore", "--staged", "--"];
                if let Some(old) = old_file.as_deref().filter(|old| *old != file) {
                    args.push(old);
                }
                args.push(&file);
                Self::success(path, &args)
            }
            ChangeAction::Unstage => {
                let mut args = vec!["rm", "--cached", "--ignore-unmatch", "--"];
                if let Some(old) = old_file.as_deref().filter(|old| *old != file) {
                    args.push(old);
                }
                args.push(&file);
                Self::success(path, &args)
            }
            ChangeAction::Discard if old_file.is_some() => Err(
                "Discarding a rename is disabled because it could remove the destination; unstage it or use Git directly"
                    .into(),
            ),
            ChangeAction::Discard if section == "unstaged" => {
                Self::success(path, &["restore", "--worktree", "--", &file])
            }
            ChangeAction::Discard => {
                Err("Only unstaged tracked changes can be discarded; unstage the file first".into())
            }
            ChangeAction::Trash if section == "untracked" => {
                let info = Self::trash_info(path, &file)?;
                if info.contains_nested_repository {
                    return Err(
                        "Git Tempo will not move a directory containing a nested Git repository to Trash"
                            .into(),
                    );
                }
                trash::delete(Path::new(path).join(file.as_ref()))
                    .map_err(|e| format!("Could not move file to Trash: {e}"))
            }
            ChangeAction::Trash => Err("Only untracked files can be moved to Trash".into()),
        }
    }

    pub fn trash_info(path: &str, file: &str) -> Result<TrashInfo, String> {
        let file = safe_file(path, file)?;
        inspect_trash_target(&Path::new(path).join(file))
    }

    pub fn apply_patch(
        path: &str,
        file: &str,
        old_file: Option<&str>,
        section: &str,
        expected_diff: &str,
        patch: &[u8],
        reverse: bool,
    ) -> Result<(), String> {
        if patch.len() > 10 * 1024 * 1024 {
            return Err("Selected patch exceeds the 10 MB safety limit".into());
        }
        if !matches!(section, "staged" | "unstaged") {
            return Err("Partial patches are supported only for staged or unstaged changes".into());
        }
        let current_diff = Self::diff(path, file, section, None, old_file)?;
        if current_diff != expected_diff {
            return Err(
                "The file changed after this diff was loaded. Git Tempo refreshed it without applying the selection."
                    .into(),
            );
        }
        let mut check = vec!["apply", "--cached", "--check", "--recount"];
        if reverse {
            check.push("--reverse");
        }
        check.push("-");
        Self::stdin(path, &check, patch)?;
        let mut apply = vec!["apply", "--cached", "--recount"];
        if reverse {
            apply.push("--reverse");
        }
        apply.push("-");
        Self::stdin(path, &apply, patch)
    }

    fn has_head(path: &str) -> Result<bool, String> {
        let output = Self::run(path, &["rev-parse", "--verify", "HEAD"])?;
        Ok(output.status.success())
    }

    fn commit_parents(path: &str, oid: &str) -> Result<Vec<String>, String> {
        validate_oid(oid)?;
        let line = Self::text(path, &["rev-list", "--parents", "-n", "1", oid])?;
        let mut fields = line.split_whitespace();
        let _commit = fields.next().ok_or("Git returned no commit")?;
        Ok(fields.map(Into::into).collect())
    }

    fn run(path: &str, args: &[&str]) -> Result<Output, String> {
        Self::command()
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .map_err(|e| format!("Could not start Git: {e}"))
    }
    fn text(path: &str, args: &[&str]) -> Result<String, String> {
        let output = Self::run(path, args)?;
        if !output.status.success() {
            return Err(git_error(&output));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into())
    }
    fn success(path: &str, args: &[&str]) -> Result<(), String> {
        let output = Self::run(path, args)?;
        if output.status.success() {
            Ok(())
        } else {
            Err(git_error(&output))
        }
    }
    fn stdin(path: &str, args: &[&str], input: &[u8]) -> Result<(), String> {
        let mut child = Self::command()
            .arg("-C")
            .arg(path)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        child
            .stdin
            .take()
            .ok_or("Git stdin unavailable")?
            .write_all(input)
            .map_err(|e| e.to_string())?;
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(git_error(&output))
        }
    }

    fn command() -> Command {
        Command::new(
            GIT_EXECUTABLE
                .get()
                .cloned()
                .unwrap_or_else(resolve_git_executable),
        )
    }
}

fn resolve_git_executable() -> PathBuf {
    let executable_name = if cfg!(windows) { "git.exe" } else { "git" };
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            let candidate = directory.join(executable_name);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    for candidate in [
        PathBuf::from("/usr/bin/git"),
        PathBuf::from("/usr/local/bin/git"),
        PathBuf::from("/opt/homebrew/bin/git"),
        PathBuf::from(r"C:\Program Files\Git\cmd\git.exe"),
    ] {
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from(executable_name)
}

fn parse_status(bytes: &[u8]) -> Vec<ChangedFile> {
    let records: Vec<_> = bytes.split(|byte| *byte == 0).collect();
    let mut result = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let record = String::from_utf8_lossy(records[index]);
        index += 1;
        if record.is_empty() || record.starts_with('#') || record.starts_with("! ") {
            continue;
        }
        if let Some(path) = record.strip_prefix("? ") {
            result.push(ChangedFile {
                path: path.into(),
                old_path: None,
                status: "?".into(),
                section: "untracked".into(),
            });
            continue;
        }
        if record.starts_with("u ") {
            let fields: Vec<_> = record.splitn(11, ' ').collect();
            if let Some(path) = fields.get(10) {
                result.push(ChangedFile {
                    path: (*path).into(),
                    old_path: None,
                    status: "U".into(),
                    section: "unstaged".into(),
                });
            }
            continue;
        }
        let renamed = record.starts_with("2 ");
        if !record.starts_with("1 ") && !renamed {
            continue;
        }
        let fields: Vec<_> = record.splitn(if renamed { 10 } else { 9 }, ' ').collect();
        let required = if renamed { 10 } else { 9 };
        if fields.len() < required || fields[1].len() < 2 {
            continue;
        }
        let path = fields[required - 1];
        let old_path = if renamed && index < records.len() {
            let old = String::from_utf8_lossy(records[index]).into_owned();
            index += 1;
            Some(old)
        } else {
            None
        };
        append_status_sections(&mut result, fields[1], path, old_path);
    }
    result
}

fn append_status_sections(
    result: &mut Vec<ChangedFile>,
    xy: &str,
    path: &str,
    old_path: Option<String>,
) {
    let index = &xy[0..1];
    let worktree = &xy[1..2];
    if index != "." {
        result.push(ChangedFile {
            path: path.into(),
            old_path: old_path.clone(),
            status: index.into(),
            section: "staged".into(),
        });
    }
    if worktree != "." {
        result.push(ChangedFile {
            path: path.into(),
            old_path,
            status: worktree.into(),
            section: "unstaged".into(),
        });
    }
}

fn parse_commit(record: &str) -> Option<CommitSummary> {
    let fields: Vec<_> = record.trim_start_matches('\n').split(FIELD).collect();
    commit_from_fields(&fields).ok()
}
fn commit_from_fields(fields: &[&str]) -> Result<CommitSummary, String> {
    if fields.len() < 7 {
        return Err("Incomplete commit".into());
    }
    Ok(CommitSummary {
        oid: fields[0].into(),
        short_oid: fields[1].into(),
        parents: fields[2].split_whitespace().map(Into::into).collect(),
        subject: fields[3].into(),
        author: fields[4].into(),
        timestamp: fields[5].parse().unwrap_or(0),
        refs: fields[6]
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(Into::into)
            .collect(),
    })
}
fn parse_name_status(bytes: &[u8]) -> Vec<ChangedFile> {
    let mut fields = bytes.split(|b| *b == 0).filter(|v| !v.is_empty());
    let mut files = Vec::new();
    while let Some(status) = fields.next() {
        let status = String::from_utf8_lossy(status).into_owned();
        let renamed = status.starts_with('R') || status.starts_with('C');
        let first = fields.next();
        let second = if renamed { fields.next() } else { None };
        if let Some(path) = second.or(first) {
            files.push(ChangedFile {
                path: String::from_utf8_lossy(path).into(),
                old_path: if renamed {
                    first.map(|value| String::from_utf8_lossy(value).into())
                } else {
                    None
                },
                status,
                section: "commit".into(),
            });
        }
    }
    files
}
fn validate_oid(oid: &str) -> Result<(), String> {
    if oid.len() < 4 || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        Err("Invalid commit object ID".into())
    } else {
        Ok(())
    }
}
fn parse_git_version(value: &str) -> Option<(u32, u32, u32)> {
    let version = value.split_whitespace().find(|part| {
        part.as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_digit())
    })?;
    let mut numbers = version.split('.').map(|part| {
        part.chars()
            .take_while(|character| character.is_ascii_digit())
            .collect::<String>()
            .parse::<u32>()
            .ok()
    });
    Some((
        numbers.next()??,
        numbers.next()??,
        numbers.next().flatten().unwrap_or(0),
    ))
}
fn safe_file(root: &str, file: &str) -> Result<PathBuf, String> {
    let relative = Path::new(file);
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("File path escapes the repository".into());
    }
    let root = Path::new(root).canonicalize().map_err(|e| e.to_string())?;
    let joined = root.join(relative);
    if !joined.starts_with(&root) {
        return Err("File path escapes the repository".into());
    }
    Ok(relative.into())
}
fn inspect_trash_target(target: &Path) -> Result<TrashInfo, String> {
    let metadata = fs::symlink_metadata(target)
        .map_err(|error| format!("Could not inspect the untracked path: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(TrashInfo {
            is_directory: false,
            entry_count: 1,
            contains_nested_repository: false,
        });
    }

    let mut entry_count = 0;
    let mut contains_nested_repository = false;
    let mut pending = vec![target.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let entries = fs::read_dir(&directory)
            .map_err(|error| format!("Could not inspect the untracked directory: {error}"))?;
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if entry.file_name() == ".git" {
                contains_nested_repository = true;
                continue;
            }
            let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                pending.push(path);
            } else {
                entry_count += 1;
            }
        }
    }
    Ok(TrashInfo {
        is_directory: true,
        entry_count,
        contains_nested_repository,
    })
}
fn synthetic_untracked_diff(path: &str, file: &str) -> Result<String, String> {
    let target = Path::new(path).join(file);
    let metadata = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        let info = inspect_trash_target(&target)?;
        return Ok(format!(
            "diff --git a/{file} b/{file}\nGit Tempo untracked directory containing {} file{}\n",
            info.entry_count,
            if info.entry_count == 1 { "" } else { "s" }
        ));
    }
    let (bytes, mode) = if metadata.file_type().is_symlink() {
        (
            fs::read_link(&target)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .into_owned()
                .into_bytes(),
            "120000",
        )
    } else {
        (fs::read(&target).map_err(|e| e.to_string())?, "100644")
    };
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("Untracked file is larger than the 2 MB preview limit".into());
    }
    if bytes.contains(&0) {
        return Ok(format!("Binary files /dev/null and b/{file} differ"));
    }
    let text = String::from_utf8_lossy(&bytes);
    let count = text.lines().count();
    if count == 0 {
        return Ok(String::new());
    }
    let mut added = text
        .lines()
        .map(|line| format!("+{line}"))
        .collect::<Vec<_>>()
        .join("\n");
    if !bytes.ends_with(b"\n") {
        added.push_str("\n\\ No newline at end of file");
    }
    Ok(format!(
        "diff --git a/{file} b/{file}\nnew file mode {mode}\n--- /dev/null\n+++ b/{file}\n@@ -0,0 +1,{count} @@\n{added}\n"
    ))
}
fn git_error(output: &Output) -> String {
    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if message.is_empty() {
        format!("Git exited with {}", output.status)
    } else {
        message
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestRepository(PathBuf);

    impl TestRepository {
        fn new(name: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path =
                std::env::temp_dir().join(format!("tempo-{name}-{}-{unique}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            let repository = Self(path);
            repository.git(&["init", "-q"]);
            repository.git(&["config", "user.email", "tempo-tests@example.com"]);
            repository.git(&["config", "user.name", "Git Tempo Tests"]);
            repository
        }

        fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }

        fn git(&self, args: &[&str]) -> String {
            let output = Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().into()
        }

        fn write(&self, relative: &str, contents: &str) {
            let path = self.0.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(path, contents).unwrap();
        }

        fn commit_all(&self, message: &str) -> String {
            self.git(&["add", "."]);
            self.git(&["commit", "-q", "-m", message]);
            self.git(&["rev-parse", "HEAD"])
        }
    }

    impl Drop for TestRepository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parses_commit_record() {
        let raw = format!("abc123{FIELD}abc123{FIELD}def456{FIELD}Subject{FIELD}Author{FIELD}100{FIELD}HEAD -> main");
        let commit = parse_commit(&raw).unwrap();
        assert_eq!(commit.subject, "Subject");
        assert_eq!(commit.parents, vec!["def456"]);
    }
    #[test]
    fn rejects_parent_paths() {
        assert!(safe_file(".", "../secret").is_err());
    }
    #[test]
    fn parses_untracked_status() {
        let files = parse_status(b"? notes.md\0");
        assert_eq!(files[0].section, "untracked");
    }

    #[test]
    fn parses_renamed_porcelain_record() {
        let raw = b"2 R. N... 100644 100644 100644 abc123 def456 R100 new name.txt\0old name.txt\0";
        let files = parse_status(raw);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "new name.txt");
        assert_eq!(files[0].old_path.as_deref(), Some("old name.txt"));
        assert_eq!(files[0].section, "staged");
    }

    #[test]
    fn parses_platform_git_versions() {
        assert_eq!(
            parse_git_version("git version 2.50.1 (Apple Git-155)"),
            Some((2, 50, 1))
        );
        assert_eq!(
            parse_git_version("git version 2.23.windows.1"),
            Some((2, 23, 0))
        );
    }

    #[test]
    fn applies_and_reverses_a_checked_patch() {
        let repository = TestRepository::new("apply-patch");
        repository.write("notes.txt", "alpha\nbeta\n");
        repository.commit_all("initial");
        repository.write("notes.txt", "alpha\nupdated\n");

        let worktree =
            GitService::diff(repository.path(), "notes.txt", "unstaged", None, None).unwrap();
        GitService::apply_patch(
            repository.path(),
            "notes.txt",
            None,
            "unstaged",
            &worktree,
            worktree.as_bytes(),
            false,
        )
        .unwrap();
        let staged =
            GitService::diff(repository.path(), "notes.txt", "staged", None, None).unwrap();
        assert!(staged.contains("+updated"));

        GitService::apply_patch(
            repository.path(),
            "notes.txt",
            None,
            "staged",
            &staged,
            staged.as_bytes(),
            true,
        )
        .unwrap();
        assert!(
            GitService::diff(repository.path(), "notes.txt", "staged", None, None)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn rejects_a_patch_when_the_diff_snapshot_is_stale() {
        let repository = TestRepository::new("stale-patch");
        repository.write("notes.txt", "alpha\nbeta\n");
        repository.commit_all("initial");
        repository.write("notes.txt", "alpha\nfirst edit\n");
        let snapshot =
            GitService::diff(repository.path(), "notes.txt", "unstaged", None, None).unwrap();
        repository.write("notes.txt", "alpha\nsecond edit\n");

        let error = GitService::apply_patch(
            repository.path(),
            "notes.txt",
            None,
            "unstaged",
            &snapshot,
            snapshot.as_bytes(),
            false,
        )
        .unwrap_err();
        assert!(error.contains("changed after this diff was loaded"));
        assert!(
            GitService::diff(repository.path(), "notes.txt", "staged", None, None)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn unstages_files_in_a_repository_without_head() {
        let repository = TestRepository::new("unborn-unstage");
        repository.write("new.txt", "new repository\n");
        repository.git(&["add", "new.txt"]);

        GitService::change_file(
            repository.path(),
            "new.txt",
            None,
            "staged",
            ChangeAction::Unstage,
        )
        .unwrap();
        let status = GitService::repository(repository.path()).unwrap();
        assert_eq!(status.changes.len(), 1);
        assert_eq!(status.changes[0].section, "untracked");
    }

    #[test]
    fn unstages_both_sides_of_a_renamed_file() {
        let repository = TestRepository::new("unstage-rename");
        repository.write("old.txt", "contents\n");
        repository.commit_all("initial");
        repository.git(&["mv", "old.txt", "new.txt"]);

        GitService::change_file(
            repository.path(),
            "new.txt",
            Some("old.txt"),
            "staged",
            ChangeAction::Unstage,
        )
        .unwrap();

        assert!(repository
            .git(&["diff", "--cached", "--name-only"])
            .is_empty());
        let status = repository.git(&["status", "--porcelain"]);
        assert!(status.contains("D old.txt"));
        assert!(status.contains("?? new.txt"));
    }

    #[test]
    fn merge_commit_files_and_diffs_use_the_first_parent() {
        let repository = TestRepository::new("merge-diff");
        repository.write("base.txt", "base\n");
        repository.commit_all("initial");
        let main_branch = repository.git(&["branch", "--show-current"]);
        repository.git(&["checkout", "-q", "-b", "feature"]);
        repository.write("feature.txt", "from feature\n");
        repository.commit_all("feature");
        repository.git(&["checkout", "-q", &main_branch]);
        repository.write("main.txt", "from main\n");
        repository.commit_all("main");
        repository.git(&["merge", "--no-ff", "-q", "feature", "-m", "merge feature"]);
        let merge = repository.git(&["rev-parse", "HEAD"]);

        let details = GitService::commit(repository.path(), &merge).unwrap();
        assert_eq!(details.summary.parents.len(), 2);
        assert!(details.files.iter().any(|file| file.path == "feature.txt"));
        assert!(!details.files.iter().any(|file| file.path == "main.txt"));
        let diff = GitService::diff(
            repository.path(),
            "feature.txt",
            "commit",
            Some(&merge),
            None,
        )
        .unwrap();
        assert!(diff.contains("+from feature"));
        let history = GitService::history(repository.path(), 0, 100).unwrap();
        assert!(history.iter().any(|commit| commit.subject == "feature"));
        assert!(history.iter().any(|commit| commit.subject == "main"));
    }

    #[test]
    fn history_pages_do_not_repeat_commits() {
        let repository = TestRepository::new("history-pages");
        for index in 0..5 {
            repository.write("counter.txt", &format!("{index}\n"));
            repository.commit_all(&format!("commit {index}"));
        }
        let first = GitService::history(repository.path(), 0, 2).unwrap();
        let second = GitService::history(repository.path(), 2, 2).unwrap();
        assert_eq!(first.len(), 2);
        assert_eq!(second.len(), 2);
        assert!(first
            .iter()
            .all(|commit| second.iter().all(|other| other.oid != commit.oid)));
    }

    #[test]
    fn commit_rename_diffs_include_both_paths() {
        let repository = TestRepository::new("rename-diff");
        repository.write(
            "old.txt",
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
        );
        repository.commit_all("initial");
        repository.git(&["mv", "old.txt", "new.txt"]);
        repository.write(
            "new.txt",
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nupdated\n",
        );
        let rename = repository.commit_all("rename with edit");

        let details = GitService::commit(repository.path(), &rename).unwrap();
        let file = details
            .files
            .iter()
            .find(|file| file.path == "new.txt")
            .unwrap();
        assert_eq!(file.old_path.as_deref(), Some("old.txt"));
        let diff = GitService::diff(
            repository.path(),
            &file.path,
            "commit",
            Some(&rename),
            file.old_path.as_deref(),
        )
        .unwrap();
        assert!(diff.contains("rename from old.txt"));
        assert!(diff.contains("rename to new.txt"));
    }

    #[test]
    fn detects_nested_repositories_before_trashing_a_directory() {
        let repository = TestRepository::new("nested-trash");
        repository.write("vendor/project/.git/config", "[core]\n");
        let info = GitService::trash_info(repository.path(), "vendor").unwrap();
        assert!(info.is_directory);
        assert!(info.contains_nested_repository);
        assert_eq!(info.entry_count, 0);
    }

    #[test]
    fn previews_untracked_directories_without_reading_them_as_files() {
        let repository = TestRepository::new("directory-preview");
        repository.write("drafts/one.txt", "one\n");
        repository.write("drafts/two.txt", "two\n");
        let preview =
            GitService::diff(repository.path(), "drafts", "untracked", None, None).unwrap();
        assert!(preview.contains("Git Tempo untracked directory containing 2 files"));
    }

    #[cfg(unix)]
    #[test]
    fn previews_a_symlink_target_without_reading_the_target_file() {
        use std::os::unix::fs::symlink;

        let repository = TestRepository::new("symlink-preview");
        let outside = repository
            .0
            .parent()
            .unwrap()
            .join("tempo-outside-secret.txt");
        fs::write(&outside, "secret contents\n").unwrap();
        symlink(&outside, repository.0.join("link.txt")).unwrap();
        let preview =
            GitService::diff(repository.path(), "link.txt", "untracked", None, None).unwrap();
        let _ = fs::remove_file(&outside);
        assert!(preview.contains("new file mode 120000"));
        assert!(preview.contains(&format!("+{}", outside.to_string_lossy())));
        assert!(!preview.contains("secret contents"));
    }
}
