// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import { resolveNativeFilePublicationHelperPath } from "./NativeFilePublication.ts";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const Reply = Schema.Struct({
  code: Schema.Number,
  flags: Schema.Number,
  syncManaged: Schema.optionalKey(Schema.Boolean),
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
  if (!executable) throw new Error("Windows native file helper is unavailable.");
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
  const info = await windowsNativeFile(path);
  if (info.code === 2 || info.code === 3) return null;
  if (info.code !== 0 || !info.identity)
    throw new Error(`Windows file identity refused (${info.code}).`);
  return info.identity;
}
