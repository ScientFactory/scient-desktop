/**
 * ACP Registry's server entry: the driver and adapter driver the server
 * registers, the catalog layer it provides once, and the managed-binary
 * directories the terminal manager keeps off agent PATHs.
 *
 * The catalog and runtime coordinator are services; import them from
 * `./server/AcpRegistrySupport` and `./server/AcpRegistryRuntimeCoordinator`.
 *
 * @module provider-acp-registry/server
 */
/** @public Upstream-compatible package default; Scient registers its app-composed wrapper. */
export { AcpRegistryDriver } from "./server/driver.ts";
export {
  makeAcpRegistryDriver,
  type AcpRegistryDriverEnv,
  type AcpRegistryDriverOptions,
} from "./server/driver.ts";
export {
  AcpRegistryAdapterV2Driver,
  type AcpRegistryAdapterV2DriverEnv,
} from "./server/adapter.ts";
export { acpRegistryManagedBinaryDirectories } from "./server/AcpRegistrySupport.ts";
