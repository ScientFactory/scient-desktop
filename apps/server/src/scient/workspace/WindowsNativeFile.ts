// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import type { ScientOverleafFilesystemRefusalReason } from "@t3tools/contracts";

import {
  ensureNativePrivateRetentionDirectory,
  resolveNativeFilePublicationHelperPath,
} from "./NativeFilePublication.ts";

export class WindowsNativeFileError extends Error {
  readonly reason: ScientOverleafFilesystemRefusalReason;
  constructor(reason: ScientOverleafFilesystemRefusalReason) {
    super(reason);
    this.reason = reason;
  }
}

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const Reply = Schema.Struct({
  code: Schema.Number,
  flags: Schema.Number,
  syncManaged: Schema.optionalKey(Schema.Boolean),
  changeTime: Schema.optionalKey(Schema.String),
  identity: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        dev: Schema.String,
        ino: Schema.String,
        type: Schema.String,
      }),
    ),
  ),
});

const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(Reply));

async function invokeWindows(args: string[], helper?: string) {
  const executable =
    helper ??
    (await resolveNativeFilePublicationHelperPath(process.env.SCIENT_FILE_PUBLICATION_HELPER));
  if (!executable) throw new WindowsNativeFileError("helper-unavailable");
  return (await run(executable, args, { windowsHide: true, maxBuffer: 65536 })).stdout;
}
const decodeFlags = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Number)));
export async function windowsNativeFlags(paths: ReadonlyArray<string>) {
  return decodeFlags(await invokeWindows(["--windows-flags=1", ...paths]));
}

export async function windowsNativeFile(
  path: string,
  operation: "info" | "flags" | "private" = "info",
  helper?: string,
) {
  return decodeReply(await invokeWindows(["--windows=1", operation, path], helper));
}

export async function windowsFileIdentity(path: string) {
  if (
    path.startsWith("\\\\") &&
    (!path.startsWith("\\\\?\\") || path.toUpperCase().startsWith("\\\\?\\UNC\\"))
  )
    throw new WindowsNativeFileError("network-filesystem");
  const info = await windowsNativeFile(path);
  if (info.code === 2 || info.code === 3) return null;
  if (info.code !== 0 || !info.identity)
    throw new WindowsNativeFileError(
      info.code === 536870917
        ? "network-filesystem"
        : info.code === 536870918
          ? "unsupported-filesystem"
          : info.code === 1150
            ? "unsupported-windows-version"
            : info.code === 206
              ? "path-too-long"
              : "identity-unavailable",
    );
  return info.identity;
}

/** Revalidate existing policy natively; only a missing directory needs creation leases. */
export async function windowsPrivateDirectory(path: string, create: boolean, helper: string) {
  const info = await windowsNativeFile(path, "private", helper);
  if ((info.code === 2 || info.code === 3) && create) {
    await ensureNativePrivateRetentionDirectory(helper, path);
    return;
  }
  if (info.code || info.syncManaged || info.identity?.type !== "directory") {
    const error = new Error(info.syncManaged ? "sync-managed-folder" : "unsafe-directory");
    if (info.code === 2 || info.code === 3) Object.assign(error, { code: "ENOENT" });
    else if (info.code === 5) Object.assign(error, { code: "EACCES" });
    throw error;
  }
}
