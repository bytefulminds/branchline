import {
  Code2,
  GitBranch,
  type LucideIcon,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button, IconButton } from "../../components/Button";
import { platform } from "../../services/platform";
import { settingsService } from "../../services/settings";
import type { GitError } from "../../types/git";
import type {
  ConfigScope,
  DiffLayout,
  Identity,
  IdentityValues,
  Settings,
} from "../../types/settings";
import { AiSection } from "./AiSection";
import { Field, NumberSelect, type Setter, TextSetting, Toggle } from "./SettingControls";
import { useSettings } from "./SettingsProvider";
import "./SettingsView.css";

export type SettingsSection = "general" | "git" | "identity" | "editor" | "safety" | "ai";

const SECTIONS: { id: SettingsSection; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: RefreshCw },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "identity", label: "Identity & signing", icon: UserRound },
  { id: "editor", label: "Editor & diff", icon: Code2 },
  { id: "safety", label: "Confirmations", icon: ShieldCheck },
  { id: "ai", label: "AI commit messages", icon: Sparkles },
];

const FETCH_OPTIONS = [0, 5, 10, 15, 30, 60].map((m) => ({
  value: m,
  label: m === 0 ? "Off" : `Every ${m} minutes`,
}));

function GeneralSection({ s, set }: { s: Settings; set: Setter }) {
  const fetchId = useId();
  return (
    <>
      <Toggle
        label="Reopen the last repository"
        help="Start where you left off instead of on the welcome screen."
        checked={s.general.openLastRepository}
        onChange={(v) => set((x) => ({ ...x, general: { ...x.general, openLastRepository: v } }))}
      />
      <Toggle
        label="Refresh when Branchline gets focus"
        help="Picks up changes made in other apps. Branchline also watches the folder for changes."
        checked={s.general.refreshOnFocus}
        onChange={(v) => set((x) => ({ ...x, general: { ...x.general, refreshOnFocus: v } }))}
      />
      <Field
        label="Fetch in the background"
        help="Keeps remote branches and ahead/behind counts current. Never pulls or changes your branches."
        htmlFor={fetchId}
      >
        <NumberSelect
          id={fetchId}
          value={s.general.autoFetchMinutes}
          options={FETCH_OPTIONS}
          onChange={(v) => set((x) => ({ ...x, general: { ...x.general, autoFetchMinutes: v } }))}
        />
      </Field>
    </>
  );
}

function GitSection({ s, set }: { s: Settings; set: Setter }) {
  const pullId = useId();
  return (
    <>
      <Field
        label="Pull button"
        help="What Pull does. The menu next to it always offers all three."
        htmlFor={pullId}
      >
        <select
          id={pullId}
          className="bl-input bl-setting__select"
          value={s.git.defaultPullMode}
          onChange={(e) =>
            set((x) => ({
              ...x,
              git: {
                ...x.git,
                defaultPullMode: e.target.value as Settings["git"]["defaultPullMode"],
              },
            }))
          }
        >
          <option value="fastForward">Fast-forward only</option>
          <option value="merge">Merge</option>
          <option value="rebase">Rebase</option>
        </select>
      </Field>
      <Toggle
        label="Remove deleted remote branches when fetching"
        help="Branches deleted on the server disappear from the list (git fetch --prune)."
        checked={s.git.pruneOnFetch}
        onChange={(v) => set((x) => ({ ...x, git: { ...x.git, pruneOnFetch: v } }))}
      />
      <Toggle
        label="Push annotated tags with commits"
        help="Tags on the commits you push go along (git push --follow-tags)."
        checked={s.git.pushFollowTags}
        onChange={(v) => set((x) => ({ ...x, git: { ...x.git, pushFollowTags: v } }))}
      />
    </>
  );
}

const EMPTY_IDENTITY: IdentityValues = {
  name: "",
  email: "",
  signCommits: false,
  signingFormat: "",
  signingKey: "",
};

