import * as NodeModule from "node:module";
import * as NodeProcess from "node:process";

import { createDuplicateSigningFilter } from "./development-code-signing.mjs";

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
  // osx-sign 1.x follows framework directory aliases (including Versions/Current).
  // Sign every distinct target once; the normal final bundle verification remains.
  ignore: createDuplicateSigningFilter(),
  // Local development signatures do not need a trusted timestamp. Avoiding
  // one network request per nested Electron component keeps cold launch fast.
  // The hardened runtime would also prevent the development backend from
  // loading native workspace dependencies outside this app bundle.
  optionsForFile: () => ({ timestamp: "none", hardenedRuntime: false }),
});
