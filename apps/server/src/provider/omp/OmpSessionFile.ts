import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { sessionFileInsideRoot } from "./OmpSessionCursor.ts";

/**
 * Canonical containment. `realPath` resolves symlinks, then the resolved file
 * must be a readable regular file inside the resolved session root.
 */
export const assertReadableOmpSessionFile = (input: {
  readonly sessionRoot: string;
  readonly relativeSessionFile: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const rootReal = yield* fs
      .realPath(input.sessionRoot)
      .pipe(Effect.mapError(() => "Oh My Pi session directory is not readable."));
    const candidate = path.resolve(rootReal, input.relativeSessionFile);
    const fileReal = yield* fs
      .realPath(candidate)
      .pipe(Effect.mapError(() => "Oh My Pi session file is not readable."));
    if (!sessionFileInsideRoot(rootReal, fileReal)) {
      return yield* Effect.fail("Oh My Pi resume cursor points outside its session directory.");
    }
    const info = yield* fs
      .stat(fileReal)
      .pipe(Effect.mapError(() => "Oh My Pi session file is not readable."));
    if (info.type !== "File") {
      return yield* Effect.fail("Oh My Pi session file is not a regular file.");
    }
    yield* fs
      .access(fileReal, { readable: true })
      .pipe(Effect.mapError(() => "Oh My Pi session file is not readable."));
  });

/**
 * Compare the session identity reported by OMP with the cursor's expected
 * file after both paths have passed through the filesystem's realpath
 * resolver. This matters on macOS, where `/tmp` and `/private/tmp` are two
 * names for the same file.
 */
export const ompSessionFilesEqual = (input: {
  readonly sessionRoot: string;
  readonly expectedRelativeFile: string;
  readonly reportedFile: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const rootReal = yield* fs
      .realPath(input.sessionRoot)
      .pipe(Effect.mapError(() => "Oh My Pi session directory is not readable."));
    const expected = yield* fs
      .realPath(path.resolve(rootReal, input.expectedRelativeFile))
      .pipe(Effect.mapError(() => "Oh My Pi session file is not readable."));
    const reportedCandidate = path.isAbsolute(input.reportedFile)
      ? input.reportedFile
      : path.resolve(rootReal, input.reportedFile);
    const reported = yield* fs
      .realPath(reportedCandidate)
      .pipe(Effect.mapError(() => "Oh My Pi session file is not readable."));
    return path.normalize(expected) === path.normalize(reported);
  });
