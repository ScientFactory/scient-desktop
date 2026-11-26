import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { PROJECT_FILE_NAMES, type ProjectFileName } from "@t3tools/contracts";

/**
 * The first project file `read` finds, in Scient's order: `scient.json`, then `t3.json`. `read`
 * answers null for a file it cannot find; the result is null when neither exists.
 */
export const firstProjectFile = Effect.fnUntraced(function* <E, R>(
  read: (name: ProjectFileName) => Effect.Effect<string | null, E, R>,
) {
  for (const name of PROJECT_FILE_NAMES) {
    const contents = yield* read(name);
    if (contents !== null) return { name, contents };
  }
  return null;
});

/**
 * The text of the project file in `root`, or null when it has none or neither can be read. A `/`
 * joins the name on every platform, as the file system accepts it on Windows too.
 */
export const readProjectFileText = Effect.fnUntraced(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const file = yield* firstProjectFile((name) =>
    fileSystem.readFileString(`${root}/${name}`).pipe(Effect.orElseSucceed(() => null)),
  );
  return file?.contents ?? null;
});
