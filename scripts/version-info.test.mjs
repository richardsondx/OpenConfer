import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getVersionInfo, releaseVersionFromTag } from "./version-info.mjs";

const appVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

test("reads semantic versions from release tags", () => {
  assert.equal(releaseVersionFromTag("v0.1.0"), "0.1.0");
  assert.equal(releaseVersionFromTag("v2.0.0-rc.1"), "2.0.0-rc.1");
});

test("rejects tags that are not release versions", () => {
  assert.equal(releaseVersionFromTag("0.1.0"), null);
  assert.equal(releaseVersionFromTag("release-v0.1.0"), null);
  assert.equal(releaseVersionFromTag("v0.1"), null);
});

test("accepts a release tag matching the app version", () => {
  const releaseTag = `v${appVersion}`;
  const info = getVersionInfo({
    env: { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: releaseTag, GITHUB_SHA: "1234567890" },
  });
  assert.deepEqual(info, {
    version: appVersion,
    tag: releaseTag,
    commit: "12345678",
    channel: "release",
  });
});

test("fails when a release tag and app version drift", () => {
  const mismatchedVersion = appVersion === "9.9.9" ? "8.8.8" : "9.9.9";
  assert.throws(
    () =>
      getVersionInfo({
        env: { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: `v${mismatchedVersion}` },
      }),
    new RegExp(`does not match package version ${appVersion.replaceAll(".", "\\.")}`),
  );
});
