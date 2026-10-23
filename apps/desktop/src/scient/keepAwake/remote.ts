import { KEEP_AWAKE_REMOTE_OBSERVER, KeepAwakeWorkBatch, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";

export class KeepAwakeRemoteError extends Schema.TaggedError<KeepAwakeRemoteError>()(
  "KeepAwakeRemoteError",
  { cause: Schema.Defect() },
) {}

export class KeepAwakeRemote extends Context.Service<
  KeepAwakeRemote,
  {
    readonly observe: (
      environmentId: string,
      threadIds: readonly ThreadId[],
    ) => Effect.Effect<KeepAwakeWorkBatch, KeepAwakeRemoteError>;
  }
>()("@t3tools/desktop/scient/keepAwake/remote/KeepAwakeRemote") {}

const encodeArguments = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.Array(ThreadId)])),
);
const decodeBatch = Schema.decodeUnknownEffect(KeepAwakeWorkBatch);

export const layer = Layer.effect(
  KeepAwakeRemote,
  Effect.gen(function* () {
    const windows = yield* ElectronWindow;
    return KeepAwakeRemote.of({
      observe: Effect.fn("KeepAwakeRemote.observe")(function* (
        environmentId: string,
        threadIds: readonly ThreadId[],
      ) {
        const window = yield* windows.main;
        if (Option.isNone(window))
          return yield* new KeepAwakeRemoteError({
            cause: "Remote authentication requires an open Scient window.",
          });
        // SSH sessions and relay signing keys belong to the existing connection runtime.
        // Only a fixed read endpoint is delegated; credentials never cross this boundary.
        const args = yield* encodeArguments([environmentId, threadIds]).pipe(
          Effect.mapError((cause) => new KeepAwakeRemoteError({ cause })),
        );
        const result = yield* Effect.tryPromise({
          try: () =>
            window.value.webContents.executeJavaScript(
              `globalThis.${KEEP_AWAKE_REMOTE_OBSERVER}(...${args})`,
            ),
          catch: (cause) => new KeepAwakeRemoteError({ cause }),
        });
        return yield* decodeBatch(result).pipe(
          Effect.mapError((cause) => new KeepAwakeRemoteError({ cause })),
        );
      }),
    });
  }),
);
