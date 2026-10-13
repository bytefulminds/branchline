export type Platform = "macos" | "windows" | "linux";

export function detectPlatform(userAgent: string = navigator.userAgent): Platform {
  if (/Mac|iPhone|iPad/i.test(userAgent)) return "macos";
  if (/Windows/i.test(userAgent)) return "windows";
  return "linux";
}

export const platform: Platform = detectPlatform();

/** Primary modifier label for shortcuts: Cmd on macOS, Ctrl elsewhere. */
export const modKeyLabel = platform === "macos" ? "⌘" : "Ctrl+";

export function isPrimaryModifier(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return platform === "macos" ? e.metaKey : e.ctrlKey;
}
