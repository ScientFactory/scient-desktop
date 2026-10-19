import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { removeAntigravitySessionFiles } from "../../provider/acp/AntigravitySessionFiles.ts";

const failedSession = "46d5cab4-b887-48a9-8b54-2898514635ea";
const liveSession = "8d3d451a-f672-4ba0-a373-a9b51d381688";

it.layer(NodeServices.layer)("Antigravity conversation sidecars", (it) => {
  it.effect("removes the WAL and SHM a failed session/new leaves without reporting its id", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
      yield* fs.makeDirectory(conversations, { recursive: true });
      const files = [
        `${failedSession}.db-wal`,
        `${failedSession}.db-shm`,
        `${liveSession}.db`,
        `${liveSession}.db-wal`,
        `${liveSession}.db-shm`,
        "notes.db-wal",
      ];
      for (const name of files) {
        yield* fs.writeFileString(path.join(conversations, name), "fixture");
      }

      yield* removeAntigravitySessionFiles({ profileDirectory, sessionId: undefined, cwd: "/x" });

      expect((yield* fs.readDirectory(conversations)).toSorted()).toEqual([
        `${liveSession}.db`,
        `${liveSession}.db-shm`,
        `${liveSession}.db-wal`,
        "notes.db-wal",
      ]);
    }),
  );

  it.effect("tolerates a profile without conversations", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      yield* removeAntigravitySessionFiles({ profileDirectory, sessionId: undefined, cwd: "/x" });
    }),
  );
});
