//! Commit history, references and commit details.

use std::path::Path;

use serde::Serialize;

use super::diff::{fingerprint, DIFF_FLAGS};
use super::paths::validate_relative;
use super::runner::{run_git, run_git_with, RunOptions, DEFAULT_TIMEOUT};
use crate::error::GitError;

/// Largest page the UI may request.
pub const MAX_PAGE: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogCommit {
    pub oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// Author time, seconds since the Unix epoch.
    pub author_time: i64,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub commits: Vec<LogCommit>,
    /// More commits exist after this page.
    pub has_more: bool,
    /// Number of commits in the whole history.
    pub total: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    Branch,
    Remote,
    Tag,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefInfo {
    /// Short name, for example `main`, `origin/main` or `v1.0`.
    pub name: String,
    pub kind: RefKind,
    /// Commit the ref points at (annotated tags are peeled).
    pub oid: String,
}

/// Accept only full or abbreviated hexadecimal object ids, never options or rev expressions.
pub fn validate_oid(oid: &str) -> Result<&str, GitError> {
    let ok = (4..=64).contains(&oid.len()) && oid.bytes().all(|b| b.is_ascii_hexdigit());
    if ok {
        Ok(oid)
    } else {
        Err(GitError::InvalidPath(format!("not a commit id: {oid}")))
    }
}

/// Parse `%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x1e` records.
pub fn parse_log(output: &[u8]) -> Result<Vec<LogCommit>, GitError> {
    let text = String::from_utf8_lossy(output);
    let mut commits = Vec::new();
    for record in text.split('\x1e') {
        let record = record.trim_start_matches(['\n', '\r']);
        if record.is_empty() {
            continue;
        }
        let f: Vec<&str> = record.splitn(6, '\0').collect();
        if f.len() != 6 {
            return Err(GitError::Parse(format!("bad log record: {record:?}")));
        }
        commits.push(LogCommit {
            oid: f[0].to_string(),
            parents: f[1].split_whitespace().map(str::to_string).collect(),
            author_name: f[2].to_string(),
            author_email: f[3].to_string(),
            author_time: f[4].trim().parse().unwrap_or(0),
            summary: f[5].trim_end_matches(['\n', '\r']).to_string(),
        });
    }
    Ok(commits)
}

fn head_is_born(root: &Path) -> Result<bool, GitError> {
    match run_git(
        root,
        &["rev-parse", "--verify", "-q", "HEAD"],
        DEFAULT_TIMEOUT,
    ) {
        Ok(_) => Ok(true),
        Err(GitError::GitFailed { code: 1, .. }) => Ok(false),
        Err(e) => Err(e),
    }
}

/// Commit order and parent links for the whole history, computed once per
/// repository state and reused for every page.
struct Topology {
    root: std::path::PathBuf,
    key: String,
    /// Commit ids in `--date-order` (children always before parents).
    order: Vec<String>,
}

static TOPOLOGY: std::sync::Mutex<Option<Topology>> = std::sync::Mutex::new(None);

/// Upper bound on commits kept in the in-memory topology.
pub const MAX_HISTORY: usize = 2_000_000;

fn history_args(born: bool) -> Vec<&'static str> {
    let mut args = vec!["--branches", "--remotes", "--tags"];
    if born {
        args.push("HEAD");
    }
    args
}

/// Identifies the current history: any moved ref or HEAD invalidates it.
fn history_key(root: &Path, born: bool) -> Result<String, GitError> {
    let head = if born {
        run_git(root, &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)?.stdout_string()
    } else {
        String::new()
    };
    Ok(format!("{}:{}", refs_fingerprint(root)?, head.trim()))
}

