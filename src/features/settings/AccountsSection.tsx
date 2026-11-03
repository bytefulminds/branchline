import { CircleAlert, ExternalLink, KeyRound, LogOut } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../../components/Button";
import { useConfirm } from "../../components/ConfirmDialog";
import { forgeService } from "../../services/forge";
import type { Access, Account, ForgeKind } from "../../types/forge";
import type { GitError } from "../../types/git";
import { Avatar } from "../history/Avatar";
import { FORGES, forgeInfo, PLANNED_FORGES } from "../reviews/forges";
import { useReviews } from "../reviews/ReviewsProvider";
import { Field } from "./SettingControls";

const ACCESS: Record<Access, string> = {
  write: "Can read merge requests, comment and approve",
  read: "Can read merge requests (read_api); commenting and approving need the api scope",
  unknown: "Connected (this server version does not say what the token may do)",
};

/** Settings > Accounts: accounts on hosting services (GitLab now; GitHub and Bitbucket
 * later), with their tokens in the system's password store. */
export function AccountsSection() {
  const { accounts, connect: connectAccount, disconnect } = useReviews();
  const confirm = useConfirm();
  const ids = { kind: useId(), url: useId(), token: useId() };
  const [kind, setKind] = useState<ForgeKind>("gitlab");
  const f = FORGES[kind];
  const [url, setUrl] = useState(f.defaultUrl);
  const [token, setToken] = useState("");
  const [state, setState] = useState<
    | { s: "idle" }
    | { s: "connecting" }
    | { s: "error"; message: string }
    | { s: "done"; who: string }
  >({ s: "idle" });

  const connect = async () => {
    setState({ s: "connecting" });
    try {
      const account = await connectAccount(kind, url, token);
      setToken("");
      setState({ s: "done", who: `${account.name} (@${account.username}) on ${account.host}` });
    } catch (e) {
      setState({ s: "error", message: (e as GitError).message ?? String(e) });
    }
  };

  const remove = async (a: Account) => {
    const ok = await confirm({
      title: `Disconnect ${a.host}?`,
      description: `Branchline forgets the account and deletes its token from this computer's password store. The token itself stays valid on ${forgeInfo(a.kind).name} until you revoke it there.`,
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (ok) await disconnect(a.kind, a.url).catch(() => {});
  };

  return (
    <>
      <p className="bl-setting__help bl-setting__intro">
        Connect your account on a hosting service to see its merge requests in the Reviews view: the
        ones waiting for your review, the ones you created, and all open ones. Branchline uses a{" "}
        <strong>personal access token</strong>, kept in this computer&apos;s password store
        (Keychain, Credential Manager or the Secret Service), and only contacts the server you enter
        here. GitLab works today; {PLANNED_FORGES.join(" and ")} are planned.
      </p>

      {accounts.length > 0 && (
        <ul className="bl-accounts" aria-label="Connected accounts">
          {accounts.map((a) => (
            <li key={a.url} className="bl-account">
              <Avatar name={a.name} email={a.username} size={28} />
              <span className="bl-account__text">
                <span className="bl-account__name">
                  {a.name} <span className="text-secondary">@{a.username}</span>
                </span>
                <span className="text-small text-muted">
                  {forgeInfo(a.kind).name} · {a.url} · {ACCESS[a.access]}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon={<LogOut size={14} aria-hidden />}
                onClick={() => void remove(a)}
              >
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      )}

      <h4 className="bl-settings__subhead">
        {accounts.length ? "Connect another account" : "Connect an account"}
      </h4>
      <Field label="Service" htmlFor={ids.kind}>
        <select
          id={ids.kind}
          className="bl-input"
          value={kind}
          onChange={(e) => {
            const next = e.target.value as ForgeKind;
            setKind(next);
            setUrl(FORGES[next].defaultUrl);
          }}
        >
          {(Object.keys(FORGES) as ForgeKind[]).map((k) => (
            <option key={k} value={k}>
              {FORGES[k].name}
            </option>
          ))}
          {PLANNED_FORGES.map((name) => (
            <option key={name} disabled>
              {name} (coming later)
            </option>
          ))}
        </select>
      </Field>
      <Field
        label={`${f.name} address`}
        help={`${f.defaultUrl}, or the address of your company's ${f.name}.`}
        htmlFor={ids.url}
      >
        <input
          id={ids.url}
          className="bl-input"
          value={url}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setUrl(e.target.value)}
        />
      </Field>
      <Field
        label="Personal access token"
        help={
          <>
            Make {f.tokenHelp} under your own profile, so it acts as you.{" "}
            <button
              type="button"
              className="bl-link-button"
              onClick={() => void forgeService.openTokenPage(kind, url).catch(() => {})}
            >
              Create a token on {f.name} <ExternalLink size={12} aria-hidden />
            </button>
          </>
        }
        htmlFor={ids.token}
      >
        <input
          id={ids.token}
          className="bl-input"
          type="password"
          value={token}
          spellCheck={false}
          autoComplete="off"
          placeholder="glpat-…"
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && token.trim() && void connect()}
        />
        <Button
          variant="primary"
          icon={<KeyRound size={14} aria-hidden />}
          loading={state.s === "connecting"}
          disabled={!token.trim() || !url.trim()}
          onClick={() => void connect()}
        >
          Connect
        </Button>
      </Field>
      <div className="bl-setting__connection" role="status" aria-live="polite">
        {state.s === "done" && <span className="bl-setting__ok">Connected as {state.who}</span>}
        {state.s === "error" && (
          <span className="bl-field-group__error">
            <CircleAlert size={14} aria-hidden /> {state.message}
          </span>
        )}
      </div>
    </>
  );
}
