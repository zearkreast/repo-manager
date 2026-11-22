//! Thin wrapper around the `git` command line.
//! Kept free of Tauri types so it can be unit-tested on its own.

use crate::i18n;
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Build a `git` command that never opens a console window and never blocks on a
/// terminal prompt.
pub fn git_cmd(dir: &Path) -> Command {
    let mut c = Command::new("git");
    c.current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Run git and return trimmed stdout, or a readable error.
pub fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = git_cmd(dir)
        .args(args)
        .output()
        .map_err(|e| i18n::git_failed(&e.to_string()))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            err
        };
        Err(clean_error(&err))
    }
}

fn clean_error(s: &str) -> String {
    let lines: Vec<&str> = s
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with("hint:"))
        .collect();
    let joined = lines.join("\n");
    if joined.is_empty() {
        i18n::unknown_git_error().into()
    } else {
        joined
    }
}

pub fn is_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LastCommit {
    pub hash: String,
    pub subject: String,
    pub author: String,
    /// unix seconds
    pub time: i64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub name: String,
    pub group: Option<String>,
    pub path: String,
    pub is_root: bool,
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changes: u32,
    pub detached: bool,
    pub description: String,
    pub has_readme: bool,
    pub last_commit: Option<LastCommit>,
    pub remote_url: Option<String>,
    pub error: Option<String>,
}

#[derive(Default, Debug, PartialEq)]
pub struct StatusHeader {
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub detached: bool,
}

/// Parse the first line of `git status --porcelain=v1 -b`.
pub fn parse_status_header(line: &str) -> StatusHeader {
    let mut h = StatusHeader::default();
    let l = line.trim_start_matches("## ").trim();
    if let Some(rest) = l.strip_prefix("No commits yet on ") {
        h.branch = rest.to_string();
        return h;
    }
    if l.starts_with("HEAD (no branch)") {
        h.branch = "HEAD".into();
        h.detached = true;
        return h;
    }
    let (names, track) = match l.find(" [") {
        Some(i) => (&l[..i], Some(&l[i + 2..l.len().saturating_sub(1)])),
        None => (l, None),
    };
    match names.split_once("...") {
        Some((b, u)) => {
            h.branch = b.to_string();
            h.upstream = Some(u.to_string());
        }
        None => h.branch = names.to_string(),
    }
    if let Some(t) = track {
        for part in t.split(", ") {
            if let Some(n) = part.strip_prefix("ahead ") {
                h.ahead = n.parse().unwrap_or(0);
            } else if let Some(n) = part.strip_prefix("behind ") {
                h.behind = n.parse().unwrap_or(0);
            }
        }
    }
    h
}

pub fn repo_info(dir: &Path, is_root: bool) -> RepoInfo {
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| dir.to_string_lossy().to_string());
    let mut info = RepoInfo {
        name,
        path: dir.to_string_lossy().to_string(),
        is_root,
        ..Default::default()
    };

    match git(dir, &["status", "--porcelain=v1", "-b", "--untracked-files=normal"]) {
        Ok(out) => {
            let mut lines = out.lines();
            if let Some(first) = lines.next() {
                let h = parse_status_header(first);
                info.branch = h.branch;
                info.upstream = h.upstream;
                info.ahead = h.ahead;
                info.behind = h.behind;
                info.detached = h.detached;
            }
            info.changes = lines.filter(|l| !l.trim().is_empty()).count() as u32;
        }
        Err(e) => info.error = Some(e),
    }

    if let Ok(out) = git(dir, &["log", "-1", "--format=%h%x1f%s%x1f%an%x1f%ct"]) {
        let p: Vec<&str> = out.split('\u{1f}').collect();
        if p.len() == 4 {
            info.last_commit = Some(LastCommit {
                hash: p[0].into(),
                subject: p[1].into(),
                author: p[2].into(),
                time: p[3].trim().parse().unwrap_or(0),
            });
        }
    }

    info.remote_url = git(dir, &["remote", "get-url", "origin"])
        .ok()
        .filter(|s| !s.is_empty());

    let (desc, has_readme) = description(dir);
    info.description = desc;
    info.has_readme = has_readme;
    info
}

