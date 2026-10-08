// @effect-diagnostics nodeBuiltinImport:off - CLI integration uses temporary Node paths.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentInternalError,
  EventId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type ProjectId,
} from "@t3tools/contracts";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import * as ForgejoCli from "../sourceControl/ForgejoCli.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerRequestError,
  projectCommandErrorFromLiveServerRequest,
} from "./project.ts";

// The full command tree requires these execution authorities even when a
// fixture invokes another subcommand. Their state belongs to a scoped test profile.
const layerCliAuthority = Layer.mergeAll(
  ThreadCommandExecutor.layer,
  ProjectCloneTracker.layer.pipe(
    Layer.provide(
      SourceControlRepositoryService.layer.pipe(
        Layer.provide(GitVcsDriver.layer),
        Layer.provide(
          SourceControlProviderRegistry.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                AzureDevOpsCli.layer,
                BitbucketApi.layer,
                GitHubCli.layer,
                GitLabCli.layer,
                ForgejoCli.layer,
              ),
            ),
            Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer))),
          ),
        ),
      ),
    ),
    Layer.provide(GitVcsDriver.layer),
    Layer.provide(ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer))),
    Layer.provide(VcsProcess.layer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    Layer.provide(
      ServerConfig.layerTest("/", { prefix: "scient-cli-authority-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

const CliRuntimeLayer = Layer.mergeAll(
  NodeServices.layer,
  NetService.layer,
  layerCliAuthority,
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
);
const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.provide(CliRuntimeLayer));

const layerPersistence = (baseDir: string) =>
  SqlitePersistence.layerConfig.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

// Read the CLI's committed V2 project shells, including projects whose
// workspaces no longer exist.
const readStoredProjects = (baseDir: string) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    return { projects: yield* projects.listShells() };
  }).pipe(Effect.provide(ProjectStore.layer.pipe(Layer.provide(layerPersistence(baseDir)))));

it("maps declared server failures into structural project command errors", () => {
  const cause = new EnvironmentInternalError({
    code: "internal_error",
    reason: "access_token_issuance_failed",
    traceId: "trace-123",
  });

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerDeclaredResponseError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.code, "internal_error");
  assert.strictEqual(error.traceId, "trace-123");
  assert.strictEqual(error.message, "Server request failed (internal_error, trace trace-123).");
  assert.strictEqual(error.cause, cause);
});

it("preserves unexpected server failures without deriving the message from them", () => {
  const cause = new Error("credential abc123 was rejected");

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerRequestError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.message, "Failed to call the running server.");
  assert.strictEqual(error.cause, cause);
});

it.effect("adds, renames, and removes projects through the V2 project CLI domain", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-project-cli-" });
    const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-project-workspace-" });

    yield* runCli(["project", "add", workspaceRoot, "--title", "Alpha", "--base-dir", baseDir]);
    const added = (yield* readStoredProjects(baseDir)).projects[0];
    assert.equal(added?.title, "Alpha");
    assert.equal(added?.workspaceRoot, workspaceRoot);

    yield* runCli(["project", "rename", workspaceRoot, "Beta", "--base-dir", baseDir]);
    assert.equal((yield* readStoredProjects(baseDir)).projects[0]?.title, "Beta");

    yield* runCli(["project", "remove", added?.id ?? "", "--base-dir", baseDir]);
    assert.deepEqual((yield* readStoredProjects(baseDir)).projects, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const makeProjectLookupFixture = Effect.fn("ProjectCliTest.makeProjectLookupFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-project-lookup-" });
  const baseDir = NodePath.join(root, "state");
  const workspaceRoot = NodePath.join(root, "workspace");
  yield* fs.makeDirectory(workspaceRoot);
  yield* runCli(["project", "add", workspaceRoot, "--base-dir", baseDir]);
  const project = (yield* readStoredProjects(baseDir)).projects[0];
  assert.isDefined(project);
  return { baseDir, workspaceRoot, project: project! };
});