fn load_order(root: &Path, born: bool) -> Result<Vec<String>, GitError> {
    let mut args = vec!["rev-list", "--date-order"];
    args.extend(history_args(born));
    args.push("--");
    let out = match run_git(root, &args, std::time::Duration::from_secs(120)) {
        Ok(out) => out,
        Err(GitError::GitFailed { .. }) if !born => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let text = out.stdout_string();
    Ok(text
        .lines()
        .filter(|l| !l.is_empty())
        .take(MAX_HISTORY)
        .map(str::to_string)
        .collect())
}

/// One page of history across HEAD, local branches, remote branches and tags,
/// newest first, children always before parents (`--date-order`).
///
/// Ordering requires Git to walk the whole history, which takes about a second
/// on very large repositories without a commit-graph file. That walk happens
/// once per repository state (only commit ids are read); every page after that
/// only fetches the metadata of its own commits.
pub fn log_page(root: &Path, skip: usize, limit: usize) -> Result<LogPage, GitError> {
    let limit = limit.clamp(1, MAX_PAGE);
    let born = head_is_born(root)?;
    let key = history_key(root, born)?;

    let slice: Vec<String> = {
        let mut cache = TOPOLOGY.lock().unwrap_or_else(|e| e.into_inner());
        let fresh = cache
            .as_ref()
            .is_some_and(|t| t.root == root && t.key == key);
        if !fresh {
            *cache = Some(Topology {
                root: root.to_path_buf(),
                key,
                order: load_order(root, born)?,
            });
        }
        let order = &cache.as_ref().expect("just filled").order;
        let total = order.len();
        let end = (skip + limit).min(total);
        let slice = order.get(skip.min(total)..end).unwrap_or_default().to_vec();
        if slice.is_empty() {
            return Ok(LogPage {
                commits: Vec::new(),
                has_more: false,
                total,
            });
        }
        slice
    };

    // Metadata for exactly these commits, in this order.
    let mut stdin = slice.join("\n");
    stdin.push('\n');
    let out = run_git_with(
        root,
        &[
            "log",
            "--no-walk=unsorted",
            "--stdin",
            "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x1e",
        ],
        &RunOptions {
            stdin: Some(stdin.as_bytes()),
            ..RunOptions::default()
        },
    )?;
    let commits = parse_log(&out.stdout)?;
    let total = TOPOLOGY
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map_or(0, |t| t.order.len());
    Ok(LogPage {
        has_more: skip + commits.len() < total,
        commits,
        total,
    })
}

fn refs_output(root: &Path) -> Result<Vec<u8>, GitError> {
    Ok(run_git(
        root,
        &[
            "for-each-ref",
            "--format=%(objectname)%00%(*objectname)%00%(refname)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
        DEFAULT_TIMEOUT,
    )?
    .stdout)
}

pub fn parse_refs(output: &[u8]) -> Vec<RefInfo> {
    let text = String::from_utf8_lossy(output);
    let mut refs = Vec::new();
    for line in text.lines() {
        let mut f = line.splitn(3, '\0');
        let (Some(oid), Some(peeled), Some(name)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        let oid = if peeled.is_empty() { oid } else { peeled };
        let (kind, short) = if let Some(s) = name.strip_prefix("refs/heads/") {
            (RefKind::Branch, s)
        } else if let Some(s) = name.strip_prefix("refs/remotes/") {
            // `origin/HEAD` is a pointer, not a branch of its own.
            if s.ends_with("/HEAD") {
                continue;
            }
            (RefKind::Remote, s)
        } else if let Some(s) = name.strip_prefix("refs/tags/") {
            (RefKind::Tag, s)
        } else {
            continue;
        };
        refs.push(RefInfo {
            name: short.to_string(),
            kind,
            oid: oid.to_string(),
        });
    }
    refs
}

pub fn list_refs(root: &Path) -> Result<Vec<RefInfo>, GitError> {
    Ok(parse_refs(&refs_output(root)?))
}

/// Changes whenever any branch, remote branch or tag moves; used to decide
/// whether the history view must reload.
pub fn refs_fingerprint(root: &Path) -> Result<String, GitError> {
    Ok(fingerprint(&refs_output(root)?))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub original_path: Option<String>,
    /// `A`, `M`, `D`, `R`, `C` or `T`.
    pub status: String,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_date: String,
    pub committer_name: String,
    pub committer_email: String,
    pub committer_date: String,
    pub message: String,
    /// Changes relative to the first parent (or to nothing, for a root commit).
    pub files: Vec<CommitFile>,
}

/// `git diff-tree` base arguments comparing `oid` with its first parent.
fn tree_range(oid: &str, parents: &[String]) -> Vec<String> {
    match parents.first() {
        Some(p) => vec![p.clone(), oid.to_string()],
        None => vec!["--root".into(), oid.to_string()],
    }
}

fn parse_name_status(out: &[u8]) -> Vec<CommitFile> {
    let text = String::from_utf8_lossy(out);
    let mut fields = text.split('\0').filter(|s| !s.is_empty());
    let mut files = Vec::new();
    while let Some(status) = fields.next() {
        let code = status.chars().next().unwrap_or('M');
        let (original, path) = if code == 'R' || code == 'C' {
            let from = fields.next().unwrap_or_default().to_string();
            (Some(from), fields.next().unwrap_or_default().to_string())
        } else {
            (None, fields.next().unwrap_or_default().to_string())
        };
        files.push(CommitFile {
            path,
            original_path: original,
            status: code.to_string(),
            additions: None,
            deletions: None,
            binary: false,
        });
    }
    files
}

/// Apply `--numstat -z` output (`add\tdel\tpath\0` or `add\tdel\t\0from\0to\0`).
fn apply_numstat(files: &mut [CommitFile], out: &[u8]) {
    let text = String::from_utf8_lossy(out);
    let mut parts = text.split('\0').peekable();
    while let Some(head) = parts.next() {
        if head.is_empty() {
            continue;
        }
        let mut cols = head.splitn(3, '\t');
        let (Some(a), Some(d), Some(rest)) = (cols.next(), cols.next(), cols.next()) else {
            continue;
        };
        let path = if rest.is_empty() {
            // Rename: the next two fields are the old and new path.
            let _from = parts.next();
            parts.next().unwrap_or_default().to_string()
        } else {
            rest.to_string()
        };
        if let Some(f) = files.iter_mut().find(|f| f.path == path) {
            if a == "-" && d == "-" {
                f.binary = true;
            } else {
                f.additions = a.parse().ok();
                f.deletions = d.parse().ok();
            }
        }
    }
}

pub fn commit_details(root: &Path, oid: &str) -> Result<CommitDetails, GitError> {
    validate_oid(oid)?;
    let out = run_git(
        root,
        &[
            "show",
            "-s",
            "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B",
            oid,
            "--",
        ],
        DEFAULT_TIMEOUT,
    )?;
    let text = out.stdout_string();
    let f: Vec<&str> = text.splitn(9, '\0').collect();
    if f.len() != 9 {
        return Err(GitError::Parse(format!("bad commit record for {oid}")));
    }
    let full = f[0].to_string();
    let parents: Vec<String> = f[1].split_whitespace().map(str::to_string).collect();

    let range = tree_range(&full, &parents);
    let mut base: Vec<&str> = vec!["diff-tree", "-r", "-z", "-M", "--no-commit-id"];
    base.extend(range.iter().map(String::as_str));
    let mut ns = base.clone();
    ns.insert(1, "--name-status");
    let mut num = base.clone();
    num.insert(1, "--numstat");
    let mut files = parse_name_status(&run_git(root, &ns, DEFAULT_TIMEOUT)?.stdout);
    apply_numstat(&mut files, &run_git(root, &num, DEFAULT_TIMEOUT)?.stdout);

    Ok(CommitDetails {
        oid: full,
        parents,
        author_name: f[2].into(),
        author_email: f[3].into(),
        author_date: f[4].into(),
        committer_name: f[5].into(),
        committer_email: f[6].into(),
        committer_date: f[7].into(),
        message: f[8].trim_end().to_string(),
        files,
    })
}

/// Raw unified diff of one file in a commit, relative to its first parent.
pub fn commit_file_diff_raw(
    root: &Path,
    oid: &str,
    path: &str,
    original_path: Option<&str>,
    max_output: usize,
) -> Result<Vec<u8>, GitError> {
    validate_oid(oid)?;
    validate_relative(path)?;
    if let Some(o) = original_path {
        validate_relative(o)?;
    }
    let parents_out = run_git(
        root,
        &["rev-list", "--parents", "-n", "1", oid, "--"],
        DEFAULT_TIMEOUT,
    )?;
    let parents_line = parents_out.stdout_string();
    let mut ids = parents_line.split_whitespace();
    let full = ids
        .next()
        .ok_or_else(|| GitError::Parse(format!("unknown commit {oid}")))?
        .to_string();
    let first_parent = ids.next().map(str::to_string);

    let mut args: Vec<&str> = match &first_parent {
        Some(p) => vec!["diff", p.as_str(), full.as_str()],
        // Root commit: `show` diffs against the empty tree.
        None => vec!["show", "--format=", full.as_str()],
    };
    args.extend_from_slice(DIFF_FLAGS);
    args.push("-M");
    args.push("--");
    if let Some(o) = original_path {
        args.push(o);
    }
    args.push(path);
    Ok(run_git_with(
        root,
        &args,
        &RunOptions {
            timeout: DEFAULT_TIMEOUT,
            max_output: Some(max_output),
            ..RunOptions::default()
        },
    )?
    .stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_log_records() {
        let out = b"aaa\x00bbb ccc\x00Ann\x00ann@x\x001700000000\x00Merge: things \xe2\x9c\x93\x1e\nddd\x00\x00Bob\x00b@x\x001600000000\x00root\x1e\n";
        let c = parse_log(out).unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].parents, vec!["bbb", "ccc"]);
        assert_eq!(c[0].summary, "Merge: things \u{2713}");
        assert_eq!(c[0].author_time, 1_700_000_000);
        assert!(c[1].parents.is_empty());
        assert!(parse_log(b"broken\x1e").is_err());
    }

    #[test]
    fn parses_refs_and_peels_tags() {
        let out = b"111\x00\x00refs/heads/main\n222\x00\x00refs/remotes/origin/main\n333\x00\x00refs/remotes/origin/HEAD\n444\x00555\x00refs/tags/v1.0\n666\x00\x00refs/tags/light\n";
        let r = parse_refs(out);
        assert_eq!(r.len(), 4);
        assert_eq!(
            r[0],
            RefInfo {
                name: "main".into(),
                kind: RefKind::Branch,
                oid: "111".into()
            }
        );
        assert_eq!(r[1].kind, RefKind::Remote);
        assert_eq!(
            r[2],
            RefInfo {
                name: "v1.0".into(),
                kind: RefKind::Tag,
                oid: "555".into()
            }
        );
        assert_eq!(r[3].oid, "666");
    }

    #[test]
    fn oids_must_be_hex() {
        assert!(validate_oid("a1b2c3d").is_ok());
        assert!(validate_oid(&"f".repeat(40)).is_ok());
        for bad in ["", "abc", "HEAD", "--output=/tmp/x", "main~1", "g123456"] {
            assert!(validate_oid(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn parses_name_status_and_numstat() {
        let ns = b"M\x00a.txt\x00R100\x00old.rs\x00new.rs\x00A\x00img.png\x00";
        let mut files = parse_name_status(ns);
        assert_eq!(files.len(), 3);
        assert_eq!(files[1].original_path.as_deref(), Some("old.rs"));
        assert_eq!(files[1].status, "R");
        let num = b"3\t1\ta.txt\x000\t0\t\x00old.rs\x00new.rs\x00-\t-\timg.png\x00";
        apply_numstat(&mut files, num);
        assert_eq!((files[0].additions, files[0].deletions), (Some(3), Some(1)));
        assert_eq!(files[1].additions, Some(0));
        assert!(files[2].binary);
    }
}