pub struct Found {
    pub path: PathBuf,
    pub group: Option<String>,
}

impl Found {
    pub fn display_name(&self) -> String {
        let n = file_name(&self.path);
        match &self.group {
            Some(g) => format!("{g}/{n}"),
            None => n,
        }
    }
}

fn file_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn descendable(p: &Path) -> bool {
    let n = file_name(p);
    !n.starts_with('.') && !n.eq_ignore_ascii_case("node_modules")
}

fn subdirs(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    Ok(fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect())
}

/// Repositories directly under `root`; with `depth` 2 also those one level
/// inside sub-folders that are not repos themselves (grouped by that folder).
pub fn scan(root: &Path, depth: u32) -> Result<Vec<Found>, String> {
    let dirs = subdirs(root).map_err(|e| i18n::folder_unreadable(&e.to_string()))?;
    let mut found = Vec::new();
    for d in dirs {
        if is_repo(&d) {
            found.push(Found {
                path: d,
                group: None,
            });
        } else if depth >= 2 && descendable(&d) {
            let group = file_name(&d);
            for sub in subdirs(&d).unwrap_or_default() {
                if is_repo(&sub) {
                    found.push(Found {
                        path: sub,
                        group: Some(group.clone()),
                    });
                }
            }
        }
    }
    found.sort_by_key(|f| f.display_name().to_lowercase());
    Ok(found)
}

fn set_group(info: &mut RepoInfo, group: Option<String>) {
    if let Some(g) = &group {
        info.name = format!("{g}/{}", info.name);
    }
    info.group = group;
}

fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        p.to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    };
    norm(a) == norm(b)
}

/// The group a depth-2 scan would give `dir`, so single-repo refreshes keep
/// the same name as the list.
pub fn group_for(dir: &Path, roots: &[String]) -> Option<String> {
    let parent = dir.parent()?;
    let grand = parent.parent()?;
    let is_root = |p: &Path| roots.iter().any(|r| same_path(Path::new(r), p));
    if is_root(parent) || !is_root(grand) || is_repo(parent) || !descendable(parent) {
        return None;
    }
    Some(file_name(parent))
}

pub fn with_group(mut info: RepoInfo, roots: &[String]) -> RepoInfo {
    if !info.is_root {
        let g = group_for(Path::new(&info.path), roots);
        set_group(&mut info, g);
    }
    info
}

pub fn infos_parallel(root: &Path, found: &[Found]) -> Vec<RepoInfo> {
    let mut jobs: Vec<(PathBuf, bool, Option<String>)> = Vec::new();
    if is_repo(root) {
        jobs.push((root.to_path_buf(), true, None));
    }
    jobs.extend(found.iter().map(|f| (f.path.clone(), false, f.group.clone())));
    run_bounded(&jobs, 8, |(p, r, g)| {
        let mut info = repo_info(p, *r);
        set_group(&mut info, g.clone());
        info
    })
}

/// Map over `items` using at most `max` worker threads, preserving order.
pub fn run_bounded<T: Sync, R: Send, F: Fn(&T) -> R + Sync>(
    items: &[T],
    max: usize,
    f: F,
) -> Vec<R> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<R>>> = Mutex::new((0..items.len()).map(|_| None).collect());
    let workers = max.max(1).min(items.len().max(1));
    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                if i >= items.len() {
                    break;
                }
                let r = f(&items[i]);
                results.lock().unwrap()[i] = Some(r);
            });
        }
    });
    results.into_inner().unwrap().into_iter().flatten().collect()
}

// ---------------------------------------------------------------- README

fn find_readme(dir: &Path) -> Option<PathBuf> {
    let rd = fs::read_dir(dir).ok()?;
    let mut found: Vec<PathBuf> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .map(|n| n.to_string_lossy().to_lowercase().starts_with("readme"))
                    .unwrap_or(false)
        })
        .collect();
    found.sort_by_key(|p| {
        let n = p.file_name().unwrap().to_string_lossy().to_lowercase();
        match n.as_str() {
            "readme.md" => 0,
            "readme" => 1,
            "readme.txt" => 2,
            _ => 3,
        }
    });
    found.into_iter().next()
}

