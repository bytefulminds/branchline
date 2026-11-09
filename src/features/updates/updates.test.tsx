import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "../../App";
import { installTauriTestEnvironment, setup } from "../../test/harness";

// On macOS and Windows the update is installed by Branchline itself.
vi.mock("../../services/platform", async (original) => ({
  ...(await original<typeof import("../../services/platform")>()),
  platform: "macos",
}));

installTauriTestEnvironment();

describe("updates on macOS and Windows", () => {
  it("offers to install the new release and restart", async () => {
    const user = userEvent.setup();
    setup((cmd) =>
      cmd === "plugin:updater|check"
        ? { rid: 1, currentVersion: "0.1.0", version: "0.2.0", date: null, body: "", rawJson: {} }
        : undefined,
    );
    render(<App />);
    // isPrimaryModifier still checks the real platform (Linux in tests), so Control.
    await user.keyboard("{Control>},{/Control}");
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(within(settings).getByRole("button", { name: "About Branchline" }));
    await user.click(await within(settings).findByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Branchline 0.2.0 is available")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install and restart" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open releases page" })).toBeNull();
  });
});
