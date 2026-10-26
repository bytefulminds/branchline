#!/usr/bin/env node
/**
 * List every third-party package Branchline ships, with its license and license text, for
 * the About section in Settings:
 *
 *   node scripts/licenses.mjs           write src/features/about/licenses.json
 *   node scripts/licenses.mjs --check   fail when that file is out of date (CI)
 *
 * JavaScript: the production dependencies (`npm query .prod`), which end up in the app bundle.
 * Rust: every crate the app links on the platforms Branchline is built for (normal
 * dependencies of the branchline crate, followed through the whole graph, per target).
 * Build-only and dev dependencies are left out.
 * License texts are read from each package's LICENSE, COPYING or NOTICE files; identical
 * texts are stored once.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const OUT = "src/features/about/licenses.json";
const check = process.argv.includes("--check");
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-._].*)?$/i;
const MAX_TEXT = 64 * 1024;

const texts = new Map();
function readTexts(dir) {
  if (!dir || !existsSync(dir)) return [];
  const ids = [];
  for (const file of readdirSync(dir).sort()) {
    if (!LICENSE_FILE.test(file)) continue;
    let text;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      continue; // a folder named LICENSES, or unreadable
    }
    text = text.replace(/\r\n/g, "\n").trim().slice(0, MAX_TEXT);
    if (!text) continue;
    const id = createHash("sha256").update(text).digest("hex").slice(0, 16);
    texts.set(id, text);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

// ---- JavaScript ------------------------------------------------------------------------
const npm = JSON.parse(
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["query", ".prod"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  }),
);
const own = JSON.parse(readFileSync("package.json", "utf8")).name;
const js = npm
  .filter((p) => p.location && p.name !== own)
  .map((p) => ({
    name: p.name,
    version: p.version,
    license:
      typeof p.license === "string" ? p.license : (p.license?.type ?? "See license text"),
    source: "npm",
    url: `https://www.npmjs.com/package/${p.name}/v/${p.version}`,
    texts: readTexts(p.path),
  }));

// ---- Rust ------------------------------------------------------------------------------
/** The targets the release pipeline builds (macOS builds one app for both chips). */
const TARGETS = [
  "x86_64-unknown-linux-gnu",
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
];
const byId = new Map();
const linked = new Set();
for (const target of TARGETS) {
  const meta = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--format-version",
        "1",
        "--locked",
        "--filter-platform",
        target,
        "--manifest-path",
        "src-tauri/Cargo.toml",
      ],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    ),
  );
  for (const p of meta.packages) byId.set(p.id, p);
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const queue = [meta.resolve.root];
  const seen = new Set();
  while (queue.length) {
    const id = queue.pop();
    for (const dep of nodes.get(id)?.deps ?? []) {
      // Linked: a normal (not build or dev) dependency on this target.
      if (!dep.dep_kinds.some((k) => k.kind === null)) continue;
      if (seen.has(dep.pkg)) continue;
      seen.add(dep.pkg);
      linked.add(dep.pkg);
      queue.push(dep.pkg);
    }
  }
}
const rust = [...linked]
  .map((id) => byId.get(id))
  .filter((p) => p && p.source) // registry or git crates; local path crates are ours
  .map((p) => {
    const dir = dirname(p.manifest_path);
    const ids = readTexts(dir);
    if (ids.length === 0 && p.license_file) ids.push(...readTexts(dirname(join(dir, p.license_file))));
    return {
      name: p.name,
      version: p.version,
      license: p.license ?? (p.license_file ? "See license text" : "Unknown"),
      source: "crate",
      url: `https://crates.io/crates/${p.name}/${p.version}`,
      texts: ids,
    };
  });

const packages = [...js, ...rust].sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);
const used = new Set(packages.flatMap((p) => p.texts));
const data = {
  packages,
  texts: Object.fromEntries([...texts].filter(([id]) => used.has(id)).sort()),
};
const json = `${JSON.stringify(data, null, 1)}\n`;

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== json) {
    console.error(`${OUT} is out of date. Run: node scripts/licenses.mjs`);
    process.exit(1);
  }
  console.log(`${OUT} is up to date (${packages.length} packages).`);
} else {
  writeFileSync(OUT, json);
  const missing = packages.filter((p) => p.texts.length === 0).length;
  console.log(
    `Wrote ${OUT}: ${js.length} JavaScript and ${rust.length} Rust packages, ` +
      `${Object.keys(data.texts).length} distinct license texts` +
      (missing ? `, ${missing} without a license file (license id only).` : "."),
  );
}
