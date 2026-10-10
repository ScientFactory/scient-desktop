// @effect-diagnostics nodeBuiltinImport:off -- The replay subprocess publishes synchronous status snapshots.
import * as NodeFS from "node:fs";

/** Publish a complete snapshot without exposing a truncated file to the parent. */
export function writeAcpReplayStatus(statusPath: string, contents: string): void {
  const temporaryPath = `${statusPath}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporaryPath, contents, "utf8");
  NodeFS.renameSync(temporaryPath, statusPath);
}
