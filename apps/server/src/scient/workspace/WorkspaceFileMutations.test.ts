import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { makeWorkspaceFileMutations } from "./WorkspaceFileMutations.ts";

const entries = WorkspaceEntries.WorkspaceEntries.of({
  browse: () => Effect.die("unused"),
  list: () => Effect.die("unused"),
  listIgnoredFiles: () => Effect.die("unused"),
  listDirectory: () => Effect.die("unused"),
  search: () => Effect.die("unused"),
  searchContents: () => Effect.die("unused"),
  refresh: () => Effect.void,
});

it.layer(NodeServices.layer)("WorkspaceFileMutations", (it) => {
  // The host checks a write before handing it here; the mutation repeats the check on its own
  // resolution, so a link swapped in between cannot carry the write into Git's folder.
  it.effect("refuses a protected target on its own resolution", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-mutations-" });
      yield* fileSystem.makeDirectory(path.join(root, ".git"));
      const checked: string[] = [];
      const mutations = yield* makeWorkspaceFileMutations({
        fileSystem,
        path,
        workspacePaths: yield* WorkspacePaths.WorkspacePaths,
        workspaceEntries: entries,
        readFile: () => Effect.die("unused"),
        retentionStorageDirectory: path.join(root, "retention"),
        retentionDirectoryFor: () => Promise.reject(new Error("unused")),
        isProtectedPath: async (absolutePath) => {
          checked.push(absolutePath);
          return absolutePath.split(path.sep).includes(".git");
        },
      });

      const refused = yield* Effect.flip(
        mutations.writeFile({ cwd: root, relativePath: ".git/config", contents: "[core]\n" }),
      );
      assert.equal(refused._tag, "WorkspaceFilePathEscapeError");
      assert.isFalse(yield* fileSystem.exists(path.join(root, ".git", "config")));

      yield* mutations.writeFile({ cwd: root, relativePath: "notes.md", contents: "notes\n" });
      assert.equal(yield* fileSystem.readFileString(path.join(root, "notes.md")), "notes\n");
      assert.isAbove(checked.length, 0);
    }).pipe(Effect.provide(WorkspacePaths.layer), Effect.scoped),
  );
});
