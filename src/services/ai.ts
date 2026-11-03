import { Channel } from "@tauri-apps/api/core";
import type { AiProvider, Settings } from "../types/settings";
import { call } from "./git";

/** Mirrors `ModelInfo` in `src-tauri/src/ai/provider.rs`. */
export interface AiModel {
  name: string;
  /** A friendlier name, when the provider has one. */
  displayName: string | null;
  /** Bytes on disk (Ollama). */
  size: number | null;
  parameterSize: string | null;
}

export interface AiServerInfo {
  version: string | null;
  models: AiModel[];
}

export interface ProviderInfo {
  name: string;
  /** Shown in the provider list. */
  label: string;
  /** Sends code to a cloud service rather than a server the user runs. */
  cloud: boolean;
  /** Uses an address the user sets (Ollama, compatible servers). */
  hasAddress: boolean;
  /** "required", "optional" or no key at all. */
  key: "required" | "optional" | null;
  keyPlaceholder?: string;
  /** Where API keys are made (allowed in src-tauri/capabilities/default.json). */
  keyPage?: string;
  keySite?: string;
}

export const PROVIDERS: Record<AiProvider, ProviderInfo> = {
  ollama: {
    name: "Ollama",
    label: "Ollama (on your computer or network)",
    cloud: false,
    hasAddress: true,
    key: null,
  },
  openaiCompatible: {
    name: "OpenAI-compatible server",
    label: "OpenAI-compatible server (LM Studio, vLLM, OpenRouter…)",
    cloud: false,
    hasAddress: true,
    key: "optional",
    keyPlaceholder: "Only if the server asks for one",
  },
  anthropic: {
    name: "Anthropic",
    label: "Anthropic (Claude)",
    cloud: true,
    hasAddress: false,
    key: "required",
    keyPlaceholder: "sk-ant-…",
    keyPage: "https://platform.claude.com/settings/keys",
    keySite: "the Claude Console",
  },
  openai: {
    name: "OpenAI",
    label: "OpenAI (GPT)",
    cloud: true,
    hasAddress: false,
    key: "required",
    keyPlaceholder: "sk-…",
    keyPage: "https://platform.openai.com/api-keys",
    keySite: "the OpenAI platform",
  },
};

/** The settings fields that hold the address and model of each provider. */
const FIELDS: Record<AiProvider, { url?: "url" | "compatibleUrl"; model: keyof Settings["ai"] }> = {
  ollama: { url: "url", model: "model" },
  openaiCompatible: { url: "compatibleUrl", model: "compatibleModel" },
  anthropic: { model: "anthropicModel" },
  openai: { model: "openaiModel" },
};

/** The address the chosen provider uses ("" for the cloud providers, whose address is fixed). */
export function providerUrl(ai: Settings["ai"]): string {
  const field = FIELDS[ai.provider].url;
  return field ? ai[field] : "";
}

/** The model chosen for the current provider. */
export function providerModel(ai: Settings["ai"]): string {
  return String(ai[FIELDS[ai.provider].model] ?? "");
}

/** A settings change that sets the current provider's address or model. */
export function providerPatch(
  ai: Settings["ai"],
  change: { url?: string; model?: string },
): Partial<Settings["ai"]> {
  const fields = FIELDS[ai.provider];
  const patch: Partial<Settings["ai"]> = {};
  if (change.url !== undefined && fields.url) patch[fields.url] = change.url;
  if (change.model !== undefined) (patch as Record<string, string>)[fields.model] = change.model;
  return patch;
}

export const aiService = {
  /** Connect to the provider and list its chat models. */
  serverInfo: (provider: AiProvider, url: string) =>
    call<AiServerInfo>("ai_server_info", { provider, url }),
  /** Whether an API key is stored; the key itself never comes back. */
  keyExists: (provider: AiProvider) => call<boolean>("ai_key_exists", { provider }),
  /** Store the key in the system's password store; an empty key removes it. */
  saveKey: (provider: AiProvider, key: string) => call<void>("save_ai_key", { provider, key }),
  /**
   * Suggest a commit message for the staged changes. `onText` receives the
   * message so far while the model writes. Cancel with `cancel(opId)`.
   */
  suggestCommitMessage: (repo: string, opId: string, onText: (text: string) => void) => {
    const channel = new Channel<string>();
    channel.onmessage = onText;
    return call<string>("suggest_commit_message", { repo, opId, onText: channel });
  },
  cancel: (opId: string) => call<void>("cancel_remote_operation", { opId }),
};

/** Whether the server runs on this computer, so nothing leaves it. */
export function isLocalServer(url: string): boolean {
  const rest = url
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .toLowerCase();
  const host = rest.startsWith("[")
    ? rest.slice(1, rest.indexOf("]"))
    : (rest.split(/[:/]/)[0] ?? "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/** "4.7 GB" style size. */
export function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
