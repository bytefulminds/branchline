//! Branchline backend.
//!
//! Layering:
//! * `git`      - Git CLI execution, output parsing and repository models (no Tauri types).
//! * `commands` - thin async Tauri IPC layer on top of `git`.
//! * `error`    - error model serialized to the frontend.

pub mod commands;
pub mod error;
pub mod git;
pub mod watcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(watcher::WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            commands::git_version,
            commands::inspect_repository,
            commands::launch_repository_path,
            commands::file_diff,
            commands::stage_files,
            commands::unstage_files,
            commands::discard_files,
            commands::apply_lines,
            commands::log_page,
            commands::list_refs,
            commands::commit_details,
            commands::commit_file_diff,
            commands::commit_draft,
            commands::create_commit,
            commands::list_branches,
            commands::check_branch_name,
            commands::create_branch,
            commands::switch_branch,
            commands::checkout_remote_branch,
            commands::checkout_detached,
            commands::rename_branch,
            commands::delete_branch,
            commands::list_remotes,
            commands::fetch_remote,
            commands::pull_branch,
            commands::push_branch,
            commands::cancel_remote_operation,
            commands::watch_repository,
            commands::unwatch_repository,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Branchline");
}
