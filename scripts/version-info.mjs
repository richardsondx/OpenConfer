import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function releaseVersionFromTag(tag) {
  return RELEASE_TAG.exec(tag)?.[1] ?? null;
}

export function getVersionInfo({ cwd = process.cwd(), env = process.env } = {}) {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const targetVersion = String(manifest.version);
  const exactTag = env.GITHUB_REF_TYPE === "tag" ? env.GITHUB_REF_NAME : env.OPENCONFER_RELEASE_TAG;
  const taggedVersion = exactTag ? releaseVersionFromTag(exactTag) : null;

  if (exactTag && !taggedVersion) {
    throw new Error(`Release tag ${exactTag} must use the form v1.2.3.`);
  }
  if (taggedVersion && taggedVersion !== targetVersion) {
    throw new Error(
      `Release tag ${exactTag} does not match package version ${targetVersion}. ` +
        `Update package.json to ${taggedVersion} before tagging.`,
    );
  }

  const commit = env.GITHUB_SHA?.slice(0, 8) || git(["rev-parse", "--short=8", "HEAD"], cwd) || "unknown";
  return {
    version: taggedVersion || targetVersion,
    tag: taggedVersion ? exactTag : null,
    commit,
    channel: taggedVersion ? "release" : "development",
  };
}
