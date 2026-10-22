import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { SHORTCUT_GROUPS } from "./shortcuts";

/** Overview of every keyboard shortcut (`Ctrl+/` / `⌘/`, or `?`). */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Keyboard shortcuts"
      size="wide"
      onCancel={onClose}
      onSubmit={onClose}
      actions={
        <Button type="submit" variant="primary">
          Done
        </Button>
      }
    >
      <div className="bl-shortcuts">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title} aria-labelledby={`shortcuts-${group.title}`}>
            <h3 id={`shortcuts-${group.title}`} className="bl-shortcuts__title">
              {group.title}
            </h3>
            <dl>
              {group.items.map((item) => (
                <div key={`${item.keys}-${item.action}`} className="bl-shortcuts__row">
                  <dt>
                    <kbd className="bl-kbd">{item.keys}</kbd>
                  </dt>
                  <dd>{item.action}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
