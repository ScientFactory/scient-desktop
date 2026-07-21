// FILE: notarize-mac-app.cjs
// Purpose: Runs controlled notarization and stapling before electron-builder creates ZIP/DMG files.
// Layer: electron-builder afterSign hook

const { join } = require("node:path");

const { runMacNotarization } = require("./lib/mac-notarization.cjs");

function createNotarizeMacAppHook(notarize = runMacNotarization) {
  return async function notarizeMacApp(context) {
    if (context.electronPlatformName !== "darwin") return;

    const productName = context.packager.appInfo.productFilename;
    const appPath = join(context.appOutDir, `${productName}.app`);
    const evidenceDirectory = process.env.SCIENT_NOTARIZATION_EVIDENCE_DIR ?? context.outDir;
    await notarize({
      appPath,
      arch: process.env.SCIENT_NOTARIZATION_ARCH ?? String(context.arch),
      commit: process.env.SCIENT_NOTARIZATION_COMMIT,
      environment: process.env,
      evidenceDirectory,
      productName,
      version: process.env.SCIENT_NOTARIZATION_VERSION,
    });
  };
}

module.exports = createNotarizeMacAppHook();
module.exports.createNotarizeMacAppHook = createNotarizeMacAppHook;
