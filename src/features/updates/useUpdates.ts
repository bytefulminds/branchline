import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useToast } from "../../components/Toast";
import { openLink, RELEASES_URL } from "../../services/links";
import { useSettings } from "../settings/SettingsProvider";

/** Wait after start before looking for an update, so it never slows down opening a repository. */
const STARTUP_DELAY_MS = 8000;

export interface UpdatesController {
  /** Look for a new release. `quiet` reports nothing unless one is found. */
  check: (options: { quiet: boolean }) => Promise<void>;
}

/**
 * Finds, downloads and installs new releases (Tauri updater, signed with Branchline's
 * update key). Nothing is installed without asking; the app restarts after installing.
 */
export function useUpdates(): UpdatesController {
  const toast = useToast();
  const { settings, loaded } = useSettings();
  const running = useRef(false);

  const install = useCallback(
    async (update: Update) => {
      toast({
        title: `Downloading Branchline ${update.version}…`,
        description: "Branchline restarts when the update is installed.",
        durationMs: 6000,
      });
      try {
        await update.downloadAndInstall();
        await relaunch();
      } catch (e) {
        toast({
          tone: "error",
          title: "The update could not be installed",
          description: String((e as Error)?.message ?? e),
          actions: [{ label: "Open releases page", onClick: () => openLink(RELEASES_URL) }],
        });
      }
    },
    [toast],
  );

  const run = useCallback(
    async ({ quiet }: { quiet: boolean }) => {
      if (running.current) return;
      running.current = true;
      try {
        const update = await check();
        if (update) {
          toast({
            title: `Branchline ${update.version} is available`,
            description: `You have ${update.currentVersion}. Install it now? Branchline restarts afterwards.`,
            actions: [
              { label: "Install and restart", onClick: () => void install(update) },
              { label: "What's new", onClick: () => openLink(RELEASES_URL) },
            ],
          });
        } else if (!quiet) {
          toast({ tone: "success", title: "Branchline is up to date", durationMs: 4000 });
        }
      } catch (e) {
        if (!quiet)
          toast({
            tone: "error",
            title: "Could not check for updates",
            description: String((e as Error)?.message ?? e),
          });
      } finally {
        running.current = false;
      }
    },
    [toast, install],
  );

  // One quiet check per start, in release builds only.
  const enabled = loaded && settings.general.checkForUpdates && import.meta.env.PROD;
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => void run({ quiet: true }), STARTUP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, run]);

  return useMemo(() => ({ check: run }), [run]);
}
