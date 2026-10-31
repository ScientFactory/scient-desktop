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
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import {
  WorkspaceFileSystemOperationError,
  type WorkspaceFileSystem,
  type WorkspaceFileSystemError,
} from "../../workspace/WorkspaceFileSystem.ts";
import type * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { isNodeError } from "./WorkspaceFileErrors.ts";

/** How often a watch checks that its folder is still the one it is attached to. */
const WATCHED_FOLDER_CHECK = "2 seconds";

/** Linux gives a new folder the inode of a deleted one at once, so the birth time counts too. */
const folderIdentity = ({ dev, ino, birthtimeNs }: NodeFS.BigIntStats) =>
  `${dev}:${ino}:${birthtimeNs}`;

const isFolderMissing = (error: WorkspaceFileSystemOperationError) =>
  (error.operation === "realpath-watch-directory" || error.operation === "watch") &&
  (isNodeError(error.cause, "ENOENT") || isNodeError(error.cause, "ENOTDIR"));

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
  readonly waitForSettlement?: (
    input: ProjectReadFileInput,
  ) => Effect.Effect<void, WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError>;
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
      const root = yield* Effect.promise(() => NodeFSP.realpath(input.cwd).catch(() => null));
      const relative = root === null ? null : path.relative(root, realTargetPath);
      const settlementInput =
        root !== null &&
        relative !== null &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
          ? { cwd: root, relativePath: relative }
          : null;
      return { realTargetPath, target, watchDirectory, settlementInput };
    },
  );

  /**
   * A native watch holds the folder itself, not its path: once the folder is deleted it
   * reports nothing, even when a folder of that name returns. So this ends when the
   * folder goes or is replaced, and follows it to the next one. `returned` says the
   * folder was away, so whoever has the file open reads it again.
   */
  const follow = (
    input: ProjectReadFileInput,
    returned: boolean,
  ): Stream.Stream<
    ProjectFileWatchEvent,
    WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
  > =>
    Stream.unwrap(
      resolveRealFileWatchTarget(input).pipe(
        Effect.map(({ realTargetPath, target, watchDirectory, settlementInput }) => {
          return Stream.callback<ProjectFileWatchEvent, WorkspaceFileSystemOperationError>(
            (queue) =>
              Effect.acquireRelease(
                Effect.try({
                  try: () => {
                    const folder = folderIdentity(
                      NodeFS.statSync(watchDirectory, { bigint: true }),
                    );
                    const folderLost = () =>
                      NodeFSP.stat(watchDirectory, { bigint: true }).then(
                        (found) => folderIdentity(found) !== folder,
                        (error) => isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR"),
                      );
                    const changed = () =>
                      Queue.offerUnsafe(queue, {
                        _tag: "file-changed",
                        relativePath: target.relativePath,
                      });
                    const leave = () => {
                      changed();
                      Queue.endUnsafe(queue);
                    };
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
                      changed();
                    });
                    // Windows reports a deleted folder as an error on its watch.
                    watcher.on("error", (cause) => {
                      void folderLost().then((lost) => {
                        if (lost) return leave();
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
                    });
                    watcher.on("close", () => Queue.endUnsafe(queue));
                    Queue.offerUnsafe(queue, {
                      _tag: "watch-ready",
                      relativePath: target.relativePath,
                    });
                    if (returned) changed();
                    return { watcher, folderLost, leave };
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
                ({ watcher }) => Effect.sync(() => watcher.close()),
              ).pipe(
                Effect.flatMap(({ folderLost, leave }) =>
                  Effect.promise(folderLost).pipe(
                    Effect.flatMap((lost) => (lost ? Effect.sync(leave) : Effect.void)),
                    Effect.repeat(Schedule.spaced(WATCHED_FOLDER_CHECK)),
                    Effect.forkScoped,
                  ),
                ),
              ),
          ).pipe(
            // Batching coalesces hints, not native retirement. Readiness remains
            // independent; changed-file hints join publication settlement below.
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
            Stream.mapEffect((event) =>
              event._tag === "file-changed" &&
              settlementInput !== null &&
              deps.waitForSettlement !== undefined
                ? deps.waitForSettlement(settlementInput).pipe(Effect.as(event))
                : Effect.succeed(event),
            ),
          );
        }),
      ),
    ).pipe(
      Stream.catchIf(
        (error) => error._tag === "WorkspaceFileSystemOperationError" && isFolderMissing(error),
        () =>
          returned
            ? Stream.empty
            : Stream.make({ _tag: "watch-ready", relativePath: input.relativePath } as const),
      ),
      Stream.concat(
        Stream.suspend(() =>
          Stream.unwrap(Effect.as(Effect.sleep(WATCHED_FOLDER_CHECK), follow(input, true))),
        ),
      ),
    );

  const watchFile: WorkspaceFileSystem["Service"]["watchFile"] = (input) => follow(input, false);

  return { watchFile };
}
