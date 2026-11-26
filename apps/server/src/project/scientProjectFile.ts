import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { PROJECT_FILE_NAMES, type ProjectFileName } from "@t3tools/contracts";

/**
 * The first project file `read` finds, in Scient's order: `scient.json`, then `t3.json`. `read`
 * answers null for a file it cannot find; the result is null when neither exists.
 */
const firstProjectFile = Effect.fnUntraced(function* <E, R>(
  read: (name: ProjectFileName) => Effect.Effect<string | null, E, R>,
) {
  for (const name of PROJECT_FILE_NAMES) {
    const contents = yield* read(name);
    if (contents !== null) return { name, contents };
  }
  return null;
});

/**
 * The text of the project file in `root`, or null when it has none or it cannot be read. Only a
 * missing `scient.json` lets `t3.json` answer: one that fails to read stops the search, so its
 * settings are never swapped for older ones. A `/` joins the name on every platform, as the file
 * system accepts it on Windows too.
 */
export const readProjectFileText = Effect.fnUntraced(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  let unreadable = false;
  const file = yield* firstProjectFile((name) =>
    unreadable
      ? Effect.succeed(null)
      : fileSystem.readFileString(`${root}/${name}`).pipe(
          Effect.catchTags({
            PlatformError: (error) => {
              if (error.reason._tag !== "NotFound") unreadable = true;
              return Effect.succeed(null);
            },
          }),
          Effect.orElseSucceed(() => null),
        ),
  );
  return file?.contents ?? null;
});
