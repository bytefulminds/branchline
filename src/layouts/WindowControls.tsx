import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import "./WindowControls.css";

/** Custom window controls for Windows and Linux (macOS keeps native traffic lights). */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const available = isTauri();

  useEffect(() => {
    if (!available) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const sync = () =>
      win
        .isMaximized()
        .then((m) => !cancelled && setMaximized(m))
        .catch(() => {});
    sync();
    win
      .onResized(sync)
      .then((u) => (cancelled ? u() : (unlisten = u)))
      .catch(() => {});
    return () => {
      cancelled = true;
      try {
        unlisten?.();
      } catch {
        // The window is already gone.
      }
    };
  }, [available]);

  const act = (fn: (w: ReturnType<typeof getCurrentWindow>) => Promise<void>) => () => {
    if (available) fn(getCurrentWindow()).catch(() => {});
  };

  return (
    <div className="bl-window-controls" role="group" aria-label="Window controls">
      <button
        type="button"
        className="bl-window-controls__btn"
        aria-label="Minimize"
        onClick={act((w) => w.minimize())}
      >
        <Minus size={16} strokeWidth={1.5} aria-hidden />
      </button>
      <button
        type="button"
        className="bl-window-controls__btn"
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={act((w) => w.toggleMaximize())}
      >
        {maximized ? (
          <Copy size={13} strokeWidth={1.5} aria-hidden style={{ transform: "scaleX(-1)" }} />
        ) : (
          <Square size={13} strokeWidth={1.5} aria-hidden />
        )}
      </button>
      <button
        type="button"
        className="bl-window-controls__btn bl-window-controls__btn--close"
        aria-label="Close"
        onClick={act((w) => w.close())}
      >
        <X size={16} strokeWidth={1.5} aria-hidden />
      </button>
    </div>
  );
}
