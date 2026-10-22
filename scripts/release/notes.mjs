#!/usr/bin/env node
/**
 * Print the CHANGELOG.md section of one version (the release description):
 *
 *   node scripts/release/notes.mjs 0.1.0
 */
import { readFileSync } from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
const text = readFileSync("CHANGELOG.md", "utf8");
const start = text.indexOf(`## [${version}]`);
if (!version || start === -1) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
const body = text.slice(text.indexOf("\n", start) + 1);
const end = body.search(/^## \[/m);
process.stdout.write(`${(end === -1 ? body : body.slice(0, end)).trim()}\n`);
