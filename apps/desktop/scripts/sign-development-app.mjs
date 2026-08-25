import * as NodeModule from "node:module";
import * as NodeProcess from "node:process";

const require = NodeModule.createRequire(import.meta.url);
const { signAsync } = require("@electron/osx-sign");

const [appBundlePath, identity] = NodeProcess.argv.slice(2);
if (!appBundlePath || !identity) {
  throw new Error("Usage: sign-development-app.mjs <app-bundle-path> <identity>");
}

await signAsync({
  app: appBundlePath,
  identity,
  identityValidation: identity !== "-",
  platform: "darwin",
  type: "development",
  preAutoEntitlements: false,
  preEmbedProvisioningProfile: false,
  // Local development signatures do not need a trusted timestamp. Avoiding
  // one network request per nested Electron component keeps cold launch fast.
  // The hardened runtime would also prevent the development backend from
  // loading native workspace dependencies outside this app bundle.
  optionsForFile: () => ({ timestamp: "none", hardenedRuntime: false }),
});
