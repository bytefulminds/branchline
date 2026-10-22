# Accessibility

Branchline aims for WCAG 2.2 AA. This page records how that is checked and what the review
before the first release found and changed.

## How it is checked

- **Automated (every test run):** `src/test/a11y.test.tsx` runs [axe-core](https://github.com/dequelabs/axe-core)
  on the welcome screen, every workspace view (Changes with a diff in both layouts, History
  with filters, Branches, Stashes, Tags, Worktrees, Remotes), the command palette, the
  shortcut overview, About, every Settings section and the merge editor. Any violation fails
  the build.
- **Not automated:** jsdom has no layout, so color contrast and target size are checked by
  hand (below), and screen reader output was reviewed by reading the accessibility tree.
  A pass with VoiceOver (macOS) and NVDA (Windows) on the release builds is still to do.

## Keyboard

- Everything can be done from the keyboard. `Ctrl+K` / `⌘K` opens the command palette with
  every action, including the ones that are mouse shortcuts elsewhere (Stage all, Unstage
  all, switching branches, opening recent repositories). `Ctrl+/` / `⌘/` or `?` shows all
  shortcuts.
- Lists (changed files, commits) are single tab stops with arrow-key navigation and
  `aria-activedescendant`, so tabbing does not walk through thousands of rows.
- Diffs: arrow keys move between changed lines, `Space` selects a line, `Shift` extends the
  selection, `Esc` clears it. The line under the keyboard is outlined and read out.
- Dialogs trap focus, close with `Esc` and give focus back to where it was.
- Panel dividers are focusable separators: arrow keys resize, `Home`/`End` jump, `Enter`
  resets the commit message size.

## Screen readers

- Landmarks: title bar (`header`), sidebar (`nav`, including its divider), workspace
  (`main`), status bar (`contentinfo`).
- Changed files are grouped per area (`group`, "Staged changes (3)"); each file is an
  option with its status letter and path.
- Removed and added diff lines are announced as such; selected lines say "selected".
- Progress, results and errors use `status` and `alert` regions; long operations announce
  their phase.

## Contrast

All text pairs reach 4.5:1 (large text and icons 3:1). Values are in `src/styles/tokens.css`;
the reasoning for each deviation from the design reference is in
[design-system.md](design-system.md).

| Pair | Ratio |
|---|---|
| Primary text on background | 17.1:1 |
| Muted text on background / surface | 5.6:1 / 4.6:1 |
| Muted text on raised surfaces (menus, dialogs, palette) | 5.8:1 |
| Syntax colors on diff rows (plain, added, removed, selected) | 4.6:1 or more |
| Accent on raised surfaces | 6.5:1 |

Status is never shown by color alone: file states have a letter (`M`, `A`, `D`...) and a
label, diff lines a `+`/`−` sign, and graph lanes are decorative.

## Changes made in this review

| Finding (axe rule) | Fix |
|---|---|
| Row buttons inside list options could not be reached reliably (`nested-interactive`) | The icons on file rows are mouse shortcuts hidden from assistive technology; the same actions are on the keyboard (`Space`, `Enter`, `Delete`) and in the command palette |
| Group headers inside the file listbox (`aria-required-children`) | Files are grouped in labelled `group`s; the visual header is hidden from assistive technology |
| `aria-selected` on diff lines without a role (`aria-allowed-attr`) | Removed; selection is spoken as "selected", and lines can now be selected with the keyboard |
| Sidebar divider outside any landmark (`region`) | Moved inside the navigation landmark |
| Dialog role on a `form` element (`aria-allowed-role`) | The role moved to a wrapper element |
| `dt`/`dd` wrapped in an extra element in commit details (`dlitem`) | Restructured |
| Muted text on raised surfaces at 4.0:1 (manual) | Lighter muted color on menus, dialogs, toasts and the palette |

## Known gaps

- Reduced motion is respected (`prefers-reduced-motion` turns animations off); there is no
  high-contrast or light theme yet.
- The commit graph is not described to screen readers beyond the commit list itself.
- The merge editor labels each side and each editable result block, and `F7` moves between
  conflicts, but the three panes are not announced as one comparison.
