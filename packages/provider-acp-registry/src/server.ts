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
