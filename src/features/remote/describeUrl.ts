/** Host and path of an address, for a compact label ("github.com · you/project"). */
export function describeUrl(url: string): string {
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(url);
  if (scp) return `${scp[1]} · ${scp[2]!.replace(/\.git$/, "")}`;
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url);
  if (m) return `${m[1]} · ${m[2]!.replace(/\.git$/, "")}`;
  return url;
}
