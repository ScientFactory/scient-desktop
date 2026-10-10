/**
 * OpenCode's server entry: the driver the server registers, its adapter
 * driver, and the runtime layer the driver needs from the server.
 *
 * @module provider-opencode/server
 */
/** @public Upstream-compatible package default; Scient registers its app-composed wrapper. */
export { OpenCodeDriver } from "./server/driver.ts";
export {
  makeOpenCodeDriver,
  type OpenCodeDriverEnv,
  type OpenCodeDriverOptions,
} from "./server/driver.ts";
export {
  OpenCodeAdapterV2Driver,
  makeOpenCodeAdapterV2Driver,
  openCodePermissionRules,
  type OpenCodeAdapterV2DriverEnv,
  type OpenCodeAdapterV2DriverOptions,
} from "./server/adapter.ts";
