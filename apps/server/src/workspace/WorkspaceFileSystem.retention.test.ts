import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import {
  filePublicationTestHelper,
  nativePublicationHost,
} from "../scient/workspace/fileExchange.testkit.ts";
import { revisionForBytes } from "../scient/workspace/WorkspaceFileMutations.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const helper = await filePublicationTestHelper();
const nativeHost = await nativePublicationHost();
const layer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provideMerge(NodeServices.layer),
);

const fixture = Effect.fn("WorkspaceFileSystem.retentionFixture")(function* (
  leaf: "missing" | "symlink" | "public" = "missing",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "scient-retention-alias-" });
  const root = yield* fs.realPath(temporary);
  const home = path.join(root, "home");
  const alias = path.join(root, "alias");
  const cwd = path.join(root, "project");
  const retention = path.join(home, "nested", "file-publications");
  yield* fs.makeDirectory(home);
  yield* fs.makeDirectory(cwd);
  yield* fs.symlink(home, alias);
  yield* fs.writeFileString(path.join(cwd, "rich.md"), "before");
  if (leaf !== "missing") {
    yield* fs.makeDirectory(path.dirname(retention));
    if (leaf === "symlink") {
      const outside = path.join(root, "outside");
      yield* fs.makeDirectory(outside, { mode: 0o700 });
      yield* fs.symlink(outside, retention);
    } else {
      yield* fs.makeDirectory(retention, { mode: 0o755 });
    }
  }
  const api = yield* WorkspaceFileSystem.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(cwd, root, {
          filePublicationHelperPath: helper,
          filePublicationRetentionRoot: path.join(alias, "nested", "file-publications"),
          filePublicationRetentionLimitBytes: 1024 * 1024,
        }),
        Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
      ),
    ),
  );
  return { fs, path, root, cwd, home, alias, retention, api };
});

// These contracts require the host's real retained-publication primitives; other hosts use plain saves.
describe.skipIf(!nativeHost)("WorkspaceFileSystem canonical retention", () => {
  it.layer(layer, { excludeTestServices: true })("native owner", (it) => {
    it.effect("keeps working when a record's folder was deleted", () =>
      Effect.gen(function* () {
        const { fs, path, root, cwd, retention, api } = yield* fixture();
        const opened = yield* api.readFile({ cwd, relativePath: "rich.md" });
        const first = yield* api.writeFile({
          cwd,
          relativePath: "rich.md",
          contents: "after",
          expectedRevision: opened.revision,
          mutationId: "before-the-folder-went",
        });
        const stale = path.join(retention, "1-2", "stale");
        yield* fs.makeDirectory(stale, { recursive: true, mode: 0o700 });
        yield* fs.chmod(path.dirname(stale), 0o700);
        yield* fs.writeFileString(
          path.join(stale, "reference.json"),
          JSON.stringify({ version: 1, recordDirectory: path.join(root, "deleted", "record") }),
        );
        const saved = yield* api.writeFile({
          cwd,
          relativePath: "rich.md",
          contents: "later",
          expectedRevision: first.revision,
          mutationId: "after-the-folder-went",
        });
        expect(saved.revision).toBe(revisionForBytes(Buffer.from("later")));
        const history = yield* api.listFileVersions({ cwd, relativePath: "rich.md" });
        expect(history.attention).toBeNull();
      }),
    );

    it.effect.each(["symlink", "public"] as const)(
      "saves whatever a %s storage directory holds, which it leaves unchanged",
      (leaf) =>
        Effect.gen(function* () {
          const { fs, path, root, cwd, retention, api } = yield* fixture(leaf);
          yield* api.writeFile({
            cwd,
            relativePath: "rich.md",
            contents: "after",
            expectedRevision: revisionForBytes(Buffer.from("before")),
            mutationId: `saved-${leaf}`,
          });
          expect(yield* fs.readFileString(path.join(cwd, "rich.md"))).toBe("after");
          if (leaf === "symlink") {
            expect(yield* fs.readLink(retention)).toBe(path.join(root, "outside"));
            expect(yield* fs.readDirectory(path.join(root, "outside"))).toEqual([]);
          } else {
            expect((yield* fs.stat(retention)).mode & 0o777).toBe(0o755);
            expect(yield* fs.readDirectory(retention)).toEqual([]);
          }
        }),
    );
  });
});
