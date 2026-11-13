import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import App from "../../App";
import { formatSize, isLocalServer } from "../../services/ai";
import { installTauriTestEnvironment, openButton, REPO, setup } from "../../test/harness";
import { DEFAULT_SETTINGS, type Settings } from "../../types/settings";
import { resetCommitDrafts } from "../changes/CommitBox";
import { preferredModel } from "./AiSection";

installTauriTestEnvironment();
afterEach(resetCommitDrafts);

type Extra = (cmd: string, args: Record<string, unknown>) => unknown;
type TextChannel = { onmessage: (text: string) => void };

const ENABLED: Settings = {
  ...DEFAULT_SETTINGS,
  ai: { ...DEFAULT_SETTINGS.ai, enabled: true, model: "qwen2.5-coder:7b" },
};

const SERVER = {
  version: "0.6.2",
  models: [
    { name: "llama3.2:latest", size: 2_019_393_189, parameterSize: "3.2B" },
    { name: "qwen2.5-coder:7b", size: 4_683_087_332, parameterSize: "7.6B" },
  ],
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function start(settings: Settings, extra: Extra = () => undefined) {
  const user = userEvent.setup();
  const calls = setup((cmd, args) => {
    const answer = extra(cmd, args);
    if (answer !== undefined) return answer;
    if (cmd === "get_settings") return settings;
    if (cmd === "save_settings") return args.value;
    if (cmd === "plugin:dialog|open") return REPO.path;
    if (cmd === "inspect_repository") return REPO;
  });
  render(<App />);
  return { user, calls };
}

const saved = (calls: { cmd: string; args: Record<string, unknown> }[]) =>
  calls.filter((c) => c.cmd === "save_settings").pop()?.args.value as Settings | undefined;

describe("AI helpers", () => {
  it("knows local servers, sizes and a good default model", () => {
    expect(isLocalServer("http://localhost:11434")).toBe(true);
    expect(isLocalServer("http://127.0.0.1:11434")).toBe(true);
    expect(isLocalServer("http://[::1]:11434")).toBe(true);
    expect(isLocalServer("http://192.168.1.4:11434")).toBe(false);
    expect(isLocalServer("https://localhost.example.com")).toBe(false);
    expect(formatSize(4_683_087_332)).toBe("4.7 GB");
    expect(formatSize(274_302_450)).toBe("274 MB");
    expect(preferredModel(["llama3.2", "qwen2.5-coder:7b"])).toBe("qwen2.5-coder:7b");
    expect(preferredModel(["llama3.2"])).toBe("llama3.2");
    expect(preferredModel([])).toBe("");
    expect(preferredModel(["claude-opus-x", "claude-sonnet-x"], "anthropic")).toBe(
      "claude-sonnet-x",
    );
    expect(preferredModel(["gpt-4.1", "gpt-4.1-mini"], "openai")).toBe("gpt-4.1-mini");
  });
});

describe("AI settings", () => {
  it("contacts nothing while off, then connects and picks a model", async () => {
    const { user, calls } = start(DEFAULT_SETTINGS, (cmd) => {
      if (cmd === "ai_server_info") return SERVER;
    });
    await screen.findByRole("button", { name: "Clone…" });
    await user.keyboard("{Control>},{/Control}");
    const panel = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(within(panel).getByRole("button", { name: "AI" }));
    expect(calls.some((c) => c.cmd === "ai_server_info")).toBe(false);

    await user.click(within(panel).getByRole("switch", { name: /Use AI/ }));
    expect(await within(panel).findByText(/Connected to Ollama 0\.6\.2/)).toHaveTextContent(
      "2 models",
    );
    expect(calls.find((c) => c.cmd === "ai_server_info")?.args).toEqual({
      provider: "ollama",
      url: "http://localhost:11434",
    });
    // Ollama has no key, so the password store is not asked.
    expect(calls.some((c) => c.cmd === "ai_key_exists")).toBe(false);
    // A coding model is chosen when none was set.
    await waitFor(() => expect(saved(calls)?.ai.model).toBe("qwen2.5-coder:7b"));
    expect(saved(calls)?.ai.enabled).toBe(true);

    await user.selectOptions(within(panel).getByLabelText("Message style"), "plain");
    await waitFor(() => expect(saved(calls)?.ai.style).toBe("plain"));
    // Local server: no warning.
    expect(within(panel).queryByText(/sent to this server/)).not.toBeInTheDocument();

    // The context length stays the same for every request, or is left to Ollama.
    const context = within(panel).getByLabelText("Context length");
    expect(context).toHaveValue("16384");
    await user.selectOptions(context, "0");
    await waitFor(() => expect(saved(calls)?.ai.ollamaContext).toBe(0));
  });

  it("warns about remote servers and shows connection errors", async () => {
    const { user } = start(
      { ...ENABLED, ai: { ...ENABLED.ai, url: "http://10.0.0.5:11434" } },
      (cmd) => {
        if (cmd === "ai_server_info")
          return Promise.reject({
            kind: "ai",
            message: "Could not reach Ollama at http://10.0.0.5:11434.",
            detail: null,
          });
      },
    );
    await screen.findByRole("button", { name: "Clone…" });
    await user.keyboard("{Control>},{/Control}");
    const panel = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(within(panel).getByRole("button", { name: "AI" }));
    expect(within(panel).getByText(/sent to this server/)).toHaveTextContent("not encrypted");
    expect(await within(panel).findByText(/Could not reach Ollama/)).toBeInTheDocument();
    // The chosen model stays visible even though the list could not load.
    expect(within(panel).getByLabelText("Model")).toHaveValue("qwen2.5-coder:7b");
  });

  it("stores a cloud provider's key, then lists its models", async () => {
    let stored = false;
    const { user, calls } = start(ENABLED, (cmd, args) => {
      if (cmd === "ai_key_exists") return stored;
      if (cmd === "save_ai_key") {
        stored = args.key !== "";
        return null;
      }
      if (cmd === "ai_server_info")
        return {
          version: null,
          models: [
            {
              name: "claude-opus-x",
              displayName: "Claude Opus X",
              size: null,
              parameterSize: null,
            },
            {
              name: "claude-sonnet-x",
              displayName: "Claude Sonnet X",
              size: null,
              parameterSize: null,
            },
          ],
        };
    });
    await screen.findByRole("button", { name: "Clone…" });
    await user.keyboard("{Control>},{/Control}");
    const panel = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(within(panel).getByRole("button", { name: "AI" }));
    await user.selectOptions(within(panel).getByLabelText("Provider"), "anthropic");
    await waitFor(() => expect(saved(calls)?.ai.provider).toBe("anthropic"));
    expect(within(panel).getByText(/does not include the API/)).toBeInTheDocument();
    expect(within(panel).getByText(/sent to Anthropic/)).toBeInTheDocument();
    expect(await within(panel).findByText(/Save your Anthropic API key first/)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Test" })).toBeDisabled();
    expect(within(panel).queryByLabelText("Server address")).not.toBeInTheDocument();
    const before = calls.filter((c) => c.cmd === "ai_server_info").length;

    await user.type(within(panel).getByLabelText("API key"), "sk-ant-secret");
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    expect(calls.find((c) => c.cmd === "save_ai_key")?.args).toEqual({
      provider: "anthropic",
      key: "sk-ant-secret",
    });
    expect(await within(panel).findByText(/Connected to Anthropic/)).toHaveTextContent("2 models");
    const tests = calls.filter((c) => c.cmd === "ai_server_info");
    expect(tests.length).toBe(before + 1);
    expect(tests.at(-1)?.args.provider).toBe("anthropic");
    // A Sonnet model is chosen, and the Ollama model is kept for later.
    await waitFor(() => expect(saved(calls)?.ai.anthropicModel).toBe("claude-sonnet-x"));
    expect(saved(calls)?.ai.model).toBe("qwen2.5-coder:7b");
    expect(within(panel).getByRole("option", { name: "Claude Sonnet X" })).toBeInTheDocument();
    // The key never comes back to the window.
    expect(within(panel).getByLabelText("API key")).toHaveValue("");
    expect(within(panel).getByText(/Saved in your system's password store/)).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Remove" }));
    expect(calls.filter((c) => c.cmd === "save_ai_key").at(-1)?.args.key).toBe("");
    expect(await within(panel).findByText(/Save your Anthropic API key first/)).toBeInTheDocument();
  });
});

describe("suggesting a commit message", () => {
  it("is hidden while AI is off", async () => {
    const { user } = start(DEFAULT_SETTINGS);
    await user.click(openButton());
    await screen.findByRole("heading", { name: "Changes" });
    expect(screen.queryByRole("button", { name: /Suggest message/ })).not.toBeInTheDocument();
  });

  it("is hidden when commit suggestions are off", async () => {
    const { user } = start({ ...ENABLED, ai: { ...ENABLED.ai, commitSuggestions: false } });
    await user.click(openButton());
    await screen.findByRole("heading", { name: "Changes" });
    expect(screen.queryByRole("button", { name: /Suggest message/ })).not.toBeInTheDocument();
  });

  it("names the cloud model it writes with", async () => {
    const { user } = start(
      {
        ...ENABLED,
        ai: { ...ENABLED.ai, provider: "anthropic", anthropicModel: "claude-sonnet-x" },
      },
      (cmd) => {
        if (cmd === "suggest_commit_message") return new Promise(() => {});
      },
    );
    await user.click(openButton());
    await screen.findByRole("heading", { name: "Changes" });
    await user.click(screen.getByRole("button", { name: /Suggest message/ }));
    expect(await screen.findByText("Writing with claude-sonnet-x…")).toBeInTheDocument();
  });

  it("streams the suggestion into the message and offers undo", async () => {
    const pending = deferred<string>();
    let channel: TextChannel | null = null;
    const { user, calls } = start(ENABLED, (cmd, args) => {
      if (cmd === "suggest_commit_message") {
        channel = args.onText as TextChannel;
        return pending.promise;
      }
    });
    await user.click(openButton());
    await screen.findByRole("heading", { name: "Changes" });
    const summary = screen.getByLabelText("Commit summary");
    await user.type(summary, "wip");

    await user.click(screen.getByRole("button", { name: /Suggest message/ }));
    expect(calls.find((c) => c.cmd === "suggest_commit_message")?.args).toMatchObject({
      repo: REPO.path,
    });
    expect(await screen.findByText("Writing with qwen2.5-coder:7b…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Commit \d+ file/ })).toBeDisabled();

    channel!.onmessage("refactor: move a.rs");
    await waitFor(() => expect(summary).toHaveValue("refactor: move a.rs"));
    expect(summary).toHaveAttribute("readonly");

    pending.resolve("refactor: move a.rs to b.rs\n\nKeeps the library modules together.");
    await waitFor(() => expect(summary).toHaveValue("refactor: move a.rs to b.rs"));
    expect(screen.getByLabelText("Commit description")).toHaveValue(
      "Keeps the library modules together.",
    );
    expect(summary).not.toHaveAttribute("readonly");

    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(summary).toHaveValue("wip");
  });

  it("stops on Escape and keeps what was typed", async () => {
    const pending = deferred<string>();
    let channel: TextChannel | null = null;
    const { user, calls } = start(ENABLED, (cmd, args) => {
      if (cmd === "suggest_commit_message") {
        channel = args.onText as TextChannel;
        return pending.promise;
      }
      if (cmd === "cancel_remote_operation") {
        pending.reject({
          kind: "cancelled",
          message: "The operation was cancelled.",
          detail: null,
        });
        return null;
      }
    });
    await user.click(openButton());
    await screen.findByRole("heading", { name: "Changes" });
    await user.type(screen.getByLabelText("Commit summary"), "my words");
    await user.click(screen.getByRole("button", { name: /Suggest message/ }));
    channel!.onmessage("feat: something else");
    await waitFor(() =>
      expect(screen.getByLabelText("Commit summary")).toHaveValue("feat: something else"),
    );
    screen.getByLabelText("Commit summary").focus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByLabelText("Commit summary")).toHaveValue("my words"));
    const opId = calls.find((c) => c.cmd === "suggest_commit_message")?.args.opId;
    expect(calls.find((c) => c.cmd === "cancel_remote_operation")?.args.opId).toBe(opId);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Late text after stopping is ignored.
    channel!.onmessage("feat: too late");
    expect(screen.getByLabelText("Commit summary")).toHaveValue("my words");
  });

  it("shows why a suggestion failed", async () => {
    const { user } = start(ENABLED, (cmd) => {
      if (cmd === "suggest_commit_message")
        return Promise.reject({
          kind: "ai",
          message: "The model qwen2.5-coder:7b is not installed on the server.",
          detail: null,
        });
    });
    await user.click(openButton());
    await screen.findByRole("heading", { name: "Changes" });
    await user.click(screen.getByRole("button", { name: /Suggest message/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("is not installed");
  });
});
