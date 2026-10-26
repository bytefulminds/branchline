/** Shape of licenses.json, written by scripts/licenses.mjs. */
export interface ThirdPartyPackage {
  name: string;
  version: string;
  /** SPDX expression as the package states it, for example "MIT OR Apache-2.0". */
  license: string;
  source: "npm" | "crate";
  /** The package's page on npmjs.com or crates.io. */
  url: string;
  /** Ids of its license texts in `texts` (empty when the package has no license file). */
  texts: string[];
}

export interface LicenseData {
  packages: ThirdPartyPackage[];
  texts: Record<string, string>;
}

/** Loaded on demand: the file is large and only About needs it. */
export async function loadLicenses(): Promise<LicenseData> {
  const data = await import("./licenses.json");
  return (data.default ?? data) as unknown as LicenseData;
}

/** Packages matching `query` in name, version or license. */
export function filterPackages(list: ThirdPartyPackage[], query: string): ThirdPartyPackage[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((p) => `${p.name} ${p.version} ${p.license}`.toLowerCase().includes(q));
}
