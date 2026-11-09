import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class PiSessionFileError extends Schema.TaggedError<PiSessionFileError>()(
  "PiSessionFileError",
  { operation: Schema.String, sessionFile: Schema.String, cause: Schema.Defect() },
) {}

export const piInstanceStateRoot = Effect.fn("PiSessionFile.piInstanceStateRoot")(
  function* (input: { readonly stateDir: string; readonly instanceId: string }) {
    const path = yield* Path.Path;
    if (
      !input.instanceId ||
      input.instanceId.trim() !== input.instanceId ||
      input.instanceId === "." ||
      input.instanceId === ".."
    ) {
      return yield* new PiSessionFileError({
        operation: "instanceId",
        sessionFile: input.stateDir,
        cause: input.instanceId,
      });
    }
    return path.resolve(
      input.stateDir,
      "providers",
      "pi",
      encodeURIComponent(input.instanceId),
      "sessions",
    );
  },
);

const canonicalContainedPath = (path: Path.Path, root: string, candidate: string) => {
  const canonicalRoot = path.resolve(root);
  const canonical = path.resolve(candidate);
  return canonical !== canonicalRoot && canonical.startsWith(`${canonicalRoot}${path.sep}`)
    ? canonical
    : undefined;
};

export const allocateFreshPiSessionFile = Effect.fn("PiSessionFile.allocateFresh")(
  function* (input: { readonly stateRoot: string; readonly fileId: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(input.stateRoot);
    yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
    yield* fs.chmod(root, 0o700);
    const rootReal = yield* fs.realPath(root);
    if (!input.fileId || input.fileId.trim() !== input.fileId) {
      return yield* new PiSessionFileError({
        operation: "allocate",
        sessionFile: rootReal,
        cause: input.fileId,
      });
    }
    const sessionFile = path.join(rootReal, `${encodeURIComponent(input.fileId)}.jsonl`);
    if (!canonicalContainedPath(path, rootReal, sessionFile)) {
      return yield* new PiSessionFileError({
        operation: "allocate",
        sessionFile,
        cause: input.fileId,
      });
    }
    return yield* Effect.acquireUseRelease(
      fs
        .writeFileString(sessionFile, "", { flag: "wx", mode: 0o600 })
        .pipe(Effect.as({ sessionFile })),
      (fresh) => fs.chmod(sessionFile, 0o600).pipe(Effect.as(fresh)),
      (fresh, exit) =>
        Exit.isFailure(exit)
          ? fs.remove(fresh.sessionFile, { force: true }).pipe(Effect.ignore)
          : Effect.void,
    );
  },
);

export const cleanupFreshPiSessionFile = Effect.fn("PiSessionFile.cleanupFresh")(function* (fresh: {
  readonly sessionFile: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(fresh.sessionFile, { force: true });
});
