use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitVersion {
    pub available: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
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
        match Command::new("git").arg("--version").output() {
            Ok(output) if output.status.success() => GitVersion {
                available: true,
                version: Some(String::from_utf8_lossy(&output.stdout).trim().into()),
                error: None,
            },
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
        let raw = String::from_utf8_lossy(&output.stdout);
        let mut branch = "HEAD".to_string();
        let mut head = None;
        let mut ahead = 0;
        let mut behind = 0;
        let mut changes = Vec::new();
        for entry in raw.split('\0').filter(|item| !item.is_empty()) {
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
            if let Some(file) = parse_status_entry(entry) {
                changes.extend(file);
            }
        }
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
        let names = Self::run(
            path,
            &[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--name-status",
                "-r",
                "-z",
                oid,
            ],
        )?;
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
    ) -> Result<String, String> {
        let file = safe_file(path, file)?;
        let file = file.to_string_lossy();
        let args: Vec<&str> = if let Some(oid) = oid {
            validate_oid(oid)?;
            vec![
                "show",
                "--format=",
                "--no-ext-diff",
                "--no-color",
                oid,
                "--",
                &file,
            ]
        } else if section == "staged" {
            vec![
                "diff",
                "--cached",
                "--no-ext-diff",
                "--no-color",
                "--",
                &file,
            ]
        } else if section == "untracked" {
            return synthetic_untracked_diff(path, &file);
        } else {
            vec!["diff", "--no-ext-diff", "--no-color", "--", &file]
        };
        Self::text(path, &args)
    }

    pub fn change_file(path: &str, file: &str, action: ChangeAction) -> Result<(), String> {
        let file = safe_file(path, file)?;
        let file = file.to_string_lossy();
        match action {
            ChangeAction::Stage => Self::success(path, &["add", "--", &file]),
            ChangeAction::Unstage => Self::success(path, &["restore", "--staged", "--", &file]),
            ChangeAction::Discard => Self::success(path, &["restore", "--worktree", "--", &file]),
            ChangeAction::Trash => trash::delete(Path::new(path).join(file.as_ref()))
                .map_err(|e| format!("Could not move file to Trash: {e}")),
        }
    }

    pub fn apply_patch(path: &str, patch: &[u8], reverse: bool) -> Result<(), String> {
        if patch.len() > 10 * 1024 * 1024 {
            return Err("Selected patch exceeds the 10 MB safety limit".into());
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

    fn run(path: &str, args: &[&str]) -> Result<Output, String> {
        Command::new("git")
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
        let mut child = Command::new("git")
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
}

fn parse_status_entry(entry: &str) -> Option<Vec<ChangedFile>> {
    if let Some(path) = entry.strip_prefix("? ") {
        return Some(vec![ChangedFile {
            path: path.into(),
            old_path: None,
            status: "?".into(),
            section: "untracked".into(),
        }]);
    }
    if !entry.starts_with("1 ") && !entry.starts_with("2 ") {
        return None;
    }
    let fields: Vec<_> = entry
        .splitn(if entry.starts_with("2 ") { 10 } else { 9 }, ' ')
        .collect();
    if fields.len() < 9 {
        return None;
    }
    let xy = fields[1];
    let path = fields.last()?.split('\t').next().unwrap_or_default();
    let mut result = Vec::new();
    let index = &xy[0..1];
    let worktree = &xy[1..2];
    if index != "." {
        result.push(ChangedFile {
            path: path.into(),
            old_path: None,
            status: index.into(),
            section: "staged".into(),
        });
    }
    if worktree != "." {
        result.push(ChangedFile {
            path: path.into(),
            old_path: None,
            status: worktree.into(),
            section: "unstaged".into(),
        });
    }
    Some(result)
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
        if let Some(path) = fields.next() {
            files.push(ChangedFile {
                path: String::from_utf8_lossy(path).into(),
                old_path: None,
                status,
                section: "staged".into(),
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
fn synthetic_untracked_diff(path: &str, file: &str) -> Result<String, String> {
    let bytes = std::fs::read(Path::new(path).join(file)).map_err(|e| e.to_string())?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("Untracked file is larger than the 2 MB preview limit".into());
    }
    if bytes.contains(&0) {
        return Ok(format!("Binary files /dev/null and b/{file} differ"));
    }
    let text = String::from_utf8_lossy(&bytes);
    let count = text.lines().count();
    Ok(format!("diff --git a/{file} b/{file}\nnew file mode 100644\n--- /dev/null\n+++ b/{file}\n@@ -0,0 +1,{count} @@\n{}\n", text.lines().map(|l| format!("+{l}")).collect::<Vec<_>>().join("\n")))
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
        let files = parse_status_entry("? notes.md").unwrap();
        assert_eq!(files[0].section, "untracked");
    }
}
