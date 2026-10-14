//! Time history paging: cargo run --release --example history -- <repo>
use std::time::Instant;

fn main() {
    let repo = std::env::args().nth(1).expect("usage: history <repo>");
    let root = branchline_lib::git::repository::resolve_root(&repo).unwrap();
    for skip in [0usize, 300, 10_000, 50_000] {
        let t = Instant::now();
        let page = branchline_lib::git::log::log_page(&root, skip, 300).unwrap();
        println!(
            "skip {skip:>6}: {} commits in {:.1} ms (has_more {})",
            page.commits.len(),
            t.elapsed().as_secs_f64() * 1000.0,
            page.has_more
        );
    }
    let t = Instant::now();
    let refs = branchline_lib::git::log::list_refs(&root).unwrap();
    println!(
        "refs: {} in {:.1} ms",
        refs.len(),
        t.elapsed().as_secs_f64() * 1000.0
    );
    let t = Instant::now();
    let info = branchline_lib::git::repository::inspect(&repo).unwrap();
    println!(
        "inspect: {:.1} ms ({} changes)",
        t.elapsed().as_secs_f64() * 1000.0,
        info.total_changes
    );
}
