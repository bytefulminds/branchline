//! Branchline backend.
//!
//! Layering:
//! * `git`      - Git CLI execution, output parsing and repository models (no Tauri types).
//! * `commands` - thin async Tauri IPC layer on top of `git`.
//! * `error`    - error model serialized to the frontend.

pub mod ai;
pub mod commands;
pub mod error;
pub mod forge;
pub mod git;
pub mod measure;
pub mod open;
pub mod secrets;
pub mod settings;
pub mod shell_env;
pub mod watcher;
pub mod window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(watcher::WatcherState::default())
        .setup(|app| {
            use tauri::Manager;
            shell_env::init_in_background();
            if let Ok(dir) = app.path().app_config_dir() {
                settings::init(dir.join("settings.json"));
                forge::accounts::init(dir.join("accounts.json"));
            }
            window::create_main(app)?;
            measure::mark_window_created();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::git_version,
            commands::inspect_repository,
            commands::launch_repository_path,
            commands::measure_mode,
            commands::measure_elapsed,
            commands::finish_measurement,
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
            commands::gone_branches,
            commands::delete_gone_branches,
            commands::list_remotes,
            commands::fetch_remote,
            commands::pull_branch,
            commands::push_branch,
            commands::cancel_remote_operation,
            commands::forge_accounts,
            commands::connect_account,
            commands::disconnect_account,
            commands::review_source,
            commands::review_requests,
            commands::open_forge_page,
            commands::open_merge_request,
            commands::range_file_diff,
            commands::open_token_page,
            commands::ai_server_info,
            commands::ai_key_exists,
            commands::save_ai_key,
            commands::git_command_log,
            commands::clear_git_command_log,
            commands::suggest_commit_message,
            commands::list_stashes,
            commands::save_stash,
            commands::apply_stash,
            commands::drop_stash,
            commands::list_tags,
            commands::check_tag_name,
            commands::create_tag,
            commands::delete_tag,
            commands::push_tag,
            commands::merge_into_current,
            commands::rebase_current,
            commands::cherry_pick,
            commands::cherry_pick_many,
            commands::revert_commit,
            commands::operation_step,
            commands::conflict_file,
            commands::list_worktrees,
            commands::get_settings,
            commands::save_settings,
            commands::get_identity,
            commands::set_identity,
            commands::open_in_editor,
            commands::open_terminal,
            commands::reveal_in_file_manager,
            commands::add_remote,
            commands::edit_remote,
            commands::remove_remote,
            commands::clone_repository,
            commands::init_repository,
            commands::add_worktree,
            commands::remove_worktree,
            commands::lock_worktree,
            commands::prune_worktrees,
            commands::resolve_conflict_text,
            commands::resolve_conflict_side,
            commands::rebase_plan_commits,
            commands::rewrite_base,
            commands::suggest_rebase,
            commands::quest_plan,
            commands::quest_round,
            commands::quest_reply,
            commands::interactive_rebase,
            commands::watch_repository,
            commands::unwatch_repository,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Branchline");
}
