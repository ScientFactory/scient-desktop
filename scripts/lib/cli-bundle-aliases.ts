// @effect-diagnostics nodeBuiltinImport:off - build-time package resolution only.
import * as NodeModule from "node:module";

const serverRequire = NodeModule.createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
);

/** Node uses the public UMD entry; bundles need its statically visible ESM closure. */
export const CLI_BUNDLE_ALIASES = {
  "jsonc-parser": serverRequire.resolve("jsonc-parser/lib/esm/main.js"),
};
