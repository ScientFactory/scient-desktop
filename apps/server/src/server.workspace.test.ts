// @effect-diagnostics nodeBuiltinImport:off
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  EnvironmentFilePath,
  ThreadSectionId,
  GitCommandError,
  VcsCheckpointUnavailableError,
  MessageId,
  OrchestrationDispatchCommandError,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  RunId,
  WS_METHODS,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { assertFailure, assertTrue } from "@effect/vitest/utils";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";
import * as OrchestratorV2 from "./orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchV2 from "./orchestration-v2/ThreadLaunchService.ts";
import {
  turnEvents as transferV2TurnEvents,
  THREAD_ID as transferV2ThreadId,
} from "../integration/TransferBudgetV2Fixture.integration.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import { registerAnalysisRpcTests } from "./scient/analysis/AnalysisRpcServerTests.ts";
import { registerComputeRpcTests } from "./scient/compute/ComputeRpcServerTests.ts";
import { registerMarkdownTransportTests } from "./scient/markdown/MarkdownTransportServerTests.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { toThreadForkCommand } from "./orchestration-v2/testkit/ConversationForkCommand.ts";
import { readConversationFork } from "./orchestration-v2/scient-fork/ConversationForkRecords.ts";
import {
  NodeHttpServerTest,
  TEST_EPOCH,
  buildAppUnderTest,
  collectV2ShellCatchup,
  decodeQueueOperationError,
  decodeQueueSnapshot,
  defaultModelSelection,
  defaultProjectId,
  exchangeAccessToken,
  fetchEffect,
  getAuthenticatedSessionCookieHeader,
  getHttpServerUrl,
  getWsServerUrl,
  ignoredReadHelper,
  ignoredReadNative,
  jsonRequestBody,
  nativeAdmissionInstance,
  responseJsonEffect,
  seedV2StreamThread,
  withWsRpcClient,
} from "./server.testkit.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer))(
  "server router seam: workspace",
  (it) => {
    // SCIENT-FORK:START — ignored-file discovery must not publish stale root authority.
    for (const replaceRoot of [false, true]) {
      it.effect.skipIf(replaceRoot && !ignoredReadNative)(
        replaceRoot
          ? "rejects ignored-file results after workspace root authority changes"
          : "routes websocket rpc ignored files from a settled workspace",
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const parent = yield* fs.makeTempDirectoryScoped({ prefix: "scient-ignored-rpc-" });
            const workspaceDir = path.join(parent, "workspace");
            yield* fs.makeDirectory(workspaceDir);
            yield* fs.writeFileString(path.join(workspaceDir, ".gitignore"), ".env\n");
            yield* fs.writeFileString(path.join(workspaceDir, ".env"), "SYNTHETIC=true\n");
            const vcs = yield* VcsProcess.VcsProcess.pipe(Effect.provide(VcsProcess.layer));
            yield* vcs.run({
              operation: "fixture.git-init",
              command: "git",
              args: ["init", "--quiet"],
              cwd: workspaceDir,
            });
            yield* buildAppUnderTest({
              config:
                ignoredReadHelper === undefined
                  ? {}
                  : { filePublicationHelperPath: ignoredReadHelper },
              transformWorkspaceEntries: (entries) => ({
                ...entries,
                listIgnoredFiles: Effect.fn("ServerTest.listIgnoredFiles")(function* (input) {
                  const result = yield* entries.listIgnoredFiles(input);
                  assert.deepEqual(result.files, [{ path: ".env", byteLength: 15 }]);
                  if (replaceRoot) {
                    yield* fs
                      .rename(workspaceDir, path.join(parent, "previous-workspace"))
                      .pipe(Effect.orDie);
                    yield* fs.makeDirectory(workspaceDir).pipe(Effect.orDie);
                  }
                  return result;
                }),
              }),
            });
            const response = yield* Effect.scoped(
              withWsRpcClient(yield* getWsServerUrl("/ws"), (client) =>
                client[WS_METHODS.projectsListIgnoredFiles]({ cwd: workspaceDir }).pipe(
                  Effect.result,
                ),
              ),
            );
            if (replaceRoot) {
              if (
                response._tag !== "Failure" ||
                response.failure._tag !== "ProjectListEntriesError"
              ) {
                assert.fail("Changed workspace authority must not return ignored-file results.");
              }
              assert.equal(response.failure.cwd, workspaceDir);
              assert.equal(response.failure.failure, "directory_list_failed");
              assert.propertyVal(response.failure.cause, "name", "WorkspaceFileTargetChangedError");
            } else {
              if (response._tag !== "Success") assert.fail("Expected ignored-file results.");
              assert.deepEqual(response.success, {
                files: [{ path: ".env", byteLength: 15 }],
                truncated: false,
              });
            }
          }).pipe(Effect.provide(NodeHttpServerTest), TestClock.withLive),
      );
    }
    // SCIENT-FORK:END

    it.effect("routes websocket rpc projects.searchEntries excludes gitignored files", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-ws-project-search-gitignored-",
        });
        yield* fs.writeFileString(path.join(workspaceDir, ".gitignore"), ".venv/\n");
        yield* fs.makeDirectory(path.join(workspaceDir, ".venv", "lib"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workspaceDir, ".venv", "lib", "ignored-search-target.ts"),
          "export const ignored = true;",
        );
        yield* fs.makeDirectory(path.join(workspaceDir, "src"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workspaceDir, "src", "tracked.ts"),
          "export const ok = 1;",
        );

        yield* buildAppUnderTest({
          layers: {
            vcsDriver: {
              isInsideWorkTree: () => Effect.succeed(true),
              listWorkspaceFiles: () =>
                Effect.succeed({
                  paths: ["src/tracked.ts"],
                  truncated: false,
                  freshness: {
                    source: "live-local",
                    observedAt: TEST_EPOCH,
                    expiresAt: Option.none(),
                  },
                }),
              filterIgnoredPaths: (_cwd, relativePaths) =>
                Effect.succeed(
                  relativePaths.filter((relativePath) => !relativePath.startsWith(".venv/")),
                ),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.projectsSearchEntries]({
              cwd: workspaceDir,
              query: "ignored-search-target",
              limit: 10,
            }),
          ),
        );

        assert.equal(response.entries.length, 0);
        assert.equal(response.truncated, false);
      }).pipe(Effect.provide(NodeHttpServerTest), TestClock.withLive),
    );

    it.effect.skipIf(!symlinksSupported)("preserves structured workspace rpc failures", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-ws-workspace-errors-",
        });
        const outsideDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-ws-workspace-errors-outside-",
        });
        const outsideFile = path.join(outsideDir, "outside.txt");
        yield* fs.writeFileString(outsideFile, "outside\n");
        yield* fs.symlink(outsideFile, path.join(workspaceDir, "linked-outside.txt"));
        yield* fs.symlink(
          path.join(workspaceDir, "missing-referent.txt"),
          path.join(workspaceDir, "dangling.txt"),
        );

        yield* buildAppUnderTest();

        const invalidWorkspace = path.join(workspaceDir, "missing-workspace");
        const missingBrowseParent = path.join(workspaceDir, "missing-browse");
        const sensitiveQuery = "authorization: Bearer secret-token";
        const wsUrl = yield* getWsServerUrl("/ws");
        const results = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.all({
              search: client[WS_METHODS.projectsSearchEntries]({
                cwd: invalidWorkspace,
                query: sensitiveQuery,
                limit: 10,
              }).pipe(Effect.result),
              list: client[WS_METHODS.projectsListEntries]({ cwd: invalidWorkspace }).pipe(
                Effect.result,
              ),
              directory: client[WS_METHODS.projectsListDirectory]({
                cwd: invalidWorkspace,
                relativeDirectory: "",
                view: "ordinary",
              }).pipe(Effect.result),
              read: client[WS_METHODS.projectsReadFile]({
                cwd: workspaceDir,
                relativePath: "missing.txt",
              }).pipe(Effect.result),
              missingRootRead: client[WS_METHODS.projectsReadFile]({
                cwd: invalidWorkspace,
                relativePath: "missing.txt",
              }).pipe(Effect.result),
              nonDirectoryRootRead: client[WS_METHODS.projectsReadFile]({
                cwd: outsideFile,
                relativePath: "missing.txt",
              }).pipe(Effect.result),
              linkedRead: client[WS_METHODS.projectsReadFile]({
                cwd: workspaceDir,
                relativePath: "linked-outside.txt",
              }).pipe(Effect.result),
              danglingRead: client[WS_METHODS.projectsReadFile]({
                cwd: workspaceDir,
                relativePath: "dangling.txt",
              }).pipe(Effect.result),
              browse: client[WS_METHODS.filesystemBrowse]({
                cwd: workspaceDir,
                partialPath: "./missing-browse/child",
              }).pipe(Effect.result),
            }),
          ),
        );

        if (
          results.search._tag !== "Failure" ||
          results.search.failure._tag !== "ProjectSearchEntriesError"
        ) {
          assert.fail("Expected a ProjectSearchEntriesError");
        }
        const searchError = results.search.failure;
        assert.equal(
          searchError.message,
          `Failed to search workspace entries in '${invalidWorkspace}'.`,
        );
        assert.equal(searchError.cwd, invalidWorkspace);
        assert.equal(searchError.queryLength, sensitiveQuery.length);
        assert.notProperty(searchError, "query");
        assert.notInclude(searchError.message, "Bearer");
        assert.notInclude(searchError.message, "secret-token");
        assert.equal(searchError.limit, 10);
        assert.equal(searchError.failure, "workspace_root_not_found");
        assert.equal(searchError.normalizedCwd, invalidWorkspace);
        assert.isDefined(searchError.cause);

        if (
          results.list._tag !== "Failure" ||
          results.list.failure._tag !== "ProjectListEntriesError"
        ) {
          assert.fail("Expected a ProjectListEntriesError");
        }
        const listError = results.list.failure;
        assert.equal(
          listError.message,
          `Failed to list workspace entries in '${invalidWorkspace}'.`,
        );
        assert.equal(listError.cwd, invalidWorkspace);
        assert.equal(listError.failure, "workspace_root_not_found");
        assert.equal(listError.normalizedCwd, invalidWorkspace);
        assert.isDefined(listError.cause);

        if (
          results.directory._tag !== "Failure" ||
          results.directory.failure._tag !== "ProjectListDirectoryError"
        ) {
          assert.fail("Expected a ProjectListDirectoryError");
        }
        const directoryError = results.directory.failure;
        assert.equal(
          directoryError.message,
          `Failed to list workspace directory '' in '${invalidWorkspace}'.`,
        );
        assert.equal(directoryError.failure, "workspace_root_not_found");
        assert.equal(directoryError.resolvedPath, invalidWorkspace);
        assert.isDefined(directoryError.cause);

        if (
          results.read._tag !== "Failure" ||
          results.read.failure._tag !== "ProjectReadFileError"
        ) {
          assert.fail("Expected a ProjectReadFileError");
        }
        const readError = results.read.failure;
        assert.equal(
          readError.message,
          `Failed to read workspace file 'missing.txt' in '${workspaceDir}'.`,
        );
        assert.equal(readError.cwd, workspaceDir);
        assert.equal(readError.relativePath, "missing.txt");
        assert.equal(readError.failure, "operation_failed");
        assert.equal(readError.reason, "not_found");
        assert.equal(readError.currentMissing, true);
        assert.isDefined(readError.cause);

        if (
          results.danglingRead._tag !== "Failure" ||
          results.danglingRead.failure._tag !== "ProjectReadFileError"
        ) {
          assert.fail("Expected a typed dangling-referent read failure");
        }
        assert.equal(results.danglingRead.failure.cwd, workspaceDir);
        assert.equal(results.danglingRead.failure.relativePath, "dangling.txt");
        assert.equal(results.danglingRead.failure.reason, "not_found");
        assert.isUndefined(results.danglingRead.failure.currentMissing);

        if (
          results.missingRootRead._tag !== "Failure" ||
          results.missingRootRead.failure._tag !== "ProjectReadFileError"
        ) {
          assert.fail("Expected a typed missing-root read failure");
        }
        assert.equal(results.missingRootRead.failure.failure, "operation_failed");
        assert.equal(results.missingRootRead.failure.operation, "realpath-workspace-root");
        assert.equal(results.missingRootRead.failure.operationPath, invalidWorkspace);
        assert.equal(results.missingRootRead.failure.reason, "not_found");
        assert.equal(results.missingRootRead.failure.osErrorCode, "ENOENT");
        assert.isUndefined(results.missingRootRead.failure.currentMissing);
        assert.isDefined(results.missingRootRead.failure.cause);

        if (
          results.nonDirectoryRootRead._tag !== "Failure" ||
          results.nonDirectoryRootRead.failure._tag !== "ProjectReadFileError"
        ) {
          assert.fail("Expected a typed non-directory-root read failure");
        }
        assert.equal(results.nonDirectoryRootRead.failure.failure, "operation_failed");
        assert.equal(results.nonDirectoryRootRead.failure.operation, "stat");
        assert.equal(results.nonDirectoryRootRead.failure.operationPath, outsideFile);
        assert.equal(results.nonDirectoryRootRead.failure.osErrorCode, "ENOTDIR");
        assert.isUndefined(results.nonDirectoryRootRead.failure.currentMissing);
        assert.isDefined(results.nonDirectoryRootRead.failure.cause);

        // A symlink leading out of the project is viewable, never editable.
        if (results.linkedRead._tag !== "Success") {
          assert.fail("Expected the symlinked outside file to be readable");
        }
        assert.equal(results.linkedRead.success.relativePath, "linked-outside.txt");
        assert.equal(results.linkedRead.success.contents, "outside\n");
        assert.equal(results.linkedRead.success.readOnly, true);

        if (
          results.browse._tag !== "Failure" ||
          results.browse.failure._tag !== "FilesystemBrowseError"
        ) {
          assert.fail("Expected a FilesystemBrowseError");
        }
        const browseError = results.browse.failure;
        assert.equal(
          browseError.message,
          `Failed to browse filesystem path './missing-browse/child' from '${workspaceDir}'.`,
        );
        assert.equal(browseError.cwd, workspaceDir);
        assert.equal(browseError.partialPath, "./missing-browse/child");
        assert.equal(browseError.failure, "read_directory_failed");
        assert.equal(browseError.parentPath, missingBrowseParent);
        assert.isDefined(browseError.cause);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect.skipIf(!symlinksSupported)(
      "opens the file a chat link means over the wire, wherever it lives",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseDir = yield* fs.realPath(
            yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-file-links-" }),
          );
          const workspaceDir = path.join(baseDir, "workspace");
          const outsideDir = path.join(baseDir, "outside");
          yield* fs.makeDirectory(path.join(workspaceDir, "reports/2026"), { recursive: true });
          yield* fs.makeDirectory(path.join(workspaceDir, "data"), { recursive: true });
          yield* fs.makeDirectory(outsideDir, { recursive: true });
          yield* fs.writeFileString(path.join(workspaceDir, "reports/2026/summary.md"), "inside\n");
          yield* fs.writeFileString(path.join(outsideDir, "notes.md"), "outside\n");
          yield* fs.symlink(
            path.join(outsideDir, "notes.md"),
            path.join(workspaceDir, "data/shared-notes.md"),
          );

          yield* buildAppUnderTest();

          const wsUrl = yield* getWsServerUrl("/ws");
          const link = (linkPath: string) => ({
            workspaceRoot: EnvironmentFilePath.make(workspaceDir),
            path: EnvironmentFilePath.make(linkPath),
          });
          const results = yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              Effect.all({
                outside: client[WS_METHODS.filesystemResolveFileLink](link("../outside/notes.md")),
                wrongFolder: client[WS_METHODS.filesystemResolveFileLink](link("2026/summary.md")),
                symlinkOnly: client[WS_METHODS.filesystemResolveFileLink](link("shared-notes.md")),
                nothing: client[WS_METHODS.filesystemResolveFileLink](link("reports/none.md")),
                // The outside file reads the same through every spelling.
                readClimbing: client[WS_METHODS.projectsReadFile]({
                  cwd: workspaceDir,
                  relativePath: "../outside/notes.md",
                }),
                readSymlink: client[WS_METHODS.projectsReadFile]({
                  cwd: workspaceDir,
                  relativePath: "data/shared-notes.md",
                }),
                // Writing through the same spellings is still refused.
                writeClimbing: client[WS_METHODS.projectsWriteFile]({
                  cwd: workspaceDir,
                  relativePath: "../outside/notes.md",
                  contents: "overwritten\n",
                }).pipe(Effect.result),
                writeSymlink: client[WS_METHODS.projectsWriteFile]({
                  cwd: workspaceDir,
                  relativePath: "data/shared-notes.md",
                  contents: "overwritten\n",
                }).pipe(Effect.result),
              }),
            ),
          );

          const filePath = EnvironmentFilePath.make;
          assert.deepEqual(results.outside, {
            _tag: "literal",
            path: filePath(path.join(outsideDir, "notes.md")),
          });
          assert.deepEqual(results.wrongFolder, {
            _tag: "recovered",
            path: filePath("reports/2026/summary.md"),
            missingPath: filePath(path.join(workspaceDir, "2026/summary.md")),
          });
          assert.deepEqual(results.symlinkOnly, {
            _tag: "recovered",
            path: filePath("data/shared-notes.md"),
            missingPath: filePath(path.join(workspaceDir, "shared-notes.md")),
          });
          assert.equal(results.nothing._tag, "none");
          for (const read of [results.readClimbing, results.readSymlink]) {
            assert.equal(read.contents, "outside\n");
            assert.equal(read.readOnly, true);
          }
          assert.equal(results.readClimbing.revision, results.readSymlink.revision);
          assert.equal(results.writeClimbing._tag, "Failure");
          assert.equal(results.writeSymlink._tag, "Failure");
          assert.equal(yield* fs.readFileString(path.join(outsideDir, "notes.md")), "outside\n");
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    // chmod cannot deny the superuser, and Windows has no POSIX permission bits.
    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32" || process.getuid?.() === 0)(
      "reports an unreadable file as a permission failure",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspaceDir = yield* fs.makeTempDirectoryScoped({
            prefix: "t3-ws-workspace-denied-",
          });
          const lockedFile = path.join(workspaceDir, "locked.txt");
          yield* fs.writeFileString(lockedFile, "private\n");
          yield* fs.chmod(lockedFile, 0o000);

          yield* buildAppUnderTest();

          const wsUrl = yield* getWsServerUrl("/ws");
          const result = yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              client[WS_METHODS.projectsReadFile]({
                cwd: workspaceDir,
                relativePath: "locked.txt",
              }).pipe(Effect.result),
            ),
          );
          yield* fs.chmod(lockedFile, 0o600);

          if (result._tag !== "Failure" || result.failure._tag !== "ProjectReadFileError") {
            assert.fail("Expected a ProjectReadFileError");
          }
          assert.equal(result.failure.failure, "operation_failed");
          assert.equal(result.failure.reason, "permission_denied");
          assert.isUndefined(result.failure.currentMissing);
          // The system's own code travels too: a file mode refuses with EACCES,
          // which the client tells apart from the system itself declining.
          assert.equal(result.failure.osErrorCode, "EACCES");
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("reports workspace root stat failures without relabeling them as missing", () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;

        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const blockedRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-ws-workspace-stat-error-",
        });
        const workspaceRoot = path.join(blockedRoot, "workspace");
        yield* fs.makeDirectory(workspaceRoot);
        yield* fs.chmod(blockedRoot, 0o000);

        const result = yield* Effect.gen(function* () {
          yield* buildAppUnderTest();
          const wsUrl = yield* getWsServerUrl("/ws");
          return yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              client[WS_METHODS.projectsListEntries]({ cwd: workspaceRoot }).pipe(Effect.result),
            ),
          );
        }).pipe(Effect.ensuring(fs.chmod(blockedRoot, 0o700).pipe(Effect.ignore)));

        if (result._tag !== "Failure" || result.failure._tag !== "ProjectListEntriesError") {
          assert.fail("Expected a ProjectListEntriesError");
        }
        const error = result.failure;
        assert.equal(error.failure, "workspace_root_stat_failed");
        assert.equal(error.normalizedCwd, workspaceRoot);
        assert.equal(error.detail, "validate-existing");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "preserves websocket file mutation ownership, file history, and recovery refusal",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspaceDir = yield* fs.makeTempDirectoryScoped({
            prefix: "t3-ws-project-write-",
          });

          yield* buildAppUnderTest();

          const wsUrl = yield* getWsServerUrl("/ws");
          yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              Effect.gen(function* () {
                const input = {
                  cwd: workspaceDir,
                  relativePath: "nested/created.txt",
                  contents: "written-by-rpc",
                  createOnly: true as const,
                  mutationId: "rpc-create",
                };
                const created = yield* client[WS_METHODS.projectsWriteFile](input);
                assert.equal(created.mutationId, input.mutationId);
                assert.deepEqual(yield* client[WS_METHODS.projectsWriteFile](input), created);
                const conflict = yield* client[WS_METHODS.projectsWriteFile]({
                  ...input,
                  contents: "must-not-publish",
                }).pipe(Effect.flip);
                assert.equal(conflict._tag, "ProjectWriteFileError");
                if (conflict._tag !== "ProjectWriteFileError")
                  return assert.fail("Expected mutation intent failure");
                assert.equal(conflict.failure, "mutation_intent_conflict");
                assert.equal(conflict.mutationId, input.mutationId);
                assert.equal(
                  yield* fs.readFileString(path.join(workspaceDir, input.relativePath)),
                  input.contents,
                );

                const updated = yield* client[WS_METHODS.projectsWriteFile]({
                  cwd: input.cwd,
                  relativePath: input.relativePath,
                  contents: "updated-by-rpc",
                  expectedRevision: created.revision,
                  mutationId: "rpc-update",
                });
                const history = yield* client[WS_METHODS.projectsListFileVersions](input);
                const retained = history.versions.find(
                  (version) => version.revision === created.revision,
                );
                assert.isDefined(retained);
                if (!retained) return assert.fail("Expected the replaced revision in the history");
                assert.isNull(history.attention);
                const discarded = yield* client[WS_METHODS.projectsDiscardFileVersion]({
                  ...input,
                  versionId: retained.versionId,
                });
                assert.equal(discarded.versionId, retained.versionId);
                const afterDiscard = yield* client[WS_METHODS.projectsListFileVersions](input);
                assert.isFalse(
                  afterDiscard.versions.some((version) => version.versionId === retained.versionId),
                );
                assert.isNull(afterDiscard.attention);

                for (const currentRevision of [updated.revision, null]) {
                  const refused = yield* client[WS_METHODS.projectsResolveFileMutation]({
                    ...input,
                    recoveryId: "no-durable-attention",
                    currentRevision,
                    choice: "accept-current",
                  }).pipe(Effect.flip);
                  assert.equal(refused._tag, "ProjectWriteFileError");
                  if (refused._tag !== "ProjectWriteFileError")
                    return assert.fail("Expected typed recovery refusal");
                  // Without the native helper there are no older records to resolve at all.
                  assert.include(
                    ["mutation_intent_conflict", "mutation_unavailable"],
                    refused.failure,
                  );
                  assert.equal(refused.cwd, input.cwd);
                  assert.equal(refused.relativePath, input.relativePath);
                  assert.equal(refused.recoveryId, "no-durable-attention");
                  assert.isUndefined(refused.currentRevision);
                }
                assert.equal(
                  yield* fs.readFileString(path.join(workspaceDir, input.relativePath)),
                  "updated-by-rpc",
                );

                const renameInput = {
                  cwd: input.cwd,
                  relativePath: input.relativePath,
                  destinationRelativePath: "nested/renamed.txt",
                  expectedRevision: updated.revision,
                  mutationId: "rpc-rename",
                };
                const renamed = yield* client[WS_METHODS.projectsRenameFile](renameInput);
                assert.equal(renamed.mutationId, renameInput.mutationId);
                assert.deepEqual(
                  yield* client[WS_METHODS.projectsRenameFile](renameInput),
                  renamed,
                );
                assert.isFalse(yield* fs.exists(path.join(workspaceDir, input.relativePath)));
                const absentRefused = yield* client[WS_METHODS.projectsResolveFileMutation]({
                  cwd: input.cwd,
                  relativePath: input.relativePath,
                  recoveryId: "no-durable-attention",
                  currentRevision: null,
                  choice: "accept-current",
                }).pipe(Effect.flip);
                assert.equal(absentRefused._tag, "ProjectWriteFileError");
                if (absentRefused._tag !== "ProjectWriteFileError")
                  return assert.fail("Expected typed absent-path refusal");
                assert.include(
                  ["mutation_intent_conflict", "mutation_unavailable"],
                  absentRefused.failure,
                );
                assert.isUndefined(absentRefused.currentRevision);
                assert.isFalse(yield* fs.exists(path.join(workspaceDir, input.relativePath)));
                assert.equal(
                  yield* fs.readFileString(
                    path.join(workspaceDir, renameInput.destinationRelativePath),
                  ),
                  "updated-by-rpc",
                );
                const deleteInput = {
                  cwd: input.cwd,
                  relativePath: renameInput.destinationRelativePath,
                  expectedRevision: renamed.revision,
                  mutationId: "rpc-delete",
                };
                const deleted = yield* client[WS_METHODS.projectsDeleteFile](deleteInput);
                assert.equal(deleted.mutationId, deleteInput.mutationId);
                assert.deepEqual(
                  yield* client[WS_METHODS.projectsDeleteFile](deleteInput),
                  deleted,
                );
                assert.isFalse(yield* fs.exists(path.join(workspaceDir, deleteInput.relativePath)));
              }),
            ),
          );
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("rejects generic Files writes to owner-managed project paths", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceDir = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-ws-project-managed-write-",
        });
        const projectFile = path.join(workspaceDir, ".scient", "project.json");
        const aliasFile = path.join(workspaceDir, "managed-alias.json");
        const sourcesDirectory = path.join(workspaceDir, ".scient", "sources");
        const sourcesAlias = path.join(workspaceDir, "managed-directory-alias");
        yield* fs.makeDirectory(path.dirname(projectFile), { recursive: true });
        yield* fs.makeDirectory(sourcesDirectory, { recursive: true });
        yield* fs.writeFileString(projectFile, '{"id":"original"}\n');
        yield* fs.symlink(projectFile, aliasFile);
        yield* fs.symlink(sourcesDirectory, sourcesAlias);

        yield* buildAppUnderTest();

        const wsUrl = yield* getWsServerUrl("/ws");
        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.projectsWriteFile]({
              cwd: workspaceDir,
              relativePath: ".scient/project.json",
              contents: '{"id":"changed"}\n',
            }),
          ).pipe(Effect.result),
        );

        if (result._tag !== "Failure" || result.failure._tag !== "ProjectWriteFileError") {
          assert.fail("Expected a ProjectWriteFileError");
        }
        assert.equal(result.failure.failure, "read_only_in_files");
        assert.equal(
          result.failure.message,
          "Workspace file '.scient/project.json' is read-only in Files.",
        );
        assert.equal(yield* fs.readFileString(projectFile), '{"id":"original"}\n');

        const aliasRead = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: "managed-alias.json",
            }),
          ),
        );
        const aliasWrite = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.projectsWriteFile]({
              cwd: workspaceDir,
              relativePath: "managed-alias.json",
              contents: '{"id":"changed-through-alias"}\n',
              expectedRevision: aliasRead.revision,
            }),
          ).pipe(Effect.result),
        );
        if (aliasWrite._tag !== "Failure" || aliasWrite.failure._tag !== "ProjectWriteFileError") {
          assert.fail("Expected a ProjectWriteFileError for a symlink path");
        }
        assert.equal(aliasWrite.failure.failure, "read_only_in_files");
        assert.equal(yield* fs.readFileString(projectFile), '{"id":"original"}\n');

        const aliasCreate = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.projectsWriteFile]({
              cwd: workspaceDir,
              relativePath: "managed-directory-alias/created.json",
              contents: "{}\n",
            }),
          ).pipe(Effect.result),
        );
        if (
          aliasCreate._tag !== "Failure" ||
          aliasCreate.failure._tag !== "ProjectWriteFileError"
        ) {
          assert.fail("Expected a ProjectWriteFileError for a symlinked directory");
        }
        assert.equal(aliasCreate.failure.failure, "read_only_in_files");
        assert.isTrue(
          Option.isNone(
            yield* fs.stat(path.join(sourcesDirectory, "created.json")).pipe(Effect.option),
          ),
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("streams selected workspace file changes over websocket rpc", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-ws-project-watch-",
        });
        const sourcePath = path.join(workspaceDir, "analysis.m");
        yield* fs.writeFileString(sourcePath, "answer = 1;\n");

        yield* buildAppUnderTest();
        const wsUrl = yield* getWsServerUrl("/ws");
        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const event = yield* client[WS_METHODS.projectsSubscribeFileChanges]({
                cwd: workspaceDir,
                relativePath: "analysis.m",
              }).pipe(
                Stream.tap((event) =>
                  event._tag === "watch-ready"
                    ? fs.writeFileString(sourcePath, "answer = 2;\n")
                    : Effect.void,
                ),
                Stream.filter((event) => event._tag === "file-changed"),
                Stream.runHead,
              );
              const refreshed = yield* client[WS_METHODS.projectsReadFile]({
                cwd: workspaceDir,
                relativePath: "analysis.m",
              });
              return { event, refreshed };
            }),
          ),
        );

        assert.deepEqual(
          result.event,
          Option.some({ _tag: "file-changed", relativePath: "analysis.m" }),
        );
        assert.equal(result.refreshed.contents, "answer = 2;\n");
        assert.match(result.refreshed.revision, /^sha256:[0-9a-f]{64}$/u);
      }).pipe(Effect.provide(NodeHttpServerTest), TestClock.withLive),
    );

    const scientRpcHarness = {
      buildAppUnderTest,
      exchangeAccessToken,
      fetchEffect,
      getHttpServerUrl,
      getWsServerUrl,
      withWsRpcClient,
    };
    registerAnalysisRpcTests(it, scientRpcHarness);
    registerComputeRpcTests(it, scientRpcHarness);
    registerMarkdownTransportTests(it, scientRpcHarness);

    it.effect("creates a missing workspace root during native websocket project mutation", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-create-" });
        const missingWorkspaceRoot = path.join(parentDir, "nested", "new-project");

        yield* buildAppUnderTest();

        const wsUrl = yield* getWsServerUrl("/ws");
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.projectsMutate]({
              type: "project.create",
              commandId: CommandId.make("cmd-project-create-missing-root"),
              projectId: ProjectId.make("project-create-missing-root"),
              title: "New Project",
              workspaceRoot: missingWorkspaceRoot,
              createWorkspaceRootIfMissing: true,
              defaultModelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5-codex",
              },
            }),
          ),
        );
        const stat = yield* fs.stat(missingWorkspaceRoot);

        assert.equal(response.id, ProjectId.make("project-create-missing-root"));
        assert.equal(stat.type, "Directory");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("answers a fork's readiness only after its provisioning completes", () =>
      Effect.gen(function* () {
        const provisioningStarted = yield* Deferred.make<void>();
        const allowProvisioningToComplete = yield* Deferred.make<void>();
        const rpcCompleted = yield* Deferred.make<void>();
        const forkThreadId = ThreadId.make("thread-fork-ready-gate");

        yield* buildAppUnderTest({
          layers: {
            conversationFork: {
              awaitReady: (threadId) =>
                Effect.gen(function* () {
                  assert.equal(threadId, forkThreadId);
                  yield* Deferred.succeed(provisioningStarted, undefined);
                  yield* Deferred.await(allowProvisioningToComplete);
                  return { forkAttachmentIdMap: { "origin-file": "fork-file" } };
                }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const rpcFiber = yield* client[ORCHESTRATION_WS_METHODS.awaitFork]({
                threadId: forkThreadId,
              }).pipe(
                Effect.tap(() => Deferred.succeed(rpcCompleted, undefined)),
                Effect.forkChild,
              );

              yield* Deferred.await(provisioningStarted);
              assert.isTrue(Option.isNone(yield* Deferred.poll(rpcCompleted)));
              yield* Deferred.succeed(allowProvisioningToComplete, undefined);
              return yield* Fiber.join(rpcFiber);
            }),
          ),
        );

        assert.deepEqual(response.forkAttachmentIdMap, { "origin-file": "fork-file" });
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("returns a fork's provisioning failure to the caller", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          layers: {
            conversationFork: {
              awaitReady: () =>
                Effect.fail(
                  new OrchestrationDispatchCommandError({
                    message: "Fork workspace provisioning failed.",
                    forkDisposition: "failed",
                  }),
                ),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.awaitFork]({
              threadId: ThreadId.make("thread-fork-failed-gate"),
            }),
          ).pipe(Effect.result),
        );

        assertTrue(result._tag === "Failure");
        assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
        assert.include(result.failure.message, "Fork workspace provisioning failed.");
        assert.equal(result.failure.forkDisposition, "failed");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("rejects an unavailable running fork boundary before creating the fork", () =>
      Effect.gen(function* () {
        const forkThreadId = ThreadId.make("thread-fork-capture-failure");
        const originThreadId = ThreadId.make("thread-fork-capture-origin");
        const app = yield* buildAppUnderTest();
        yield* seedV2StreamThread(app, originThreadId);
        const before = yield* app.v2.eventSink.latestSequence();
        const result = yield* Effect.scoped(
          withWsRpcClient(yield* getWsServerUrl("/ws"), (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.fork",
              commandId: CommandId.make("cmd-thread-fork-capture-failure"),
              sourceThreadId: originThreadId,
              targetThreadId: forkThreadId,
              sourcePoint: { type: "latest_stable" },
              createdBy: "user",
              creationSource: "web",
              scient: {
                boundary: { kind: "running-turn", runId: RunId.make("running-capture") },
                workspaceMode: "local",
              },
            }),
          ).pipe(Effect.result),
        );
        assertTrue(result._tag === "Failure");
        assertTrue(result.failure._tag === "OrchestrationV2DispatchCommandError");
        assert.include(result.failure.message, "selected run is unavailable");
        assert.equal(result.failure.commandDisposition, "rejected");
        assert.equal(yield* app.v2.eventSink.latestSequence(), before);
        assert.isNull(yield* app.v2.threads.getThreadShell(forkThreadId));
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("returns authoritative fork options over the read-authorized RPC", () =>
      Effect.gen(function* () {
        const originThreadId = ThreadId.make("fork-options-origin");
        const sourceAssistantMessageId = MessageId.make("fork-options-answer");
        yield* buildAppUnderTest({
          layers: {
            conversationFork: {
              getOptions: (input) => {
                assert.equal(input.originThreadId, originThreadId);
                assert.isUndefined(input.sourceAssistantMessageId);
                return Effect.succeed({
                  available: true,
                  localAvailable: true,
                  reason: null,
                  newWorktree: false,
                  sourceAssistantMessageId,
                  sourceUserMessageId: null,
                });
              },
            },
          },
        });
        const wsUrl = yield* getWsServerUrl("/ws");
        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.getForkOptions]({ originThreadId }),
          ),
        );
        assert.equal(result.sourceAssistantMessageId, sourceAssistantMessageId);
        assert.isTrue(result.localAvailable);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("starts a project clone in the background and blocks threads until it lands", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-clone-" });
        const destinationPath = path.join(parentDir, "t3code");
        const projectId = ProjectId.make("project-clone-1");
        const cloneGate = yield* Deferred.make<void>();

        const app = yield* buildAppUnderTest({
          layers: {
            sourceControlRepositoryService: {
              prepareClone: (input) =>
                Effect.succeed({
                  destinationPath: input.destinationPath,
                  remoteUrl: input.remoteUrl ?? "",
                  cloneUrl: input.remoteUrl ?? "",
                  repository: null,
                }),
              cloneRepository: (input) =>
                Deferred.await(cloneGate).pipe(
                  Effect.as({
                    cwd: input.destinationPath,
                    remoteUrl: input.remoteUrl ?? "",
                    repository: null,
                  }),
                ),
            },
          },
        });

        const projectEvents = yield* app.v2.events
          .streamApplicationEvents({ afterSequence: 0 })
          .pipe(
            Stream.filter((event) => !("event" in event) && event.aggregateId === projectId),
            Stream.takeUntil(
              (event) =>
                !("event" in event) &&
                event.type === "project.meta-updated" &&
                event.commandId === CommandId.make(`project-clone-done:${projectId}`),
            ),
            Stream.runCollect,
            Effect.forkScoped,
          );
        const wsUrl = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const started = yield* client[WS_METHODS.projectCloneStart]({
                projectId,
                title: "t3code",
                createdAt: "2026-01-01T00:00:00.000Z",
                remoteUrl: "git@github.com:octocat/t3code.git",
                destinationPath,
              });
              assert.equal(started.cwd, destinationPath);
              const registered = yield* app.v2.projects.getById(projectId);
              assertTrue(Option.isSome(registered));
              assert.equal(registered.value.workspaceRoot, destinationPath);
              const creation = yield* app.v2.events
                .readApplicationEvents({
                  afterSequence: 0,
                  throughSequence: yield* app.v2.events.latestApplicationSequence,
                })
                .pipe(Stream.runCollect);
              assert.deepEqual(
                creation.flatMap((event) => ("event" in event ? [] : [event.type])),
                ["project.created"],
              );

              const blocked = yield* Effect.flip(
                client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                  type: "thread.create",
                  commandId: CommandId.make("cmd-thread-create-while-cloning"),
                  threadId: ThreadId.make("thread-while-cloning"),
                  projectId,
                  title: "Draft",
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: "gpt-5-codex",
                  },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  createdBy: "user",
                  creationSource: "web",
                }),
              );
              assert.include(String(blocked.message), "still being cloned");

              const snapshots = yield* client[WS_METHODS.subscribeProjectClones]({}).pipe(
                Stream.takeUntil((clones) => clones[0]?.phase === "done"),
                Stream.runCollect,
                Effect.forkChild,
              );
              yield* Effect.yieldNow;
              yield* Deferred.succeed(cloneGate, undefined);
              const lists = yield* Fiber.join(snapshots);
              assert.equal(lists.at(-1)?.[0]?.phase, "done");
              const committed = yield* Fiber.join(projectEvents);
              assert.deepEqual(
                committed.flatMap((event) => ("event" in event ? [] : [event.type])),
                ["project.created", "project.meta-updated"],
              );
              assert.isNull(
                yield* app.v2.threads.getThreadShell(ThreadId.make("thread-while-cloning")),
              );
            }),
          ),
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "legacy queue HTTP preserves clone rejection prose and held work until completion",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const parentDir = yield* fs.makeTempDirectoryScoped({
            prefix: "scient-queue-clone-http-",
          });
          const destinationPath = path.join(parentDir, "checkout");
          const projectId = ProjectId.make("queue-http-clone-project");
          const threadId = ThreadId.make("queue-http-clone-thread");
          const cloneGate = yield* Deferred.make<void>();
          const app = yield* buildAppUnderTest({
            layers: {
              providerInstanceRegistry: {
                getInstance: (id) =>
                  Effect.succeed(
                    id === defaultModelSelection.instanceId ? nativeAdmissionInstance : undefined,
                  ),
                listInstances: Effect.succeed([nativeAdmissionInstance]),
              },
              sourceControlRepositoryService: {
                prepareClone: (input) =>
                  Effect.succeed({
                    destinationPath: input.destinationPath,
                    remoteUrl: input.remoteUrl ?? "",
                    cloneUrl: input.remoteUrl ?? "",
                    repository: null,
                  }),
                cloneRepository: (input) =>
                  Deferred.await(cloneGate).pipe(
                    Effect.as({
                      cwd: input.destinationPath,
                      remoteUrl: input.remoteUrl ?? "",
                      repository: null,
                    }),
                  ),
              },
            },
          });
          yield* app.v2.orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("queue-http-clone-create"),
            threadId,
            projectId,
            title: "Held draft",
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: destinationPath,
            createdBy: "user",
            creationSource: "web",
          });
          const wsUrl = yield* getWsServerUrl("/ws");
          yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              Effect.gen(function* () {
                yield* client[WS_METHODS.projectCloneStart]({
                  projectId,
                  title: "Clone queue",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  remoteUrl: "https://example.invalid/clone-queue.git",
                  destinationPath,
                });
                const cookie = yield* getAuthenticatedSessionCookieHeader();
                const headers = { cookie, "content-type": "application/json" };
                const queueItemId = "qitem_httpclone";
                yield* app.v2.orchestrator.dispatch({
                  type: "legacy-queue.import",
                  commandId: CommandId.make("queue-http-clone-held"),
                  threadId,
                  queueItemId,
                  messageId: MessageId.make("queue-http-clone-held-message"),
                  text: "Keep the captured skills",
                  attachments: [],
                  selectedScientSkillNames: ["analysis"],
                  modelSelection: defaultModelSelection,
                  createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                });
                const listResponse = yield* fetchEffect(
                  yield* getHttpServerUrl("/api/scient/thread-queue/v2/list"),
                  { method: "POST", headers, body: jsonRequestBody({ threadId }) },
                );
                assert.equal(listResponse.status, 200);
                const admitted = yield* decodeQueueSnapshot(
                  yield* responseJsonEffect<unknown>(listResponse),
                );
                assert.equal(admitted.items.length, 1);
                assert.deepEqual(admitted.items[0]?.selectedScientSkillNames, ["analysis"]);
                const before = yield* app.v2.orchestrator.getThreadProjection(threadId);
                assert.equal(before.runs[0]?.queueHeld, true);
                const effectsBefore = yield* app.v2.sql`SELECT effect_id, effect_type, payload_json
              FROM orchestration_v2_effect_outbox ORDER BY effect_id`;
                const controlUrl = yield* getHttpServerUrl("/api/scient/thread-queue/v2/control");
                const control = {
                  method: "POST",
                  headers,
                  body: jsonRequestBody({ threadId, action: "send", queueItemId }),
                };
                const blockedResponse = yield* fetchEffect(controlUrl, control);
                assert.equal(blockedResponse.status, 409);
                const blocked = yield* decodeQueueOperationError(
                  yield* responseJsonEffect<unknown>(blockedResponse),
                );
                assert.equal(blocked.message, "The repository is still being cloned.");
                assert.deepEqual(yield* app.v2.orchestrator.getThreadProjection(threadId), before);
                assert.deepEqual(
                  yield* app.v2.sql`SELECT effect_id, effect_type, payload_json
                FROM orchestration_v2_effect_outbox ORDER BY effect_id`,
                  effectsBefore,
                );
                const finished = yield* client[WS_METHODS.subscribeProjectClones]({}).pipe(
                  Stream.filter((clones) =>
                    clones.some((clone) => clone.projectId === projectId && clone.phase === "done"),
                  ),
                  Stream.take(1),
                  Stream.runDrain,
                  Effect.forkChild,
                );
                yield* Deferred.succeed(cloneGate, undefined);
                yield* Fiber.join(finished);
                const sentResponse = yield* fetchEffect(controlUrl, control);
                assert.equal(sentResponse.status, 200);
                const sent = yield* decodeQueueSnapshot(
                  yield* responseJsonEffect<unknown>(sentResponse),
                );
                assert.equal(sent.items.length, 0);
                const after = yield* app.v2.orchestrator.getThreadProjection(threadId);
                assert.equal(after.runs[0]?.queueHeld, false);
                assert.equal(after.runs[0]?.status, "starting");
                assert.deepEqual(after.messages[0]?.selectedScientSkillNames, ["analysis"]);
                assert.equal(
                  (yield* app.v2.sql<{ count: number }>`SELECT COUNT(*) AS count
              FROM orchestration_v2_effect_outbox WHERE effect_type = 'provider-turn.start'`)[0]
                    ?.count,
                  1,
                );
              }),
            ),
          );
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("finds a cloned project's icon once the clone lands", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-clone-favicon-" });
        const destinationPath = path.join(parentDir, "app");
        const projectId = ProjectId.make("project-clone-favicon");
        const cloneGate = yield* Deferred.make<void>();

        const app = yield* buildAppUnderTest({
          layers: {
            sourceControlRepositoryService: {
              prepareClone: (input) =>
                Effect.succeed({
                  destinationPath: input.destinationPath,
                  remoteUrl: input.remoteUrl ?? "",
                  cloneUrl: input.remoteUrl ?? "",
                  repository: null,
                }),
              cloneRepository: (input) =>
                Deferred.await(cloneGate).pipe(
                  Effect.andThen(
                    fs.writeFileString(path.join(input.destinationPath, "favicon.svg"), "<svg/>"),
                  ),
                  Effect.orDie,
                  Effect.as({
                    cwd: input.destinationPath,
                    remoteUrl: input.remoteUrl ?? "",
                    repository: null,
                  }),
                ),
            },
          },
        });

        const metadataCommitted = yield* app.v2.events
          .streamApplicationEvents({ afterSequence: 0 })
          .pipe(
            Stream.filter(
              (event) =>
                !("event" in event) &&
                event.aggregateId === projectId &&
                event.type === "project.meta-updated" &&
                event.commandId === CommandId.make(`project-clone-done:${projectId}`),
            ),
            Stream.runHead,
            Effect.forkScoped,
          );
        const wsUrl = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              yield* client[WS_METHODS.projectCloneStart]({
                projectId,
                title: "app",
                createdAt: "2026-01-01T00:00:00.000Z",
                remoteUrl: "git@github.com:octocat/app.git",
                destinationPath,
              });
              const resource = { _tag: "project-favicon" as const, cwd: destinationPath };
              const duringClone = yield* client[WS_METHODS.assetsCreateUrl]({ resource });
              assert.isTrue(duringClone.relativeUrl.endsWith("/project-favicon-missing"));

              yield* Deferred.succeed(cloneGate, undefined);
              assert.isTrue(Option.isSome(yield* Fiber.join(metadataCommitted)));
              assert.equal(
                yield* fs.readFileString(path.join(destinationPath, "favicon.svg")),
                "<svg/>",
              );
              // The lookup during the clone must not leave a cached miss behind.
              const afterClone = yield* client[WS_METHODS.assetsCreateUrl]({ resource });
              assert.equal(afterClone.sourcePath, "favicon.svg");
            }),
          ),
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("records thread analytics only after a client command succeeds", () =>
      Effect.gen(function* () {
        const effects: string[] = [];
        const analyticsProperties: Array<Readonly<Record<string, unknown>> | undefined> = [];
        const failedCommandId = CommandId.make("cmd-thread-create-failed");

        const app = yield* buildAppUnderTest({
          transformThreadLaunchV2: (service) => ({
            ...service,
            launch: (input) =>
              Effect.sync(() => effects.push(`launch:${input.commandId}`)).pipe(
                Effect.andThen(
                  input.commandId === failedCommandId
                    ? Effect.fail(
                        new ThreadLaunchV2.ThreadLaunchError({
                          commandId: input.commandId,
                          projectId: input.projectId,
                          threadId: input.threadId,
                          operation: "create-thread",
                          cause: "Injected thread creation failure",
                        }),
                      )
                    : service.launch(input),
                ),
              ),
          }),
          layers: {
            analyticsService: {
              record: (event, properties) =>
                Effect.sync(() => {
                  effects.push(`analytics:${event}`);
                  analyticsProperties.push(properties);
                }),
            },
          },
        });

        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-analytics-project-" });
        yield* app.v2.projects.create({
          commandId: CommandId.make("analytics-project"),
          projectId: defaultProjectId,
          title: "Analytics project",
          workspaceRoot: cwd,
        });
        const createThreadCommand = (commandId: CommandId, threadId: ThreadId) =>
          ({
            commandId,
            threadId,
            projectId: defaultProjectId,
            title: "Analytics test",
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
          }) as const;

        const wsUrl = yield* getWsServerUrl(
          "/ws?clientSurface=mobile&clientAppVersion=1.2.3&clientDeviceType=phone&clientOs=iOS&clientOsMajorVersion=18&clientDeviceModel=iPhone+15+Pro&connectionMethod=relay",
        );
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const failed = yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread](
                createThreadCommand(failedCommandId, ThreadId.make("thread-create-failed")),
              ).pipe(Effect.result);

              assert.equal(failed._tag, "Failure");
              assert.deepEqual(effects, ["launch:cmd-thread-create-failed"]);

              const succeeded = yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread](
                createThreadCommand(
                  CommandId.make("cmd-thread-create-succeeded"),
                  ThreadId.make("thread-create-succeeded"),
                ),
              );

              assert.equal(succeeded.threadId, ThreadId.make("thread-create-succeeded"));
              assert.isNull(
                yield* app.v2.threads.getThreadShell(ThreadId.make("thread-create-failed")),
              );
            }),
          ),
        );

        assert.deepEqual(effects, [
          "launch:cmd-thread-create-failed",
          "launch:cmd-thread-create-succeeded",
          "analytics:client.thread.started",
        ]);
        assert.deepEqual(analyticsProperties, [
          {
            surface: "mobile",
            appVersion: "1.2.3",
            clientAppVersion: "1.2.3",
            clientOs: "iOS",
            os: "iOS",
            clientDeviceType: "phone",
            osMajorVersion: 18,
            clientOsMajorVersion: 18,
            deviceModel: "iPhone 15 Pro",
            clientDeviceModel: "iPhone 15 Pro",
            connectionMethod: "relay",
            workspaceStrategy: "root",
          },
        ]);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("keeps telemetry separate for simultaneous clients", () =>
      Effect.gen(function* () {
        const analyticsEvents: Array<{
          event: string;
          properties: Readonly<Record<string, unknown>> | undefined;
        }> = [];

        const app = yield* buildAppUnderTest({
          layers: {
            providerInstanceRegistry: {
              getInstance: () => Effect.succeed(nativeAdmissionInstance),
            },
            analyticsService: {
              record: (event, properties) =>
                Effect.sync(() => analyticsEvents.push({ event, properties })),
            },
          },
        });

        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-client-telemetry-" });
        yield* app.v2.projects.create({
          commandId: CommandId.make("telemetry-project"),
          projectId: ProjectId.make("transfer-project"),
          title: "Telemetry project",
          workspaceRoot: cwd,
        });
        for (const actor of ["web", "mobile"])
          yield* seedV2StreamThread(app, ThreadId.make(`thread-${actor}`));
        const webUrl = yield* getWsServerUrl(
          "/ws?clientSurface=web&clientAppVersion=2.0.0&clientDeviceType=desktop&clientOs=Windows&clientWebDeployment=hosted&clientBrowser=Chrome&connectionMethod=direct",
        );
        const mobileUrl = yield* getWsServerUrl(
          "/ws?clientSurface=mobile&clientAppVersion=3.0.0&clientDeviceType=tablet&clientOs=Android&clientOsMajorVersion=15&clientDeviceModel=Pixel+Tablet&connectionMethod=relay",
        );
        const turnCommand = (actor: string) => ({
          type: "message.dispatch" as const,
          commandId: CommandId.make(`cmd-${actor}-turn`),
          threadId: ThreadId.make(`thread-${actor}`),
          messageId: MessageId.make(`message-${actor}`),
          text: "hello",
          attachments: [],
          modelSelection: defaultModelSelection,
          createdBy: "user" as const,
          creationSource: "web" as const,
          dispatchMode: { type: "start_immediately" as const },
        });

        yield* Effect.scoped(
          withWsRpcClient(webUrl, (webClient) =>
            withWsRpcClient(mobileUrl, (mobileClient) =>
              Effect.gen(function* () {
                yield* mobileClient[ORCHESTRATION_WS_METHODS.dispatchCommand](
                  turnCommand("mobile"),
                );
                yield* webClient[ORCHESTRATION_WS_METHODS.dispatchCommand](turnCommand("web"));
              }),
            ),
          ),
        );

        // SCIENT-FORK:START — each sent message also carries its length and frustration signals.
        const messageSignals = {
          messageChars: 5,
          messageWords: 1,
          yelling: 0,
          profanity: 0,
          anguish: 0,
          negation: 0,
          repetition: 0,
          blame: 0,
        };
        // SCIENT-FORK:END
        assert.deepEqual(
          analyticsEvents
            .filter(({ event }) => event === "client.turn.requested")
            .map(({ properties }) => properties),
          [
            {
              ...messageSignals,
              surface: "mobile",
              appVersion: "3.0.0",
              clientAppVersion: "3.0.0",
              clientOs: "Android",
              os: "Android",
              clientDeviceType: "tablet",
              osMajorVersion: 15,
              clientOsMajorVersion: 15,
              deviceModel: "Pixel Tablet",
              clientDeviceModel: "Pixel Tablet",
              connectionMethod: "relay",
            },
            {
              ...messageSignals,
              surface: "web",
              appVersion: "2.0.0",
              clientAppVersion: "2.0.0",
              clientOs: "Windows",
              clientDeviceType: "desktop",
              webDeployment: "hosted",
              clientBrowser: "Chrome",
              connectionMethod: "direct",
            },
          ],
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("ignores invalid client telemetry without rejecting the connection", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const invalidUrl = yield* getWsServerUrl(
          "/ws?clientSurface=watch&clientDeviceType=television&clientOs=Plan9&clientWebDeployment=cdn&clientBrowser=&clientOsMajorVersion=-1&connectionMethod=teleport",
        );
        yield* Effect.scoped(
          withWsRpcClient(invalidUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("routes websocket rpc projects.writeFile errors", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-write-" });

        yield* buildAppUnderTest();

        const wsUrl = yield* getWsServerUrl("/ws");
        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.projectsWriteFile]({
              cwd: workspaceDir,
              relativePath: "../escape.txt",
              contents: "nope",
              mutationId: "rpc-refused-write",
            }),
          ).pipe(Effect.result),
        );

        if (result._tag !== "Failure" || result.failure._tag !== "ProjectWriteFileError") {
          assert.fail("Expected a ProjectWriteFileError");
        }
        const writeError = result.failure;
        assert.equal(
          writeError.message,
          `Failed to write workspace file '../escape.txt' in '${workspaceDir}'.`,
        );
        assert.equal(writeError.cwd, workspaceDir);
        assert.equal(writeError.relativePath, "../escape.txt");
        assert.equal(writeError.failure, "workspace_path_outside_root");
        assert.equal(writeError.mutationId, "rpc-refused-write");
        assert.isUndefined(writeError.publicationOutcome);
        assert.isDefined(writeError.cause);
        assert.notProperty(writeError, "contents");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("routes file preparation and exact asset transport end to end", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-ws-file-open-" });
        const filePath = path.join(root, "outside-workspace.tsx");
        const contents = "export const Result = () => <strong>42</strong>;\n";
        yield* fileSystem.writeFileString(filePath, contents);
        yield* buildAppUnderTest();

        const wsUrl = yield* getWsServerUrl("/ws");
        const { prepared, issued } = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const prepared = yield* client[WS_METHODS.filesystemPrepareFileOpen]({
                path: EnvironmentFilePath.make(filePath),
              });
              const issued = yield* client[WS_METHODS.assetsCreateUrl]({
                resource: {
                  _tag: "environment-file",
                  path: prepared.canonicalPath,
                  access: "exact",
                },
              });
              return { prepared, issued };
            }),
          ),
        );
        assert.equal(prepared.canonicalPath, yield* fileSystem.realPath(filePath));
        assert.equal(prepared.presentation.kind, "text");
        assert.equal(prepared.byteLength, new TextEncoder().encode(contents).byteLength);

        const response = yield* HttpClient.get(issued.relativeUrl);
        assert.equal(response.status, 200);
        assert.equal(yield* response.text, contents);
      }).pipe(Effect.provide(NodeHttpServerTest), Effect.scoped),
    );

    it.effect("routes websocket rpc git.pull errors", () =>
      Effect.gen(function* () {
        const gitError = new GitCommandError({
          operation: "pull",
          command: "git pull --ff-only",
          cwd: "/tmp/repo",
          detail: "upstream missing",
        });
        let invalidationCalls = 0;
        let statusCalls = 0;
        yield* buildAppUnderTest({
          layers: {
            gitVcsDriver: {
              pullCurrentBranch: () => Effect.fail(gitError),
            },
            gitManager: {
              invalidateLocalStatus: () =>
                Effect.sync(() => {
                  invalidationCalls += 1;
                }),
              invalidateRemoteStatus: () =>
                Effect.sync(() => {
                  invalidationCalls += 1;
                }),
              invalidateStatus: () =>
                Effect.sync(() => {
                  invalidationCalls += 1;
                }),
              localStatus: () =>
                Effect.succeed({
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: true,
                  refName: "main",
                  hasWorkingTreeChanges: true,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                }),
              remoteStatus: () =>
                Effect.sync(() => {
                  statusCalls += 1;
                  return {
                    hasUpstream: true,
                    aheadCount: 0,
                    behindCount: 0,
                    pr: null,
                  };
                }),
              status: () =>
                Effect.sync(() => {
                  statusCalls += 1;
                  return {
                    isRepo: true,
                    hasPrimaryRemote: true,
                    isDefaultRef: true,
                    refName: "main",
                    hasWorkingTreeChanges: true,
                    workingTree: { files: [], insertions: 0, deletions: 0 },
                    hasUpstream: true,
                    aheadCount: 0,
                    behindCount: 0,
                    pr: null,
                  };
                }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: "/tmp/repo" })).pipe(
            Effect.result,
          ),
        );

        assertFailure(result, gitError);
        assert.equal(invalidationCalls, 0);
        assert.equal(statusCalls, 0);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("routes websocket rpc git.runStackedAction errors after refreshing git status", () =>
      Effect.gen(function* () {
        const gitError = new GitCommandError({
          operation: "commit",
          command: "git commit",
          cwd: "/tmp/repo",
          detail: "nothing to commit",
        });
        let invalidationCalls = 0;
        let statusCalls = 0;
        yield* buildAppUnderTest({
          layers: {
            gitManager: {
              invalidateLocalStatus: () =>
                Effect.sync(() => {
                  invalidationCalls += 1;
                }),
              invalidateRemoteStatus: () =>
                Effect.sync(() => {
                  invalidationCalls += 1;
                }),
              invalidateStatus: () =>
                Effect.sync(() => {
                  invalidationCalls += 1;
                }),
              localStatus: () =>
                Effect.succeed({
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: false,
                  refName: "feature/demo",
                  hasWorkingTreeChanges: true,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                }),
              remoteStatus: () =>
                Effect.sync(() => {
                  statusCalls += 1;
                  return {
                    hasUpstream: true,
                    aheadCount: 0,
                    behindCount: 0,
                    pr: null,
                  };
                }),
              status: () =>
                Effect.sync(() => {
                  statusCalls += 1;
                  return {
                    isRepo: true,
                    hasPrimaryRemote: true,
                    isDefaultRef: false,
                    refName: "feature/demo",
                    hasWorkingTreeChanges: true,
                    workingTree: { files: [], insertions: 0, deletions: 0 },
                    hasUpstream: true,
                    aheadCount: 0,
                    behindCount: 0,
                    pr: null,
                  };
                }),
              runStackedAction: () => Effect.fail(gitError),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.gitRunStackedAction]({
              actionId: "action-1",
              cwd: "/tmp/repo",
              action: "commit",
            }).pipe(Stream.runCollect, Effect.result),
          ),
        );

        assertFailure(result, gitError);
        assert.equal(invalidationCalls, 0);
        assert.equal(statusCalls, 0);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "completes websocket rpc git.pull before background git status refresh finishes",
      () =>
        Effect.gen(function* () {
          yield* buildAppUnderTest({
            layers: {
              gitVcsDriver: {
                pullCurrentBranch: () =>
                  Effect.succeed({
                    status: "pulled" as const,
                    refName: "main",
                    upstreamRef: "origin/main",
                  }),
              },
              gitManager: {
                invalidateLocalStatus: () => Effect.void,
                invalidateRemoteStatus: () => Effect.void,
                invalidateStatus: () => Effect.void,
                localStatus: () =>
                  Effect.succeed({
                    isRepo: true,
                    hasPrimaryRemote: true,
                    isDefaultRef: true,
                    refName: "main",
                    hasWorkingTreeChanges: false,
                    workingTree: { files: [], insertions: 0, deletions: 0 },
                  }),
                // Still refreshing when the RPC answers: nothing may wait for it.
                remoteStatus: () => Effect.never,
              },
            },
          });

          const wsUrl = yield* getWsServerUrl("/ws");
          const startedAt = yield* Clock.currentTimeMillis;
          const result = yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: "/tmp/repo" })),
          );
          const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;

          assert.equal(result.status, "pulled");
          assertTrue(elapsedMs < 1_000);
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "completes websocket rpc git.runStackedAction before background git status refresh finishes",
      () =>
        Effect.gen(function* () {
          yield* buildAppUnderTest({
            layers: {
              vcsDriver: {
                isInsideWorkTree: () => Effect.succeed(true),
              },
              gitManager: {
                invalidateLocalStatus: () => Effect.void,
                invalidateRemoteStatus: () => Effect.void,
                invalidateStatus: () => Effect.void,
                localStatus: () =>
                  Effect.succeed({
                    isRepo: true,
                    hasPrimaryRemote: true,
                    isDefaultRef: false,
                    refName: "feature/demo",
                    hasWorkingTreeChanges: false,
                    workingTree: { files: [], insertions: 0, deletions: 0 },
                  }),
                // Still refreshing when the RPC answers: nothing may wait for it.
                remoteStatus: () => Effect.never,
                runStackedAction: () =>
                  Effect.succeed({
                    action: "commit" as const,
                    branch: { status: "skipped_not_requested" as const },
                    commit: {
                      status: "created" as const,
                      commitSha: "abc123",
                      subject: "feat: demo",
                    },
                    push: { status: "skipped_not_requested" as const },
                    pr: { status: "skipped_not_requested" as const },
                    toast: {
                      title: "Committed abc123",
                      description: "feat: demo",
                      cta: {
                        kind: "run_action" as const,
                        label: "Push",
                        action: {
                          kind: "push" as const,
                        },
                      },
                    },
                  }),
              },
            },
          });

          const wsUrl = yield* getWsServerUrl("/ws");
          const startedAt = yield* Clock.currentTimeMillis;
          yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              client[WS_METHODS.gitRunStackedAction]({
                actionId: "action-1",
                cwd: "/tmp/repo",
                action: "commit",
              }).pipe(Stream.runCollect),
            ),
          );
          const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;

          assertTrue(elapsedMs < 1_000);
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "starts a background local git status refresh after a successful git.runStackedAction",
      () =>
        Effect.gen(function* () {
          const localRefreshStarted = yield* Deferred.make<void>();

          yield* buildAppUnderTest({
            layers: {
              vcsDriver: {
                isInsideWorkTree: () => Effect.succeed(true),
              },
              gitManager: {
                invalidateLocalStatus: () => Effect.void,
                invalidateRemoteStatus: () => Effect.void,
                invalidateStatus: () => Effect.void,
                localStatus: () =>
                  Deferred.succeed(localRefreshStarted, undefined).pipe(
                    Effect.ignore,
                    Effect.andThen(
                      Effect.succeed({
                        isRepo: true,
                        hasPrimaryRemote: true,
                        isDefaultRef: false,
                        refName: "feature/demo",
                        hasWorkingTreeChanges: false,
                        workingTree: { files: [], insertions: 0, deletions: 0 },
                      }),
                    ),
                  ),
                // Still refreshing when the RPC answers: nothing may wait for it.
                remoteStatus: () => Effect.never,
                runStackedAction: () =>
                  Effect.succeed({
                    action: "commit" as const,
                    branch: { status: "skipped_not_requested" as const },
                    commit: {
                      status: "created" as const,
                      commitSha: "abc123",
                      subject: "feat: demo",
                    },
                    push: { status: "skipped_not_requested" as const },
                    pr: { status: "skipped_not_requested" as const },
                    toast: {
                      title: "Committed abc123",
                      description: "feat: demo",
                      cta: {
                        kind: "run_action" as const,
                        label: "Push",
                        action: {
                          kind: "push" as const,
                        },
                      },
                    },
                  }),
              },
            },
          });

          const wsUrl = yield* getWsServerUrl("/ws");
          yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              client[WS_METHODS.gitRunStackedAction]({
                actionId: "action-1",
                cwd: "/tmp/repo",
                action: "commit",
              }).pipe(Stream.runCollect),
            ),
          );

          yield* Deferred.await(localRefreshStarted);
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("opens a rooted workspace PDF before its draft thread exists", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "scient-draft-pdf-",
        });
        const relativePath = "ילדים/מבואות ילדים/סיכום גיל בעריכת שחר.pdf";
        const pdfPath = path.join(workspaceRoot, relativePath);
        const bytes = new TextEncoder().encode("%PDF-1.7\nrooted draft");
        yield* fileSystem.makeDirectory(path.dirname(pdfPath), { recursive: true });
        yield* fileSystem.writeFile(pdfPath, bytes);

        yield* buildAppUnderTest({
          transformThreadManagementV2: (threads) => ({
            ...threads,
            getThreadShell: () => Effect.die("Rooted workspace assets must not resolve a thread."),
            getThreadProjection: () =>
              Effect.die("Rooted workspace assets must not read a projection."),
          }),
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const asset = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.assetsCreateUrl]({
              resource: {
                _tag: "workspace-file",
                cwd: workspaceRoot,
                relativePath,
                threadId: ThreadId.make("client-only-draft"),
                path: pdfPath,
              },
            }),
          ),
        );
        const response = yield* fetchEffect(`${yield* getHttpServerUrl()}${asset.relativeUrl}`);

        assert.equal(asset.sourcePath, relativePath);
        assert.equal(response.status, 200);
        assert.equal(response.headers["content-type"], "application/pdf");
        assert.deepEqual(new Uint8Array(yield* response.arrayBuffer), bytes);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("routes native websocket orchestration mutation, checkpoint diff and search", () =>
      Effect.gen(function* () {
        const threadId = transferV2ThreadId;
        const app = yield* buildAppUnderTest({
          layers: {
            checkpointDiffQuery: {
              getTurnDiff: (input) => Effect.succeed({ ...input, diff: "turn-diff" }),
              getFullThreadDiff: (input) =>
                Effect.succeed({ ...input, fromTurnCount: 0, diff: "full-diff" }),
            },
          },
        });
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-native-rpc-routes-" });
        yield* app.v2.projects.create({
          commandId: CommandId.make("native-rpc-project"),
          projectId: ProjectId.make("transfer-project"),
          title: "Project A",
          workspaceRoot: root,
        });
        yield* seedV2StreamThread(app);
        yield* app.v2.eventSink.write({
          events: transferV2TurnEvents(ProviderDriverKind.make("codex"), 0, false).map((event) => {
            if (event.type === "message.updated" && event.payload.role === "assistant")
              return {
                ...event,
                payload: { ...event.payload, text: "Search reached the final response." },
              };
            if (event.type === "turn-item.updated" && event.payload.type === "assistant_message")
              return {
                ...event,
                payload: { ...event.payload, text: "Search reached the final response." },
              };
            return event;
          }),
        });
        const wsUrl = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const before = yield* app.v2.events.latestAgentSequence(threadId);
              const dispatch = yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
                type: "thread.metadata.update",
                commandId: CommandId.make("native-route-title"),
                threadId,
                title: "Routed native title",
              });
              assert.isAbove(dispatch.sequence, before);
              assert.equal(
                (yield* app.v2.threads.getThreadProjection(threadId)).thread.title,
                "Routed native title",
              );
              assert.equal(
                (yield* client[ORCHESTRATION_V2_WS_METHODS.getTurnDiff]({
                  threadId,
                  fromTurnCount: 0,
                  toTurnCount: 1,
                })).diff,
                "turn-diff",
              );
              assert.equal(
                (yield* client[ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]({
                  threadId,
                  toTurnCount: 1,
                })).diff,
                "full-diff",
              );
              const search = yield* client[ORCHESTRATION_V2_WS_METHODS.searchThreads]({
                query: "final response",
              });
              assert.deepEqual(search.matches, [
                {
                  threadId,
                  projectId: ProjectId.make("transfer-project"),
                  source: "assistant",
                  snippet: "Search reached the final response.",
                  messageCreatedAt: "2026-06-01T00:01:00.000Z",
                  // Upstream's indexed search ranks matches: an exact phrase, one hit.
                  quality: 1.25,
                  hits: 1,
                  messageId: MessageId.make("assistant-0"),
                },
              ]);
            }),
          ),
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "dispatches V2 creation, section assignment and exact-boundary forks through the real shared websocket RPC",
      () =>
        Effect.gen(function* () {
          const app = yield* buildAppUnderTest();
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-ws-v2-fork-" });
          const projectId = ProjectId.make("transfer-project");
          yield* app.v2.projects.create({
            commandId: CommandId.make("ws-native-fork-project"),
            projectId,
            title: "Native fork project",
            workspaceRoot: cwd,
          });
          const wsUrl = yield* getWsServerUrl("/ws");
          yield* withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
                type: "thread.create",
                commandId: CommandId.make("ws-native-create"),
                threadId: transferV2ThreadId,
                projectId,
                title: "Native conversation",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdBy: "user",
                creationSource: "web",
              });
              const sectionId = ThreadSectionId.make("section:ws-native");
              yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
                type: "thread.section.set",
                commandId: CommandId.make("ws-native-section"),
                threadId: transferV2ThreadId,
                sectionId,
              });
              assert.equal(
                (yield* app.v2.threads.getThreadProjection(transferV2ThreadId)).thread.sectionId,
                sectionId,
              );
              const events = transferV2TurnEvents(
                ProviderDriverKind.make("codex"),
                0,
                false,
              ).filter(
                (event) =>
                  event.type !== "turn-item.updated" ||
                  event.payload.type === "user_message" ||
                  event.payload.type === "assistant_message",
              );
              yield* app.v2.eventSink.write({ events });
              const options = yield* client[ORCHESTRATION_WS_METHODS.getForkOptions]({
                originThreadId: transferV2ThreadId,
                sourceAssistantMessageId: MessageId.make("assistant-0"),
              });
              assert.isTrue(options.localAvailable);
              const target = ThreadId.make("ws-native-frozen-fork");
              const command = {
                type: "thread.fork" as const,
                commandId: CommandId.make("ws-native-fork"),
                originThreadId: transferV2ThreadId,
                newThreadId: target,
                sourceAssistantMessageId: MessageId.make("assistant-0"),
                workspaceMode: "local" as const,
              };
              const provisioningCursor = yield* app.v2.eventSink.latestSequence();
              const provisioning = yield* app.v2.eventSink
                .stream({
                  threadId: target,
                  afterSequence: provisioningCursor,
                })
                .pipe(
                  Stream.filter((stored) => stored.event.type === "thread.created"),
                  Stream.take(1),
                  Stream.runDrain,
                  Effect.andThen(app.v2.worker.drain()),
                  Effect.forkScoped,
                );
              const accepted = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](
                toThreadForkCommand(command),
              );
              yield* Fiber.join(provisioning);
              const fork = yield* app.v2.threads.getThreadProjection(target);
              assert.equal(
                (yield* readConversationFork(app.v2.sql, fork.thread.id))?.status,
                "ready",
              );
              assert.equal(fork.thread.sectionId, sectionId);
              assert.equal(fork.thread.activeProviderThreadId, null);
              assert.equal(fork.thread.historyOrigin, "scient_fork");
              assert.deepEqual(fork.providerSessions, []);
              assert.deepEqual(fork.runtimeRequests, []);
              assert.deepEqual(fork.runs, []);
              assert.deepEqual(
                fork.messages.map((message) => message.role),
                ["user", "assistant"],
              );
              assert.isTrue(
                fork.turnItems.every((item) => item.providerTurnId === null && item.runId === null),
              );
              yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
                type: "thread.delete",
                commandId: CommandId.make("ws-native-delete-source"),
                threadId: transferV2ThreadId,
              });
              const repeated = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](
                toThreadForkCommand(command),
              );
              assert.equal(repeated.sequence, accepted.sequence);
              assert.deepEqual(
                (yield* app.v2.threads.getThreadProjection(target)).messages,
                fork.messages,
              );
              const rejected = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](
                toThreadForkCommand({
                  ...command,
                  commandId: CommandId.make("ws-native-rejected-fork"),
                  newThreadId: ThreadId.make("ws-native-rejected"),
                }),
              ).pipe(Effect.flip);
              assert.equal(rejected._tag, "OrchestrationV2DispatchCommandError");
              if (rejected._tag === "OrchestrationV2DispatchCommandError")
                assert.equal(rejected.commandDisposition, "rejected");
            }),
          );
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "rejects exact-boundary fork reuse of a deleted identity and preserves its history",
      () =>
        Effect.gen(function* () {
          const app = yield* buildAppUnderTest();
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-fork-immutable-id-" });
          yield* app.v2.projects.create({
            commandId: CommandId.make("immutable-fork-project"),
            projectId: ProjectId.make("transfer-project"),
            title: "Immutable fork project",
            workspaceRoot: cwd,
          });
          yield* seedV2StreamThread(app);
          yield* app.v2.eventSink.write({
            events: transferV2TurnEvents(ProviderDriverKind.make("codex"), 0, false).filter(
              (event) =>
                event.type !== "turn-item.updated" ||
                event.payload.type === "user_message" ||
                event.payload.type === "assistant_message",
            ),
          });
          const wsUrl = yield* getWsServerUrl("/ws");
          yield* withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const deletedId = ThreadId.make("immutable-fork-deleted");
              const freshId = ThreadId.make("immutable-fork-fresh");
              const command = {
                type: "thread.fork" as const,
                commandId: CommandId.make("immutable-fork-original"),
                originThreadId: transferV2ThreadId,
                newThreadId: deletedId,
                sourceAssistantMessageId: MessageId.make("assistant-0"),
                workspaceMode: "local" as const,
              };
              const firstProvisionCursor = yield* app.v2.eventSink.latestSequence();
              const firstProvision = yield* app.v2.eventSink
                .stream({
                  threadId: deletedId,
                  afterSequence: firstProvisionCursor,
                })
                .pipe(
                  Stream.filter((stored) => stored.event.type === "thread.created"),
                  Stream.take(1),
                  Stream.runDrain,
                  Effect.andThen(app.v2.worker.drain()),
                  Effect.forkScoped,
                );
              yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](toThreadForkCommand(command));
              yield* Fiber.join(firstProvision);
              yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
                type: "thread.delete",
                commandId: CommandId.make("immutable-fork-delete"),
                threadId: deletedId,
              });
              const tombstone = yield* app.v2.threads.getThreadProjection(deletedId);
              assert.isNotNull(tombstone.thread.deletedAt);
              assert.lengthOf(tombstone.messages, 2);
              const rejected = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](
                toThreadForkCommand({
                  ...command,
                  commandId: CommandId.make("immutable-fork-reuse-rejected"),
                }),
              ).pipe(Effect.flip);
              assert.equal(rejected._tag, "OrchestrationV2DispatchCommandError");
              if (rejected._tag === "OrchestrationV2DispatchCommandError")
                assert.equal(rejected.commandDisposition, "rejected");
              assert.deepEqual(yield* app.v2.threads.getThreadProjection(deletedId), tombstone);
              yield* app.v2.worker.drain();
              const freshProvisionCursor = yield* app.v2.eventSink.latestSequence();
              const freshProvision = yield* app.v2.eventSink
                .stream({
                  threadId: freshId,
                  afterSequence: freshProvisionCursor,
                })
                .pipe(
                  Stream.filter((stored) => stored.event.type === "thread.created"),
                  Stream.take(1),
                  Stream.runDrain,
                  Effect.andThen(app.v2.worker.drain()),
                  Effect.forkScoped,
                );
              yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](
                toThreadForkCommand({
                  ...command,
                  commandId: CommandId.make("immutable-fork-fresh"),
                  newThreadId: freshId,
                }),
              );
              yield* Fiber.join(freshProvision);
              const fresh = yield* app.v2.threads.getThreadProjection(freshId);
              assert.equal(
                (yield* readConversationFork(app.v2.sql, fresh.thread.id))?.status,
                "ready",
              );
              assert.isNull(fresh.thread.deletedAt);
              assert.deepEqual(
                fresh.messages.map((message) => [message.role, message.text]),
                tombstone.messages.map((message) => [message.role, message.text]),
              );
              // The fresh fork shows the source's history by reference, frozen.
              assert.isTrue(
                fresh.messages.every((message) => message.threadId === transferV2ThreadId),
              );
              assert.isTrue(fresh.turnItems.every((item) => item.threadId === freshId));
              assert.isTrue(
                fresh.visibleTurnItems.every(
                  ({ item }) => item.runId === null && item.providerTurnId === null,
                ),
              );
              assert.deepEqual(fresh.runs, []);
              assert.deepEqual(fresh.providerSessions, []);
              assert.deepEqual(fresh.runtimeRequests, []);
              assert.deepEqual(yield* app.v2.threads.getThreadProjection(deletedId), tombstone);
            }),
          );
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect.each(["local", "new-worktree"] as const)(
      "real V2 running fork with failing workspace capture, mode=%s",
      (workspaceMode) =>
        Effect.gen(function* () {
          const captures: Array<{ readonly cwd: string; readonly checkpointRef: string }> = [];
          const app = yield* buildAppUnderTest({
            layers: {
              vcsDriver: {
                checkpoints: {
                  captureCheckpoint: (input) =>
                    Effect.sync(() => captures.push(input)).pipe(
                      Effect.andThen(
                        Effect.fail(
                          new VcsCheckpointUnavailableError({
                            operation: "fixture.capture",
                            cwd: input.cwd,
                            reason: "path-limit",
                            detail: "Private diagnostic: oversized Git listing",
                          }),
                        ),
                      ),
                    ),
                  hasCheckpointRef: () =>
                    Effect.die("A running fork must capture its own baseline"),
                  restoreCheckpoint: () =>
                    Effect.die("Rejected capture must not restore a checkout"),
                  diffCheckpoints: () => Effect.die("Rejected capture must not read a diff"),
                  deleteCheckpointRefs: () =>
                    Effect.die("Rejected capture must not publish cleanup"),
                  listAuthoredPaths: () =>
                    Effect.die("Rejected capture must not list authored paths"),
                  // No clean HEAD, so the baseline takes the full capture that fails.
                  resolveCleanHead: () => Effect.succeed(null),
                  captureHeadCheckpoint: () =>
                    Effect.die("Rejected capture must not record a HEAD checkpoint"),
                },
              },
            },
          });
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectoryScoped({
            prefix: "scient-native-capture-failure-",
          });
          const process = yield* VcsProcess.VcsProcess.pipe(Effect.provide(VcsProcess.layer));
          yield* process.run({
            operation: "fixture.git-init",
            command: "git",
            args: ["init", "--quiet"],
            cwd,
          });
          yield* app.v2.projects.create({
            commandId: CommandId.make("capture-project"),
            projectId: ProjectId.make("transfer-project"),
            title: "Capture source",
            workspaceRoot: cwd,
          });
          yield* seedV2StreamThread(app);
          yield* app.v2.eventSink.write({
            events: transferV2TurnEvents(ProviderDriverKind.make("codex"), 0, false).filter(
              (event) => event.type !== "run.updated",
            ),
          });
          const before = yield* app.v2.eventSink.latestSequence();
          const target = ThreadId.make("native-failed-capture-target");
          const dispatch = withWsRpcClient(yield* getWsServerUrl("/ws"), (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand](
              toThreadForkCommand({
                commandId: CommandId.make("native-failed-capture"),
                originThreadId: transferV2ThreadId,
                newThreadId: target,
                sourceRunningRunId: RunId.make("run-0"),
                workspaceMode,
              }),
            ),
          );
          if (workspaceMode === "local") {
            const provisioning = yield* app.v2.eventSink
              .stream({ threadId: target, afterSequence: before })
              .pipe(
                Stream.filter((stored) => stored.event.type === "thread.created"),
                Stream.take(1),
                Stream.runDrain,
                Effect.andThen(app.v2.worker.drain()),
                Effect.forkScoped,
              );
            yield* dispatch;
            yield* Fiber.join(provisioning);
            const fork = yield* app.v2.threads.getThreadProjection(target);
            assert.equal(captures.length, 0);
            assert.equal(
              (yield* readConversationFork(app.v2.sql, fork.thread.id))?.status,
              "ready",
            );
            assert.isNull((yield* readConversationFork(app.v2.sql, fork.thread.id))?.checkpointRef);
            assert.isNull((yield* readConversationFork(app.v2.sql, fork.thread.id))?.checkpointOid);
            assert.deepEqual(fork.runs, []);
            assert.deepEqual(fork.providerSessions, []);
            assert.equal(
              (yield* app.v2.threads.getThreadProjection(transferV2ThreadId)).runs[0]?.status,
              "running",
            );
            return;
          }
          const failure = yield* dispatch.pipe(Effect.flip);
          assert.equal(failure._tag, "OrchestrationV2DispatchCommandError");
          if (failure._tag === "OrchestrationV2DispatchCommandError") {
            assert.include(failure.message, "This workspace exceeds the snapshot limits");
            // Git output and workspace paths stay in the server log.
            assert.notInclude(JSON.stringify(failure), "Private diagnostic");
            assert.equal(failure.commandDisposition, "rejected");
          }
          assert.equal(captures.length, 1);
          assert.equal(captures[0]?.cwd, cwd);
          assert.equal(yield* app.v2.eventSink.latestSequence(), before);
          assert.isNull(yield* app.v2.threads.getThreadShell(target));
          assert.equal(
            (yield* app.v2.threads.getThreadProjection(transferV2ThreadId)).runs[0]?.status,
            "running",
          );
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect.each(["read", "decode"] as const)(
      "routes websocket rpc V2 shell snapshot errors during %s",
      (stage) =>
        Effect.gen(function* () {
          const failure = Effect.fail(
            new OrchestratorV2.OrchestratorProjectionError({
              threadId: transferV2ThreadId,
              cause: new Error("projection unavailable"),
            }),
          );
          yield* buildAppUnderTest({
            layers: {
              threadManagementV2: {
                readShellSnapshot: () => (stage === "read" ? failure : Effect.succeed(failure)),
              },
            },
          });
          const error = yield* collectV2ShellCatchup(yield* getWsServerUrl("/ws")).pipe(
            Effect.flip,
          );
          assert.equal(error._tag, "OrchestrationV2GetShellSnapshotError");
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );
  },
);
