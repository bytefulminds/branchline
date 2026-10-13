import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/** Show the native folder picker. Resolves to `null` when cancelled. */
export async function pickRepositoryFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Open Git repository",
  });
  return typeof selected === "string" ? selected : null;
}