const makeThreadPersistenceLayer = (baseDir: string) =>
  Layer.mergeAll(RuntimeLayer.layerEventSink, ProjectionStore.layer, EventStore.layer).pipe(
    Layer.provide(layerPersistence(baseDir)),
  );

const seedNativeThreads = Effect.fn("ProjectCliTest.seedNativeThreads")(function* (
  baseDir: string,
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly archived: boolean;
  }>,
) {
  const layer = makeThreadPersistenceLayer(baseDir);
  const createdAt = DateTime.makeUnsafe("2026-09-04T12:00:00.000Z");
  const providerInstanceId = ProviderInstanceId.make("codex");
  yield* Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    yield* eventSink.write({
      commandId: CommandId.make("project-cli-seed-threads"),
      events: threads.map(({ id, projectId, archived }) => {
        const payload: OrchestrationV2AppThread = {
          createdBy: "user",
          creationSource: "web",
          id,
          projectId,
          title: id,
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
          forkedFrom: null,
          createdAt,
          updatedAt: createdAt,
          archivedAt: archived ? createdAt : null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        };
        return {
          id: EventId.make(`project-cli-create-${id}`),
          type: "thread.created" as const,
          threadId: id,
          providerInstanceId,
          occurredAt: createdAt,
          payload,
        };
      }),
    });
  }).pipe(Effect.provide(layer));
});

const readNativeThreadState = Effect.fn("ProjectCliTest.readNativeThreadState")(function* (
  baseDir: string,
  threadId: ThreadId,
) {
  const layer = makeThreadPersistenceLayer(baseDir);
  return yield* Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    return {
      thread: yield* projections.getThread(threadId),
      events: yield* events.read({ threadId }).pipe(Stream.runCollect),
    };
  }).pipe(Effect.provide(layer));
});

it.layer(NodeServices.layer)("project deletion with native V2 threads", (it) => {
  it.effect.each([
    { label: "an active thread", archived: false, missing: false },
    { label: "an archived thread", archived: true, missing: false },
    {
      label: "an active thread after its workspace disappears",
      archived: false,
      missing: true,
    },
    {
      label: "an archived thread after its workspace disappears",
      archived: true,
      missing: true,
    },
  ])("rejects unforced removal of a project with $label", ({ archived, missing }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      const threadId = ThreadId.make("project-cli-preserved-thread");
      yield* seedNativeThreads(baseDir, [{ id: threadId, projectId: project.id, archived }]);
      const before = yield* readNativeThreadState(baseDir, threadId);
      if (missing) yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);

      const error = yield* runCli([
        "project",
        "remove",
        missing ? workspaceRoot : project.id,
        "--base-dir",
        baseDir,
      ]).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Removing a nonempty project must require --force."),
        }),
      );

      assert.include(error.message, "not empty");
      assert.deepEqual(
        (yield* readStoredProjects(baseDir)).projects.map((entry) => entry.id),
        [project.id],
      );
      assert.deepEqual(yield* readNativeThreadState(baseDir, threadId), before);
      assert.equal(yield* fs.exists(workspaceRoot), !missing);
    }),
  );

  it.effect.each(["present", "missing"] as const)(
    "force-removes active and archived V2 threads with the workspace %s, preserving unrelated projects",
    (workspace) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
        const otherWorkspace = `${workspaceRoot}-other`;
        yield* fs.makeDirectory(otherWorkspace);
        yield* runCli(["project", "add", otherWorkspace, "--base-dir", baseDir]);
        const otherProject = (yield* readStoredProjects(baseDir)).projects.find(
          (entry) => entry.workspaceRoot === otherWorkspace,
        );
        assert.isDefined(otherProject);
        const activeId = ThreadId.make("project-cli-deleted-active");
        const archivedId = ThreadId.make("project-cli-deleted-archived");
        const unrelatedId = ThreadId.make("project-cli-unrelated-thread");
        yield* seedNativeThreads(baseDir, [
          { id: activeId, projectId: project.id, archived: false },
          { id: archivedId, projectId: project.id, archived: true },
          { id: unrelatedId, projectId: otherProject!.id, archived: false },
        ]);
        const unrelatedBefore = yield* readNativeThreadState(baseDir, unrelatedId);
        if (workspace === "missing") {
          yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
        }

        yield* runCli([
          "project",
          "remove",
          workspace === "missing" ? workspaceRoot : project.id,
          "--force",
          "--base-dir",
          baseDir,
        ]);

        assert.deepEqual(
          (yield* readStoredProjects(baseDir)).projects.map((entry) => entry.id),
          [otherProject!.id],
        );
        for (const threadId of [activeId, archivedId]) {
          const state = yield* readNativeThreadState(baseDir, threadId);
          assert.isNotNull(state.thread.deletedAt);
          assert.lengthOf(
            state.events.filter((record) => record.event.type === "thread.deleted"),
            1,
          );
        }
        assert.deepEqual(yield* readNativeThreadState(baseDir, unrelatedId), unrelatedBefore);
        assert.equal(yield* fs.exists(workspaceRoot), workspace === "present");
        assert.isTrue(yield* fs.exists(otherWorkspace));
      }),
  );
});

