import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { installTauriTestEnvironment, openButton, REPO, setup } from "../../test/harness";
import { DEFAULT_SETTINGS, type Settings } from "../../types/settings";
import { diffRowHeight } from "../changes/DiffView";

installTauriTestEnvironment();

afterEach(() => {
  vi.useRealTimers();
});

type Extra = (cmd: string, args: Record<string, unknown>) => unknown;
type Call = { cmd: string; args: Record<string, unknown> };

const lastSave = (calls: Call[]) => calls.filter((c) => c.cmd === "save_settings").pop();

function withSettings(change: (s: Settings) => Settings): Settings {
  return change(structuredClone(DEFAULT_SETTINGS));
}

async function start(settings: Settings = DEFAULT_SETTINGS, extra: Extra = () => undefined) {
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

async function openRepo(user: ReturnType<typeof userEvent.setup>) {
  await user.click(openButton());
  await screen.findByRole("heading", { name: "Changes" });
}

describe("settings screen", () => {
  it("opens with Ctrl+comma and saves changes right away", async () => {
    const { user, calls } = await start();
    await screen.findByRole("button", { name: "Clone…" });
    await user.keyboard("{Control>},{/Control}");
    const panel = await screen.findByRole("dialog", { name: "Settings" });
    const refresh = within(panel).getByRole("switch", {
      name: /Refresh when Branchline gets focus/,
    });
    expect(refresh).toBeChecked();
    await user.click(refresh);
    await waitFor(() =>
      expect((lastSave(calls)?.args.value as Settings).general.refreshOnFocus).toBe(false),
    );
    expect(await within(panel).findByText("Saved")).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Git" }));
    await user.selectOptions(within(panel).getByLabelText("Pull button"), "rebase");
    await waitFor(() =>
      expect((lastSave(calls)?.args.value as Settings).git.defaultPullMode).toBe("rebase"),
    );

    // Text fields save when they lose focus, not on every key.
    await user.click(within(panel).getByRole("button", { name: "Editor & diff" }));
    const saves = calls.filter((c) => c.cmd === "save_settings").length;
    await user.type(within(panel).getByLabelText("External editor"), "code -n");
    expect(calls.filter((c) => c.cmd === "save_settings").length).toBe(saves);
    await user.tab();
    await waitFor(() =>
      expect((lastSave(calls)?.args.value as Settings).editor.externalEditor).toBe("code -n"),
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("saves the identity for one repository", async () => {
    const { user, calls } = await start(DEFAULT_SETTINGS, (cmd) => {
      if (cmd === "get_identity")
        return {
          global: {
            name: "Ada",
            email: "ada@home.example",
            signCommits: false,
            signingFormat: "",
            signingKey: "",
          },
          repository: {
            name: "",
            email: "",
            signCommits: false,
            signingFormat: "",
            signingKey: "",
          },
        };
      if (cmd === "set_identity") return null;
    });
    await openRepo(user);
    await user.click(screen.getByRole("button", { name: /Settings/ }));
    const panel = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(within(panel).getByRole("button", { name: "Identity & signing" }));
    expect(await within(panel).findByLabelText("Name")).toHaveValue("Ada");
    await user.click(within(panel).getByRole("tab", { name: "Only demo" }));
    expect(within(panel).getByLabelText("Email")).toHaveAttribute(
      "placeholder",
      "ada@home.example",
    );
    await user.type(within(panel).getByLabelText("Email"), "ada@work.example");
    await user.click(within(panel).getByRole("switch", { name: "Sign commits" }));
    await user.selectOptions(within(panel).getByLabelText("Signing format"), "ssh");
    await user.click(within(panel).getByRole("button", { name: "Save identity" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "set_identity")?.args).toEqual({
        scope: "repository",
        repo: REPO.path,
        values: {
          name: "",
          email: "ada@work.example",
          signCommits: true,
          signingFormat: "ssh",
          signingKey: "",
        },
      }),
    );
    expect(await within(panel).findByText("Saved to Git's configuration.")).toBeInTheDocument();
  });
});

describe("settings in effect", () => {
  it("uses the default pull mode for the Pull button", async () => {
    const { user, calls } = await start(
      withSettings((s) => ({ ...s, git: { ...s.git, defaultPullMode: "rebase" } })),
      (cmd) => {
        if (cmd === "list_remotes") return [{ name: "origin", url: "x", pushUrl: null }];
        if (cmd === "pull_branch")
          return { outcome: { updatedRefs: 0, upToDate: true }, repo: REPO };
      },
    );
    await openRepo(user);
    await user.click(await screen.findByRole("button", { name: "Pull (1 behind)" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "pull_branch")?.args.mode).toBe("rebase"),
    );
  });

  it("discards without asking when that confirmation is off", async () => {
    const { user, calls } = await start(
      withSettings((s) => ({ ...s, safety: { ...s.safety, confirmDiscard: false } })),
      (cmd) => {
        if (cmd === "discard_files") return REPO;
      },
    );
    await openRepo(user);
    await user.click(await screen.findByText("app.ts"));
    await user.click(await screen.findByRole("button", { name: "Discard file" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "discard_files")?.args.paths).toEqual(["src/app.ts"]),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("fetches in the background at the chosen interval", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = await start(
      withSettings((s) => ({ ...s, general: { ...s.general, autoFetchMinutes: 5 } })),
      (cmd) => {
        if (cmd === "list_remotes") return [{ name: "origin", url: "x", pushUrl: null }];
        if (cmd === "fetch_remote")
          return { outcome: { updatedRefs: 1, upToDate: false }, repo: REPO };
      },
    );
    fireEvent.click(openButton());
    await screen.findByRole("heading", { name: "Changes" });
    // The timer starts once the remotes are known.
    await waitFor(() => expect(screen.getByRole("button", { name: /^Fetch/ })).toBeEnabled());
    expect(calls.some((c) => c.cmd === "fetch_remote")).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
    });
    await waitFor(() => expect(calls.some((c) => c.cmd === "fetch_remote")).toBe(true));
    // Quiet: no "Fetched" toast.
    expect(screen.queryByText("Fetched")).not.toBeInTheDocument();
  });

  it("reopens the last repository when asked", async () => {
    window.localStorage.setItem(
      "branchline.recentRepositories.v1",
      JSON.stringify([{ path: REPO.path, name: "demo", lastOpened: Date.now() }]),
    );
    const { calls } = await start(
      withSettings((s) => ({ ...s, general: { ...s.general, openLastRepository: true } })),
    );
    expect(await screen.findByRole("heading", { name: "Changes" })).toBeInTheDocument();
    expect(calls.find((c) => c.cmd === "inspect_repository")?.args.path).toBe(REPO.path);
  });

  it("sizes diff rows for the code font", () => {
    expect(diffRowHeight(12)).toBe(22);
    expect(diffRowHeight(16)).toBe(28);
  });
});
