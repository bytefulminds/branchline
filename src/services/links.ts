import { openUrl } from "@tauri-apps/plugin-opener";

export const PROJECT_URL = "https://gitlab.com/bytefulminds/branchline";
export const RELEASES_URL = `${PROJECT_URL}/-/releases`;
export const ISSUES_URL = `${PROJECT_URL}/-/issues`;

/** Open a web page in the default browser (only Branchline's own pages are allowed). */
export function openLink(url: string): void {
  void openUrl(url).catch(() => {});
}
