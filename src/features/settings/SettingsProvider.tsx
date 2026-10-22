import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { settingsService } from "../../services/settings";
import { DEFAULT_SETTINGS, type Settings } from "../../types/settings";

export interface SettingsContextValue {
  settings: Settings;
  /** True once the stored settings were read (or reading failed and defaults apply). */
  loaded: boolean;
  /** Change settings; saved right away. Resolves to an error message, or null. */
  update: (change: (s: Settings) => Settings) => Promise<string | null>;
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  loaded: true,
  update: async () => null,
});

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext);
}

/** Fill in sections or fields missing from what the backend returned. */
function withDefaults(s: Partial<Settings> | null | undefined): Settings {
  if (!s || typeof s !== "object") return DEFAULT_SETTINGS;
  return {
    general: { ...DEFAULT_SETTINGS.general, ...s.general },
    git: { ...DEFAULT_SETTINGS.git, ...s.git },
    editor: { ...DEFAULT_SETTINGS.editor, ...s.editor },
    safety: { ...DEFAULT_SETTINGS.safety, ...s.safety },
    ai: { ...DEFAULT_SETTINGS.ai, ...s.ai },
  };
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const latest = useRef(settings);

  useEffect(() => {
    let cancelled = false;
    settingsService
      .get()
      .then((s) => {
        if (cancelled) return;
        latest.current = withDefaults(s);
        setSettings(latest.current);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  // Code font size and tab width apply everywhere code is shown.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--text-code-size", `${settings.editor.codeFontSize}px`);
    root.setProperty("--text-code-line", `${Math.round(settings.editor.codeFontSize * 1.5)}px`);
    root.setProperty("--code-tab-size", String(settings.editor.tabWidth));
  }, [settings.editor.codeFontSize, settings.editor.tabWidth]);

  const update = useCallback(async (change: (s: Settings) => Settings) => {
    const next = change(latest.current);
    latest.current = next;
    setSettings(next);
    try {
      const stored = withDefaults((await settingsService.save(next)) ?? next);
      // Keep what the user typed unless the backend corrected it.
      if (latest.current === next) {
        latest.current = stored;
        setSettings(stored);
      }
      return null;
    } catch (e) {
      return (e as { message?: string }).message ?? "Could not save the settings.";
    }
  }, []);

  const value = useMemo(() => ({ settings, loaded, update }), [settings, loaded, update]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}
