// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    branchline_lib::measure::mark_process_start();
    branchline_lib::run()
}
