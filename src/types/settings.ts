import type { PullMode } from "./git";

/** Mirrors `src-tauri/src/settings.rs`. */
export interface Settings {
  general: {
    openLastRepository: boolean;
    refreshOnFocus: boolean;
    /** 0 is off. */
    autoFetchMinutes: number;
  };
  git: {
    defaultPullMode: PullMode;
    pruneOnFetch: boolean;
    pushFollowTags: boolean;
  };
  editor: {
    externalEditor: string;
    terminal: string;
    diffContext: number;
    ignoreWhitespace: boolean;
    tabWidth: number;
    codeFontSize: number;
  };
  safety: {
    confirmDiscard: boolean;
    confirmForcePush: boolean;
    confirmRebasePublished: boolean;
    confirmDeleteBranch: boolean;
  };
  ai: {
    enabled: boolean;
    url: string;
    model: string;
    style: "conventional" | "plain";
    language: string;
    instructions: string;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  general: { openLastRepository: false, refreshOnFocus: true, autoFetchMinutes: 0 },
  git: { defaultPullMode: "fastForward", pruneOnFetch: true, pushFollowTags: false },
  editor: {
    externalEditor: "",
    terminal: "",
    diffContext: 3,
    ignoreWhitespace: false,
    tabWidth: 4,
    codeFontSize: 12,
  },
  safety: {
    confirmDiscard: true,
    confirmForcePush: true,
    confirmRebasePublished: true,
    confirmDeleteBranch: true,
  },
  ai: {
    enabled: false,
    url: "http://localhost:11434",
    model: "",
    style: "conventional",
    language: "English",
    instructions: "",
  },
};

export interface IdentityValues {
  name: string;
  email: string;
  signCommits: boolean;
  /** "", "openpgp", "ssh" or "x509". */
  signingFormat: string;
  signingKey: string;
}

export interface Identity {
  global: IdentityValues;
  repository: IdentityValues | null;
}

export type ConfigScope = "global" | "repository";
