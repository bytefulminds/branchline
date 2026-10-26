import { openUrl } from "@tauri-apps/plugin-opener";

export const PROJECT_URL = "https://gitlab.com/bytefulminds/branchline";
export const RELEASES_URL = `${PROJECT_URL}/-/releases`;
export const ISSUES_URL = `${PROJECT_URL}/-/issues`;

/** Open a web page in the default browser. Allowed sites are listed in
 * src-tauri/capabilities/default.json: Branchline's own pages, ollama.com and package pages
 * on npmjs.com and crates.io. */
export function openLink(url: string): void {
  void openUrl(url).catch(() => {});
}
