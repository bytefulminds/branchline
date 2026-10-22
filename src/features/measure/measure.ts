/**
 * Startup and interaction timing, run when Branchline is started with
 * `--measure-startup=<file.json> <repository>` (see docs/performance.md).
 *
 * Each step does what a person would do and waits until the result is on screen (a frame
 * has been painted), so the numbers include rendering, not only Git.
 */
import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceView } from "../../layouts/Sidebar";

export interface MeasureSteps {
  setView: (view: WorkspaceView) => void;
  openPalette: () => void;
  closePalette: () => void;
}

let enabled: Promise<boolean> | null = null;

/** Whether this run measures startup (asked once). */
export function isMeasuring(): Promise<boolean> {
  enabled ??= invoke<boolean>("measure_mode").catch(() => false);
  return enabled;
}

const elapsed = () => invoke<number>("measure_elapsed");

/** Resolves after the next painted frame. */
const painted = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

async function until(selector: string, timeoutMs = 30_000): Promise<Element> {
  const end = performance.now() + timeoutMs;
  for (;;) {
    const el = document.querySelector(selector);
    if (el) {
      await painted();
      return el;
    }
    if (performance.now() > end) throw new Error(`Timed out waiting for ${selector}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Time one interaction: start it, then wait until `selector` is on screen. */
async function timed(start: () => void, selector: string): Promise<number> {
  const t0 = performance.now();
  start();
  await until(selector);
  return Math.round((performance.now() - t0) * 10) / 10;
}

/** Called once React has painted the first frame. */
export async function markFirstFrame(): Promise<number | null> {
  if (!(await isMeasuring())) return null;
  await painted();
  return elapsed();
}

/** Run the scenario once the repository is open, then hand the report to the backend. */
export async function runMeasurement(steps: MeasureSteps, firstFrameMs: number | null) {
  const report: Record<string, unknown> = { firstFrameMs };
  try {
    await until('[role="listbox"][aria-label="Changed files"], .bl-empty');
    report.repoReadyMs = await elapsed();
    report.historyMs = await timed(
      () => steps.setView("history"),
      '[role="listbox"][aria-label="Commits"] [role="option"], .bl-empty',
    );
    report.changesMs = await timed(
      () => steps.setView("changes"),
      '[role="listbox"][aria-label="Changed files"], .bl-empty',
    );
    const file = document.querySelector<HTMLElement>(
      '[role="listbox"][aria-label="Changed files"] [role="option"]',
    );
    report.diffMs = file
      ? await timed(() => file.click(), ".bl-diff-row, .bl-diff .bl-empty")
      : null;
    report.paletteMs = await timed(
      steps.openPalette,
      '[role="dialog"][aria-label="Command palette"]',
    );
    steps.closePalette();
    report.totalMs = await elapsed();
  } catch (e) {
    report.error = String(e);
  }
  await invoke("finish_measurement", { report });
}
