#!/usr/bin/env node
/**
 * Copy the installers (and updater signatures) of one platform into one folder, with names
 * that include the version and platform:
 *
 *   node scripts/release/collect.mjs <target/.../bundle> <release-files> <linux|macos|windows>
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [bundleDir, outDir, platform] = process.argv.slice(2);
if (!bundleDir || !outDir || !["linux", "macos", "windows"].includes(platform)) {
  console.error("usage: collect.mjs <bundle dir> <out dir> <linux|macos|windows>");
  process.exit(2);
}
const { version } = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));

/** [sub folder, file pattern, rename (null keeps the name)] */
const RULES = {
  linux: [
    ["appimage", /\.AppImage(\.sig)?$/, null],
    ["deb", /\.deb$/, null],
    ["rpm", /\.rpm$/, null],
  ],
  macos: [
    ["dmg", /\.dmg$/, null],
    // The updater archive has no version in its name; add it so releases never collide.
    [
      "macos",
      /\.app\.tar\.gz(\.sig)?$/,
      (f) => f.replace(/^.*\.app\.tar\.gz/, `Branchline_${version}_universal.app.tar.gz`),
    ],
  ],
  windows: [
    ["nsis", /-setup\.exe(\.sig)?$/, null],
    ["msi", /\.msi(\.sig)?$/, null],
  ],
};

mkdirSync(outDir, { recursive: true });
let copied = 0;
for (const [sub, pattern, rename] of RULES[platform]) {
  const dir = join(bundleDir, sub);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir)) {
    if (!pattern.test(file)) continue;
    const name = (rename ? rename(file) : file).replace(/\s+/g, "_");
    copyFileSync(join(dir, file), join(outDir, name));
    console.log(`  ${name}`);
    copied++;
  }
}
if (copied === 0) {
  console.error(`No ${platform} installers found in ${bundleDir}`);
  process.exit(1);
}
