import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const encodeMarker = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      runId: Schema.String,
      retirement: Schema.Literal("unknown"),
    }),
  ),
);

/** Persist unknown ownership before launch; only proven retirement may clear it. */
export const makeLatexProcessRetirementMarkers = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  return Effect.fnUntraced(function* (markerPath: string, runId: string) {
    const syncDirectory = Effect.scoped(
      Effect.gen(function* () {
        if (platform === "win32") return;
        const directory = yield* fs.open(path.dirname(markerPath), { flag: "r" });
        yield* directory.sync;
      }),
    );
    yield* fs.writeFileString(markerPath, encodeMarker({ runId, retirement: "unknown" }) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const marker = yield* fs.open(markerPath, { flag: "r+" });
        yield* marker.sync;
      }),
    );
    yield* syncDirectory;
    return fs.remove(markerPath).pipe(Effect.andThen(syncDirectory));
  });
});