fn read_limited(p: &Path, max: usize) -> Option<String> {
    let mut f = fs::File::open(p).ok()?;
    let mut buf = Vec::with_capacity(max.min(64 * 1024));
    f.by_ref().take(max as u64).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).replace("\r\n", "\n"))
}

pub fn readme(dir: &Path) -> Option<String> {
    find_readme(dir).and_then(|p| read_limited(&p, 48 * 1024))
}

/// Strip common inline markdown so a sentence reads cleanly.
pub fn strip_inline_md(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // [text](url) / ![alt](url)
        if c == '!' && chars.get(i + 1) == Some(&'[') {
            i += 1;
            continue;
        }
        if c == '[' {
            if let Some(close) = chars[i..].iter().position(|&x| x == ']') {
                let close = i + close;
                if chars.get(close + 1) == Some(&'(') {
                    if let Some(pc) = chars[close..].iter().position(|&x| x == ')') {
                        out.extend(&chars[i + 1..close]);
                        i = close + pc + 1;
                        continue;
                    }
                }
            }
        }
        if c == '*' || c == '`' || (c == '_' && (i == 0 || chars.get(i + 1) == Some(&'_'))) {
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The README's introduction: every paragraph before the first section
/// heading / code block that follows real text (capped at ~1500 chars).
pub fn summarize_readme(text: &str) -> String {
    let mut paras: Vec<String> = Vec::new();
    let mut cur: Vec<String> = Vec::new();
    let mut in_code = false;
    let mut in_html_comment = false;
    let flush = |cur: &mut Vec<String>, paras: &mut Vec<String>| {
        if !cur.is_empty() {
            paras.push(cur.join(" "));
            cur.clear();
        }
    };
    for raw in text.lines() {
        let l = raw.trim();
        if l.starts_with("```") || l.starts_with("~~~") {
            if !paras.is_empty() || !cur.is_empty() {
                break;
            }
            in_code = !in_code;
            continue;
        }
        if in_code {
            continue;
        }
        if in_html_comment {
            if l.contains("-->") {
                in_html_comment = false;
            }
            continue;
        }
        if l.starts_with("<!--") {
            in_html_comment = !l.contains("-->");
            continue;
        }
        if l.starts_with('#') || l.starts_with("---") || l.starts_with("===") || l.starts_with("***") {
            if !paras.is_empty() || !cur.is_empty() {
                break;
            }
            continue;
        }
        let skip = l.starts_with('<')
            || l.starts_with("[!")
            || l.starts_with("![")
            || l.starts_with('|')
            || (l.starts_with('[') && l.contains("]: "));
        if l.is_empty() || skip {
            flush(&mut cur, &mut paras);
            continue;
        }
        let is_item = l.starts_with("- ") || l.starts_with("* ") || l.starts_with("+ ");
        let body = l.trim_start_matches('>').trim_start_matches(['-', '*', '+']).trim();
        let s = strip_inline_md(body);
        if s.is_empty() {
            continue;
        }
        if is_item {
            flush(&mut cur, &mut paras);
            paras.push(format!("• {s}"));
        } else {
            cur.push(s);
        }
    }
    flush(&mut cur, &mut paras);
    // list items stay on their own lines, paragraphs get a blank line between
    let mut out = String::new();
    for (i, p) in paras.iter().enumerate() {
        if i > 0 {
            let both_items = p.starts_with("• ") && paras[i - 1].starts_with("• ");
            out.push_str(if both_items { "\n" } else { "\n\n" });
        }
        out.push_str(p);
    }
    if out.chars().count() > 1500 {
        out = out.chars().take(1497).collect::<String>() + "…";
    }
    out
}

/// (description, has_readme)
pub fn description(dir: &Path) -> (String, bool) {
    if let Some(text) = readme(dir) {
        let s = summarize_readme(&text);
        if !s.is_empty() {
            return (s, true);
        }
        let d = git_description(dir);
        return (d, true);
    }
    (git_description(dir), false)
}

fn git_description(dir: &Path) -> String {
    let p = dir.join(".git").join("description");
    match fs::read_to_string(p) {
        Ok(s) if !s.starts_with("Unnamed repository") => s.trim().to_string(),
        _ => String::new(),
    }
}

// ---------------------------------------------------------------- actions

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    /// "updated" | "uptodate" | "error"
    pub status: String,
    pub commits: u32,
    pub message: String,
    pub repo: RepoInfo,
}

pub fn pull(dir: &Path, is_root: bool) -> PullResult {
    let before = git(dir, &["rev-parse", "HEAD"]).ok();
    let res = git(dir, &["pull", "--ff-only", "--no-rebase"]);
    let after = git(dir, &["rev-parse", "HEAD"]).ok();
    let repo = repo_info(dir, is_root);
    match res {
        Err(e) => PullResult {
            status: "error".into(),
            commits: 0,
            message: friendly_pull_error(&e),
            repo,
        },
        Ok(_) if before == after => PullResult {
            status: "uptodate".into(),
            commits: 0,
            message: i18n::already_up_to_date().into(),
            repo,
        },
        Ok(_) => {
            let commits = match (&before, &after) {
                (Some(b), Some(a)) => git(dir, &["rev-list", "--count", &format!("{b}..{a}")])
                    .ok()
                    .and_then(|s| s.trim().parse().ok())
                    .unwrap_or(0),
                _ => 0,
            };
            PullResult {
                status: "updated".into(),
                commits,
                message: i18n::pulled(commits),
                repo,
            }
        }
    }
}

fn friendly_pull_error(e: &str) -> String {
    let low = e.to_lowercase();
    if low.contains("no tracking information") || low.contains("no such ref was fetched") {
        i18n::no_upstream().into()
    } else if low.contains("not possible to fast-forward") || low.contains("diverging branches") {
        i18n::diverged().into()
    } else if low.contains("would be overwritten") || low.contains("local changes") {
        i18n::local_changes_block_pull().into()
    } else if low.contains("could not read from remote") || low.contains("unable to access") {
        i18n::remote_unreachable(e)
    } else if low.contains("authentication") || low.contains("terminal prompts disabled") {
        i18n::auth_required().into()
    } else {
        e.to_string()
    }
}

pub fn fetch(dir: &Path, is_root: bool) -> Result<RepoInfo, String> {
    git(dir, &["fetch", "--all", "--prune"])?;
    Ok(repo_info(dir, is_root))
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    pub current: String,
    pub local: Vec<String>,
    pub remote: Vec<String>,
}

pub fn branches(dir: &Path) -> Result<Branches, String> {
    let current = git(dir, &["branch", "--show-current"]).unwrap_or_default();
    let local: Vec<String> = git(dir, &["branch", "--format=%(refname:short)"])?
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && !s.starts_with('('))
        .collect();
    let remote: Vec<String> = git(dir, &["branch", "-r", "--format=%(refname:short)"])
        .unwrap_or_default()
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| {
            !s.is_empty()
                && !s.ends_with("/HEAD")
                && s.contains('/')
                && !local.iter().any(|l| s.split_once('/').map(|x| x.1) == Some(l.as_str()))
        })
        .collect();
    Ok(Branches {
        current,
        local,
        remote,
    })
}

