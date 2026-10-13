/**
 * Muse Code's server entry: the driver the server registers, plus the
 * adapter factory the replay testkit and fixture recorder build on.
 *
 * @module provider-muse/server
 */
export {
  // SCIENT-FORK:START — expose the optional host-copy driver factory to the app composition.
  makeMuseDriver,
  type MuseDriverOptions,
  type MuseRuntimeResolution,
  // SCIENT-FORK:END
  type MuseDriverEnv,
} from "./server/driver.ts";
/** @public Upstream-compatible package default; Scient registers its app-composed wrapper. */
export { MuseDriver } from "./server/driver.ts";
export { makeMuseAdapterV2, type MuseAdapterV2Options } from "./server/adapter.ts";
// SCIENT-FORK:START — the app qualifies native MSP through the same SDK owner.
export { createMuseSdkHost, type MuseSdkHost } from "./server/sdk.ts";
// SCIENT-FORK:END
