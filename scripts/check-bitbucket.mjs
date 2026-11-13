#!/usr/bin/env node
/**
 * Try every Bitbucket Cloud request Branchline makes against the real API, with your own
 * account, so a request Bitbucket changed or removed shows up before a release (the tests
 * use a fake server and cannot notice). Read-only: it only sends GET requests.
 *
 *   read -s BITBUCKET_TOKEN && export BITBUCKET_TOKEN
 *   BITBUCKET_EMAIL=you@example.com BITBUCKET_REPO=workspace/repo npm run check:bitbucket
 *
 * BITBUCKET_PR picks the pull request to read (default: the newest open one in the repo).
 * Keep this list in step with src-tauri/src/forge/bitbucket.rs.
 */

// BITBUCKET_API is only for trying the script against a local test server.
const API = process.env.BITBUCKET_API ?? "https://api.bitbucket.org/2.0";
const { BITBUCKET_EMAIL: email, BITBUCKET_TOKEN: token, BITBUCKET_REPO: repo } = process.env;
if (!email || !token || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) {
  console.error(
    "Set BITBUCKET_EMAIL (your Atlassian email), BITBUCKET_TOKEN (an API token) and\n" +
      "BITBUCKET_REPO (workspace/repository) first; see the top of this file.",
  );
  process.exit(2);
}
const auth = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
const fields = "fields=%2Bvalues.reviewers%2C%2Bvalues.participants";
let failed = 0;

/** GET one path, print the outcome, and return the JSON (or null). `check` names a field
 * Branchline reads, so a changed answer is noticed too. */
async function step(label, path, check = () => true) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      headers: { Authorization: auth, Accept: "application/json" },
      redirect: "manual",
    });
  } catch (e) {
    failed++;
    console.log(`FAIL     ${label}: ${e.message}`);
    return null;
  }
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: reported below.
  }
  const removed = res.status === 404 && text.includes("no API hosted at this URL");
  const ok = res.status === 200 && body !== null && check(body);
  if (!ok) failed++;
  const state = removed ? "REMOVED" : ok ? "ok" : `FAIL ${res.status}`;
  console.log(`${state.padEnd(8)} ${label}  (GET /2.0${path.split("?")[0]})`);
  if (!ok && !removed && res.status === 200)
    console.log("         the answer is missing a field Branchline reads");
  if (res.status === 403) console.log("         the token is missing a scope for this request");
  return ok ? body : null;
}

const values = (b) => Array.isArray(b.values);

const user = await step("Your profile (connecting)", "/user", (b) => !!b.uuid);
await step(
  "Pull requests of the repository",
  `/repositories/${repo}/pullrequests?state=OPEN&sort=-updated_on&pagelen=50&${fields}`,
  values,
).then(async (list) => {
  const id = process.env.BITBUCKET_PR ?? list?.values?.[0]?.id;
  if (!id) {
    console.log(
      list
        ? "skipped  Reading a pull request: no open pull request (set BITBUCKET_PR to pick one)"
        : "skipped  Reading a pull request: the list did not load",
    );
    return;
  }
  const base = `/repositories/${repo}/pullrequests/${id}`;
  await step(
    `Pull request #${id}`,
    base,
    (b) => !!b.source?.commit?.hash && !!b.destination?.branch?.name,
  );
  await step(`Commits of #${id}`, `${base}/commits?pagelen=100`, values);
  await step(`Comments of #${id}`, `${base}/comments?pagelen=100`, values);
  await step(`Build statuses of #${id}`, `${base}/statuses?pagelen=25`, values);
});
const workspaces = await step(
  "Your workspaces (Created by you, everywhere)",
  "/user/workspaces?pagelen=100",
  values,
);
const slug = workspaces?.values?.[0]?.workspace?.slug;
if (user && slug) {
  await step(
    `Your pull requests in ${slug}`,
    `/workspaces/${slug}/pullrequests/${encodeURIComponent(user.uuid)}?state=OPEN&pagelen=50&${fields}`,
    values,
  );
}

console.log(failed ? `\n${failed} request(s) failed.` : "\nEvery request Branchline makes works.");
process.exit(failed ? 1 : 0);
