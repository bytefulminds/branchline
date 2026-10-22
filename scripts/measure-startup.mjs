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
