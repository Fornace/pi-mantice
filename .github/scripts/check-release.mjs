import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function assertRelease({ refType, refName, eventSha, head, main, version }) {
  assert.ok(typeof version === "string" && version.length > 0, "Package version is missing.");
  assert.equal(refType, "tag", "Publication requires a version tag.");
  assert.equal(refName, `v${version}`, "Tag must match package.json version.");
  assert.ok(head && main, "Cannot establish release source identity.");
  assert.equal(head, eventSha, "Checkout differs from the triggering commit.");
  assert.equal(head, main,
    "Release is not current main. Review current source and create a fresh version/tag; do not rerun a stale release.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const git = args => execFileSync("git", args, { encoding: "utf8", timeout: 15_000 }).trim();
  const head = git(["rev-parse", "HEAD"]);
  git(["diff", "--quiet", "--exit-code", "HEAD", "--"]);
  // Git's ls-remote output is a tab-delimited SHA/ref record, not provider prose.
  const main = git(["ls-remote", "--exit-code", "origin", "refs/heads/main"]).split("\t")[0];
  const { name, version } = JSON.parse(readFileSync("package.json", "utf8"));
  assertRelease({ refType: process.env.GITHUB_REF_TYPE, refName: process.env.GITHUB_REF_NAME,
    eventSha: process.env.GITHUB_SHA, head, main, version });
  console.log(`Release source verified: ${name}@${version}, ${head}`);
}
