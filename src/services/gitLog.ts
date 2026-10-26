import { call } from "./git";

/** Mirrors `CommandEntry` in `src-tauri/src/git/command_log.rs`. */
export interface GitLogEntry {
  id: number;
  /** Changes whenever the entry changes; ask for entries after the highest one seen. */
  seq: number;
  /** Milliseconds since the Unix epoch. */
  startedAt: number;
  /** null while running. */
  durationMs: number | null;
  cwd: string;
  /** Arguments after `git`. */
  args: string[];
  readOnly: boolean;
  exitCode: number | null;
  /** null while running. */
  ok: boolean | null;
  /** Why the command did not finish normally (timeout, cancelled, could not start). */
  error: string | null;
  stdout: string;
  stdoutBytes: number;
  stderr: string;
  stderrBytes: number;
  stdinBytes: number | null;
}

export const gitLogService = {
  /** Commands that started or finished after `since` (0 for all), oldest first. */
  entries: (since: number) => call<GitLogEntry[]>("git_command_log", { since }),
  clear: () => call<void>("clear_git_command_log"),
};

/** The command as you would type it in a terminal (POSIX quoting where needed). */
export function formatCommand(args: string[]): string {
  const quote = (a: string) =>
    a === "" ? "''" : /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
  return ["git", ...args.map(quote)].join(" ");
}
