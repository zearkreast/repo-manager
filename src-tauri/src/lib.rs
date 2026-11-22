mod config;
mod git;
mod i18n;

use config::{ConfigStore, Settings};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;
use time::format_description::well_known::Rfc3339;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

type Store = Mutex<ConfigStore>;

fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> impl std::future::Future<Output = Result<T, String>> {
    async move {
        tauri::async_runtime::spawn_blocking(f)
            .await
            .map_err(|e| e.to_string())?
    }
}

fn existing_dir(p: &str) -> Result<PathBuf, String> {
    let pb = PathBuf::from(p);
    if pb.is_dir() {
        Ok(pb)
    } else {
        Err(i18n::folder_not_found(p))
    }
}

fn settings(store: &Store) -> Settings {
    store.lock().unwrap().data.settings.clone()
}

fn roots(store: &Store) -> Vec<String> {
    store.lock().unwrap().data.roots.clone()
}

// ------------------------------------------------------------------ info

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: &'static str,
    build: &'static str,
    channel: &'static str,
    installed: bool,
    repo_url: &'static str,
}

// The NSIS installer drops uninstall.exe next to the app; the portable exe has none.
fn is_installed() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join("uninstall.exe").is_file()))
        .unwrap_or(false)
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        build: env!("BUILD_HASH"),
        channel: "alpha",
        installed: is_installed(),
        repo_url: "https://github.com/zearkreast/repo-manager",
    }
}

// --------------------------------------------------------------- settings

#[tauri::command]
fn get_settings(store: State<Store>) -> Settings {
    settings(&store)
}

#[tauri::command]
fn set_settings(settings: Settings, store: State<Store>) -> Settings {
    let settings = settings.sanitize();
    if let Some(lang) = i18n::Lang::from_code(&settings.language) {
        i18n::set(lang);
    }
    let mut s = store.lock().unwrap();
    s.data.settings = settings.clone();
    s.save();
    settings
}

#[tauri::command]
fn set_ui_lang(lang: String) {
    i18n::set(i18n::Lang::from_code(&lang).unwrap_or(i18n::Lang::En));
}

// ------------------------------------------------------------------ roots

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RootEntry {
    path: String,
    name: String,
    exists: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RootsState {
    roots: Vec<RootEntry>,
    last_root: Option<String>,
}

fn roots_state(store: &ConfigStore) -> RootsState {
    RootsState {
        roots: store
            .data
            .roots
            .iter()
            .map(|r| {
                let p = Path::new(r);
                RootEntry {
                    path: r.clone(),
                    name: p
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| r.clone()),
                    exists: p.is_dir(),
                }
            })
            .collect(),
        last_root: store.data.last_root.clone(),
    }
}

#[tauri::command]
fn get_roots(store: State<Store>) -> RootsState {
    roots_state(&store.lock().unwrap())
}

