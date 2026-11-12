import { CircleAlert, CircleCheck, ExternalLink, KeyRound, PlugZap, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "../../components/Button";
import {
  aiService,
  type AiServerInfo,
  formatSize,
  isLocalServer,
  PROVIDERS,
  providerModel,
  providerPatch,
  providerUrl,
} from "../../services/ai";
import { openLink } from "../../services/links";
import type { GitError } from "../../types/git";
import type { AiProvider, Settings } from "../../types/settings";
import { Field, type Setter, TextSetting, Toggle } from "./SettingControls";

type Connection =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; info: AiServerInfo }
  | { state: "error"; message: string };

/** Pick a sensible model when none is chosen yet. */
export function preferredModel(names: string[], provider: AiProvider = "ollama"): string {
  const pick =
    provider === "anthropic"
      ? names.find((n) => /sonnet/i.test(n))
      : provider === "openai"
        ? names.find((n) => /^gpt-[\d.]+-mini$/i.test(n))
        : names.find((n) => /coder|code/i.test(n));
  return pick ?? names[0] ?? "";
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

/** Whether an API key is stored for the provider, looked up again after each change. */
function useStoredKey(provider: AiProvider) {
  const wanted = PROVIDERS[provider].key !== null;
  const [round, setRound] = useState(0);
  const [result, setResult] = useState<{ key: string; exists: boolean } | null>(null);
  const lookup = `${provider}|${round}`;
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    aiService.keyExists(provider).then(
      (exists) => !cancelled && setResult({ key: lookup, exists }),
      () => !cancelled && setResult({ key: lookup, exists: false }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookup]);
  const exists = !wanted ? false : result?.key === lookup ? result.exists : null;
  return { exists, changed: () => setRound((n) => n + 1) };
}

/** Ollama context sizes to choose from; 0 leaves it to Ollama. */
const CONTEXT_OPTIONS: [number, string][] = [
  [0, "Ollama's setting"],
  [8192, "8K tokens"],
  [16384, "16K tokens (default)"],
  [32768, "32K tokens"],
  [65536, "64K tokens"],
  [131072, "128K tokens"],
];

function ApiKeyField({
  provider,
  exists,
  onChanged,
}: {
  provider: AiProvider;
  exists: boolean | null;
  onChanged: () => void;
}) {
  const info = PROVIDERS[provider];
  const id = useId();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      await aiService.saveKey(provider, value);
      setDraft("");
      onChanged();
    } catch (e) {
      setError((e as GitError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Field
        label={info.key === "optional" ? "API key (optional)" : "API key"}
        help={
          <>
            {exists
              ? "Saved in your system's password store. Paste a new key to replace it."
              : "Kept in your system's password store, never in Branchline's settings file."}{" "}
            {info.keyPage && (
              <button
                type="button"
                className="bl-link-button"
                onClick={() => openLink(info.keyPage!)}
              >
                Create a key in {info.keySite} <ExternalLink size={12} aria-hidden />
              </button>
            )}
          </>
        }
        htmlFor={id}
      >
        <input
          id={id}
          className="bl-input"
          type="password"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder={exists ? "•••••••• (saved)" : info.keyPlaceholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && draft.trim() && void save(draft)}
        />
        {draft.trim() || !exists ? (
          <Button
            variant="primary"
            icon={<KeyRound size={14} aria-hidden />}
            loading={busy}
            disabled={!draft.trim()}
            onClick={() => void save(draft)}
          >
            Save
          </Button>
        ) : (
          <Button
            icon={<Trash2 size={14} aria-hidden />}
            loading={busy}
            onClick={() => void save("")}
          >
            Remove
          </Button>
        )}
      </Field>
      {error && (
        <div className="bl-setting__connection" role="alert">
          <span className="bl-field-group__error">
            <CircleAlert size={14} aria-hidden /> {error}
          </span>
        </div>
      )}
    </>
  );
}

export function AiSection({ s, set }: { s: Settings; set: Setter }) {
  const ai = s.ai;
  const provider = PROVIDERS[ai.provider];
  const url = providerUrl(ai);
  const model = providerModel(ai);
  const ids = {
    context: useId(),
    provider: useId(),
    url: useId(),
    model: useId(),
    style: useId(),
    language: useId(),
    instructions: useId(),
  };
  const setAi = (patch: Partial<Settings["ai"]>) =>
    set((x) => ({ ...x, ai: { ...x.ai, ...patch } }));
  const storedKey = useStoredKey(ai.provider);

  // Each Test click (and each new provider, address or key) is a new attempt; results are
  // kept per attempt.
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; info?: AiServerInfo; error?: string } | null>(
    null,
  );
  const key = `${attempt}|${ai.provider}|${url}|${storedKey.exists}`;
  // Nothing is contacted while AI is off, unless the user clicks Test. A provider that
  // needs a key waits until one is stored.
  const ready = provider.hasAddress
    ? url !== "" && (provider.key === null || storedKey.exists !== null)
    : storedKey.exists === true;
  const active = (ai.enabled || attempt > 0) && ready;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const forProvider = ai.provider;
    aiService.serverInfo(forProvider, url).then(
      (info) => {
        if (cancelled) return;
        setResult({ key, info });
        if (!model && info.models.length > 0)
          set((x) =>
            x.ai.provider === forProvider
              ? {
                  ...x,
                  ai: {
                    ...x.ai,
                    ...providerPatch(x.ai, {
                      model: preferredModel(
                        info.models.map((m) => m.name),
                        forProvider,
                      ),
                    }),
                  },
                }
              : x,
          );
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
  const listed = models.some((m) => m.name === model);
  const remote = provider.hasAddress && url !== "" && !isLocalServer(url);
  const noKey = provider.key === "required" && storedKey.exists === false;
  const testButton = (
    <Button
      icon={<PlugZap size={14} aria-hidden />}
      loading={connection.state === "testing"}
      disabled={noKey}
      onClick={() => setAttempt((n) => n + 1)}
    >
      Test
    </Button>
  );

  return (
    <>
      <p className="bl-setting__help bl-setting__intro">
        Branchline can use an AI model to help you: it writes a first draft of your commit message,
        suggests how to tidy a branch before you share it, and runs the review quest on merge
        requests and your own branch. Choose where the model runs: with <strong>Ollama</strong> or
        your own server, nothing leaves your computer or network; with <strong>Anthropic</strong> or{" "}
        <strong>OpenAI</strong>, it goes to their cloud. Nothing is sent until you ask for it, and
        with AI off, no AI feature appears anywhere in Branchline.
      </p>
      <Toggle
        label="Use AI"
        help="Turns on the AI features below. Off: no AI buttons, and nothing is sent."
        checked={ai.enabled}
        onChange={(v) => setAi({ enabled: v })}
      />
      <Field label="Provider" htmlFor={ids.provider}>
        <select
          id={ids.provider}
          className="bl-input bl-setting__select"
          value={ai.provider}
          onChange={(e) => setAi({ provider: e.target.value as AiProvider })}
        >
          {(Object.keys(PROVIDERS) as AiProvider[]).map((p) => (
            <option key={p} value={p}>
              {PROVIDERS[p].label}
            </option>
          ))}
        </select>
      </Field>
      {ai.provider === "ollama" && (
        <p className="bl-setting__help bl-setting__note">
          Private: the model runs on your computer or network. Install Ollama from ollama.com, then
          pull a model, for example <code className="mono">ollama pull qwen2.5-coder:7b</code>.
          Small models answer fast but make more mistakes.
        </p>
      )}
      {ai.provider === "openaiCompatible" && (
        <p className="bl-setting__help bl-setting__note">
          Any server with an OpenAI-compatible API: LM Studio, vLLM, the llama.cpp server, or a
          hosted service such as OpenRouter. Use the address that ends in{" "}
          <code className="mono">/v1</code>.
        </p>
      )}
      {provider.cloud && (
        <p className="bl-setting__help bl-setting__note">
          <span className="bl-setting__warning">
            When you ask for a suggestion, your staged changes are sent to {provider.name}.
          </span>{" "}
          {ai.provider === "anthropic"
            ? "A Claude Pro or Max plan does not include the API."
            : "A ChatGPT Plus or Pro plan does not include the API."}{" "}
          Apps such as Branchline need an API key from {provider.keySite}, billed per use and
          separately from a subscription. A commit message costs a fraction of a cent with most
          models.
        </p>
      )}
      {provider.hasAddress && (
        <Field
          label={ai.provider === "ollama" ? "Ollama server" : "Server address"}
          help={
            <>
              {ai.provider === "ollama"
                ? "Usually http://localhost:11434."
                : "For example http://localhost:1234/v1 for LM Studio."}{" "}
              {remote && (
                <span className="bl-setting__warning">
                  Your staged changes are sent to this server; use one you trust.
                  {url.toLowerCase().startsWith("http://") &&
                    " Plain http:// is not encrypted on the network."}
                </span>
              )}
            </>
          }
          htmlFor={ids.url}
        >
          <TextSetting
            id={ids.url}
            value={url}
            placeholder={
              ai.provider === "ollama" ? "http://localhost:11434" : "http://localhost:1234/v1"
            }
            onCommit={(v) => setAi(providerPatch(ai, { url: v.trim() }))}
          />
          {testButton}
        </Field>
      )}
      {provider.key && (
        <ApiKeyField
          key={ai.provider}
          provider={ai.provider}
          exists={storedKey.exists}
          onChanged={() => {
            storedKey.changed();
            setAttempt((n) => n + 1);
          }}
        />
      )}
      <Field
        label="Model"
        help={
          noKey
            ? `Save your ${provider.name} API key first, then choose a model.`
            : connection.state === "ok" && models.length === 0
              ? ai.provider === "ollama"
                ? "No models installed yet. Pull one with ollama pull, then test again."
                : "The server lists no models. Load one, then test again."
              : model && connection.state === "ok" && !listed
                ? `${model} is not available ${ai.provider === "ollama" ? "on this server" : `at ${provider.name}`}.`
                : ai.provider === "anthropic"
                  ? "Sonnet models are a good balance; Haiku models are faster and cheaper."
                  : ai.provider === "openai"
                    ? "Mini models are fast and cheap, and good enough for commit messages."
                    : "Coding models such as qwen2.5-coder or llama3.1 work well. Smaller models answer faster."
        }
        htmlFor={ids.model}
      >
        <select
          id={ids.model}
          className="bl-input bl-setting__select"
          value={model}
          onChange={(e) => setAi(providerPatch(ai, { model: e.target.value }))}
        >
          {!model && <option value="">Choose a model</option>}
          {model && !listed && <option value={model}>{model}</option>}
          {models.map((m) => (
            <option key={m.name} value={m.name}>
              {m.displayName ?? m.name}
              {m.parameterSize ? ` · ${m.parameterSize}` : ""}
              {m.size ? ` · ${formatSize(m.size)}` : ""}
            </option>
          ))}
        </select>
        {!provider.hasAddress && testButton}
      </Field>
      {ai.provider === "ollama" && (
        <Field
          label="Context length"
          help="How much text the model reads at once. Ollama reloads the model whenever this changes, so Branchline keeps it the same for every request. Choose Ollama's setting to use what you set in Ollama itself (its app, or OLLAMA_CONTEXT_LENGTH); if that is small, long changes get cut off."
          htmlFor={ids.context}
        >
          <select
            id={ids.context}
            className="bl-input bl-setting__select"
            value={ai.ollamaContext}
            onChange={(e) => setAi({ ollamaContext: Number(e.target.value) })}
          >
            {CONTEXT_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="bl-setting__connection" role="status" aria-live="polite">
        {connection.state === "ok" && (
          <span className="bl-setting__ok">
            <CircleCheck size={14} aria-hidden /> Connected
            {ai.provider === "ollama"
              ? connection.info.version
                ? ` to Ollama ${connection.info.version}`
                : ""
              : ` to ${provider.cloud ? provider.name : "the server"}`}
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

      <h4 className="bl-settings__subhead">Commit messages</h4>
      <Toggle
        label="Suggest commit messages"
        help="Adds a Suggest message button to the commit box while AI is on."
        checked={ai.commitSuggestions}
        onChange={(v) => setAi({ commitSuggestions: v })}
      />
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
