/**
 * Failed session/new may leave sidecars without reporting a session ID, and exiting agents can
 * rewrite them after cleanup. A live session has its database; remove only sidecars with no
 * corresponding database in the private profile.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const sidecarName =
  /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.db-(?:wal|shm|journal)$/i;

export const removeOrphanedAntigravityConversationSidecars = Effect.fn(
  "removeOrphanedAntigravityConversationSidecars",
)(
  function* (profileDirectory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
    const names = yield* fs
      .readDirectory(conversations)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
    const present = new Set(names.map((name) => name.toLowerCase()));
    for (const name of names) {
      const sessionId = sidecarName.exec(name)?.[1];
      if (sessionId === undefined || present.has(`${sessionId}.db`.toLowerCase())) continue;
      yield* fs.remove(path.join(conversations, name), { force: true });
    }
  },
  Effect.catch(() =>
    Effect.logWarning("Could not remove leftover Antigravity conversation files."),
  ),
);
