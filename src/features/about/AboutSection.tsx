import { getVersion } from "@tauri-apps/api/app";
import { ChevronRight, Download, ExternalLink, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { BytefulmindsLogo } from "../../components/BytefulmindsLogo";
import { Button } from "../../components/Button";
import { LogoMark } from "../../components/Logo";
import { Spinner } from "../../components/Spinner";
import { gitService } from "../../services/git";
import { ISSUES_URL, openLink, PROJECT_URL, RELEASES_URL } from "../../services/links";
import { filterPackages, loadLicenses, type LicenseData, type ThirdPartyPackage } from "./licenses";
import "./AboutSection.css";

const SOURCE_LABEL = { npm: "JavaScript", crate: "Rust" } as const;

/** Packages listed at first, and how many more each "Show more" adds. */
export const LICENSE_PAGE = 10;

function PackageRow({
  pkg,
  texts,
  expanded,
  onToggle,
}: {
  pkg: ThirdPartyPackage;
  texts: LicenseData["texts"];
  expanded: boolean;
  onToggle: () => void;
}) {
  const id = useId();
  return (
    <li className="bl-licenses__item">
      <button
        type="button"
        className="bl-licenses__row"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={onToggle}
      >
        <ChevronRight size={14} aria-hidden className="bl-licenses__chevron" />
        <span className="bl-licenses__name truncate">{pkg.name}</span>
        <span className="bl-licenses__version mono text-muted">{pkg.version}</span>
        <span className="bl-licenses__license truncate">{pkg.license}</span>
        <span className="bl-licenses__source text-muted">{SOURCE_LABEL[pkg.source]}</span>
      </button>
      {expanded && (
        <div id={id} className="bl-licenses__detail">
          {pkg.texts.length === 0 ? (
            <p className="text-small text-secondary">
              The package includes no license file; it is licensed under {pkg.license}.
            </p>
          ) : (
            pkg.texts.map((t) => (
              <pre key={t} className="mono selectable">
                {texts[t]}
              </pre>
            ))
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<ExternalLink size={14} aria-hidden />}
            onClick={() => openLink(pkg.url)}
          >
            View on {pkg.source === "npm" ? "npmjs.com" : "crates.io"}
          </Button>
        </div>
      )}
    </li>
  );
}

/** Settings > About: version, maker, links and the open-source packages Branchline ships. */
export function AboutSection({ onCheckForUpdates }: { onCheckForUpdates: () => void }) {
  const [version, setVersion] = useState<string | null>(null);
  const [git, setGit] = useState<string | null>(null);
  const [licenses, setLicenses] = useState<LicenseData | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [limit, setLimit] = useState(LICENSE_PAGE);

  useEffect(() => {
    let cancelled = false;
    getVersion()
      .then((v) => !cancelled && setVersion(v))
      .catch(() => {});
    gitService
      .version()
      .then((v) => !cancelled && setGit(v.version))
      .catch(() => {});
    loadLicenses()
      .then((d) => !cancelled && setLicenses(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const shown = useMemo(
    () => (licenses ? filterPackages(licenses.packages, query) : []),
    [licenses, query],
  );
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
    <>
      <div className="bl-about-hero">
        <LogoMark size={64} />
        <div className="bl-about-hero__text">
          <p className="bl-about-hero__name">Branchline</p>
          <p className="bl-about-hero__version">
            Version <span className="mono">{version ?? "…"}</span>
            {git && <span className="text-muted"> · Git {git}</span>}
          </p>
          <p className="bl-about-hero__maker">
            by <BytefulmindsLogo height={24} />
            <span>Bytefulminds</span>
          </p>
        </div>
      </div>
      <p className="bl-setting__help bl-setting__intro">
        A fast, local-first Git desktop client. Free and open source under the MIT License.
        Copyright 2026 Branchline contributors.
      </p>
      <div className="bl-about-actions">
        <Button icon={<Download size={14} aria-hidden />} onClick={onCheckForUpdates}>
          Check for updates
        </Button>
        {link("Release notes", RELEASES_URL)}
        {link("Website and source", PROJECT_URL)}
        {link("Report a problem", ISSUES_URL)}
      </div>

      <section className="bl-licenses" aria-labelledby="bl-licenses-title">
        <div className="bl-licenses__header">
          <h4 id="bl-licenses-title" className="bl-licenses__title">
            Open-source software
          </h4>
          <span className="text-small text-muted">
            {licenses
              ? `${licenses.packages.length} packages Branchline is built with`
              : "Loading…"}
          </span>
          <label className="bl-search bl-licenses__search">
            <Search size={14} aria-hidden className="bl-search__icon" />
            <span className="visually-hidden">Search packages</span>
            <input
              type="search"
              placeholder="Search packages or licenses"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setLimit(LICENSE_PAGE);
              }}
              spellCheck={false}
            />
            {query && (
              <button
                type="button"
                className="bl-search__clear"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("");
                  setLimit(LICENSE_PAGE);
                }}
              >
                <X size={12} aria-hidden />
              </button>
            )}
          </label>
        </div>
        {!licenses ? (
          <div className="bl-licenses__loading" role="status">
            <Spinner size={14} /> Loading licenses…
          </div>
        ) : shown.length === 0 ? (
          <p className="text-small text-muted">No package matches “{query}”.</p>
        ) : (
          <>
            <ul className="bl-licenses__list" aria-label="Open-source packages">
              {shown.slice(0, limit).map((p) => {
                const key = `${p.source}:${p.name}@${p.version}`;
                return (
                  <PackageRow
                    key={key}
                    pkg={p}
                    texts={licenses.texts}
                    expanded={expanded === key}
                    onToggle={() => setExpanded((k) => (k === key ? null : key))}
                  />
                );
              })}
            </ul>
            {shown.length > LICENSE_PAGE && (
              <div className="bl-licenses__more">
                <span className="text-small text-muted">
                  Showing {Math.min(limit, shown.length)} of {shown.length}
                </span>
                {limit < shown.length ? (
                  <>
                    <Button size="sm" onClick={() => setLimit((l) => l + LICENSE_PAGE)}>
                      Show {Math.min(LICENSE_PAGE, shown.length - limit)} more
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setLimit(shown.length)}>
                      Show all
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setLimit(LICENSE_PAGE)}>
                    Show fewer
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}
