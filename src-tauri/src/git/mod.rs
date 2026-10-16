//! Git service: everything that talks to the Git CLI lives here.
//! The UI never runs Git directly; it calls the IPC commands in `commands.rs`.

pub mod branches;
pub mod commit;
pub mod diff;
pub mod log;
pub mod ops;
pub mod patch;
pub mod paths;
pub mod remote;
pub mod repository;
pub mod runner;
pub mod status;
