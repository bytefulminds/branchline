//! Git service: everything that talks to the Git CLI lives here.
//! The UI never runs Git directly; it calls the IPC commands in `commands.rs`.

pub mod repository;
pub mod runner;
pub mod status;
