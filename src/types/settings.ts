import type { PullMode } from "./git";

/** Unified: one column. Split: old version left, new version right. */
export type DiffLayout = "unified" | "split";

/** Mirrors `AiProvider` in `src-tauri/src/settings.rs`. */
export type AiProvider = "ollama" | "openaiCompatible" | "anthropic" | "openai";

/** Mirrors `src-tauri/src/settings.rs`. */
export interface Settings {
  general: {
    openLastRepository: boolean;
    refreshOnFocus: boolean;
    /** 0 is off. */
    autoFetchMinutes: number;
    checkForUpdates: boolean;
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
    diffLayout: DiffLayout;
    syntaxHighlighting: boolean;
  };
  safety: {
    confirmDiscard: boolean;
    confirmForcePush: boolean;
    confirmRebasePublished: boolean;
    confirmDeleteBranch: boolean;
  };
  ai: {
    /** The general "Use AI" switch. */
    enabled: boolean;
    provider: AiProvider;
    /** Ollama server and model. */
    url: string;
    model: string;
    compatibleUrl: string;
    compatibleModel: string;
    anthropicModel: string;
    openaiModel: string;
    commitSuggestions: boolean;
    style: "conventional" | "plain";
    language: string;
    instructions: string;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  general: {
    openLastRepository: false,
    refreshOnFocus: true,
    autoFetchMinutes: 0,
    checkForUpdates: true,
  },
  git: { defaultPullMode: "fastForward", pruneOnFetch: true, pushFollowTags: false },
  editor: {
    externalEditor: "",
    terminal: "",
    diffContext: 3,
    ignoreWhitespace: false,
    tabWidth: 4,
    codeFontSize: 12,
    diffLayout: "unified",
    syntaxHighlighting: true,
  },
  safety: {
    confirmDiscard: true,
    confirmForcePush: true,
    confirmRebasePublished: true,
    confirmDeleteBranch: true,
  },
  ai: {
    enabled: false,
    provider: "ollama",
    url: "http://localhost:11434",
    model: "",
    compatibleUrl: "http://localhost:1234/v1",
    compatibleModel: "",
    anthropicModel: "",
    openaiModel: "",
    commitSuggestions: true,
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
