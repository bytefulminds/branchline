import { Columns2, Rows2 } from "lucide-react";
import { IconButton } from "../../components/Button";
import type { DiffLayout } from "../../types/settings";
import { useSettings } from "../settings/SettingsProvider";

/** Switch between one column and side by side; saved as a setting for every diff. */
export function DiffLayoutToggle() {
  const { settings, update } = useSettings();
  const layout = settings.editor.diffLayout;
  const set = (diffLayout: DiffLayout) =>
    void update((s) => ({ ...s, editor: { ...s.editor, diffLayout } }));
  return (
    <div className="bl-segmented" role="group" aria-label="Diff layout">
      <IconButton
        size="sm"
        label="One column"
        icon={<Rows2 size={14} aria-hidden />}
        aria-pressed={layout === "unified"}
        onClick={() => set("unified")}
      />
      <IconButton
        size="sm"
        label="Side by side"
        icon={<Columns2 size={14} aria-hidden />}
        aria-pressed={layout === "split"}
        onClick={() => set("split")}
      />
    </div>
  );
}
