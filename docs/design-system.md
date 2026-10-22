# Branchline design system

The specification is `_assets/design_ui.md`, a local design folder that is not part of the
repository. This document records how
it is implemented and where the implementation had to interpret or deviate from the references.

## Sources

| Referenced in `design_ui.md` | File actually present | Status |
|---|---|---|
| `_assets/branchline_logo.png` | `_assets/Branchline_logo.png` | Inspected. Name differs (capital B). |
| `_assets/branchline-design-rules.png` | `_assets/Branchline ontwerpsysteem in donkere stijl.png` | Inspected. Name differs; assumed to be the same reference. |

`_assets/app_structure.txt` refers to `branchline-logo.png`, a third spelling. Renaming the files
(or updating the Markdown) is recommended so the references resolve.

## Tokens

All colors, type sizes, spacing, radii, component heights, shadows and motion live in
[`src/styles/tokens.css`](../src/styles/tokens.css). Components must not use literal values for
these. The token names follow the semantic groups in the specification (`background`, `surface`,
`surface-elevated`, `border`, `text-*`, `accent*`, `success`, `warning`, `error`, `focus-ring`).
A light theme can be added by overriding the same custom properties under
`:root[data-theme="light"]`.

Typography follows the reference: Inter (24/32, 18/26, 14/20 headings; 14/20 body; 12/16 small)
and JetBrains Mono 12/16 for code, hashes and paths. Both fonts are bundled locally through
Fontsource, so the app works offline.

## Components

| Component | File | Variants and states |
|---|---|---|
| Button | `components/Button.tsx` | primary, secondary, ghost, danger; sm, md; hover, active, focus, disabled, loading |
| IconButton | `components/Button.tsx` | sm, md; tooltip from its accessible label |
| Badge / Count | `components/Badge.tsx` | neutral, accent, success, warning, error, info |
| StatusLetter | `components/StatusLetter.tsx` | one per Git status; letter + color + accessible label |
| Menu | `components/Menu.tsx` | WAI-ARIA menu button; arrows, Home/End, Escape, outside click |
| Splitter | `components/Splitter.tsx` | pointer and keyboard resizing (arrows, Shift for larger steps) |
| Toast | `components/Toast.tsx` | info, success, error; errors persist until dismissed |
| EmptyState | `components/EmptyState.tsx` | neutral, accent, success, error |
| Tooltip | `components/Tooltip.css` | `data-tooltip` attribute; hover and keyboard focus |
| Spinner | `components/Spinner.tsx` | slows down under reduced motion |

## Window

- **macOS:** native traffic lights over a custom title bar (`titleBarStyle: Overlay`,
  `tauri.macos.conf.json`). The bar reserves space on the left for them. The buttons are
  vertically centered in the 44 px bar: at startup `src-tauri/src/window.rs` reads AppKit's
  button layout (which differs between macOS versions) and creates the window with the
  matching offset.
- **Windows and Linux:** undecorated window with Branchline's own minimize, maximize/restore and
  close buttons on the right, following those platforms' placement.
- The title bar is also the application toolbar (brand, repository selector, branch, refresh,
  open). It is a drag region; double-click maximizes.
- The status bar shows branch, ahead/behind, operation in progress, change or conflict count,
  refresh state and Git version.

## Recorded discrepancies and decisions

1. **Muted text contrast.** The reference value `#64748B` reaches only 3.75:1 on the background
   and 3.07:1 on surfaces, below WCAG AA (4.5:1), while the Markdown requires sufficient contrast
   for secondary text as well. `--color-text-muted` is `#8391A7` (5.59:1 on background, 4.58:1 on
   surface). Explicit Markdown rule took priority over the image.
2. **Error text contrast.** `#EF4444` is 3.89:1 on surfaces. It remains the error fill color;
   error text uses `--color-error-text: #F87171` (5.29:1).
3. **Logo mint vs. primary accent.** The logo uses a softer mint (about `#5CCF9E`) than the
   Primary color `#00D1A0`. The logo keeps its own color (`--color-brand-mint`); UI accents use
   Primary.
4. **Panel and chrome tones.** The application mockup shows sidebars and bars slightly darker than
   `Surface #1E293B`. Two derived tokens were added: `--color-surface-subtle #152036` (sidebar,
   details panel) and `--color-chrome #0C1424` (title and status bars). `Surface` is used for
   inputs, cards and controls, as specified.
5. **Git status colors.** The palette does not define renamed or untracked colors. Renamed uses
   `--color-info #60A5FA`; untracked uses teal `#2DD4BF`. Every status also shows a letter and an
   accessible label.
6. **Commit graph lane colors.** The mockup uses purple, yellow and pink lanes that are not in the
   palette. They are defined as `--graph-0` to `--graph-7` (mint, purple, amber, pink, blue, cyan,
   orange, lime), starting with the primary accent. The same colors tint author avatars, which
   are generated locally from initials (no network lookups).
7. **Reference image labeling slip.** The components panel shows a checked checkbox labeled
   "Radio optie". Treated as a typo.
8. **Folder structure panel.** The reference image suggests `src/assets`, `pages` and `services`;
   `app_structure.txt` suggests `components`, `features`, `layouts`, `styles`. The implementation
   follows `app_structure.txt` (plus `services`, `types`, `lib`) and keeps design references in
   `_assets/`.
9. **macOS app icon.** The supplied icon fills its canvas edge to edge, which makes it larger than
   other apps in the Dock. `icons/icon.icns` places the artwork at 824 of 1024 pixels with a soft
   shadow, following Apple's macOS icon grid. For depth, like Apple's own icons, the tile has a
   gentle top-to-bottom gradient, a light sheen at the top and a shining inner edge that is
   brightest along the top. The source is `icons/macos/icon.svg`; rebuild the `.icns` with
   `python3 src-tauri/icons/macos/build.py`. Windows and Linux icons stay full-bleed.
10. **Syntax colors.** The design reference has no code colors. Diffs use ten `--syntax-*`
    tokens (keyword purple, string green, number orange, comment grey, function blue, type
    yellow, tag red, attribute yellow, meta cyan, variable white). Each reaches at least 4.5:1
    on the plain, added and removed diff rows and on selected rows, which is why comments are
    `#9AA8BC` rather than a darker grey. Color is never the only signal: the `+`/`−` gutter
    and row tints mark changes.