function IdentitySection({ repoPath, repoName }: { repoPath: string | null; repoName: string }) {
  const [scope, setScope] = useState<ConfigScope>("global");
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [draft, setDraft] = useState<IdentityValues>(EMPTY_IDENTITY);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { name: useId(), email: useId(), format: useId(), key: useId() };

  useEffect(() => {
    let cancelled = false;
    settingsService
      .getIdentity(repoPath)
      .then((id) => {
        if (cancelled || !id) return;
        setIdentity(id);
        setDraft(id.global);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const pick = (next: ConfigScope) => {
    setScope(next);
    setStatus(null);
    if (identity)
      setDraft((next === "global" ? identity.global : identity.repository) ?? EMPTY_IDENTITY);
  };

  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await settingsService.setIdentity(scope, repoPath, draft);
      setIdentity((id) =>
        id ? (scope === "global" ? { ...id, global: draft } : { ...id, repository: draft }) : id,
      );
      setStatus({ tone: "ok", text: "Saved to Git's configuration." });
    } catch (e) {
      setStatus({ tone: "error", text: (e as GitError).message });
    } finally {
      setBusy(false);
    }
  };

  const fallback = scope === "repository" ? identity?.global : null;
  const set = (patch: Partial<IdentityValues>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setStatus(null);
  };

  return (
    <>
      <div className="bl-setting-tabs" role="tablist" aria-label="Where to save">
        <button
          type="button"
          role="tab"
          aria-selected={scope === "global"}
          onClick={() => pick("global")}
        >
          All repositories
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={scope === "repository"}
          disabled={!repoPath}
          title={repoPath ? undefined : "Open a repository first"}
          onClick={() => pick("repository")}
        >
          Only {repoPath ? repoName : "this repository"}
        </button>
      </div>
      <p className="bl-setting__help bl-setting__intro">
        {scope === "global"
          ? "Stored in your global Git configuration (~/.gitconfig), so the command line uses it too."
          : "Stored in this repository only, for example a work email. Empty fields use the values for all repositories."}
      </p>
      <Field label="Name" htmlFor={ids.name}>
        <input
          id={ids.name}
          className="bl-input"
          value={draft.name}
          placeholder={fallback?.name || "Ada Lovelace"}
          onChange={(e) => set({ name: e.target.value })}
        />
      </Field>
      <Field label="Email" htmlFor={ids.email}>
        <input
          id={ids.email}
          className="bl-input"
          type="email"
          value={draft.email}
          placeholder={fallback?.email || "ada@example.com"}
          onChange={(e) => set({ email: e.target.value })}
        />
      </Field>
      <Toggle
        label="Sign commits"
        help="Requires a GPG or SSH signing key set up on this computer. Git asks the key's agent; Branchline never sees the key."
        checked={draft.signCommits}
        onChange={(v) => set({ signCommits: v })}
      />
      {draft.signCommits && (
        <>
          <Field label="Signing format" htmlFor={ids.format}>
            <select
              id={ids.format}
              className="bl-input bl-setting__select"
              value={draft.signingFormat}
              onChange={(e) => set({ signingFormat: e.target.value })}
            >
              <option value="">GPG (default)</option>
              <option value="openpgp">GPG (OpenPGP)</option>
              <option value="ssh">SSH key</option>
              <option value="x509">X.509 (S/MIME)</option>
            </select>
          </Field>
          <Field
            label="Signing key"
            help={
              draft.signingFormat === "ssh"
                ? "Path to the public key, for example ~/.ssh/id_ed25519.pub."
                : "Key id or fingerprint. Empty uses the key that matches your email."
            }
            htmlFor={ids.key}
          >
            <input
              id={ids.key}
              className="bl-input mono"
              value={draft.signingKey}
              onChange={(e) => set({ signingKey: e.target.value })}
            />
          </Field>
        </>
      )}
      <div className="bl-setting__actions">
        {status && (
          <span
            className={status.tone === "ok" ? "bl-setting__ok" : "bl-field-group__error"}
            role={status.tone === "ok" ? "status" : "alert"}
          >
            {status.text}
          </span>
        )}
        <Button variant="primary" loading={busy} disabled={!identity} onClick={() => void save()}>
          Save identity
        </Button>
      </div>
    </>
  );
}

const EDITOR_HINT =
  platform === "macos"
    ? "For example code, cursor, subl or an app name such as Zed. Empty opens files with their default app."
    : platform === "windows"
      ? "For example code or the full path to your editor. Empty opens files with their default app."
      : "For example code, subl or gedit. Empty opens files with their default app.";

const TERMINAL_HINT =
  platform === "macos"
    ? "An app name such as iTerm, Warp or Ghostty. Empty uses Terminal."
    : platform === "windows"
      ? "Empty uses Windows Terminal (or Command Prompt)."
      : "For example gnome-terminal or kitty. Empty tries the usual terminals.";

function EditorSection({ s, set }: { s: Settings; set: Setter }) {
  const ids = {
    editor: useId(),
    terminal: useId(),
    context: useId(),
    tab: useId(),
    font: useId(),
    layout: useId(),
  };
  const e = s.editor;
  const setE = (patch: Partial<Settings["editor"]>) =>
    set((x) => ({ ...x, editor: { ...x.editor, ...patch } }));
  return (
    <>
      <Field label="External editor" help={EDITOR_HINT} htmlFor={ids.editor}>
        <TextSetting
          id={ids.editor}
          value={e.externalEditor}
          placeholder="Default app"
          onCommit={(v) => setE({ externalEditor: v })}
        />
      </Field>
      <Field label="Terminal" help={TERMINAL_HINT} htmlFor={ids.terminal}>
        <TextSetting
          id={ids.terminal}
          value={e.terminal}
          placeholder="System terminal"
          onCommit={(v) => setE({ terminal: v })}
        />
      </Field>
      <Field
        label="Diff layout"
        help="Also switchable with the buttons above each diff."
        htmlFor={ids.layout}
      >
        <select
          id={ids.layout}
          className="bl-input bl-setting__select"
          value={e.diffLayout}
          onChange={(ev) => setE({ diffLayout: ev.target.value as DiffLayout })}
        >
          <option value="unified">One column</option>
          <option value="split">Side by side</option>
        </select>
      </Field>
      <Toggle
        label="Syntax highlighting"
        help="Colors code in diffs by language. Very large diffs are shown without colors."
        checked={e.syntaxHighlighting}
        onChange={(v) => setE({ syntaxHighlighting: v })}
      />
      <Field
        label="Context lines in diffs"
        help="Unchanged lines shown around each change."
        htmlFor={ids.context}
      >
        <NumberSelect
          id={ids.context}
          value={e.diffContext}
          options={[0, 1, 3, 5, 10, 25].map((n) => ({ value: n, label: String(n) }))}
          onChange={(v) => setE({ diffContext: v })}
        />
      </Field>
      <Toggle
        label="Ignore whitespace changes in diffs"
        help="Hides lines where only spaces or tabs changed. While this is on (or context is not 3 lines), staging single lines is off, because Git needs the full diff for that."
        checked={e.ignoreWhitespace}
        onChange={(v) => setE({ ignoreWhitespace: v })}
      />
      <Field label="Tab width" htmlFor={ids.tab}>
        <NumberSelect
          id={ids.tab}
          value={e.tabWidth}
          options={[2, 4, 8].map((n) => ({ value: n, label: `${n} spaces` }))}
          onChange={(v) => setE({ tabWidth: v })}
        />
      </Field>
      <Field label="Code font size" htmlFor={ids.font}>
        <NumberSelect
          id={ids.font}
          value={e.codeFontSize}
          options={[11, 12, 13, 14, 15, 16].map((n) => ({ value: n, label: `${n} px` }))}
          onChange={(v) => setE({ codeFontSize: v })}
        />
      </Field>
    </>
  );
}

function SafetySection({ s, set }: { s: Settings; set: Setter }) {
  const setS = (patch: Partial<Settings["safety"]>) =>
    set((x) => ({ ...x, safety: { ...x.safety, ...patch } }));
  return (
    <>
      <p className="bl-setting__help bl-setting__intro">
        Branchline asks before actions that lose work or rewrite shared history. Turn off the
        questions you do not need. Deleting an unmerged branch and removing a worktree with changes
        always ask.
      </p>
      <Toggle
        label="Discarding changes"
        help="Discarding files or selected lines cannot be undone."
        checked={s.safety.confirmDiscard}
        onChange={(v) => setS({ confirmDiscard: v })}
      />
      <Toggle
        label="Force pushing"
        help="Replaces the branch on the remote (with lease)."
        checked={s.safety.confirmForcePush}
        onChange={(v) => setS({ confirmForcePush: v })}
      />
      <Toggle
        label="Rebasing a published branch"
        help="Rebasing a branch that is already pushed means a force push afterwards."
        checked={s.safety.confirmRebasePublished}
        onChange={(v) => setS({ confirmRebasePublished: v })}
      />
      <Toggle
        label="Deleting branches"
        checked={s.safety.confirmDeleteBranch}
        onChange={(v) => setS({ confirmDeleteBranch: v })}
      />
    </>
  );
}

/** Settings, in a full-window panel. Changes save right away. */
export function SettingsView({
  repoPath,
  repoName,
  initialSection = "general",
  onClose,
}: {
  repoPath: string | null;
  repoName: string;
  initialSection?: SettingsSection;
  onClose: () => void;
}) {
  const { settings, update } = useSettings();
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [saveState, setSaveState] = useState<{ error: string | null; at: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
    return () => previous?.focus?.();
  }, []);

  const set: Setter = (change) => {
    void update(change).then((error) => setSaveState({ error, at: Date.now() }));
  };

  const current = SECTIONS.find((x) => x.id === section)!;

  return (
    <div
      ref={ref}
      className="bl-settings"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !(e.target as HTMLElement).closest("select")) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <nav className="bl-settings__nav" aria-label="Settings sections">
        <h2 id={titleId} className="text-h2 bl-settings__title">
          Settings
        </h2>
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className="bl-settings__nav-item"
            aria-current={section === id ? "page" : undefined}
            onClick={() => setSection(id)}
          >
            <Icon size={16} aria-hidden />
            {label}
          </button>
        ))}
      </nav>
      <section className="bl-settings__content" aria-label={current.label}>
        <header className="bl-settings__header">
          <h3 className="text-h2">{current.label}</h3>
          <span className="bl-settings__saved text-small" role="status">
            {saveState?.error ? (
              <span className="bl-field-group__error">{saveState.error}</span>
            ) : saveState ? (
              "Saved"
            ) : (
              ""
            )}
          </span>
          <IconButton
            label="Close settings (Esc)"
            icon={<X size={18} aria-hidden />}
            onClick={onClose}
            data-tooltip-align="end"
          />
        </header>
        <div className="bl-settings__body">
          {section === "general" && <GeneralSection s={settings} set={set} />}
          {section === "git" && <GitSection s={settings} set={set} />}
          {section === "identity" && <IdentitySection repoPath={repoPath} repoName={repoName} />}
          {section === "editor" && <EditorSection s={settings} set={set} />}
          {section === "safety" && <SafetySection s={settings} set={set} />}
          {section === "ai" && <AiSection s={settings} set={set} />}
        </div>
      </section>
    </div>
  );
}
