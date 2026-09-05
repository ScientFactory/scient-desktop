import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
  readonly mode?: number | undefined;
  /** Authored files need durability; regenerable caches should not flush every update. */
  readonly durable?: boolean;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const platform = yield* HostProcessPlatform;
      const path = yield* Path.Path;
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");

      yield* fs.writeFileString(tempPath, input.contents);
      if (input.durable)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(tempPath, { flag: "r+" });
            if (input.mode !== undefined) yield* fs.chmod(tempPath, input.mode);
            yield* file.sync;
          }),
        );
      else if (input.mode !== undefined) yield* fs.chmod(tempPath, input.mode);
      yield* fs.rename(tempPath, input.filePath);
      // Windows does not support opening directory handles through this API.
      // On POSIX, persist the rename as well as the temporary file's contents.
      if (input.durable && platform !== "win32") {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const directory = yield* fs.open(targetDirectory, { flag: "r" });
            yield* directory.sync;
          }),
        ).pipe(
          Effect.catch((error) => {
            const cause = error.reason.cause;
            const code =
              typeof cause === "object" && cause !== null && "code" in cause
                ? cause.code
                : undefined;
            return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP"
              ? Effect.void
              : Effect.fail(error);
          }),
        );
      }
    }),
  );
