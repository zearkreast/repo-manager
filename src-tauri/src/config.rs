use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub roots: Vec<String>,
    pub last_root: Option<String>,
    pub settings: Settings,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub language: String,
    pub motion: String,
    pub auto_update: bool,
    pub auto_fetch_minutes: u32,
    pub fetch_on_start: bool,
    pub pull_parallel: u32,
    pub scan_depth: u32,
    pub terminal: String,
    pub editor: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            language: "system".into(),
            motion: "system".into(),
            auto_update: true,
            auto_fetch_minutes: 0,
            fetch_on_start: false,
            pull_parallel: 4,
            scan_depth: 1,
            terminal: "auto".into(),
            editor: "code".into(),
        }
    }
}

fn one_of(value: &mut String, allowed: &[&str], fallback: &str) {
    let v = value.trim().to_ascii_lowercase();
    *value = if allowed.contains(&v.as_str()) {
        v
    } else {
        fallback.to_string()
    };
}

impl Settings {
    pub fn sanitize(mut self) -> Self {
        let d = Settings::default();
        one_of(&mut self.language, &["system", "tr", "en"], &d.language);
        one_of(&mut self.motion, &["system", "full", "reduced"], &d.motion);
        one_of(
            &mut self.terminal,
            &["auto", "wt", "pwsh", "powershell", "cmd"],
            &d.terminal,
        );
        self.auto_fetch_minutes = self.auto_fetch_minutes.min(24 * 60);
        self.pull_parallel = self.pull_parallel.clamp(1, 8);
        self.scan_depth = self.scan_depth.clamp(1, 2);
        let editor = self.editor.trim();
        self.editor = if editor.is_empty() {
            d.editor
        } else {
            editor.to_string()
        };
        self
    }
}

pub struct ConfigStore {
    file: PathBuf,
    pub data: Config,
}

impl ConfigStore {
    pub fn load(dir: PathBuf) -> Self {
        let file = dir.join("config.json");
        let existed = file.exists();
        let mut data: Config = fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        data.settings = data.settings.sanitize();

        if !existed {
            // First launch: if the app sits next to git repositories
            // (e.g. inside "Source Codes"), use that folder automatically.
            let mut candidates: Vec<PathBuf> = Vec::new();
            if let Ok(exe) = std::env::current_exe() {
                if let Some(p) = exe.parent() {
                    candidates.push(p.to_path_buf());
                }
            }
            if let Ok(cwd) = std::env::current_dir() {
                candidates.push(cwd);
            }
            for c in candidates {
                if looks_like_root(&c) {
                    let s = c.to_string_lossy().to_string();
                    if !data.roots.contains(&s) {
                        data.roots.push(s);
                    }
                }
            }
            data.last_root = data.roots.first().cloned();
        }
        let store = ConfigStore { file, data };
        if !existed {
            store.save();
        }
        store
    }

    pub fn save(&self) {
        if let Some(dir) = self.file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(s) = serde_json::to_string_pretty(&self.data) {
            let _ = fs::write(&self.file, s);
        }
    }
}

fn looks_like_root(p: &Path) -> bool {
    fs::read_dir(p)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .any(|e| e.path().is_dir() && e.path().join(".git").exists())
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_load_and_sanitize() {
        let c: Config = serde_json::from_str(r#"{"roots":["C:\\x"]}"#).unwrap();
        assert_eq!(c.settings, Settings::default());
        let s: Settings = serde_json::from_str(
            r#"{"language":"TR","terminal":"bash","pullParallel":20,"scanDepth":0,"editor":"  "}"#,
        )
        .unwrap();
        let s = s.sanitize();
        assert_eq!(s.language, "tr");
        assert_eq!(s.terminal, "auto");
        assert_eq!((s.pull_parallel, s.scan_depth), (8, 1));
        assert_eq!(s.editor, "code");
        assert!(s.auto_update);
    }
}
