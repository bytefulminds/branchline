//! Branchline backend.
//!
//! Layering:
//! * `git`      - Git CLI execution, output parsing and repository models (no Tauri types).
//! * `commands` - thin async Tauri IPC layer on top of `git`.
//! * `error`    - error model serialized to the frontend.

pub mod commands;
pub mod error;
pub mod git;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::git_version,
            commands::inspect_repository,
            commands::launch_repository_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Branchline");
}
