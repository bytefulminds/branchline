import type { ConfigScope, Identity, IdentityValues, Settings } from "../types/settings";
import { call } from "./git";

export const settingsService = {
  get: () => call<Settings>("get_settings"),
  /** Resolves to the settings as stored (values clamped to valid ranges). */
  save: (value: Settings) => call<Settings>("save_settings", { value }),
  getIdentity: (repo: string | null) => call<Identity>("get_identity", { repo }),
  setIdentity: (scope: ConfigScope, repo: string | null, values: IdentityValues) =>
    call<void>("set_identity", { scope, repo, values }),
  /** Open a file (or the repository when `path` is null) in the configured editor. */
  openInEditor: (repo: string, path: string | null) => call<void>("open_in_editor", { repo, path }),
  openTerminal: (repo: string) => call<void>("open_terminal", { repo }),
  revealInFileManager: (repo: string, path: string | null) =>
    call<void>("reveal_in_file_manager", { repo, path }),
};
