#!/usr/bin/env node
/**
 * Publish a GitLab release from the collected installers (runs in CI on a version tag):
 *
 *   node scripts/release/publish.mjs <release-files> [--dry-run]
 *
 * 1. Checks that the tag matches the version in tauri.conf.json.
 * 2. Writes latest.json for the updater (download URL and signature per platform).
 * 3. Uploads every file to the project's generic package registry.
 * 4. Creates the release with the CHANGELOG.md section as description and a link per file.
 *    latest.json is linked as `/latest.json`, so the app always finds the newest one at
 *    /-/releases/permalink/latest/downloads/latest.json.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, flag] = process.argv.slice(2);
const dryRun = flag === "--dry-run";
if (!dir) {
  console.error("usage: publish.mjs <release-files> [--dry-run]");
  process.exit(2);
}
const env = (name) => {
  const value = process.env[name];
  if (!value && !dryRun) throw new Error(`${name} is not set`);
  return value ?? `<${name}>`;
};

const { version } = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const tag = process.env.CI_COMMIT_TAG ?? `v${version}`;
if (tag !== `v${version}`) {
  console.error(`Tag ${tag} does not match version ${version} in tauri.conf.json.`);
  process.exit(1);
}

const api = env("CI_API_V4_URL");
const project = env("CI_PROJECT_ID");
const token = env("CI_JOB_TOKEN");
const packageUrl = `${api}/projects/${project}/packages/generic/branchline/${version}`;
const notes = execFileSync(process.execPath, ["scripts/release/notes.mjs", version], {
  encoding: "utf8",
});

const files = readdirSync(dir).filter((f) => !f.endsWith(".sig") && f !== "latest.json");
const signature = (file) => readFileSync(join(dir, `${file}.sig`), "utf8").trim();
const find = (pattern) => files.find((f) => pattern.test(f));

// What the updater installs: the AppImage on Linux, the .app archive on macOS (one universal
// build for both chips) and the NSIS installer on Windows.
const platforms = {};
const add = (keys, file) => {
  if (!file) return;
  for (const key of keys)
    platforms[key] = { url: `${packageUrl}/${file}`, signature: signature(file) };
};
add(["linux-x86_64"], find(/\.AppImage$/));
add(["darwin-aarch64", "darwin-x86_64"], find(/\.app\.tar\.gz$/));
add(["windows-x86_64"], find(/-setup\.exe$/));
if (Object.keys(platforms).length === 0) throw new Error(`No updater files in ${dir}`);

const latest = { version, notes, pub_date: new Date().toISOString(), platforms };
writeFileSync(join(dir, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
console.log(`latest.json: ${Object.keys(platforms).join(", ")}`);

async function request(method, url, body, type) {
  if (dryRun) {
    console.log(`[dry run] ${method} ${url}`);
    return {};
  }
  const res = await fetch(url, {
    method,
    headers: { "JOB-TOKEN": token, ...(type ? { "Content-Type": type } : {}) },
    body,
  });
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
  return res.json().catch(() => ({}));
}

for (const file of readdirSync(dir)) {
  await request(
    "PUT",
    `${packageUrl}/${file}`,
    readFileSync(join(dir, file)),
    "application/octet-stream",
  );
  console.log(`uploaded ${file}`);
}

const LABELS = [
  [/\.dmg$/, "macOS (Apple silicon and Intel), .dmg", "package"],
  [/-setup\.exe$/, "Windows installer, .exe", "package"],
  [/\.msi$/, "Windows installer, .msi", "package"],
  [/\.AppImage$/, "Linux AppImage", "package"],
  [/\.deb$/, "Linux .deb (Debian, Ubuntu)", "package"],
  [/\.rpm$/, "Linux .rpm (Fedora, openSUSE)", "package"],
  [/\.app\.tar\.gz$/, "macOS update archive", "other"],
];
const links = files
  .map((file) => {
    const label = LABELS.find(([pattern]) => pattern.test(file));
    return (
      label && {
        name: label[1],
        url: `${packageUrl}/${file}`,
        direct_asset_path: `/${file}`,
        link_type: label[2],
      }
    );
  })
  .filter(Boolean);
links.push({
  name: "latest.json (used by the updater)",
  url: `${packageUrl}/latest.json`,
  direct_asset_path: "/latest.json",
  link_type: "other",
});

await request(
  "POST",
  `${api}/projects/${project}/releases`,
  JSON.stringify({
    name: `Branchline ${version}`,
    tag_name: tag,
    description: notes,
    assets: { links },
  }),
  "application/json",
);
console.log(`Release ${tag} published with ${links.length} links.`);
