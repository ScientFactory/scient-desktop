/**
 * fx's server entry: the driver the server registers.
 *
 * @module provider-fx/server
 */
// SCIENT-FORK:START The server composes fx with Scient's ACP prompt bridge.
export { makeFxDriver, type FxDriverEnv, type FxDriverOptions } from "./server/driver.ts";
// SCIENT-FORK:END The server composes fx with Scient's ACP prompt bridge.
export { type FxAdapterV2DriverEnv } from "./server/adapter.ts";
