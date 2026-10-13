//! Measure repository inspection outside the UI.
//!
//! cargo run --release --example inspect -- <repo-path> [iterations]
use std::time::Instant;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .expect("usage: inspect <repo-path> [iterations]");
    let iterations: usize = args.next().and_then(|n| n.parse().ok()).unwrap_or(5);
    let mut times = Vec::with_capacity(iterations);
    let mut last = None;
    for _ in 0..iterations {
        let t = Instant::now();
        let info = branchline_lib::git::repository::inspect(&path).expect("inspect failed");
        times.push(t.elapsed().as_secs_f64() * 1000.0);
        last = Some(info);
    }
    let info = last.unwrap();
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "{}: {} changed paths (returned {}), head {:?}",
        info.path,
        info.total_changes,
        info.changes.len(),
        info.head
    );
    println!(
        "inspect ms over {} runs: min {:.1}, median {:.1}, max {:.1}",
        times.len(),
        times[0],
        times[times.len() / 2],
        times[times.len() - 1]
    );
}
