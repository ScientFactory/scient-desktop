// @effect-diagnostics nodeBuiltinImport:off
/**
 * Scient's open-file watch: native filesystem hints for one file a client has
 * open, so an editor learns when the file changed on disk.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type { ProjectFileWatchEvent, ProjectReadFileInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  WorkspaceFileSystemOperationError,
  type WorkspaceFileSystem,
  type WorkspaceFileSystemError,
} from "../../workspace/WorkspaceFileSystem.ts";
import type * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { isNodeError } from "./WorkspaceFileErrors.ts";

/** The Scient watch method WorkspaceFileSystem serves beside its reads. */
export interface WorkspaceFileWatchMethods {
  /** Observe native filesystem hints for one currently open file. */
  readonly watchFile: (
    input: ProjectReadFileInput,
  ) => Stream.Stream<
    ProjectFileWatchEvent,
    WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
  >;
}

export function makeWorkspaceFileWatch(deps: {
  readonly path: Path.Path;
  readonly workspacePaths: WorkspacePaths.WorkspacePaths["Service"];
}) {
  const { path, workspacePaths } = deps;

  // Watching is viewing: like reads, a watch follows the file wherever it lives,
  // including absolute host paths, paths that climb out of the root and
  // symlinks that lead out of it. Events carry the path exactly as requested.
  const resolveRealFileWatchTarget = Effect.fn("WorkspaceFileSystem.resolveRealFileWatchTarget")(
    function* (input: ProjectReadFileInput) {
      const requestedPath = input.relativePath;
      const containedTarget = path.isAbsolute(requestedPath)
        ? null
        : yield* workspacePaths
            .resolveRelativePathWithinRoot({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
            })
            .pipe(Effect.option);
      const target =
        containedTarget !== null && containedTarget._tag === "Some"
          ? containedTarget.value
          : {
              absolutePath: path.resolve(input.cwd, requestedPath),
              relativePath: requestedPath,
            };
      const resolvedParentDirectory = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(path.dirname(target.absolutePath)),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: path.dirname(target.absolutePath),
            operation: "realpath-watch-directory",
            cause,
          }),
      });
      const realTargetPath = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await NodeFSP.realpath(target.absolutePath);
          } catch (error) {
            if (isNodeError(error, "ENOENT")) {
              return path.join(resolvedParentDirectory, path.basename(target.absolutePath));
            }
            throw error;
          }
        },
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "realpath-target",
            cause,
          }),
      });
      // Existing file symlinks need to watch the resolved target's directory,
      // not merely the directory containing the link. Missing files already
      // resolve through their canonical parent above.
      const watchDirectory = path.dirname(realTargetPath);
      return { realTargetPath, target, watchDirectory };
    },
  );

  const watchFile: WorkspaceFileSystem["Service"]["watchFile"] = (input) =>
    Stream.unwrap(
      resolveRealFileWatchTarget(input).pipe(
        Effect.map(({ realTargetPath, target, watchDirectory }) => {
          return Stream.callback<ProjectFileWatchEvent, WorkspaceFileSystemOperationError>(
            (queue) =>
              Effect.acquireRelease(
                Effect.try({
                  try: () => {
                    const watcher = NodeFS.watch(watchDirectory, (_event, reportedPath) => {
                      // Node documents that filename may be absent on some
                      // platforms. Since this watcher is scoped to one parent,
                      // a conservative reread is cheaper than missing a save.
                      if (reportedPath !== null) {
                        const absoluteReportedPath = path.isAbsolute(reportedPath)
                          ? path.resolve(reportedPath)
                          : path.resolve(watchDirectory, reportedPath);
                        if (absoluteReportedPath !== realTargetPath) return;
                      }
                      Queue.offerUnsafe(queue, {
                        _tag: "file-changed",
                        relativePath: target.relativePath,
                      });
                    });
                    watcher.on("error", (cause) => {
                      Queue.failCauseUnsafe(
                        queue,
                        Cause.fail(
                          new WorkspaceFileSystemOperationError({
                            workspaceRoot: input.cwd,
                            relativePath: input.relativePath,
                            resolvedPath: realTargetPath,
                            operationPath: watchDirectory,
                            operation: "watch",
                            cause,
                          }),
                        ),
                      );
                    });
                    watcher.on("close", () => Queue.endUnsafe(queue));
                    Queue.offerUnsafe(queue, {
                      _tag: "watch-ready",
                      relativePath: target.relativePath,
                    });
                    return watcher;
                  },
                  catch: (cause) =>
                    new WorkspaceFileSystemOperationError({
                      workspaceRoot: input.cwd,
                      relativePath: input.relativePath,
                      resolvedPath: realTargetPath,
                      operationPath: watchDirectory,
                      operation: "watch",
                      cause,
                    }),
                }),
                (watcher) => Effect.sync(() => watcher.close()),
              ),
          ).pipe(
            // Editors and atomic writers commonly produce several events for
            // one save. Batch them after the write settles, but preserve the
            // explicit readiness signal used by clients and deterministic tests.
            Stream.groupedWithin(256, "100 millis"),
            Stream.flatMap((events) => {
              const coalesced: ProjectFileWatchEvent[] = [];
              if (events.some((event) => event._tag === "watch-ready")) {
                coalesced.push({ _tag: "watch-ready", relativePath: target.relativePath });
              }
              if (events.some((event) => event._tag === "file-changed")) {
                coalesced.push({ _tag: "file-changed", relativePath: target.relativePath });
              }
              return Stream.fromIterable(coalesced);
            }),
          );
        }),
      ),
    );

  return { watchFile };
}
