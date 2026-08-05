import assert from "node:assert/strict";
import test from "node:test";
import { getVersionInfo, releaseVersionFromTag } from "./version-info.mjs";

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
  const info = getVersionInfo({
    env: { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.1.0", GITHUB_SHA: "1234567890" },
  });
  assert.deepEqual(info, {
    version: "0.1.0",
    tag: "v0.1.0",
    commit: "12345678",
    channel: "release",
  });
});

test("fails when a release tag and app version drift", () => {
  assert.throws(
    () =>
      getVersionInfo({
        env: { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.2.0" },
      }),
    /does not match package version 0\.1\.0/,
  );
});
