/**
 * Dangling Gemini skill links make session/new mkdir fail with -32603. Link only existing
 * directories, remove dangling links, and recheck each launch so later-installed user skills can
 * replace empty agent-created directories.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's remove cannot remove only an empty directory.
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/**
 * Remove only dangling links when the target is absent or empty real directories when it exists.
 * Preserve populated directories and resolving links.
 */
export const prepareAntigravitySkillLink = Effect.fn("prepareAntigravitySkillLink")(
  function* (input: {
    readonly link: string;
    readonly target: string;
  }): Effect.fn.Return<boolean, never, FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem;
    const targetIsDirectory = yield* fs.stat(input.target).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
    if (targetIsDirectory) {
      // Only a real directory, never a link or junction to one; rmdir refuses a
      // directory with anything in it, so no content can be lost.
      yield* Effect.tryPromise(async () => {
        const info = await NodeFSP.lstat(input.link);
        if (info.isDirectory() && !info.isSymbolicLink()) await NodeFSP.rmdir(input.link);
      }).pipe(Effect.ignore);
      return false;
    }
    const isLink = yield* fs.readLink(input.link).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!isLink) return true;
    // `stat` follows the link, so only a link whose target is gone reports NotFound.
    const dangling = yield* fs.stat(input.link).pipe(
      Effect.as(false),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(true)),
      Effect.orElseSucceed(() => false),
    );
    if (dangling) {
      yield* fs
        .remove(input.link)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("A dangling Antigravity skill link could not be removed.", { error }),
          ),
        );
    }
    return true;
  },
);
