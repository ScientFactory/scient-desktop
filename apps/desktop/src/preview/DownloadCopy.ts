// @effect-diagnostics nodeBuiltinImport:off -- Node exposes the exclusive-copy flag that FileSystem.copyFile lacks.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

class PreviewDownloadCopyError extends Schema.TaggedError<PreviewDownloadCopyError>()(
  "PreviewDownloadCopyError",
  { source: Schema.String, directory: Schema.String, cause: Schema.Defect() },
) {}

const isExistingDestination = Schema.is(Schema.Struct({ code: Schema.Literal("EEXIST") }));

/** Copies a completed download without overwriting a name claimed by any other writer. */
export const copyDownloadToDirectory = Effect.fn("PreviewManager.copyDownloadToDirectory")(
  function* (source: string, fileName: string, directory: string) {
    const path = yield* Path.Path;
    const extension = path.extname(fileName);
    const stem = path.basename(fileName, extension) || "download";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const target = path.join(
        directory,
        attempt === 0 ? `${stem}${extension}` : `${stem} (${attempt})${extension}`,
      );
      const copied = yield* Effect.tryPromise({
        try: () => NodeFSP.copyFile(source, target, NodeFS.constants.COPYFILE_EXCL),
        catch: (cause) => new PreviewDownloadCopyError({ source, directory, cause }),
      }).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => isExistingDestination(error.cause),
          () => Effect.succeed(false),
        ),
      );
      if (copied) return target;
    }
    return yield* new PreviewDownloadCopyError({
      source,
      directory,
      cause: new Error("No available download filename within the 100-name limit."),
    });
  },
);
