// FILE: mac-signing-policy.cjs
// Purpose: Canonical macOS bundle and helper signing identities used by release hooks and checks.

const { join, normalize } = require("node:path");

const SCIENT_MAC_BUNDLE_IDENTIFIER = "com.scientfactory.scient";
const SCIENT_APPSNAP_HELPER_IDENTIFIER = `${SCIENT_MAC_BUNDLE_IDENTIFIER}.appsnap`;
const SCIENT_APPSNAP_HELPER_BUNDLE_PATH = join("Contents", "Helpers", "scient-appsnap-helper");

function isScientAppSnapHelperPath(filePath) {
  return normalize(filePath).endsWith(SCIENT_APPSNAP_HELPER_BUNDLE_PATH);
}

module.exports = {
  SCIENT_APPSNAP_HELPER_BUNDLE_PATH,
  SCIENT_APPSNAP_HELPER_IDENTIFIER,
  SCIENT_MAC_BUNDLE_IDENTIFIER,
  isScientAppSnapHelperPath,
};
