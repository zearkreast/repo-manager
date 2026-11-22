use std::process::Command;

fn main() {
    let hash = std::env::var("BUILD_HASH").ok().filter(|s| !s.is_empty()).or_else(|| {
        Command::new("git")
            .args(["rev-parse", "--short=6", "HEAD"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    });
    println!("cargo:rustc-env=BUILD_HASH={}", hash.unwrap_or_else(|| "dev".into()));
    println!("cargo:rerun-if-changed=../.git/HEAD");
    if let Ok(head) = std::fs::read_to_string("../.git/HEAD") {
        if let Some(r) = head.trim().strip_prefix("ref: ") {
            println!("cargo:rerun-if-changed=../.git/{r}");
        }
    }
    println!("cargo:rerun-if-env-changed=BUILD_HASH");
    tauri_build::build()
}
