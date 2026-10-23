import { DEFAULT_KEEP_AWAKE_SETTINGS, KeepAwakeDocument } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import { DesktopEnvironment } from "../../app/DesktopEnvironment.ts";

export class KeepAwakeStorageError extends Schema.TaggedError<KeepAwakeStorageError>()(
  "KeepAwakeStorageError",
  { cause: Schema.Defect() },
) {}
export class KeepAwakeStorage extends Context.Service<
  KeepAwakeStorage,
  {
    readonly load: Effect.Effect<KeepAwakeDocument, KeepAwakeStorageError>;
    readonly save: (document: KeepAwakeDocument) => Effect.Effect<void, KeepAwakeStorageError>;
  }
>()("@t3tools/desktop/scient/keepAwake/storage/KeepAwakeStorage") {}

const encodeDocument = Schema.encodeEffect(Schema.fromJsonString(KeepAwakeDocument));

export const layer = Layer.effect(
  KeepAwakeStorage,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const environment = yield* DesktopEnvironment;
    // Preserve the existing profile file and document format while switching to atomic async writes.
    const target = path.join(path.dirname(environment.clientSettingsPath), "keep-awake.json");
    return KeepAwakeStorage.of({
      load: fs.readFileString(target).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(KeepAwakeDocument))),
        Effect.catchIf(
          (error) => "reason" in error && error.reason._tag === "NotFound",
          () => Effect.succeed({ settings: DEFAULT_KEEP_AWAKE_SETTINGS, threads: [] }),
        ),
        Effect.mapError((cause) => new KeepAwakeStorageError({ cause })),
      ),
      save: (document) =>
        Effect.gen(function* () {
          const resolved = yield* resolveSymlinkTarget(target).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
          const suffix = yield* crypto.randomUUIDv4();
          const temporary = `${resolved}.${process.pid}.${suffix}.tmp`;
          const encoded = yield* encodeDocument(document);
          yield* fs.makeDirectory(path.dirname(resolved), { recursive: true });
          yield* fs.writeFileString(temporary, encoded);
          yield* fs
            .rename(temporary, resolved)
            .pipe(Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)));
        }).pipe(Effect.mapError((cause) => new KeepAwakeStorageError({ cause }))),
    });
  }),
);
