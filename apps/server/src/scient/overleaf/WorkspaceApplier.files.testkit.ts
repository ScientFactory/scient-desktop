// @effect-diagnostics nodeBuiltinImport:off
/**
 * The file layer an applier test runs on: real native publication and private
 * retention under `root`. Free of the test runner, so a child process can run
 * an applier on the same folders (WorkspaceApplier.crash-child.ts).
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import { makeWorkspaceFileMutations } from "../workspace/WorkspaceFileMutations.ts";
import {
  bytesRevision,
  directoryIdentity,
  type RetainedMutationHooks,
} from "../workspace/RetainedFileMutation.ts";
import { ensureNativePrivateRetentionDirectory } from "../workspace/NativeFilePublication.ts";

export const makeApplierFiles = Effect.fn("WorkspaceApplier.makeApplierFiles")(function* (input: {
  readonly root: string;
  readonly helper: string | undefined;
  readonly retainedHooks: RetainedMutationHooks;
}) {
  const { root, helper, retainedHooks } = input;
  const fileSystem = yield* FileSystem.FileSystem,
    pathService = yield* Path.Path,
    workspacePaths = yield* WorkspacePaths.WorkspacePaths.pipe(
      Effect.provide(WorkspacePaths.layer),
    );
  const entries = WorkspaceEntries.WorkspaceEntries.of({
    refresh: () => Effect.void,
    browse: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    listIgnoredFiles: () => Effect.die("unused"),
    listDirectory: () => Effect.die("unused"),
    search: () => Effect.die("unused"),
    searchContents: () => Effect.die("unused"),
  });
  const readFile: WorkspaceFileSystem["Service"]["readFile"] = (input) =>
    Effect.promise(async () => {
      const content = await NodeFSP.readFile(NodePath.join(input.cwd, input.relativePath));
      return {
        relativePath: input.relativePath,
        contents: content.toString(),
        byteLength: content.length,
        truncated: false,
        revision: bytesRevision(content),
      };
    });
  const methods = yield* makeWorkspaceFileMutations({
    fileSystem,
    path: pathService,
    workspacePaths,
    workspaceEntries: entries,
    readFile,
    retainedHooks,
    ...(helper === undefined ? {} : { nativePublicationHelper: helper }),
    resolveRetentionStorageDirectory: async () => NodePath.join(root, "shared-retention"),
    retentionDirectoryFor: async (_root, parent) => {
      if (!helper) throw new Error("This fixture needs a real native publication helper.");
      const identity = await directoryIdentity(parent);
      await ensureNativePrivateRetentionDirectory(helper, NodePath.join(root, "shared-retention"));
      return ensureNativePrivateRetentionDirectory(
        helper,
        NodePath.join(root, "shared-retention", `${identity.dev}-${identity.ino}`),
      );
    },
  });
  return WorkspaceFileSystem.of({
    getMetadata: () => Effect.die("getMetadata is not used by the workspace applier fixture"),
    ...methods,
    readFile,
    viewFile: readFile,
    watchFile: () => Stream.empty,
  });
});
