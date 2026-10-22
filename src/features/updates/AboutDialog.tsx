import { getVersion } from "@tauri-apps/api/app";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { LogoMark } from "../../components/Logo";
import { ISSUES_URL, openLink, PROJECT_URL, RELEASES_URL } from "../../services/links";
import { gitService } from "../../services/git";

/** Version, Git version, links and a button to look for updates. */
export function AboutDialog({
  onClose,
  onCheckForUpdates,
}: {
  onClose: () => void;
  onCheckForUpdates: () => void;
}) {
  const [version, setVersion] = useState<string | null>(null);
  const [git, setGit] = useState<string | null>(null);
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
    gitService
      .version()
      .then((v) => setGit(`Git ${v.version}`))
      .catch(() => {});
  }, []);

  const link = (label: string, url: string) => (
    <Button
      size="sm"
      variant="ghost"
      icon={<ExternalLink size={14} aria-hidden />}
      onClick={() => openLink(url)}
    >
      {label}
    </Button>
  );

  return (
    <Dialog
      title="About Branchline"
      onCancel={onClose}
      onSubmit={onClose}
      actions={
        <>
          <Button onClick={onCheckForUpdates}>Check for updates</Button>
          <Button type="submit" variant="primary">
            Close
          </Button>
        </>
      }
    >
      <div className="bl-about">
        <LogoMark size={48} />
        <div>
          <p className="bl-about__name">Branchline {version ?? ""}</p>
          <p className="text-small text-secondary">
            A fast, local-first, open-source Git desktop client.
            {git ? ` Using ${git}.` : ""}
          </p>
          <p className="text-small text-muted">
            MIT License. Copyright 2026 Branchline contributors.
          </p>
        </div>
      </div>
      <div className="bl-about__links">
        {link("Website and source", PROJECT_URL)}
        {link("Release notes", RELEASES_URL)}
        {link("Report a problem", ISSUES_URL)}
      </div>
    </Dialog>
  );
}
