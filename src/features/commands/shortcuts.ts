import { modKeyLabel, platform } from "../../services/platform";

const shift = platform === "macos" ? "⇧" : "Shift+";
const alt = platform === "macos" ? "⌥" : "Alt+";
const mod = (key: string) => `${modKeyLabel}${key}`;

/** Every keyboard shortcut, as shown in the shortcut overview and the command palette. */
export const SHORTCUTS = {
  palette: mod("K"),
  shortcuts: mod("/"),
  open: mod("O"),
  settings: mod(","),
  refresh: `${mod("R")} or F5`,
  changes: mod("1"),
  history: mod("2"),
  branches: mod("3"),
  stashes: mod("4"),
  tags: mod("5"),
  worktrees: mod("6"),
  reviews: mod("7"),
  searchHistory: mod("F"),
  console: mod("J"),
  sidebar: mod("B"),
  commit: mod("↵"),
};

export interface ShortcutGroup {
  title: string;
  items: { keys: string; action: string }[];
}

/** The shortcut overview, grouped by where the shortcuts work. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Anywhere",
    items: [
      { keys: `${SHORTCUTS.palette} or ${mod(`${shift}P`)}`, action: "Command palette" },
      { keys: `${SHORTCUTS.shortcuts} or ?`, action: "Keyboard shortcuts" },
      { keys: SHORTCUTS.open, action: "Open a repository" },
      { keys: SHORTCUTS.refresh, action: "Refresh" },
      { keys: SHORTCUTS.settings, action: "Settings" },
      { keys: SHORTCUTS.console, action: "Show or hide the Git console" },
      { keys: SHORTCUTS.sidebar, action: "Collapse or expand the sidebar" },
      {
        keys: `${SHORTCUTS.changes} to ${mod("6")}`,
        action: "Changes, History, Branches, Stashes, Tags, Worktrees",
      },
      { keys: SHORTCUTS.reviews, action: "Reviews (with a GitLab account connected)" },
      { keys: `${shift}F10 or Menu key`, action: "Context menu of the selected row" },
      { keys: "Esc", action: "Close a dialog, menu or panel" },
    ],
  },
  {
    title: "Changes",
    items: [
      { keys: "↑ ↓", action: "Move through changed files" },
      { keys: "Space or ↵", action: "Stage or unstage the selected file" },
      { keys: "Delete", action: "Discard the selected file" },
      {
        keys: "Click, Shift+click",
        action: "Select lines in a diff (then stage, unstage or discard)",
      },
      {
        keys: `↑ ↓, Space, ${shift}↑ ${shift}↓ (in a diff)`,
        action: "Move to a changed line, select it, extend",
      },
      { keys: SHORTCUTS.commit, action: "Commit" },
      { keys: "Esc", action: "Stop writing a suggested message" },
    ],
  },
  {
    title: "History",
    items: [
      { keys: SHORTCUTS.searchHistory, action: "Search commits" },
      { keys: "↑ ↓ PageUp PageDown Home End", action: "Move through commits" },
      { keys: `${shift}↑ ${shift}↓, Shift+click`, action: "Select a range of commits" },
      {
        keys: `${mod("Space")}, ${platform === "macos" ? "⌘" : "Ctrl+"}click`,
        action: "Add or remove a commit",
      },
    ],
  },
  {
    title: "Merge editor",
    items: [
      { keys: `F7, ${shift}F7`, action: "Next or previous conflict" },
      { keys: `${alt}↓ ${alt}↑`, action: "Next or previous conflict" },
      { keys: `${mod("Z")}, ${mod(`${shift}Z`)}`, action: "Undo, redo" },
      { keys: mod("↵"), action: "Save the resolution" },
    ],
  },
  {
    title: "Panels",
    items: [
      { keys: "← → (on a divider)", action: "Resize a side panel" },
      { keys: "↑ ↓ (on a divider)", action: "Resize the commit message" },
      { keys: "↵ or double-click (on that divider)", action: "Reset the commit message size" },
    ],
  },
];
