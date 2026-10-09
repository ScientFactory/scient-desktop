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
  // SCIENT-FORK:END
  MuseDriver,
  type MuseDriverEnv,
} from "./server/driver.ts";
export { makeMuseAdapterV2, type MuseAdapterV2Options } from "./server/adapter.ts";
