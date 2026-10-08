import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject } from "@scientfactory/project-init";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionMaintenance from "../../orchestration-v2/ProjectionMaintenance.ts";
import WorkspaceAuthorityCutover from "../../orchestration-v2/scient-fork/migrations/019_WorkspaceAuthorityCutover.ts";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import * as Authority from "./WorkspaceAuthorityProjection.ts";
import { WorkspaceAuthorityScopeRevision } from "./WorkspaceBinding.ts";
import * as BindingResolver from "./WorkspaceBindingResolver.ts";
import * as BindingEvidence from "./WorkspaceBindingEvidence.ts";
import * as BindingStore from "./WorkspaceBindingStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerConfig from "../../config.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as ComputeSessionService from "../compute/ComputeSessionService.ts";
import { ComputeWorkspaceAdmission } from "../compute/ComputeWorkspaceAdmission.ts";
import { makeComputeRpcGateway } from "../compute/ComputeRpcGateway.ts";
import { AgentInvocationContext } from "../operations/AgentInvocationContext.ts";
import {
  resolveDocumentBuildProject,
  assertCurrentDocumentBuildProject,
} from "../../mcp/toolkits/documents/projectDocumentBuild.ts";

const projectId = ProjectId.make("native-workspace-authority-project");
const threadId = ThreadId.make("native-workspace-authority-thread");
const providerInstanceId = ProviderInstanceId.make("codex");
const now = DateTime.makeUnsafe("2026-10-04T00:00:00.000Z");
const workspaceRoot = "/fixture/native-workspace-authority";
const eventsLayer = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
);
const testLayer = Layer.merge(Authority.layer, ProjectionMaintenance.layer).pipe(
  Layer.provideMerge(eventsLayer),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const createProject = (root = workspaceRoot) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const commandId = CommandId.make("native-workspace-authority-project-create");
    return yield* sink.commitProjectCommand({
      commandId,
      projectId,
      commandType: "project.create",
      acceptedAt: now,
      event: {
        eventId: EventId.make("native-workspace-authority-project-created"),
        type: "project.created",
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: DateTime.formatIso(now),
        commandId,
        causationEventId: null,
        correlationId: commandId,
        metadata: {},
        payload: {
          projectId,
          title: "Native workspace authority",
          workspaceRoot: root,
          defaultModelSelection: null,
          scripts: [],
          createdAt: DateTime.formatIso(now),
          updatedAt: DateTime.formatIso(now),
        },
      },
    });
  });

const thread: OrchestrationV2AppThread = {
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId,
  title: "Native authority",
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "fixture" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};

