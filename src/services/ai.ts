import { Channel } from "@tauri-apps/api/core";
import { call } from "./git";

/** Mirrors `ModelInfo` in `src-tauri/src/ai.rs`. */
export interface AiModel {
  name: string;
  /** Bytes on disk. */
  size: number;
  parameterSize: string | null;
}

export interface AiServerInfo {
  version: string | null;
  models: AiModel[];
}

export const aiService = {
  /** Connect to the Ollama server at `url` and list its chat models. */
  serverInfo: (url: string) => call<AiServerInfo>("ai_server_info", { url }),
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
