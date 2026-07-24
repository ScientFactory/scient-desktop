// FILE: sign-mac-app.cjs
// Purpose: Applies the release identity while giving AppSnap a stable identifier and minimal rights.
// Layer: electron-builder custom macOS signing hook

const { join } = require("node:path");
const {
  SCIENT_APPSNAP_HELPER_IDENTIFIER,
  isScientAppSnapHelperPath,
} = require("./lib/mac-signing-policy.cjs");

function appSnapSigningOptions(baseOptions, entitlementsPath) {
  const additionalArguments = (baseOptions.additionalArguments ?? []).filter(
    (argument, index, arguments_) =>
      argument !== "--identifier" && arguments_[index - 1] !== "--identifier",
  );
  return {
    ...baseOptions,
    entitlements: entitlementsPath,
    additionalArguments: [...additionalArguments, "--identifier", SCIENT_APPSNAP_HELPER_IDENTIFIER],
  };
}

function createMacSignHook(signAsync) {
  return async function signMacApp(options, packager) {
    const inheritedOptionsForFile = options.optionsForFile;
    const appSnapEntitlementsPath = join(
      packager.projectDir,
      "apps/desktop/resources/entitlements.appsnap.plist",
    );

    await signAsync({
      ...options,
      optionsForFile(filePath) {
        const inherited = inheritedOptionsForFile?.(filePath) ?? {};
        return isScientAppSnapHelperPath(filePath)
          ? appSnapSigningOptions(inherited, appSnapEntitlementsPath)
          : inherited;
      },
    });
  };
}

async function signMacApp(options, packager) {
  const { signAsync } = require("@electron/osx-sign");
  return createMacSignHook(signAsync)(options, packager);
}

module.exports = signMacApp;
module.exports.appSnapSigningOptions = appSnapSigningOptions;
module.exports.createMacSignHook = createMacSignHook;
