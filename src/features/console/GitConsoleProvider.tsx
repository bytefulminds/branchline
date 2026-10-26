import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface GitConsoleContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Open the console with the most recent failed command expanded. */
  showLatestFailure: () => void;
  /** Bumped by `showLatestFailure`, so the panel looks for the newest failure again. */
  revealToken: number;
  /** True once per `showLatestFailure`: the panel calls it when it found the failure. */
  consumeReveal: () => boolean;
}

const GitConsoleContext = createContext<GitConsoleContextValue>({
  open: false,
  setOpen: () => {},
  toggle: () => {},
  showLatestFailure: () => {},
  revealToken: 0,
  consumeReveal: () => false,
});

export function useGitConsole(): GitConsoleContextValue {
  return useContext(GitConsoleContext);
}

export function GitConsoleProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [revealToken, setRevealToken] = useState(0);
  const requested = useRef(0);
  const handled = useRef(0);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const showLatestFailure = useCallback(() => {
    setOpen(true);
    requested.current += 1;
    setRevealToken(requested.current);
  }, []);
  const consumeReveal = useCallback(() => {
    if (handled.current === requested.current) return false;
    handled.current = requested.current;
    return true;
  }, []);
  const value = useMemo(
    () => ({ open, setOpen, toggle, showLatestFailure, revealToken, consumeReveal }),
    [open, toggle, showLatestFailure, revealToken, consumeReveal],
  );
  return <GitConsoleContext.Provider value={value}>{children}</GitConsoleContext.Provider>;
}
