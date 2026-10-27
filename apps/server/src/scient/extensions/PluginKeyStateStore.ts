// @effect-diagnostics nodeBuiltinImport:off -- App-private binding persistence, never credential material.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ExtensionsError, PluginKeyBinding, type PluginKeyIdentity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeExtensionState } from "./connectors/ConnectorStateStore.ts";

export const PLUGIN_KEY_STATE_FILE = "scient-plugin-keys.json";
const MAX_BYTES = 1024 * 1024;
const File = Schema.Struct({
  formatVersion: Schema.Literal(1),
  bindings: Schema.Array(PluginKeyBinding),
});
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(File));
const encode = Schema.encodeSync(Schema.fromJsonString(File));
export const pluginKeyIdentity = (target: PluginKeyIdentity) =>
  JSON.stringify([target.agent ?? null, target.pluginId, target.envName]);
const failure = () =>
  new ExtensionsError({
    reason: "state-unavailable",
    message: "Plugin key bindings could not be read or saved. The previous file was preserved.",
  });
const load = async (file: string) => {
  try {
    const handle = await NodeFSP.open(
      file,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw failure();
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const next = await handle.read(bytes, length, bytes.length - length, length);
        if (!next.bytesRead) break;
        length += next.bytesRead;
      }
      if (length > MAX_BYTES) throw failure();
      const parsed = decode(bytes.subarray(0, length).toString("utf8"));
      if (new Set(parsed.bindings.map(pluginKeyIdentity)).size !== parsed.bindings.length)
        throw failure();
      return { bindings: parsed.bindings, writable: true };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { bindings: [], writable: true };
    return { bindings: [], writable: false };
  }
};

export const makePluginKeyStateStore = Effect.fn("PluginKeyStateStore.make")(function* (
  stateDir: string,
) {
  const file = NodePath.join(stateDir, PLUGIN_KEY_STATE_FILE);
  const platform = yield* HostProcess.Platform;
  const state = yield* Ref.make(yield* Effect.promise(() => load(file)));
  const lock = yield* Semaphore.make(1);
  const update = Effect.fn("PluginKeyStateStore.update")(function* (
    identity: PluginKeyIdentity,
    binding?: PluginKeyBinding,
  ) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (!current.writable) return yield* failure();
        const bindings = current.bindings.filter(
          (item) => pluginKeyIdentity(item) !== pluginKeyIdentity(identity),
        );
        if (binding) bindings.push(binding);
        const text = encode({ formatVersion: 1, bindings });
        if (Buffer.byteLength(text) > MAX_BYTES)
          return yield* new ExtensionsError({
            reason: "limit-reached",
            message: "Plugin key bindings exceed the saved-state limit.",
          });
        yield* Effect.tryPromise({
          try: () => writeExtensionState(file, text, platform),
          catch: failure,
        });
        yield* Ref.set(state, { bindings, writable: true });
      }),
    );
  });
  return { read: Ref.get(state), update };
});
