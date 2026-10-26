#!/usr/bin/env node
/**
 * Measure startup and interaction times of a built Branchline.
 *
 *   node scripts/measure-startup.mjs <branchline binary> <repository> [runs=5] [out.json]
 *
 * Starts the app `runs` times with `--measure-startup`, which opens the repository, shows
 * History, a diff and the command palette, then quits. Prints the median of every step
 * and writes all runs plus the medians to `out.json` (default: perf-report.json).
 * On Linux without a display, run it under `xvfb-run -a`.
 *
 * On Windows the app needs a desktop session: a GitLab runner installed as a service runs in
 * session 0, where WebView2 cannot start (HRESULT 0x80080005). There the script reports the
 * measurement as skipped, writes that to `out.json` and exits successfully. See
 * docs/performance.md for running the runner in a logged-in session instead.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [binary, repository, runsArg = "5", outArg = "perf-report.json"] = process.argv.slice(2);
if (!binary || !repository) {
  console.error("usage: measure-startup.mjs <branchline binary> <repository> [runs] [out.json]");
  process.exit(2);
}
const runs = Math.max(1, Number(runsArg) || 5);

/** Session id of this process on Windows (0 for services), or null when unknown. */
function windowsSession() {
  const ps = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id $PID).SessionId"],
    { encoding: "utf8", timeout: 30_000 },
  );
  const id = Number.parseInt(ps.stdout?.trim() ?? "", 10);
  return ps.status === 0 && Number.isInteger(id) ? id : null;
}

if (process.platform === "win32" && windowsSession() === 0) {
  const reason =
    "No desktop session: this runs in Windows session 0 (a service), where WebView2 cannot " +
    "open a window. Run the GitLab runner in a logged-in session to measure on Windows.";
  console.log(`Measurement skipped. ${reason}`);
  writeFileSync(outArg, JSON.stringify({ os: "windows", skipped: true, reason }, null, 2));
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "branchline-measure-"));
const results = [];

for (let i = 0; i < runs; i++) {
  const file = join(dir, `run-${i}.json`);
  const run = spawnSync(resolve(binary), [`--measure-startup=${file}`, resolve(repository)], {
    stdio: "inherit",
    timeout: 120_000,
  });
  if (run.error || run.status !== 0) {
    console.error(`run ${i + 1} failed:`, run.error?.message ?? `exit ${run.status}`);
    continue;
  }
  const report = JSON.parse(readFileSync(file, "utf8"));
  if (report.error) console.error(`run ${i + 1}:`, report.error);
  results.push(report);
}
rmSync(dir, { recursive: true, force: true });
if (results.length === 0) {
  console.error("No run finished.");
  process.exit(1);
}

const STEPS = [
  ["windowCreatedMs", "Window created (from process start)"],
  ["firstFrameMs", "First frame painted (from process start)"],
  ["repoReadyMs", "Repository open and shown (from process start)"],
  ["historyMs", "Switch to History"],
  ["changesMs", "Switch back to Changes"],
  ["diffMs", "Open a diff"],
  ["paletteMs", "Open the command palette"],
];
const median = (values) => {
  const v = values.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return Math.round((v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) * 10) / 10;
};
const medians = Object.fromEntries(STEPS.map(([k]) => [k, median(results.map((r) => r[k]))]));
const { os, arch, version, build } = results[0];

console.log(
  `\nBranchline ${version} (${build}) on ${os}/${arch}, ${results.length} runs, median:\n`,
);
console.log("| Step | Median |\n|---|---|");
for (const [key, label] of STEPS)
  console.log(`| ${label} | ${medians[key] === null ? "n/a" : `${medians[key]} ms`} |`);

writeFileSync(
  outArg,
  JSON.stringify({ os, arch, version, build, runs: results, medians }, null, 2),
);
console.log(`\nWrote ${outArg}`);