it.effect("reads the project authority committed by the actual V2 event sink", () =>
  Effect.gen(function* () {
    const created = yield* createProject();
    const authority = yield* Authority.WorkspaceAuthorityProjection;
    const context = yield* authority.getProjectContext(projectId);
    assert.deepEqual(
      context,
      Option.some({ projectId, workspaceRoot, scopeRevision: created.receipt.resultSequence }),
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reads native thread authority without any V1 thread projection or cursor", () =>
  Effect.gen(function* () {
    yield* createProject();
    const sink = yield* EventSink.EventSinkV2;
    const written = yield* sink.write({
      events: [
        {
          id: EventId.make("native-workspace-authority-thread-created"),
          type: "thread.created",
          threadId,
          providerInstanceId,
          occurredAt: now,
          payload: thread,
        },
      ],
    });
    const authority = yield* Authority.WorkspaceAuthorityProjection;
    const context = yield* authority.getThreadContext(threadId);
    assert.deepEqual(
      context,
      Option.some({
        threadId,
        projectId,
        worktreePath: null,
        projectWorkspaceRoot: workspaceRoot,
        scopeRevision: WorkspaceAuthorityScopeRevision.make(written[0]!.sequence),
      }),
    );
  }).pipe(Effect.provide(testLayer)),
);

const writeThread = (
  suffix: string,
  changes: Partial<OrchestrationV2AppThread> = {},
  type:
    | "thread.metadata-updated"
    | "thread.visited"
    | "thread.archived"
    | "thread.deleted" = "thread.metadata-updated",
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    return yield* sink.write({
      events: [
        {
          id: EventId.make(`native-authority:${suffix}`),
          type,
          threadId,
          providerInstanceId,
          occurredAt: now,
          payload: { ...thread, ...changes },
        },
      ],
    });
  });

const changeProject = (
  suffix: string,
  changes: { readonly title?: string; readonly workspaceRoot?: string },
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const commandId = CommandId.make(`native-authority-project:${suffix}`);
    return yield* sink.commitProjectCommand({
      commandId,
      projectId,
      commandType: "project.update",
      acceptedAt: now,
      event: {
        eventId: EventId.make(`native-authority-project-event:${suffix}`),
        type: "project.meta-updated",
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: DateTime.formatIso(now),
        commandId,
        correlationId: commandId,
        causationEventId: null,
        metadata: {},
        payload: { projectId, ...changes, updatedAt: DateTime.formatIso(now) },
      },
    });
  });

it.effect(
  "retains authority for title and attention changes and invalidates a same-batch worktree round trip",
  () =>
    Effect.gen(function* () {
      yield* createProject();
      const initial = yield* writeThread("initial");
      const revision = initial[0]!.sequence;
      const authority = yield* Authority.WorkspaceAuthorityProjection;
      yield* writeThread("title", { title: "Renamed", workspaceAuthorityRevision: 999_999 });
      yield* writeThread("visit", { lastVisitedAt: now }, "thread.visited");
      assert.equal(
        Option.getOrThrow(yield* authority.getThreadContext(threadId)).scopeRevision,
        revision,
      );
      const sink = yield* EventSink.EventSinkV2;
      const stored = yield* sink.write({
        events: [
          {
            id: EventId.make("native-authority:out"),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId,
            occurredAt: now,
            payload: { ...thread, worktreePath: "/worktrees/b" },
          },
          {
            id: EventId.make("native-authority:back"),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId,
            occurredAt: now,
            payload: thread,
          },
        ],
      });
      const finalRevision = Option.getOrThrow(
        yield* authority.getThreadContext(threadId),
      ).scopeRevision;
      assert.equal(finalRevision, stored[1]!.sequence);
      assert.isTrue(finalRevision > revision);
      assert.notEqual(stored[0]!.sequence, finalRevision);
      assert.deepEqual(yield* authority.listRegisteredRoots(), [
        { projectId, threadId: null, workspaceRoot },
      ]);
      yield* writeThread("archive", { archivedAt: now }, "thread.archived");
      assert.isTrue(Option.isNone(yield* authority.getThreadContext(threadId)));
      yield* writeThread("delete", { deletedAt: now }, "thread.deleted");
      assert.isTrue(Option.isNone(yield* authority.getThreadContext(threadId)));
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "folds project authority with its row and invalidates a root round trip, while no-op roots retain it",
  () =>
    Effect.gen(function* () {
      const created = yield* createProject();
      yield* writeThread("project-linked");
      const authority = yield* Authority.WorkspaceAuthorityProjection;
      yield* changeProject("rename", { title: "Renamed" });
      yield* changeProject("root-noop", { workspaceRoot });
      assert.equal(
        Option.getOrThrow(yield* authority.getProjectContext(projectId)).scopeRevision,
        created.receipt.resultSequence,
      );
      const out = yield* changeProject("out", { workspaceRoot: "/fixture/other-authority" });
      assert.equal(
        Option.getOrThrow(yield* authority.getThreadContext(threadId)).scopeRevision,
        out.receipt.resultSequence,
      );
      const back = yield* changeProject("back", { workspaceRoot });
      assert.equal(
        Option.getOrThrow(yield* authority.getProjectContext(projectId)).scopeRevision,
        back.receipt.resultSequence,
      );
      assert.isTrue(back.receipt.resultSequence > out.receipt.resultSequence);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "does not grant an unprojected workspace change after another thread advances the global cursor",
  () =>
    Effect.gen(function* () {
      yield* createProject();
      yield* writeThread("applied");
      const authority = yield* Authority.WorkspaceAuthorityProjection;
      const before = yield* authority.getThreadContext(threadId);
      const events = yield* EventStore.EventStoreV2;
      yield* events.append({
        events: [
          {
            id: EventId.make("native-authority:unprojected"),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId,
            occurredAt: now,
            payload: { ...thread, worktreePath: "/unprojected/worktree" },
          },
        ],
      });
      const otherId = ThreadId.make("native-authority-unrelated");
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({
        events: [
          {
            id: EventId.make("native-authority:unrelated"),
            type: "thread.created",
            threadId: otherId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              ...thread,
              id: otherId,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: otherId },
            },
          },
        ],
      });
      assert.deepEqual(yield* authority.getThreadContext(threadId), before);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_threads
      SET payload_json = json_remove(payload_json, '$.workspaceAuthorityRevision')
      WHERE thread_id = ${threadId}`;
      const failed = yield* authority.getThreadContext(threadId).pipe(Effect.flip);
      assert.equal(failed.kind, "workspace-unavailable");
      // The owned cutover adopts the projected root, not the unrelated global cursor.
      yield* WorkspaceAuthorityCutover;
      const adopted = Option.getOrThrow(yield* authority.getThreadContext(threadId));
      assert.equal(adopted.worktreePath, null);
      assert.isTrue(adopted.scopeRevision > Option.getOrThrow(before).scopeRevision);
      const last = yield* events.latestSequence();
      yield* WorkspaceAuthorityCutover;
      assert.equal(yield* events.latestSequence(), last);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "preserves authority across real event compaction and independent projection rebuild",
  () =>
    Effect.gen(function* () {
      yield* createProject();
      yield* writeThread("before-compact", { worktreePath: "/worktrees/owned" });
      yield* writeThread(
        "visited-before-compact",
        { worktreePath: "/worktrees/owned", lastVisitedAt: now },
        "thread.visited",
      );
      const authority = yield* Authority.WorkspaceAuthorityProjection;
      const expected = yield* authority.getThreadContext(threadId);
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const compacted = yield* maintenance.compactEventStore;
      assert.isTrue(compacted.deletedEventCount > 0);
      assert.deepEqual(yield* authority.getThreadContext(threadId), expected);
      yield* maintenance.rebuild;
      assert.deepEqual(yield* authority.getThreadContext(threadId), expected);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("rolls back the append if its canonical authority stamp cannot be persisted", () =>
  Effect.gen(function* () {
    yield* createProject();
    const sql = yield* SqlClient.SqlClient;
    const events = yield* EventStore.EventStoreV2;
    const sequence = yield* events.latestSequence();
    yield* sql.unsafe(`CREATE TRIGGER reject_authority_stamp BEFORE UPDATE OF payload_json
      ON orchestration_events WHEN NEW.stream_id = '${threadId}'
      BEGIN SELECT RAISE(ABORT, 'authority stamp blocked'); END`);
    yield* events
      .append({
        events: [
          {
            id: EventId.make("native-authority:failed-stamp"),
            type: "thread.created",
            threadId,
            providerInstanceId,
            occurredAt: now,
            payload: thread,
          },
        ],
      })
      .pipe(Effect.flip);
    assert.equal(yield* events.latestSequence(), sequence);
    const rows =
      yield* sql`SELECT 1 FROM orchestration_events WHERE event_id = 'native-authority:failed-stamp'`;
    assert.equal(rows.length, 0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "cutover preserves all project settings and rolls back its whole baseline when a later fold fails",
  () =>
    Effect.gen(function* () {
      yield* createProject();
      yield* writeThread("cutover-rollback");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_projects SET auto_pull = 1,
      default_thread_env_mode = 'worktree', favicon_path = 'brand/icon.svg',
      project_icon_json = '{"kind":"emoji","emoji":"🦊"}' WHERE project_id = ${projectId}`;
      yield* sql`DELETE FROM orchestration_v2_projection_metadata WHERE projection_name LIKE 'project-workspace-authority:%'`;
      yield* sql`UPDATE orchestration_v2_projection_threads SET
      payload_json = json_remove(payload_json, '$.workspaceAuthorityRevision') WHERE thread_id = ${threadId}`;
      const projectBefore =
        yield* sql`SELECT * FROM projection_projects WHERE project_id = ${projectId}`;
      const threadBefore =
        yield* sql`SELECT * FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
      const eventsBefore = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
      yield* sql.unsafe(`CREATE TRIGGER reject_cutover BEFORE INSERT ON orchestration_events
      WHEN NEW.event_id = 'scient:workspace-authority:thread:${threadId}'
      BEGIN SELECT RAISE(ABORT, 'cutover blocked'); END`);
      yield* WorkspaceAuthorityCutover.pipe(Effect.flip);
      assert.deepEqual(
        yield* sql`SELECT * FROM projection_projects WHERE project_id = ${projectId}`,
        projectBefore,
      );
      assert.deepEqual(
        yield* sql`SELECT * FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`,
        threadBefore,
      );
      assert.deepEqual(
        yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`,
        eventsBefore,
      );
      yield* sql`DROP TRIGGER reject_cutover`;
      yield* WorkspaceAuthorityCutover;
      assert.deepEqual(
        yield* sql`SELECT * FROM projection_projects WHERE project_id = ${projectId}`,
        projectBefore,
      );
      const authority = yield* Authority.WorkspaceAuthorityProjection;
      assert.isTrue(Option.isSome(yield* authority.getProjectContext(projectId)));
      assert.isTrue(Option.isSome(yield* authority.getThreadContext(threadId)));
    }).pipe(Effect.provide(testLayer)),
);

const liveResolverLayer = BindingResolver.layer.pipe(
  Layer.provideMerge(
    Layer.merge(
      BindingStore.layer,
      BindingEvidence.layer.pipe(
        Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
      ),
    ),
  ),
  Layer.provideMerge(testLayer),
  Layer.provide(
    Layer.succeed(
      ServerEnvironment.ServerEnvironment,
      ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("native-authority-environment")),
        getDescriptor: Effect.die("Environment identity only."),
      }),
    ),
  ),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "scient-native-authority-config-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "routes a native workspace through actual binding evidence and Compute RPC admission, rejecting stale receipts",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-native-authority-" });
      yield* Effect.promise(() => initializeScientProject({ root }));
      const canonicalRoot = yield* fs.realPath(root);
      yield* createProject(canonicalRoot);
      yield* writeThread("compute-native-created");
      const resolver = yield* BindingResolver.WorkspaceBindingResolver;
      const resolved = yield* resolver.resolveThread(threadId);
      const threadScope = {
        threadId,
        bindingId: resolved.binding.bindingId,
        authorityGeneration: resolved.binding.authorityGeneration,
        scopeRevision: resolved.scopeRevision,
      };
      yield* writeThread("compute-native-title", { title: "Title only" });
      yield* resolver.assertCurrentThreadScope(threadScope);
      const invocation = AgentInvocationContext.of({
        environmentId: EnvironmentId.make("native-authority-environment"),
        threadId,
        providerSessionId: "native-authority-session",
        providerInstanceId,
        issuedAt: 1,
        capabilities: new Set(["documents:build"]),
      });
      // Production MCP document workspace admission uses actual native authority and filesystem evidence.
      const documentScope = yield* resolveDocumentBuildProject().pipe(
        Effect.provideService(AgentInvocationContext, invocation),
      );
      assert.equal(documentScope.root, canonicalRoot);
      assert.equal(documentScope.scopeRevision, resolved.scopeRevision);
      yield* assertCurrentDocumentBuildProject(documentScope);
      const compute = yield* ComputeSessionService.ComputeSessionService;
      const gateway = makeComputeRpcGateway({
        compute,
        workspaceResolver: resolver,
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        workspaceFileSystem: {
          readFile: () => Effect.die("This inventory operation does not read a source file."),
        },
      });
      yield* gateway.inspectRuntimes({ cwd: canonicalRoot, refresh: false });
      const admission = yield* ComputeWorkspaceAdmission;
      // Gateway-local admission never leaks into the caller's ambient context.
      assert.equal(admission, null);
      const other = yield* fs.makeTempDirectoryScoped({ prefix: "scient-native-authority-other-" });
      yield* changeProject("compute-out", { workspaceRoot: other });
      yield* changeProject("compute-back", { workspaceRoot: canonicalRoot });
      const stale = yield* resolver.assertCurrentThreadScope(threadScope).pipe(Effect.flip);
      assert.equal(stale.kind, "stale-authority");
      const staleDocument = yield* assertCurrentDocumentBuildProject(documentScope).pipe(
        Effect.flip,
      );
      assert.equal(staleDocument.code, "project-changed");
    }).pipe(
      Effect.provide(
        Layer.merge(
          liveResolverLayer,
          Layer.mock(ComputeSessionService.ComputeSessionService)({
            runtimeDescriptors: [],
            inspectRuntimes: () =>
              Effect.gen(function* () {
                const receipt = yield* ComputeWorkspaceAdmission;
                assert.isNotNull(receipt);
                if (receipt !== null) {
                  assert.isTrue(receipt.scope.scopeRevision > 0);
                  yield* receipt.assertCurrent;
                }
                return [];
              }),
          }),
        ),
      ),
    ),
);
