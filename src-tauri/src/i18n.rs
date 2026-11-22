use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    En = 0,
    Tr = 1,
}

impl Lang {
    pub fn from_code(code: &str) -> Option<Lang> {
        match code.trim().to_ascii_lowercase().as_str() {
            "en" => Some(Lang::En),
            "tr" => Some(Lang::Tr),
            _ => None,
        }
    }
}

static CURRENT: AtomicU8 = AtomicU8::new(Lang::En as u8);

pub fn set(lang: Lang) {
    CURRENT.store(lang as u8, Ordering::Relaxed);
}

pub fn current() -> Lang {
    if CURRENT.load(Ordering::Relaxed) == Lang::Tr as u8 {
        Lang::Tr
    } else {
        Lang::En
    }
}

fn pick<T>(en: T, tr: T) -> T {
    match current() {
        Lang::En => en,
        Lang::Tr => tr,
    }
}

pub fn folder_not_found(p: &str) -> String {
    pick(
        format!("Folder not found: {p}"),
        format!("Klasör bulunamadı: {p}"),
    )
}

pub fn folder_unreadable(e: &str) -> String {
    pick(
        format!("Can't read the folder: {e}"),
        format!("Klasör okunamadı: {e}"),
    )
}

pub fn pick_root_title() -> &'static str {
    pick(
        "Choose the folder that holds your repositories",
        "Depoların bulunduğu klasörü seçin",
    )
}

pub fn invalid_git_url() -> &'static str {
    pick("Enter a valid git URL", "Geçerli bir git adresi girin")
}

pub fn no_folder_name() -> &'static str {
    pick(
        "Can't derive a folder name from the URL",
        "Adresten klasör adı çıkarılamadı",
    )
}

pub fn folder_exists(name: &str) -> String {
    pick(
        format!("Folder “{name}” already exists"),
        format!("“{name}” klasörü zaten var"),
    )
}

pub fn git_failed(e: &str) -> String {
    pick(
        format!("Couldn't run git: {e}"),
        format!("git çalıştırılamadı: {e}"),
    )
}

pub fn clone_failed() -> &'static str {
    pick("Clone failed", "Klonlama başarısız")
}

pub fn unknown_git_error() -> &'static str {
    pick("Unknown git error", "Bilinmeyen git hatası")
}

pub fn editor_failed(editor: &str) -> String {
    pick(
        format!("Couldn't open the editor (`{editor}` not found)"),
        format!("Düzenleyici açılamadı (`{editor}` bulunamadı)"),
    )
}

pub fn terminal_failed(terminal: &str, e: &str) -> String {
    pick(
        format!("Couldn't start {terminal}: {e}"),
        format!("{terminal} başlatılamadı: {e}"),
    )
}

pub fn remote_not_openable() -> &'static str {
    pick(
        "This remote can't be opened in a browser",
        "Bu uzak adres tarayıcıda açılamıyor",
    )
}

pub fn already_up_to_date() -> &'static str {
    pick("Already up to date", "Zaten güncel")
}

pub fn pulled(n: u32) -> String {
    match current() {
        Lang::En if n == 1 => "Pulled 1 new commit".into(),
        Lang::En => format!("Pulled {n} new commits"),
        Lang::Tr => format!("{n} yeni commit çekildi"),
    }
}

pub fn no_upstream() -> &'static str {
    pick(
        "This branch has no upstream",
        "Bu branch'in uzak (upstream) karşılığı yok",
    )
}

pub fn diverged() -> &'static str {
    pick(
        "Local and remote branches have diverged; can't fast-forward",
        "Yerel ve uzak dallar ayrışmış — ileri sarılamıyor",
    )
}

pub fn local_changes_block_pull() -> &'static str {
    pick(
        "Local changes block the pull (commit or stash them)",
        "Yerel değişiklikler çekmeyi engelliyor (commit veya stash yapın)",
    )
}

pub fn remote_unreachable(e: &str) -> String {
    pick(
        format!("Can't reach the remote\n{e}"),
        format!("Uzak sunucuya erişilemedi\n{e}"),
    )
}

pub fn auth_required() -> &'static str {
    pick("Authentication required", "Kimlik doğrulama gerekli")
}

pub fn local_changes_block_checkout() -> &'static str {
    pick(
        "Local changes block switching branches",
        "Yerel değişiklikler branch değiştirmeyi engelliyor",
    )
}

pub fn invalid_branch() -> &'static str {
    pick("Invalid branch name", "Geçersiz branch adı")
}

pub fn no_update() -> &'static str {
    pick("No update available", "Güncelleme yok")
}

pub fn update_check_failed(e: &str) -> String {
    pick(
        format!("Couldn't check for updates: {e}"),
        format!("Güncelleme denetlenemedi: {e}"),
    )
}

pub fn update_failed(e: &str) -> String {
    pick(
        format!("Update failed: {e}"),
        format!("Güncelleme başarısız: {e}"),
    )
}
