// FILE: staple-mac-app.cjs
// Purpose: Staples and validates Apple's notarization ticket before ZIP/DMG packaging.
// Layer: electron-builder afterSign hook

const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

function createStapleMacAppHook(run = execFileSync) {
  return async function stapleMacApp(context) {
    if (context.electronPlatformName !== "darwin") return;

    const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    run("/usr/bin/xcrun", ["stapler", "staple", "--verbose", appPath], {
      stdio: "inherit",
    });
    run("/usr/bin/xcrun", ["stapler", "validate", "--verbose", appPath], {
      stdio: "inherit",
    });
  };
}

module.exports = createStapleMacAppHook();
module.exports.createStapleMacAppHook = createStapleMacAppHook;
