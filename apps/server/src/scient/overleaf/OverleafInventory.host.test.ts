/**
 * The review must never plan a write the host's file layer refuses: the applier
 * writes through that layer, and a refusal partway leaves a half-applied review.
 * These run the production `WorkspaceFileSystem` against the inventory's rules.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as KnownWorkspaces from "../../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { filePublicationTestHelper } from "../workspace/fileExchange.testkit.ts";
import { captureOverleafInventory, overleafPathExclusion } from "./OverleafInventory.ts";

const publicationHelper = await filePublicationTestHelper();

const layer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void })),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "scient-overleaf-host-" });
        return ServerConfig.layerTest(
          process.cwd(),
          yield* fs.realPath(directory),
          publicationHelper === undefined ? {} : { filePublicationHelperPath: publicationHelper },
        );
      }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

/** Whether the host's file layer refuses to write `relativePath` as a path into Git's folders. */
const hostRefuses = (cwd: string, relativePath: string) =>
  Effect.gen(function* () {
    const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
    return yield* files.writeFile({ cwd, relativePath, contents: "x" }).pipe(
      Effect.as(false),
      Effect.catchTags({
        WorkspaceFilePathEscapeError: () => Effect.succeed(true),
        // Without native publication (Linux CI) an allowed path fails later, at the write.
        WorkspaceFileMutationUnavailableError: () => Effect.succeed(false),
      }),
    );
  });

const tempFolder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "scient-overleaf-host-" }));
});

it.layer(layer)("Overleaf paths and the host's file layer", (it) => {
  describe("names", () => {
    it.effect("excludes every name the host refuses as Git's, and allows ordinary ones", () =>
      Effect.gen(function* () {
        const cwd = yield* tempFolder;
        for (const path of [
          ".git/config",
          ".GIT/config",
          ".gıt/config",
          ".git. /config",
          ".git::$INDEX_ALLOCATION/config",
          "GIT~1/config",
          "chapters/.Git/hooks/pre-commit",
        ]) {
          expect(yield* hostRefuses(cwd, path), path).toBe(true);
          expect(overleafPathExclusion(path), path).not.toBeNull();
        }
        for (const path of ["main.tex", "git/config", ".github/notes.md", "chapters/HEAD.tex"]) {
          expect(yield* hostRefuses(cwd, path), path).toBe(false);
          expect(overleafPathExclusion(path), path).toBeNull();
        }
      }),
    );
  });

  describe("repositories", () => {
    it.effect("never lists a file in a folder the host treats as a repository", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* tempFolder;
        for (const [name, contents] of [
          ["main.tex", "m"],
          [".bare/HEAD", "ref: refs/heads/main\n"],
          [".bare/objects/info/packs", ""],
          [".bare/refs/heads/main", ""],
          [".bare/description", "x"],
          ["linked/HEAD", "ref: refs/heads/main\n"],
          ["linked/commondir", "../..\n"],
          ["linked/notes.tex", "x"],
        ] as const) {
          yield* fs.makeDirectory(path.dirname(path.join(cwd, name)), { recursive: true });
          yield* fs.writeFileString(path.join(cwd, name), contents);
        }
        const inventory = yield* Effect.promise(() =>
          captureOverleafInventory({
            folder: cwd,
            managedPaths: ["main.tex"],
            localOnlyPaths: [],
            selectedAdditions: [],
            requestedPaths: [],
            stagingPaths: [],
          }),
        );
        if (inventory._tag !== "captured") return expect.fail(inventory.refusal.reason);
        expect(inventory.inventory.additions).toEqual([]);
        for (const folder of [".bare", "linked"]) {
          expect(inventory.inventory.excluded).toContainEqual({
            path: folder,
            reason: "repository",
          });
          expect(yield* hostRefuses(cwd, `${folder}/config`)).toBe(true);
        }
      }),
    );
  });
});