#[tauri::command]
async fn pick_root(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = blocking(move || {
        Ok(app
            .dialog()
            .file()
            .set_title(i18n::pick_root_title())
            .blocking_pick_folder())
    })
    .await?;
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
fn add_root(path: String, store: State<Store>) -> Result<RootsState, String> {
    existing_dir(&path)?;
    let mut s = store.lock().unwrap();
    if !s.data.roots.iter().any(|r| r.eq_ignore_ascii_case(&path)) {
        s.data.roots.push(path.clone());
    }
    s.data.last_root = Some(path);
    s.save();
    Ok(roots_state(&s))
}

#[tauri::command]
fn remove_root(path: String, store: State<Store>) -> RootsState {
    let mut s = store.lock().unwrap();
    s.data.roots.retain(|r| r != &path);
    if s.data.last_root.as_deref() == Some(path.as_str()) {
        s.data.last_root = s.data.roots.first().cloned();
    }
    s.save();
    roots_state(&s)
}

#[tauri::command]
fn set_last_root(path: String, store: State<Store>) {
    let mut s = store.lock().unwrap();
    s.data.last_root = Some(path);
    s.save();
}

// ------------------------------------------------------------------ repos

fn grouped_pull(mut r: git::PullResult, roots: &[String]) -> git::PullResult {
    r.repo = git::with_group(r.repo, roots);
    r
}

#[tauri::command]
async fn scan_root(
    path: String,
    store: State<'_, Store>,
) -> Result<Vec<git::RepoInfo>, String> {
    let depth = settings(&store).scan_depth;
    blocking(move || {
        let root = existing_dir(&path)?;
        let found = git::scan(&root, depth)?;
        Ok(git::infos_parallel(&root, &found))
    })
    .await
}

#[tauri::command]
async fn repo_status(
    path: String,
    is_root: bool,
    store: State<'_, Store>,
) -> Result<git::RepoInfo, String> {
    let roots = roots(&store);
    blocking(move || {
        let info = git::repo_info(&existing_dir(&path)?, is_root);
        Ok(git::with_group(info, &roots))
    })
    .await
}

#[tauri::command]
async fn read_readme(path: String) -> Result<Option<String>, String> {
    blocking(move || Ok(git::readme(&existing_dir(&path)?))).await
}

#[tauri::command]
async fn pull(
    path: String,
    is_root: bool,
    store: State<'_, Store>,
) -> Result<git::PullResult, String> {
    let roots = roots(&store);
    blocking(move || {
        let r = git::pull(&existing_dir(&path)?, is_root);
        Ok(grouped_pull(r, &roots))
    })
    .await
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PullAllSummary {
    updated: u32,
    uptodate: u32,
    failed: u32,
}

/// Pull every repo in `repos` (`pullParallel` at once). Emits `pull-progress`
/// with a `PullResult` as each one finishes.
#[tauri::command]
async fn pull_all(
    app: AppHandle,
    repos: Vec<(String, bool)>,
    store: State<'_, Store>,
) -> Result<PullAllSummary, String> {
    let parallel = settings(&store).pull_parallel as usize;
    let roots = roots(&store);
    blocking(move || {
        let results = git::run_bounded(&repos, parallel, |(p, is_root)| {
            let _ = app.emit("pull-start", p);
            let r = grouped_pull(git::pull(Path::new(p), *is_root), &roots);
            let _ = app.emit("pull-progress", &r);
            r
        });
        let mut s = PullAllSummary {
            updated: 0,
            uptodate: 0,
            failed: 0,
        };
        for r in &results {
            match r.status.as_str() {
                "updated" => s.updated += 1,
                "uptodate" => s.uptodate += 1,
                _ => s.failed += 1,
            }
        }
        Ok(s)
    })
    .await
}

#[tauri::command]
async fn fetch(
    path: String,
    is_root: bool,
    store: State<'_, Store>,
) -> Result<git::RepoInfo, String> {
    let roots = roots(&store);
    blocking(move || {
        let info = git::fetch(&existing_dir(&path)?, is_root)?;
        Ok(git::with_group(info, &roots))
    })
    .await
}

#[tauri::command]
async fn list_branches(path: String) -> Result<git::Branches, String> {
    blocking(move || git::branches(&existing_dir(&path)?)).await
}

#[tauri::command]
async fn checkout(
    path: String,
    branch: String,
    is_root: bool,
    store: State<'_, Store>,
) -> Result<git::RepoInfo, String> {
    let roots = roots(&store);
    blocking(move || {
        let info = git::checkout(&existing_dir(&path)?, &branch, is_root)?;
        Ok(git::with_group(info, &roots))
    })
    .await
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CloneProgress {
    id: String,
    phase: String,
    percent: Option<u32>,
}

/// Parse lines like "Receiving objects:  45% (123/456), 1.2 MiB | 3 MiB/s".
fn parse_progress(line: &str) -> Option<(String, Option<u32>)> {
    let line = line.trim().trim_start_matches("remote:").trim();
    let (phase, rest) = line.split_once(':')?;
    let pct = rest
        .trim()
        .split('%')
        .next()
        .and_then(|n| n.trim().parse::<u32>().ok());
    Some((phase.trim().to_string(), pct))
}

#[tauri::command]
async fn clone_repo(app: AppHandle, root: String, url: String, id: String) -> Result<git::RepoInfo, String> {
    blocking(move || {
        let root = existing_dir(&root)?;
        let url = url.trim().to_string();
        if url.is_empty() || url.starts_with('-') {
            return Err(i18n::invalid_git_url().into());
        }
        let name = git::clone_dir_name(&url).ok_or(i18n::no_folder_name())?;
        let target = root.join(&name);
        if target.exists() {
            return Err(i18n::folder_exists(&name));
        }
        let mut child = git::git_cmd(&root)
            .args(["clone", "--progress", "--", &url, &name])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| i18n::git_failed(&e.to_string()))?;

        let mut stderr = child.stderr.take().unwrap();
        let mut log = String::new();
        let mut cur = Vec::<u8>::new();
        let mut buf = [0u8; 512];
        let mut last_emit = (String::new(), None);
        loop {
            let n = stderr.read(&mut buf).unwrap_or(0);
            if n == 0 {
                break;
            }
            for &b in &buf[..n] {
                if b == b'\r' || b == b'\n' {
                    let line = String::from_utf8_lossy(&cur).to_string();
                    cur.clear();
                    if let Some((phase, percent)) = parse_progress(&line) {
                        if (phase.clone(), percent) != last_emit {
                            last_emit = (phase.clone(), percent);
                            let _ = app.emit(
                                "clone-progress",
                                CloneProgress { id: id.clone(), phase, percent },
                            );
                        }
                    }
                    if b == b'\n' {
                        log.push_str(&line);
                        log.push('\n');
                    }
                } else {
                    cur.push(b);
                }
            }
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() {
            let msg: Vec<&str> = log
                .lines()
                .filter(|l| l.starts_with("fatal") || l.starts_with("error"))
                .collect();
            let msg = if msg.is_empty() { log.trim().to_string() } else { msg.join("\n") };
            return Err(if msg.is_empty() { i18n::clone_failed().into() } else { msg });
        }
        Ok(git::repo_info(&target, false))
    })
    .await
}

// ------------------------------------------------------------------ shell

fn spawn_detached(mut c: Command) -> Result<(), String> {
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let p = existing_dir(&path)?;
    #[cfg(windows)]
    {
        let mut c = Command::new("explorer");
        c.arg(&p);
        spawn_detached(c)
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("xdg-open");
        c.arg(&p);
        spawn_detached(c)
    }
}

#[cfg(windows)]
fn new_console(exe: &str, args: &[&str], dir: &Path) -> Result<(), String> {
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    let mut c = Command::new(exe);
    c.args(args)
        .current_dir(dir)
        .creation_flags(CREATE_NEW_CONSOLE);
    c.spawn()
        .map(|_| ())
        .map_err(|e| i18n::terminal_failed(exe, &e.to_string()))
}

#[tauri::command]
fn open_terminal(path: String, store: State<Store>) -> Result<(), String> {
    let p = existing_dir(&path)?;
    let terminal = settings(&store).terminal;
    #[cfg(windows)]
    {
        let wt = || {
            let mut c = Command::new("wt");
            c.arg("-d").arg(&p);
            spawn_detached(c).map_err(|e| i18n::terminal_failed("Windows Terminal", &e))
        };
        match terminal.as_str() {
            "wt" => wt(),
            "pwsh" | "powershell" => new_console(terminal.as_str(), &["-NoExit"], &p),
            "cmd" => new_console("cmd", &[], &p),
            _ => wt().or_else(|_| new_console("cmd", &[], &p)),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = terminal;
        let mut c = Command::new("x-terminal-emulator");
        c.current_dir(&p);
        spawn_detached(c)
    }
}

#[cfg(windows)]
fn launch_editor(editor: &str, p: &Path) -> Result<(), String> {
    use std::time::{Duration, Instant};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let fail = || i18n::editor_failed(editor);
    let mut dir = p.display().to_string();
    if dir.ends_with('\\') {
        dir.push('.');
    }
    // cmd /C strips one outer pair of quotes, so the quoted editor and path get
    // an extra pair around them; going through cmd lets .cmd shims like code.cmd run.
    let mut c = Command::new("cmd");
    c.arg("/C")
        .raw_arg(format!("\"\"{editor}\" \"{dir}\"\""))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    let mut child = c.spawn().map_err(|_| fail())?;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(10) {
        match child.try_wait() {
            Ok(Some(st)) if st.success() => return Ok(()),
            Ok(Some(_)) | Err(_) => return Err(fail()),
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn launch_editor(editor: &str, p: &Path) -> Result<(), String> {
    let mut c = Command::new(editor);
    c.arg(p);
    spawn_detached(c).map_err(|_| i18n::editor_failed(editor))
}

#[tauri::command]
async fn open_editor(path: String, store: State<'_, Store>) -> Result<(), String> {
    let editor = settings(&store).editor;
    blocking(move || {
        let p = existing_dir(&path)?;
        let editor = editor.trim().trim_matches('"').trim();
        launch_editor(if editor.is_empty() { "code" } else { editor }, &p)
    })
    .await
}

#[tauri::command]
fn open_remote(remote: String) -> Result<(), String> {
    let url = git::web_url(&remote).ok_or(i18n::remote_not_openable())?;
    #[cfg(windows)]
    {
        let mut c = Command::new("explorer");
        c.arg(&url);
        spawn_detached(c)
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("xdg-open");
        c.arg(&url);
        spawn_detached(c)
    }
}

// ----------------------------------------------------------------- update

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
    date: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let fail = |e: tauri_plugin_updater::Error| i18n::update_check_failed(&e.to_string());
    let update = app.updater().map_err(fail)?.check().await.map_err(fail)?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
        date: u.date.and_then(|d| d.format(&Rfc3339).ok()),
    }))
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    use std::time::{Duration, Instant};
    let fail = |e: tauri_plugin_updater::Error| i18n::update_failed(&e.to_string());
    let update = app
        .updater()
        .map_err(fail)?
        .check()
        .await
        .map_err(fail)?
        .ok_or_else(|| i18n::no_update().to_string())?;
    let emitter = app.clone();
    let mut downloaded: u64 = 0;
    let mut last_emit: Option<Instant> = None;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let finished = total.is_some_and(|t| downloaded >= t);
                let due = last_emit.map_or(true, |t| t.elapsed() >= Duration::from_millis(100));
                if finished || due {
                    last_emit = Some(Instant::now());
                    let progress = UpdateProgress { downloaded, total };
                    let _ = emitter.emit("update-progress", progress);
                }
            },
            || {},
        )
        .await
        .map_err(fail)?;
    app.restart()
}

// ------------------------------------------------------------------ main

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("repo-manager"));
            let store = ConfigStore::load(dir);
            if let Some(lang) = i18n::Lang::from_code(&store.data.settings.language) {
                i18n::set(lang);
            }
            app.manage::<Store>(Mutex::new(store));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            get_settings,
            set_settings,
            set_ui_lang,
            get_roots,
            pick_root,
            add_root,
            remove_root,
            set_last_root,
            scan_root,
            repo_status,
            read_readme,
            pull,
            pull_all,
            fetch,
            list_branches,
            checkout,
            clone_repo,
            open_folder,
            open_terminal,
            open_editor,
            open_remote,
            check_update,
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("Repo Manager failed to start");
}
