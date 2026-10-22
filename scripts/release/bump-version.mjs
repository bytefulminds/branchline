#!/usr/bin/env node
/**
 * Set the version everywhere it is stored:
 *
 *   node scripts/release/bump-version.mjs 0.2.0
 *
 * Updates package.json, package-lock.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock and
 * src-tauri/tauri.conf.json, and checks that CHANGELOG.md has a section for the version.
 */
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error("usage: bump-version.mjs <major.minor.patch>, for example 0.2.0");
  process.exit(2);
}

const edit = (file, change) => {
  const before = readFileSync(file, "utf8");
  const after = change(before);
  if (after === before) console.log(`  ${file}: already ${version}`);
  else {
    writeFileSync(file, after);
    console.log(`  ${file}: updated`);
  }
};
const json = (file, change) =>
  edit(file, (text) => {
    const data = JSON.parse(text);
    change(data);
    return `${JSON.stringify(data, null, 2)}\n`;
  });

json("package.json", (p) => (p.version = version));
json("package-lock.json", (p) => {
  p.version = version;
  if (p.packages?.[""]) p.packages[""].version = version;
});
json("src-tauri/tauri.conf.json", (c) => (c.version = version));
edit("src-tauri/Cargo.toml", (t) =>
  t.replace(/^(\[package\][\s\S]*?^version = )"[^"]*"/m, `$1"${version}"`),
);
edit("src-tauri/Cargo.lock", (t) =>
  t.replace(/(\[\[package\]\]\nname = "branchline"\nversion = )"[^"]*"/, `$1"${version}"`),
);

const changelog = readFileSync("CHANGELOG.md", "utf8");
if (!changelog.includes(`## [${version}]`)) {
  console.error(
    `\nCHANGELOG.md has no "## [${version}]" section yet. Add the release notes there.`,
  );
  process.exit(1);
}
console.log(`\nVersion ${version} set. Commit, then tag: git tag v${version} && git push --tags`);
