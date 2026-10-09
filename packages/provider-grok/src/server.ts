/**
 * Grok's server entry: the driver and adapter driver the server registers.
 *
 * @module provider-grok/server
 */
/** @public Upstream-compatible package default; Scient registers its app-composed wrapper. */
export { GrokDriver } from "./server/driver.ts";
export {
  makeGrokDriver,
  type GrokDriverEnv,
  type GrokDriverFactory,
  type GrokDriverOptions,
  type GrokRuntimeResolution,
  type GrokRuntimeResolverInput,
} from "./server/driver.ts";
export { GrokAdapterV2Driver, type GrokAdapterV2DriverEnv } from "./server/adapter.ts";
export {
  GROK_AUTH_EXTENSION_METHOD,
  GROK_AUTH_METHOD_ACCOUNT,
  GROK_AUTH_METHOD_CACHED_TOKEN,
  GROK_AUTH_METHOD_OIDC,
  GROK_DEVICE_FLOW_ENV,
  makeGrokAcpRuntime,
} from "./server/acpSupport.ts";
