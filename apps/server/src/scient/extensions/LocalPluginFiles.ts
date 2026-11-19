// @effect-diagnostics nodeBuiltinImport:off -- bounded reads of agent-owned plugin metadata.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class LocalPluginReadError extends Schema.TaggedError<LocalPluginReadError>()(
  "LocalPluginReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the plugin's local files.";
  }
}

/** Reads agent-owned plugin files; a failure is a typed error carrying the original cause. */
export const tryLocalPluginRead = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: (cause) => new LocalPluginReadError({ cause }) });

const readPluginText = Effect.fn("readPluginText")(function* (
  path: string,
  maxBytes = 4 * 1024 * 1024,
) {
  return yield* tryLocalPluginRead(async () => {
    const file = await NodeFSP.open(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes)
        throw new Error("Plugin metadata is too large or not a file.");
      const buffer = Buffer.alloc(maxBytes + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > maxBytes) throw new Error("Plugin metadata grew beyond its size limit.");
      return buffer.subarray(0, total).toString("utf8");
    } finally {
      await file.close();
    }
  });
});
export const readPluginJson = (path: string, maxBytes?: number) =>
  readPluginText(path, maxBytes).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
  );