it.layer(NodeServices.layer)("project lookup with unavailable workspaces", (it) => {
  it.effect.each(["id", "stored path"] as const)(
    "removes an empty project by %s after its directory is gone",
    (identifier) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
        yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
        yield* runCli([
          "project",
          "remove",
          identifier === "id" ? project.id : workspaceRoot,
          "--base-dir",
          baseDir,
        ]);
        assert.deepEqual((yield* readStoredProjects(baseDir)).projects, []);
        assert.isFalse(yield* fs.exists(workspaceRoot));
      }),
  );

  it.effect("renames by ID and stored path after the directory is gone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
      for (const [identifier, title] of [
        [project.id, "Renamed by ID"],
        [workspaceRoot, "Renamed by stored path"],
      ] as const) {
        yield* runCli(["project", "rename", identifier, title, "--base-dir", baseDir]);
        assert.equal((yield* readStoredProjects(baseDir)).projects[0]?.title, title);
      }
      assert.isFalse(yield* fs.exists(workspaceRoot));
    }),
  );

  it.effect("does not resolve another environment's project ID in an empty database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
      const replacementDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-project-empty-" });
      const error = yield* runCli([
        "project",
        "remove",
        project.id,
        "--force",
        "--base-dir",
        replacementDir,
      ]).pipe(Effect.flip);
      assert.include(error.message, "No active project found");
      assert.deepEqual(
        (yield* readStoredProjects(baseDir)).projects.map((entry) => entry.id),
        [project.id],
      );
      assert.deepEqual((yield* readStoredProjects(replacementDir)).projects, []);
    }),
  );

  it.effect("normalizes existing paths without conflating separately registered symlinks", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      yield* runCli([
        "project",
        "rename",
        `${workspaceRoot}${NodePath.sep}.`,
        "Normalized",
        "--base-dir",
        baseDir,
      ]);
      assert.equal((yield* readStoredProjects(baseDir)).projects[0]?.title, "Normalized");
      const aliasPath = `${workspaceRoot}-alias`;
      NodeFS.symlinkSync(workspaceRoot, aliasPath, "junction");
      const unknownAlias = yield* runCli([
        "project",
        "remove",
        aliasPath,
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);
      assert.include(unknownAlias.message, "No active project found");
      yield* runCli(["project", "add", aliasPath, "--base-dir", baseDir]);
      const added = (yield* readStoredProjects(baseDir)).projects;
      assert.equal(added.length, 2);
      const aliasProject = added.find((entry) => entry.workspaceRoot === aliasPath);
      assert.isDefined(aliasProject);
      assert.notEqual(aliasProject?.id, project.id);
      yield* runCli(["project", "remove", `${aliasPath}${NodePath.sep}.`, "--base-dir", baseDir]);
      assert.deepEqual(
        (yield* readStoredProjects(baseDir)).projects.map((entry) => entry.id),
        [project.id],
      );
      assert.isTrue(NodeFS.existsSync(workspaceRoot));
    }),
  );
});
