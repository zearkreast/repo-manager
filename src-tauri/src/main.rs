// Release builds: no console window behind the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    repo_manager_lib::run()
}
