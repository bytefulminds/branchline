import { CircleAlert, CircleCheck, PlugZap } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "../../components/Button";
import { aiService, type AiServerInfo, formatSize, isLocalServer } from "../../services/ai";
import type { GitError } from "../../types/git";
import type { Settings } from "../../types/settings";
import { Field, type Setter, TextSetting, Toggle } from "./SettingControls";

type Connection =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; info: AiServerInfo }
  | { state: "error"; message: string };

/** Pick a sensible model when none is chosen yet: a coding model if there is one. */
export function preferredModel(names: string[]): string {
  return names.find((n) => /coder|code/i.test(n)) ?? names[0] ?? "";
}

/** Text area that saves when it loses focus. */
function TextAreaSetting({
  id,
  value,
  placeholder,
  onCommit,
}: {
  id: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(value);
  }
  return (
    <textarea
      id={id}
      className="bl-input bl-setting__textarea"
      rows={4}
      maxLength={4000}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
    />
  );
}

export function AiSection({ s, set }: { s: Settings; set: Setter }) {
  const ai = s.ai;
  const ids = {
    url: useId(),
    model: useId(),
    style: useId(),
    language: useId(),
    instructions: useId(),
  };
  const setAi = (patch: Partial<Settings["ai"]>) =>
    set((x) => ({ ...x, ai: { ...x.ai, ...patch } }));
  // Each Test click (and each new address) is a new attempt; results are kept per attempt.
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; info?: AiServerInfo; error?: string } | null>(
    null,
  );
  const key = `${attempt}|${ai.url}`;
  // Nothing is contacted while the feature is off, unless the user clicks Test.
  const active = (ai.enabled || attempt > 0) && ai.url !== "";

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    aiService.serverInfo(ai.url).then(
      (info) => {
        if (cancelled) return;
        setResult({ key, info });
        if (!ai.model && info.models.length > 0)
          setAi({ model: preferredModel(info.models.map((m) => m.name)) });
      },
      (e) => {
        if (!cancelled) setResult({ key, error: (e as GitError).message });
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);

  const connection: Connection = !active
    ? { state: "idle" }
    : result?.key !== key
      ? { state: "testing" }
      : result.info
        ? { state: "ok", info: result.info }
        : { state: "error", message: result.error ?? "" };

  const models = connection.state === "ok" ? connection.info.models : [];
  const installed = models.some((m) => m.name === ai.model);
  const local = isLocalServer(ai.url);

  return (
    <>
      <p className="bl-setting__help bl-setting__intro">
        Branchline can write a first draft of your commit message from the staged changes, using a
        model that runs in <strong>Ollama</strong> on your own computer or network. Nothing is sent
        until you choose <em>Suggest message</em> in the commit box, and only the staged diff, the
        file list, the branch name and recent commit subjects are sent. Install Ollama from
        ollama.com, then pull a model, for example{" "}
        <code className="mono">ollama pull qwen2.5-coder:7b</code>.
      </p>
      <Toggle
        label="Suggest commit messages"
        help="Adds a Suggest message button to the commit box."
        checked={ai.enabled}
        onChange={(v) => setAi({ enabled: v })}
      />
      <Field
        label="Ollama server"
        help={
          <>
            Usually http://localhost:11434.{" "}
            {!local && ai.url && (
              <span className="bl-setting__warning">
                Your staged changes are sent to this server; use one you trust.
                {ai.url.toLowerCase().startsWith("http://") &&
                  " Plain http:// is not encrypted on the network."}
              </span>
            )}
          </>
        }
        htmlFor={ids.url}
      >
        <TextSetting
          id={ids.url}
          value={ai.url}
          placeholder="http://localhost:11434"
          onCommit={(v) => setAi({ url: v.trim() })}
        />
        <Button
          icon={<PlugZap size={14} aria-hidden />}
          loading={connection.state === "testing"}
          onClick={() => setAttempt((n) => n + 1)}
        >
          Test
        </Button>
      </Field>
      <div className="bl-setting__connection" role="status" aria-live="polite">
        {connection.state === "ok" && (
          <span className="bl-setting__ok">
            <CircleCheck size={14} aria-hidden /> Connected
            {connection.info.version ? ` to Ollama ${connection.info.version}` : ""}
            {" · "}
            {connection.info.models.length === 1
              ? "1 model"
              : `${connection.info.models.length} models`}
          </span>
        )}
        {connection.state === "error" && (
          <span className="bl-field-group__error">
            <CircleAlert size={14} aria-hidden /> {connection.message}
          </span>
        )}
      </div>
      <Field
        label="Model"
        help={
          connection.state === "ok" && models.length === 0
            ? "No models installed yet. Pull one with ollama pull, then test again."
            : ai.model && connection.state === "ok" && !installed
              ? `${ai.model} is not installed on this server.`
              : "Coding models such as qwen2.5-coder or llama3.1 work well. Smaller models answer faster."
        }
        htmlFor={ids.model}
      >
        <select
          id={ids.model}
          className="bl-input bl-setting__select"
          value={ai.model}
          onChange={(e) => setAi({ model: e.target.value })}
        >
          {!ai.model && <option value="">Choose a model</option>}
          {ai.model && !installed && <option value={ai.model}>{ai.model}</option>}
          {models.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
              {m.parameterSize ? ` · ${m.parameterSize}` : ""} · {formatSize(m.size)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Message style" htmlFor={ids.style}>
        <select
          id={ids.style}
          className="bl-input bl-setting__select"
          value={ai.style}
          onChange={(e) => setAi({ style: e.target.value as Settings["ai"]["style"] })}
        >
          <option value="conventional">Conventional Commits (feat: add login)</option>
          <option value="plain">Plain (Add login)</option>
        </select>
      </Field>
      <Field label="Language" help="The language messages are written in." htmlFor={ids.language}>
        <TextSetting
          id={ids.language}
          value={ai.language}
          placeholder="English"
          mono={false}
          onCommit={(v) => setAi({ language: v.trim() })}
        />
      </Field>
      <Field
        label="Extra instructions"
        help="Team conventions the model should follow, for example a ticket prefix taken from the branch name."
        htmlFor={ids.instructions}
        stacked
      >
        <TextAreaSetting
          id={ids.instructions}
          value={ai.instructions}
          placeholder="Start the summary with the ticket number from the branch name, like BL-12."
          onCommit={(v) => setAi({ instructions: v })}
        />
      </Field>
    </>
  );
}
