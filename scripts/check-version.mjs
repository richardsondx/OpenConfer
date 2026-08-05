import { getVersionInfo } from "./version-info.mjs";

const info = getVersionInfo();
if (info.channel === "release") {
  console.log(`Release ${info.tag} matches package.json.`);
} else {
  console.log(`Development build targets v${info.version} (${info.commit}).`);
}