pub fn checkout(dir: &Path, branch: &str, is_root: bool) -> Result<RepoInfo, String> {
    if branch.starts_with('-') {
        return Err(i18n::invalid_branch().into());
    }
    // "origin/feature" -> create local tracking branch "feature"
    let target = match git(dir, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]) {
        Ok(_) => branch.to_string(),
        Err(_) => branch
            .split_once('/')
            .map(|(_, b)| b.to_string())
            .unwrap_or_else(|| branch.to_string()),
    };
    git(dir, &["switch", &target]).map_err(|e| {
        if e.to_lowercase().contains("would be overwritten") {
            i18n::local_changes_block_checkout().into()
        } else {
            e
        }
    })?;
    Ok(repo_info(dir, is_root))
}

/// Folder name git would choose for a clone URL.
pub fn clone_dir_name(url: &str) -> Option<String> {
    let u = url.trim().trim_end_matches('/');
    let u = u.strip_suffix(".git").unwrap_or(u);
    let last = u.rsplit(['/', ':', '\\']).next()?.trim();
    if last.is_empty() || last == "." || last == ".." {
        None
    } else {
        Some(last.to_string())
    }
}

/// Turn a remote URL into something a browser can open.
pub fn web_url(remote: &str) -> Option<String> {
    let r = remote.trim();
    let r = r.strip_suffix(".git").unwrap_or(r);
    if r.starts_with("http://") || r.starts_with("https://") {
        // drop embedded credentials
        if let Some((scheme, rest)) = r.split_once("://") {
            let rest = rest.split_once('@').map(|(_, h)| h).filter(|_| rest.find('@') < rest.find('/')).unwrap_or(rest);
            return Some(format!("{scheme}://{rest}"));
        }
    }
    if let Some(rest) = r.strip_prefix("ssh://") {
        let rest = rest.split_once('@').map(|(_, h)| h).unwrap_or(rest);
        let (host, path) = rest.split_once('/')?;
        let host = host.split(':').next()?;
        return Some(format!("https://{host}/{path}"));
    }
    // scp-like: git@host:user/repo
    if let Some((left, path)) = r.split_once(':') {
        if !left.contains('/') && !left.contains('\\') && left.len() > 1 {
            let host = left.split_once('@').map(|(_, h)| h).unwrap_or(left);
            return Some(format!("https://{host}/{}", path.trim_start_matches('/')));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_parsing() {
        let h = parse_status_header("## main...origin/main [ahead 2, behind 3]");
        assert_eq!(h.branch, "main");
        assert_eq!(h.upstream.as_deref(), Some("origin/main"));
        assert_eq!((h.ahead, h.behind), (2, 3));
        let h = parse_status_header("## dev");
        assert_eq!(h.branch, "dev");
        assert_eq!(h.upstream, None);
        let h = parse_status_header("## No commits yet on main");
        assert_eq!(h.branch, "main");
        let h = parse_status_header("## HEAD (no branch)");
        assert!(h.detached);
        let h = parse_status_header("## main...origin/main [gone]");
        assert_eq!((h.ahead, h.behind), (0, 0));
    }

    #[test]
    fn readme_summary() {
        let t = "# Title\n\n[![CI](x)](y) ![badge](z)\n\n<p align=center>logo</p>\n\nA **fast** tool for [things](http://x).\nSecond line.\n\nMore.";
        assert_eq!(summarize_readme(t), "A fast tool for things. Second line.\n\nMore.");
        let t2 = "# T\n\nIntro.\n\n- one\n- two\n\n## Install\n\nnpm i";
        assert_eq!(summarize_readme(t2), "Intro.\n\n• one\n• two");
        assert_eq!(summarize_readme("# Only title\n"), "");
    }

    #[test]
    fn urls() {
        assert_eq!(clone_dir_name("https://site.example/a/b.git").as_deref(), Some("b"));
        assert_eq!(clone_dir_name("git@github.com:u/repo.git").as_deref(), Some("repo"));
        assert_eq!(clone_dir_name("https://x/y/").as_deref(), Some("y"));
        assert_eq!(web_url("git@github.com:u/repo.git").as_deref(), Some("https://github.com/u/repo"));
        assert_eq!(web_url("https://tok@gitlab.com/u/r.git").as_deref(), Some("https://gitlab.com/u/r"));
        assert_eq!(web_url("ssh://git@host:22/u/r.git").as_deref(), Some("https://host/u/r"));
        assert_eq!(web_url("/local/path"), None);
    }

    #[test]
    fn scan_depth() {
        let root = std::env::temp_dir().join(format!("rm-scan-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for d in [
            "b-repo/.git",
            "Group/a-repo/.git",
            "Group/plain",
            ".hidden/x/.git",
            "node_modules/y/.git",
        ] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        let names = |depth| -> Vec<String> {
            scan(&root, depth)
                .unwrap()
                .iter()
                .map(Found::display_name)
                .collect()
        };
        assert_eq!(names(1), ["b-repo"]);
        assert_eq!(names(2), ["b-repo", "Group/a-repo"]);
        let roots = [root.to_string_lossy().to_string()];
        assert_eq!(
            group_for(&root.join("Group").join("a-repo"), &roots).as_deref(),
            Some("Group")
        );
        assert_eq!(group_for(&root.join("b-repo"), &roots), None);
        let _ = fs::remove_dir_all(&root);
    }
}
