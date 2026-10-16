import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import "./Toast.css";

export type ToastTone = "info" | "success" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastInput {
  tone?: ToastTone;
  title: string;
  description?: string;
  /** Buttons under the description; choosing one also dismisses the toast. */
  actions?: ToastAction[];
  /** Auto-dismiss after this many ms; errors stay until dismissed by default. */
  durationMs?: number | null;
}

interface ToastItem extends ToastInput {
  id: number;
  tone: ToastTone;
}

const ToastContext = createContext<(t: ToastInput) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

const ICON = { info: Info, success: CircleCheck, error: CircleAlert } as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      const tone = input.tone ?? "info";
      setItems((list) => [...list.slice(-3), { ...input, id, tone }]);
      // Toasts with actions stay until used or dismissed, so the choice is not lost.
      const duration =
        input.durationMs === undefined
          ? tone === "error" || input.actions?.length
            ? null
            : 4000
          : input.durationMs;
      if (duration) window.setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="bl-toasts" aria-live="polite" aria-relevant="additions">
        {items.map((t) => {
          const Icon = ICON[t.tone];
          return (
            <div
              key={t.id}
              className={`bl-toast bl-toast--${t.tone}`}
              role={t.tone === "error" ? "alert" : "status"}
            >
              <Icon size={18} className="bl-toast__icon" aria-hidden />
              <div className="bl-toast__body">
                <div className="bl-toast__title">{t.title}</div>
                {t.description && <div className="bl-toast__description">{t.description}</div>}
                {t.actions && t.actions.length > 0 && (
                  <div className="bl-toast__actions">
                    {t.actions.map((a) => (
                      <button
                        key={a.label}
                        type="button"
                        className="bl-toast__action"
                        onClick={() => {
                          dismiss(t.id);
                          a.onClick();
                        }}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="bl-toast__close"
                aria-label="Dismiss notification"
                onClick={() => dismiss(t.id)}
              >
                <X size={14} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
