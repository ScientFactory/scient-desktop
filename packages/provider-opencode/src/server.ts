/** @public Upstream-compatible package default; Scient registers its app-composed wrapper. */
export { OpenCodeDriver } from "./server/driver.ts";
export {
  makeOpenCodeDriver,
  type OpenCodeDriverEnv,
  type OpenCodeDriverOptions,
} from "./server/driver.ts";
/**
 * Default native OpenCode adapter for hosts without application-owned instruction policy.
 *
 * @public
 */
export { OpenCodeAdapterV2Driver } from "./server/adapter.ts";
export {
  makeOpenCodeAdapterV2Driver,
  openCodePermissionRules,
  type OpenCodeAdapterV2DriverEnv,
  type OpenCodeAdapterV2DriverOptions,
} from "./server/adapter.ts";
