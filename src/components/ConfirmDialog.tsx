import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "./Button";
import "./ConfirmDialog.css";

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Destructive actions use the danger style; Cancel keeps initial focus. */
  destructive?: boolean;
}

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm>(async () => false);

export function useConfirm(): Confirm {
  return useContext(ConfirmContext);
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirm = useCallback<Confirm>(
    (options) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  );
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <ConfirmDialog
          {...pending}
          onClose={(ok) => {
            pending.resolve(ok);
            setPending(null);
          }}
        />
      )}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive,
  onClose,
}: ConfirmOptions & { onClose: (ok: boolean) => void }) {
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Safe default: destructive dialogs focus Cancel, others focus the action.
    (destructive ? cancelRef : confirmRef).current?.focus();
    return () => previous?.focus?.();
  }, [destructive]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(false);
    } else if (e.key === "Tab") {
      // Keep focus inside the dialog.
      const focusables = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [],
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div
      className="bl-dialog-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && onClose(false)}
    >
      <div
        ref={dialogRef}
        className="bl-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        onKeyDown={onKeyDown}
      >
        <div className="bl-dialog__body">
          {destructive && (
            <span className="bl-dialog__icon" aria-hidden>
              <TriangleAlert size={18} />
            </span>
          )}
          <div className="bl-dialog__text">
            <h2 id={titleId} className="text-h3">
              {title}
            </h2>
            {description && (
              <div id={descId} className="bl-dialog__description">
                {description}
              </div>
            )}
          </div>
        </div>
        <div className="bl-dialog__actions">
          <Button ref={cancelRef} variant="secondary" onClick={() => onClose(false)}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={destructive ? "danger" : "primary"}
            onClick={() => onClose(true)}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
