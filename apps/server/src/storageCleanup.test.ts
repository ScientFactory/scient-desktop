import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { SCAN_CACHE_FILE_NAME } from "./usage/usageScanCache.ts";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { DEFAULT_SERVER_SETTINGS, StorageCleanupReport } from "@t3tools/contracts";
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderSession,
  OrchestrationV2ThreadShell,
  ServerSettings,
  StorageCleanupSettings,
  WorktreeKeepWhen,
} from "@t3tools/contracts";
import * as ServerConfig from "./config.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Settings from "./serverSettings.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as EffectOutbox from "./orchestration-v2/EffectOutbox.ts";
import { withComputeWorkspaceReservation } from "./scient/compute/ComputeWorkspaceLifetime.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ServerActivation } from "./serverActivation.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  storageCleanupActivityAt,
  storageCleanupPullRequestMerged,
  storageCleanupThreadIdle,
} from "./storageCleanup.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;
const decodeCleanupReport = Schema.decodeSync(StorageCleanupReport);

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("V2 storage cleanup eligibility", () => {
  const candidate = () => shell({ branch: "feature", worktreePath: "/worktrees/feature" });

  it("allows an idle worktree and rejects the project checkout", () => {
    expect(storageCleanupThreadIdle(candidate(), NOW_MS)).toBe(true);
    expect(storageCleanupThreadIdle(shell(), NOW_MS)).toBe(false);
  });

  it.each(["running", "starting", "preparing", "waiting", "queued"] as const)(
    "retains a worktree while its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS)).toBe(false);
    },
  );

  it.each(["idle", "completed", "interrupted", "failed", "cancelled", "rolled_back"] as const)(
    "allows cleanup once its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS)).toBe(true);
    },
  );

  it.each(["completed", "interrupted", "cancelled", "rolled_back"] as const)(
    "retains %s while background work is pending",
    (status) => {
      expect(
        storageCleanupThreadIdle(
          {
            ...candidateWithStatus(status),
            pendingBackgroundTasks: [{ taskId: "task-1", kind: "command" }],
          },
          NOW_MS,
        ),
      ).toBe(false);
    },
  );

  it.each(["completed", "interrupted", "cancelled", "rolled_back"] as const)(
    "retains %s while a runtime request is pending",
    (status) => {
      expect(
        storageCleanupThreadIdle(
          {
            ...candidateWithStatus(status),
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("request-1"),
              kind: "command",
              createdAt: at(0),
            },
          },
          NOW_MS,
        ),
      ).toBe(false);
    },
  );

  it("retains an active run even if the shell status is idle", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), activeRunId: RunId.make("run") }, NOW_MS),
    ).toBe(false);
  });

  it("retains a queued prompt before the new run has been projected", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), latestUserMessageAt: at(-1_000) }, NOW_MS),
    ).toBe(false);
  });

  it("uses V2 run activity instead of metadata refreshes for retention", () => {
    const thread = candidate();
    const runTime = at(-3 * DAY_MS);
    expect(
      storageCleanupActivityAt({ ...thread, latestRunCompletedAt: runTime, updatedAt: at(0) }),
    ).toBe(DateTime.toEpochMillis(runTime));
  });

  function candidateWithStatus(status: OrchestrationV2ThreadShell["status"]) {
    return { ...candidate(), status };
  }
});

describe("merged pull request cleanup", () => {
  const HEAD_SHA = "a".repeat(40);
  const integrated = {
    branch: "feature",
    defaultBranch: "main",
    headSha: HEAD_SHA,
    integrated: true,
  };
  const squashed = { ...integrated, integrated: false };
  const pullRequest = (
    overrides: Partial<NonNullable<Parameters<typeof storageCleanupPullRequestMerged>[0]>> = {},
  ) => ({
    state: "merged" as const,
    headRef: "feature",
    baseRef: "main",
    headSha: HEAD_SHA,
    ...overrides,
  });

  it("removes a worktree whose head reached the default branch through a merged pull request", () => {
    expect(storageCleanupPullRequestMerged(pullRequest({ headSha: null }), integrated)).toBe(true);
  });

  it("removes a squash-merged worktree when the pull request names its exact head", () => {
    expect(storageCleanupPullRequestMerged(pullRequest(), squashed)).toBe(true);
  });

  it.each([
    ["has a later commit than the merged head", { headSha: "c".repeat(40) }],
    ["was merged into a release branch", { baseRef: "release" }],
    ["was merged into its stack parent", { baseRef: "stack-parent" }],
    ["was merged without a reported head commit", { headSha: null }],
    ["belongs to a different branch", { headRef: "other" }],
    ["is still open", { state: "open" }],
    ["was closed without merging", { state: "closed" }],
  ] as const)("keeps a squash worktree whose pull request %s", (_name, overrides) => {
    expect(storageCleanupPullRequestMerged(pullRequest(overrides), squashed)).toBe(false);
  });

  it("keeps a worktree with no pull request, or one that is not merged", () => {
    expect(storageCleanupPullRequestMerged(null, squashed)).toBe(false);
    expect(storageCleanupPullRequestMerged(null, integrated)).toBe(false);
    expect(storageCleanupPullRequestMerged(pullRequest({ state: "open" }), integrated)).toBe(false);
  });
});

const cleanupFixture = (
  storageCleanup: StorageCleanupSettings = {
    ...DEFAULT_SERVER_SETTINGS.storageCleanup,
    worktreeAfterDays: 8,
    worktreeOnDelete: true,
  },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configured = yield* ServerConfig.ServerConfig;
    yield* fs.makeDirectory(configured.browserArtifactsDir, { recursive: true });
    yield* fs.makeDirectory(configured.logsDir, { recursive: true });
    const config = {
      ...configured,
      browserArtifactsDir: yield* fs.realPath(configured.browserArtifactsDir),
      logsDir: yield* fs.realPath(configured.logsDir),
    };
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repo = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-repo-" });
    const command = (cwd: string, args: string[]) =>
      git.execute({ operation: "cleanup-test", cwd, args });
    yield* command(repo, ["init", "-b", "main"]);
    yield* command(repo, ["config", "user.email", "cleanup@example.test"]);
    yield* command(repo, ["config", "user.name", "Cleanup test"]);
    yield* fs.writeFileString(`${repo}/tracked.txt`, "original\n");
    yield* fs.writeFileString(`${repo}/.gitignore`, ".env\ndist/\nnode_modules/\n");
    yield* command(repo, ["add", "."]);
    yield* command(repo, ["commit", "-m", "initial"]);
    yield* fs.makeDirectory(config.worktreesDir, { recursive: true });
    const worktree = `${config.worktreesDir}/feature`;
    yield* command(repo, ["worktree", "add", "-b", "feature", worktree]);
    // worktreeOnDelete lets domain events request sweeps once a test calls activate.
    let settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      storageCleanup,
    };
    let threads = [shell({ branch: "feature", worktreePath: worktree })];
    let archivedThreads: Array<OrchestrationV2ThreadShell> = [];
    let queuedThreadIds: Array<string> = [];
    let editBeforeRemoval = false;
    let ignoredBeforeIsolation: string | undefined;
    let recreateOriginal = false;
    let isolatedPath: string | undefined;
    let openSessionCwd: string | null = null;
    let openSessionStatus: OrchestrationV2ProviderSession["status"] = "ready";
    let sessionLive = true;
    let fullStatusCalls = 0;
    let snapshotReads = 0;
    let events: Stream.Stream<OrchestrationV2DomainEvent> = Stream.empty;
    const activated = yield* Deferred.make<void>();
    const context = yield* Layer.build(StorageCleanup.layer).pipe(
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(GitVcsDriver.GitVcsDriver, {
        ...git,
        execute: (input) =>
          Effect.gen(function* () {
            if (
              input.args[0] === "worktree" &&
              input.args[1] === "move" &&
              isolatedPath === undefined
            ) {
              const source = input.args[2]!;
              isolatedPath = input.args[3]!;
              if (ignoredBeforeIsolation !== undefined) {
                yield* fs.writeFileString(
                  `${source}/${ignoredBeforeIsolation}`,
                  "late ignored data\n",
                );
              }
              const result = yield* git.execute(input);
              if (recreateOriginal) {
                yield* fs.makeDirectory(source);
                yield* fs.writeFileString(`${source}/recreated.txt`, "new checkout data\n");
              }
              return result;
            }
            if (editBeforeRemoval && input.args.includes("remove")) {
              const target = input.args.at(-1)!;
              yield* fs.writeFileString(`${target}/tracked.txt`, "late edit\n");
              yield* fs.writeFileString(`${target}/notes.txt`, "untracked\n");
            }
            return yield* git.execute(input);
          }),
        statusDetailsLocal: (...args) => {
          fullStatusCalls++;
          return git.statusDetailsLocal(...args);
        },
      }),
      Effect.provideService(Settings.ServerSettingsService, {
        getSettings: Effect.sync(() => settings),
        subscribeChanges: Effect.succeed(Stream.empty),
      } as unknown as Settings.ServerSettingsService["Service"]),
      Effect.provideService(ProjectStore.ProjectStoreV2, {
        listShells: () =>
          Effect.succeed([{ id: ProjectId.make("project-1"), workspaceRoot: repo }]),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, {
        getShellSnapshot: (input?: { location?: string }) =>
          Effect.sync(() => {
            snapshotReads++;
            return {
              threads: input?.location === "archive" ? [] : threads,
              archivedThreads: input?.location === "active" ? [] : archivedThreads,
            };
          }),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
        isLive: () => Effect.sync(() => sessionLive),
      } as unknown as ProviderSessionManager.ProviderSessionManagerV2["Service"]),
      Effect.provideService(Orchestrator.OrchestratorV2, {
        streamDomainEvents: Stream.suspend(() => events),
      } as unknown as Orchestrator.OrchestratorV2["Service"]),
      Effect.provideService(EffectOutbox.EffectOutboxV2, {
        subscribeCompletions: Effect.succeed(Stream.empty),
      } as unknown as EffectOutbox.EffectOutboxV2["Service"]),
      Effect.provideService(SqlClient.SqlClient, ((strings: TemplateStringsArray) =>
        Effect.sync(() =>
          strings.join("").includes("orchestration_v2_projection_runs")
            ? queuedThreadIds.map((threadId) => ({ thread_id: threadId }))
            : openSessionCwd !== null &&
                strings.join("").includes("projection_provider_sessions") &&
                // Honors a recorded-status filter, as the real table would.
                !(openSessionStatus === "stopped" && strings.join("").includes("'stopped'"))
              ? [
                  {
                    provider_session_id: "session-1",
                    status: openSessionStatus,
                    payload_json: JSON.stringify({
                      id: "session-1",
                      driver: "codex",
                      providerInstanceId: "codex",
                      status: openSessionStatus,
                      cwd: openSessionCwd,
                      model: null,
                      capabilities: CodexProviderCapabilitiesV2,
                      createdAt: "2026-06-01T12:00:00.000Z",
                      updatedAt: "2026-06-01T12:00:00.000Z",
                      lastError: null,
                    }),
                  },
                ]
              : [],
        )) as unknown as SqlClient.SqlClient),
      Effect.provideService(GitManager.GitManager, {
        invalidateStatus: () => Effect.void,
      } as unknown as GitManager.GitManager["Service"]),
      Effect.provideService(TerminalManager.TerminalManager, {
        subscribeMetadata: () => Effect.succeed(() => {}),
      } as unknown as TerminalManager.TerminalManager["Service"]),
      Effect.provideService(ServerActivation, Deferred.await(activated)),
    );
    return {
      service: Context.get(context, StorageCleanup.StorageCleanup),
      editBeforeRemoval: () => {
        editBeforeRemoval = true;
      },
      addIgnoredBeforeIsolation: (file: string, obstructRollback = false) => {
        ignoredBeforeIsolation = file;
        recreateOriginal = obstructRollback;
      },
      isolatedPath: () => isolatedPath,
      fs,
      path,
      worktree,
      repo,
      config,
      command,
      enableFiles: () => {
        settings = {
          ...settings,
          storageCleanup: {
            ...settings.storageCleanup,
            browserArtifactsAfterDays: 8,
            logsAfterDays: 8,
          },
        };
      },
      setSettings: (next: Partial<typeof settings>) => {
        settings = { ...settings, ...next };
      },
      setPolicy: (worktreeKeepWhen: WorktreeKeepWhen) => {
        settings = {
          ...settings,
          storageCleanup: { ...settings.storageCleanup, worktreeKeepWhen },
        };
      },
      disable: () => {
        settings = {
          ...settings,
          storageCleanup: {
            ...settings.storageCleanup,
            worktreeAfterDays: null,
            worktreeOnDelete: false,
          },
        };
      },
      setThreads: (next: typeof threads) => {
        threads = next;
      },
      setArchivedThreads: (next: Array<OrchestrationV2ThreadShell>) => {
        archivedThreads = next;
      },
      setQueuedThreadIds: (next: Array<string>) => {
        queuedThreadIds = next;
      },
      setSessionLive: (live: boolean) => {
        sessionLive = live;
      },
      setOpenSessionCwd: (cwd: string | null) => {
        openSessionCwd = cwd;
      },
      setOpenSessionStatus: (status: OrchestrationV2ProviderSession["status"]) => {
        openSessionStatus = status;
      },
      fullStatusCalls: () => fullStatusCalls,
      snapshotReads: () => snapshotReads,
      /** Starts the hourly sweep and the subscription to `domainEvents`, which wait until now. */
      activate: (domainEvents: Stream.Stream<OrchestrationV2DomainEvent>) => {
        events = domainEvents;
        return Deferred.succeed(activated, undefined);
      },
    };
  });
/** The fixture, with the size walk of its worktree held until `resume` succeeds. */
const pausedMeasurementFixture = (storageCleanup?: StorageCleanupSettings) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const measuring = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let measuredPath: string | undefined;
    const fixture = yield* cleanupFixture(storageCleanup).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readDirectory: (directory, options) =>
          Effect.gen(function* () {
            if (directory === measuredPath) {
              yield* Deferred.succeed(measuring, undefined);
              yield* Deferred.await(resume);
            }
            return yield* fs.readDirectory(directory, options);
          }),
      }),
    );
    measuredPath = yield* fs.realPath(fixture.worktree);
    return { ...fixture, measuring, resume };
  });
const sessionUpdated = (
  index: number,
  status: OrchestrationV2ProviderSession["status"],
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event-${index}`),
  type: "provider-session.updated",
  threadId: ThreadId.make("thread-1"),
  occurredAt: at(0),
  payload: {
    id: ProviderSessionId.make(`session-${index}`),
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    status,
    cwd: "/elsewhere",
    model: null,
    capabilities: CodexProviderCapabilitiesV2,
    createdAt: at(0),
    updatedAt: at(0),
    lastError: null,
  },
});
const cleanupTestLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "storage-cleanup-" })),
  Layer.provideMerge(NodeServices.layer),
);
const runCleanupTest = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | ServerConfig.ServerConfig
    | GitVcsDriver.GitVcsDriver
    | Path.Path
    | Scope.Scope
  >,
) => effect.pipe(Effect.provide(cleanupTestLayer), Effect.scoped);

describe("storage cleanup reports and local file policies", () => {
  it.live("measures nested regular files without following symlinks", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setPolicy } = yield* cleanupFixture();
        setPolicy("tracked-changes");
        const sizes = yield* Effect.forEach(yield* fs.readDirectory(worktree), (name) =>
          fs.stat(`${worktree}/${name}`).pipe(Effect.map((stat) => Number(stat.size))),
        );
        const outside = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(`${outside}/external`, "must not count");
        yield* fs.makeDirectory(`${worktree}/node_modules/nested`, { recursive: true });
        yield* fs.writeFileString(`${worktree}/node_modules/nested/file`, "count me");
        yield* fs.symlink(outside, `${worktree}/node_modules/directory-link`);
        yield* fs.symlink(`${outside}/external`, `${worktree}/node_modules/file-link`);
        yield* fs.symlink(`${outside}/missing`, `${worktree}/node_modules/dangling-link`);
        const report = yield* service.runNow;
        const bytes = sizes.reduce((sum, size) => sum + size, 8);
        expect(report.entries[0]).toMatchObject({ outcome: "removed", bytes, files: null });
        expect(report.bytesFreed).toBe(bytes);
        expect(yield* fs.exists(worktree)).toBe(false);
        expect(yield* fs.readFileString(`${outside}/external`)).toBe("must not count");
      }),
    ),
  );
  it.live("still removes a worktree when measuring its size fails", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { service, worktree } = yield* cleanupFixture().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (directory) => fs.readDirectory(`${directory}/missing-directory`),
          }),
        );
        const report = yield* service.runNow;
        expect(report.entries[0]).toMatchObject({ outcome: "removed", bytes: null, files: null });
        expect(report.bytesFreed).toBe(0);
        expect(yield* fs.exists(worktree)).toBe(false);
      }),
    ),
  );
  it.live.each([
    [
      "its thread starts",
      (worktree: string) => [
        shell({ branch: "feature", worktreePath: worktree, status: "running" }),
      ],
    ],
    [
      "another thread starts using it",
      (worktree: string) => [
        shell({ branch: "feature", worktreePath: worktree }),
        shell({ id: ThreadId.make("thread-2"), branch: "feature", worktreePath: worktree }),
      ],
    ],
  ] as const)("keeps a worktree when %s during size measurement", ([, threadsWhileMeasuring]) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* pausedMeasurementFixture();
        const { fs, worktree } = fixture;
        fixture.setPolicy("tracked-changes");
        const cleanup = yield* fixture.service.runNow.pipe(Effect.forkChild);
        yield* Deferred.await(fixture.measuring);
        yield* fs.writeFileString(`${worktree}/notes.txt`, "untracked\n");
        fixture.setThreads(threadsWhileMeasuring(worktree));
        yield* Deferred.succeed(fixture.resume, undefined);
        const report = yield* Fiber.join(cleanup);
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          bytes: null,
        });
        expect(report.bytesFreed).toBe(0);
        expect(yield* fs.exists(worktree)).toBe(true);
        expect(yield* fs.readFileString(`${worktree}/notes.txt`)).toBe("untracked\n");
      }),
    ),
  );
  // SCIENT-FORK:START archived-worktree-retention — the sweep reads the snapshot once, and
  // each pre-removal recheck rereads it so archived threads and queued runs still block.
  it.live.each(["an archived thread starts sharing it", "a run is queued on its thread"] as const)(
    "keeps a worktree when %s during size measurement",
    (change) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* pausedMeasurementFixture();
          const cleanup = yield* fixture.service.runNow.pipe(Effect.forkChild);
          yield* Deferred.await(fixture.measuring);
          if (change === "a run is queued on its thread") fixture.setQueuedThreadIds(["thread-1"]);
          else
            fixture.setArchivedThreads([
              shell({
                id: ThreadId.make("thread-archived"),
                branch: "feature",
                worktreePath: fixture.worktree,
                archivedAt: at(0),
              }),
            ]);
          yield* Deferred.succeed(fixture.resume, undefined);
          const report = yield* Fiber.join(cleanup);
          expect(report.entries[0]).toMatchObject({
            outcome: "kept",
            reason: "Thread activity or shared worktree changed since check",
            bytes: null,
          });
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );
  it.live("keeps a worktree an archived thread shares", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setArchivedThreads([
          shell({
            id: ThreadId.make("thread-archived"),
            branch: "feature",
            worktreePath: fixture.worktree,
            archivedAt: at(0),
          }),
        ]);
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Shared by 2 threads",
          bytes: null,
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
      }),
    ),
  );
  it.live("keeps a worktree whose thread has a queued run", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setQueuedThreadIds(["thread-1"]);
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Thread is running or has pending work",
          bytes: null,
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
      }),
    ),
  );
  it.live("reads the thread snapshot once per sweep and once per pre-removal recheck", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, snapshotReads } = yield* cleanupFixture();
        expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "removed" });
        expect(snapshotReads()).toBe(3);
      }),
    ),
  );
  // The removing sweep reads the snapshot three times; a later sweep finds the
  // worktree gone and reads it once.
  // SCIENT-FORK:END archived-worktree-retention
  it.live.each([
    ["running", "ready", 1, 3],
    ["stopped", "error", 2, 4],
  ] as const)(
    "session updates to %s or %s during a sweep make %i sweep(s) in total",
    ([first, second, , reads]) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* pausedMeasurementFixture();
          const handled = yield* Deferred.make<void>();
          // 20 updates arrive while the first automatic sweep measures the worktree.
          yield* fixture.activate(
            Stream.fromEffect(Deferred.await(fixture.measuring)).pipe(
              Stream.flatMap(() => Stream.range(0, 19)),
              Stream.map((index) => sessionUpdated(index, index % 2 === 0 ? first : second)),
              Stream.concat(
                Stream.fromEffect(Deferred.succeed(handled, undefined)).pipe(Stream.drain),
              ),
            ),
          );
          yield* Deferred.await(handled);
          yield* Deferred.succeed(fixture.resume, undefined);
          yield* fixture.service.drain;
          expect(fixture.snapshotReads()).toBe(reads);
        }),
      ),
  );
  it.live("does not measure a worktree kept for an open provider session", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const walked: Array<string> = [];
        const fixture = yield* cleanupFixture().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (directory, options) => {
              walked.push(directory);
              return fs.readDirectory(directory, options);
            },
          }),
        );
        const root = yield* fs.realPath(fixture.worktree);
        fixture.setOpenSessionCwd(fixture.worktree);
        const kept = yield* fixture.service.runNow;
        expect(kept.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Provider session is still open",
          bytes: null,
        });
        expect(walked.filter((directory) => directory.startsWith(root))).toEqual([]);
        // The stored session stays ready after its runtime was released.
        fixture.setSessionLive(false);
        const removed = yield* fixture.service.runNow;
        expect(removed.entries[0]).toMatchObject({ outcome: "removed" });
        expect(removed.entries[0]?.bytes).toBeGreaterThan(0);
        expect(walked).toContain(root);
      }),
    ),
  );
  // SCIENT-FORK:START retiring-session-worktree-retention — a session recorded stopped
  // after its physical close timed out still holds its worktree while its process runs.
  it.live("keeps a worktree under a session recorded stopped whose process is still live", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setOpenSessionCwd(fixture.worktree);
        fixture.setOpenSessionStatus("stopped");
        const kept = yield* fixture.service.runNow;
        expect(kept.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Provider session is still open",
          bytes: null,
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        // Once its physical close ends, the stopped session no longer holds it.
        fixture.setSessionLive(false);
        const removed = yield* fixture.service.runNow;
        expect(removed.entries[0]).toMatchObject({ outcome: "removed" });
      }),
    ),
  );
  it.live("keeps a worktree when a session recorded stopped opens on it during measurement", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* pausedMeasurementFixture();
        const cleanup = yield* fixture.service.runNow.pipe(Effect.forkChild);
        yield* Deferred.await(fixture.measuring);
        fixture.setOpenSessionCwd(fixture.worktree);
        fixture.setOpenSessionStatus("stopped");
        yield* Deferred.succeed(fixture.resume, undefined);
        const report = yield* Fiber.join(cleanup);
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Provider session is still open",
          bytes: null,
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
      }),
    ),
  );
  // SCIENT-FORK:END retiring-session-worktree-retention
  it.live("compares the checked-out branch without a full status", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, command, setThreads, fullStatusCalls } =
          yield* cleanupFixture();
        const changed = { outcome: "kept", reason: "Repository or branch changed" };
        yield* command(worktree, ["checkout", "--detach"]);
        expect((yield* service.runNow).entries[0]).toMatchObject(changed);
        // A branch that has no commit yet is still a different branch.
        yield* command(worktree, ["switch", "--orphan", "other"]);
        expect((yield* service.runNow).entries[0]).toMatchObject(changed);
        // Status output reserves a leading "(" for a detached HEAD.
        yield* command(worktree, ["switch", "-c", "(feature)", "feature"]);
        setThreads([shell({ branch: "(feature)", worktreePath: worktree })]);
        expect((yield* service.runNow).entries[0]).toMatchObject(changed);
        setThreads([shell({ branch: "feature", worktreePath: worktree })]);
        // Tags named after the branch or HEAD make Git's short names ambiguous.
        yield* command(worktree, ["tag", "feature", "feature"]);
        // Newer Git refuses to create a tag named HEAD, but still reads one.
        yield* command(worktree, ["update-ref", "refs/tags/HEAD", "refs/heads/feature"]);
        yield* command(worktree, ["switch", "feature"]);
        const index = (yield* command(worktree, ["rev-parse", "--git-path", "index"])).stdout;
        yield* fs.writeFileString(`${index.trim()}.lock`, "");
        const locked = (yield* service.runNow).entries[0];
        expect(locked).toMatchObject({ outcome: "failed" });
        expect(locked?.reason).toContain("Git index is locked");
        yield* fs.remove(`${index.trim()}.lock`);
        const gitFile = yield* fs.readFileString(`${worktree}/.git`);
        yield* fs.writeFileString(`${worktree}/.git`, "gitdir: /missing-git-directory\n");
        expect((yield* service.runNow).entries[0]).toMatchObject(changed);
        yield* fs.writeFileString(`${worktree}/.git`, gitFile);
        expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "removed" });
        expect(fullStatusCalls()).toBe(0);
      }),
    ),
  );
  it("decodes reports from servers without size fields", () => {
    const report = decodeCleanupReport({
      trigger: "manual",
      startedAt: "2026-06-10T12:00:00.000Z",
      finishedAt: "2026-06-10T12:00:01.000Z",
      entries: [
        {
          kind: "worktree",
          outcome: "removed",
          reason: "Removed",
          path: null,
          threadId: null,
          threadTitle: null,
        },
      ],
      counts: { removed: 1, kept: 0, failed: 0 },
      omittedCount: 0,
    });
    expect(report.bytesFreed).toBe(0);
    expect(report.entries[0]).toMatchObject({ bytes: null, files: null });
  });
  it.live.each([
    ["any-local-files", ".env"],
    ["uncommitted-changes", ".env"],
    ["tracked-changes", ".env"],
    ["any-local-files", "notes.txt"],
    ["uncommitted-changes", "notes.txt"],
    ["tracked-changes", "notes.txt"],
    ["any-local-files", "tracked.txt"],
    ["uncommitted-changes", "tracked.txt"],
    ["tracked-changes", "tracked.txt"],
  ] as const)("preserves local files under %j", ([policy, file]) =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setPolicy } = yield* cleanupFixture();
        setPolicy(policy);
        expect(yield* service.latestReport).toBeNull();
        yield* fs.writeFileString(`${worktree}/${file}`, "local data\n");
        const report = yield* service.runNow;
        yield* service.drain;
        expect(report.trigger).toBe("manual");
        expect(report.entries.filter((entry) => entry.kind === "worktree")).toMatchObject([
          {
            outcome: "kept",
            path: worktree,
            threadId: "thread-1",
            threadTitle: "Thread",
            bytes: null,
            files: null,
          },
        ]);
        expect(report.bytesFreed).toBe(0);
        expect(yield* fs.readFileString(`${worktree}/${file}`)).toBe("local data\n");
        expect(yield* service.latestReport).toEqual(report);
      }),
    ),
  );
  it.live("preserves tracked and untracked files when removal is rejected after inspection", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setPolicy("tracked-changes");
        fixture.editBeforeRemoval();
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({ outcome: "failed", bytes: null, files: null });
        expect(report.bytesFreed).toBe(0);
        expect(yield* fixture.fs.readFileString(`${fixture.worktree}/tracked.txt`)).toBe(
          "late edit\n",
        );
        expect(yield* fixture.fs.readFileString(`${fixture.worktree}/notes.txt`)).toBe(
          "untracked\n",
        );
      }),
    ),
  );
  it.live("restores ignored data created after the final original-path inspection", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.addIgnoredBeforeIsolation(".env");
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          path: fixture.worktree,
          bytes: null,
          files: null,
        });
        expect(report.entries[0]?.reason).toContain("ignored files");
        expect(report.bytesFreed).toBe(0);
        expect(yield* fixture.fs.readFileString(`${fixture.worktree}/.env`)).toBe(
          "late ignored data\n",
        );
        expect(yield* fixture.fs.readFileString(`${fixture.worktree}/tracked.txt`)).toBe(
          "original\n",
        );
        expect(
          (yield* fixture.command(fixture.worktree, ["branch", "--show-current"])).stdout.trim(),
        ).toBe("feature");
        const isolated = fixture.isolatedPath()!;
        expect(yield* fixture.fs.exists(isolated)).toBe(false);
        expect(yield* fixture.fs.exists(fixture.path.dirname(isolated))).toBe(false);
      }),
    ),
  );
  it.live("removes a clean isolated worktree and its empty private container", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({ outcome: "removed", path: fixture.worktree });
        expect(report.counts).toEqual({ removed: 1, kept: 0, failed: 0 });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
        const isolated = fixture.isolatedPath()!;
        expect(yield* fixture.fs.exists(isolated)).toBe(false);
        expect(yield* fixture.fs.exists(fixture.path.dirname(isolated))).toBe(false);
        const listing = yield* fixture.command(fixture.repo, ["worktree", "list", "--porcelain"]);
        expect(listing.stdout).not.toContain(isolated);
        expect(listing.stdout).not.toContain(fixture.worktree);
      }),
    ),
  );
  it.live(
    "preserves recreated original data and reports the isolated checkout when rollback is obstructed",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.addIgnoredBeforeIsolation(".env", true);
          const report = yield* fixture.service.runNow;
          const isolated = fixture.isolatedPath()!;
          expect(report.entries[0]).toMatchObject({
            outcome: "failed",
            path: fixture.worktree,
            bytes: null,
            files: null,
          });
          expect(report.entries[0]?.reason).toContain(isolated);
          expect(report.counts).toEqual({ removed: 0, kept: 0, failed: 1 });
          expect(report.bytesFreed).toBe(0);
          expect(yield* fixture.fs.readFileString(`${fixture.worktree}/recreated.txt`)).toBe(
            "new checkout data\n",
          );
          expect(yield* fixture.fs.readFileString(`${isolated}/.env`)).toBe("late ignored data\n");
          expect(yield* fixture.fs.readFileString(`${isolated}/tracked.txt`)).toBe("original\n");
          expect(
            (yield* fixture.command(isolated, ["branch", "--show-current"])).stdout.trim(),
          ).toBe("feature");
          const listing = yield* fixture.command(isolated, ["worktree", "list", "--porcelain"]);
          expect(listing.stdout).toContain(isolated);
        }),
      ),
  );
  it.live("reports Compute ownership and removes only after physical release", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree } = yield* cleanupFixture();
        const release = yield* Effect.acquireRelease(
          withComputeWorkspaceReservation(worktree, (release) => Effect.succeed(release)),
          (release) => release,
        );
        const retained = yield* service.runNow;
        expect(retained.entries[0]).toMatchObject({
          outcome: "kept",
          bytes: null,
        });
        expect(retained.bytesFreed).toBe(0);
        expect(yield* fs.exists(worktree)).toBe(true);
        yield* release;
        expect((yield* service.runNow).entries[0]?.outcome).toBe("removed");
        expect(yield* fs.exists(worktree)).toBe(false);
      }),
    ),
  );
  it.live("streams the current report and subsequent runs", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service } = yield* cleanupFixture();
        const reports = yield* service.reports.pipe(
          Stream.take(2),
          Stream.tap((report) => (report === null ? service.runNow : Effect.void)),
          Stream.runCollect,
        );
        expect(reports[0]).toBeNull();
        expect(reports[1]).toEqual(yield* service.latestReport);
        expect(reports[1]?.counts).toEqual({ removed: 1, kept: 0, failed: 0 });
      }),
    ),
  );
  it.live("caps entries while preserving totals and prioritizing removals", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setThreads } = yield* cleanupFixture();
        const threads = [];
        for (let i = 0; i < 205; i++) {
          const worktreePath = `${worktree}-${i}`;
          yield* fs.makeDirectory(worktreePath);
          threads.push(
            shell({
              id: ThreadId.make(`thread-${i + 2}`),
              branch: "feature",
              worktreePath,
              status: "running",
            }),
          );
        }
        threads.push(shell({ branch: "feature", worktreePath: worktree }));
        setThreads(threads);
        const report = yield* service.runNow;
        expect(report.entries).toHaveLength(200);
        expect(report.omittedCount).toBe(6);
        expect(report.counts).toEqual({ removed: 1, kept: 205, failed: 0 });
        expect(report.entries[0]?.outcome).toBe("removed");
        expect(report.entries[0]?.bytes).toBeGreaterThan(0);
        expect(report.bytesFreed).toBe(report.entries[0]?.bytes);
      }),
    ),
  );
  it.live("keeps staged edits in tracked-only mode", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setPolicy, command } = yield* cleanupFixture();
        setPolicy("tracked-changes");
        yield* fs.writeFileString(`${worktree}/tracked.txt`, "staged\n");
        yield* command(worktree, ["add", "tracked.txt"]);
        expect((yield* service.runNow).entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Has uncommitted changes (1 file)",
        });
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );
  it.live(
    "reports shared and running worktrees but omits disabled rules and missing directories",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          const { service, fs, worktree, setThreads } = fixture;
          setThreads([shell({ branch: "feature", worktreePath: worktree, status: "running" })]);
          expect((yield* service.runNow).entries[0]?.reason).toContain("Thread is running");
          setThreads([
            shell({ branch: "feature", worktreePath: worktree }),
            shell({ id: ThreadId.make("thread-2"), branch: "feature", worktreePath: worktree }),
          ]);
          expect((yield* service.runNow).entries[0]?.reason).toBe("Shared by 2 threads");
          fixture.disable();
          expect((yield* service.runNow).entries).toEqual([]);
          yield* fs.remove(worktree, { recursive: true });
          expect(
            (yield* service.runNow).entries.filter((entry) => entry.kind === "worktree"),
          ).toEqual([]);
        }),
      ),
  );
  it.live("serializes concurrent requests and returns each run's report", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service } = yield* cleanupFixture();
        const reports = yield* Effect.all([service.runNow, service.runNow], {
          concurrency: "unbounded",
        });
        yield* service.drain;
        expect(
          reports.flatMap((report) => report.entries).filter((entry) => entry.kind === "worktree"),
        ).toMatchObject([{ outcome: "removed" }]);
        expect(yield* service.latestReport).toEqual(reports[1]);
      }),
    ),
  );
  it.live("aggregates expired artifacts and rotated logs while retaining current logs", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, config, enableFiles, disable } = yield* cleanupFixture();
        disable();
        enableFiles();
        yield* fs.makeDirectory(config.browserArtifactsDir, { recursive: true });
        yield* fs.makeDirectory(config.logsDir, { recursive: true });
        for (const name of ["one.png", "two.webm"]) {
          const file = config.browserArtifactsDir + "/" + name;
          yield* fs.writeFileString(file, "capture");
          yield* fs.utimes(file, 1, 1);
        }
        for (const name of ["server.log.1", "server.log.2", "server.log"]) {
          const file = config.logsDir + "/" + name;
          yield* fs.writeFileString(file, "log");
          yield* fs.utimes(file, 1, 1);
        }
        const report = yield* service.runNow;
        expect(report.entries.filter((entry) => entry.kind !== "worktree")).toMatchObject([
          {
            kind: "browser-artifacts",
            outcome: "removed",
            reason: "Removed 2 browser artifacts",
            bytes: 14,
            files: 2,
          },
          {
            kind: "logs",
            outcome: "removed",
            reason: "Removed 2 rotated logs",
            bytes: 6,
            files: 2,
          },
        ]);
        expect(report.bytesFreed).toBe(20);
        expect(yield* fs.readDirectory(config.browserArtifactsDir)).toEqual([]);
        expect(yield* fs.exists(config.logsDir + "/server.log")).toBe(true);
        expect(yield* fs.exists(config.logsDir + "/server.log.1")).toBe(false);
        expect(yield* fs.exists(config.logsDir + "/server.log.2")).toBe(false);
      }),
    ),
  );
  it.live("reports git failures without aborting the remaining categories", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, worktree, command, enableFiles } = yield* cleanupFixture();
        enableFiles();
        yield* command(worktree, ["worktree", "lock", worktree]);
        const report = yield* service.runNow;
        expect(report.entries[0]).toMatchObject({ outcome: "failed" });
        expect(report.entries[0]?.reason).toContain("git worktree move (isolate): fatal:");
        expect(report.entries.map((entry) => entry.kind)).toEqual([
          "worktree",
          "browser-artifacts",
          "logs",
        ]);
      }),
    ),
  );
});

describe("settled worktree retention", () => {
  it.effect.each([
    "immediate",
    "settle-script",
    "expired",
    "boundary",
    "wait",
    "recent-update",
    "active",
    "dirty",
    "project-off",
    "project-custom",
    "inactive-settling",
  ] as const)("applies retention and safety checks (%s)", (scenario) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture();
      const days = ["wait", "boundary", "expired", "recent-update"].includes(scenario) ? 8 : 0;
      const rules = {
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeSettledAfterDays:
          scenario === "project-custom" || scenario === "inactive-settling" ? null : days,
        // Another rule must not bypass the settle-script grace either.
        worktreeAfterDays: scenario === "inactive-settling" ? 1 : null,
      };
      fixture.setSettings({
        storageCleanup: rules,
        projectSettingsOverrides: {
          [ProjectId.make("project-1")]:
            scenario === "project-off"
              ? { worktreeCleanup: { mode: "off" } }
              : scenario === "project-custom"
                ? {
                    worktreeCleanup: {
                      mode: "custom",
                      rules: { ...rules, worktreeSettledAfterDays: 0 },
                    },
                  }
                : {},
        },
      });
      const thread = shell({
        branch: "feature",
        worktreePath: fixture.worktree,
        settledAt:
          scenario === "active"
            ? null
            : at(
                scenario === "expired" ||
                  scenario === "recent-update" ||
                  scenario === "inactive-settling"
                  ? -20 * DAY_MS
                  : scenario === "boundary"
                    ? -8 * DAY_MS
                    : scenario === "wait"
                      ? -8 * DAY_MS + 1
                      : scenario === "settle-script"
                        ? 0
                        : -60_000,
              ),
        updatedAt: at(
          scenario === "recent-update" ||
            scenario === "settle-script" ||
            scenario === "inactive-settling"
            ? 0
            : -10 * DAY_MS,
        ),
      });
      fixture.setThreads([thread]);
      if (scenario === "dirty")
        yield* fixture.fs.writeFileString(`${fixture.worktree}/tracked.txt`, "edit\n");
      const report = yield* fixture.service.runNow;
      const removed = ["immediate", "expired", "boundary", "project-custom"].includes(scenario);
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(!removed);
      expect(report.counts.removed).toBe(removed ? 1 : 0);
      if (scenario !== "project-off") {
        const reason =
          scenario === "active"
            ? "Not settled"
            : scenario === "wait"
              ? "Settled for 7 of 8 days"
              : ["settle-script", "recent-update", "inactive-settling"].includes(scenario)
                ? "Settled moments ago"
                : scenario === "dirty"
                  ? "Has uncommitted changes (1 file)"
                  : `Settled for ${scenario === "expired" ? 20 : scenario === "boundary" ? 8 : 0} days`;
        expect(report.entries[0]).toMatchObject({ outcome: removed ? "removed" : "kept", reason });
      }
      expect(thread.branch).toBe("feature");
      expect(
        (yield* fixture.command(fixture.repo, ["rev-parse", "--verify", "refs/heads/feature"]))
          .exitCode,
      ).toBe(0);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );
});

describe("settled worktree rechecks", () => {
  it.live.each([{ settledAt: null }, { settledAt: at(DAY_MS) }])(
    "keeps a checkout changed during measurement (%j)",
    (change) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* pausedMeasurementFixture();
          const thread = shell({
            branch: "feature",
            worktreePath: fixture.worktree,
            settledAt: at(0),
          });
          fixture.setSettings({
            storageCleanup: {
              ...DEFAULT_SERVER_SETTINGS.storageCleanup,
              worktreeSettledAfterDays: 0,
            },
          });
          fixture.setThreads([thread]);
          const run = yield* fixture.service.runNow.pipe(Effect.forkChild);
          yield* Deferred.await(fixture.measuring);
          fixture.setThreads([{ ...thread, ...change }]);
          yield* Deferred.succeed(fixture.resume, undefined);
          const report = yield* Fiber.join(run);
          expect(report.entries[0]?.reason).toBe(
            "Thread activity or shared worktree changed since check",
          );
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );
});

it.live("keeps saved usage data when removing a settled checkout", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* cleanupFixture();
      fixture.setSettings({
        storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, worktreeSettledAfterDays: 0 },
      });
      fixture.setThreads([
        shell({ branch: "feature", worktreePath: fixture.worktree, settledAt: at(0) }),
      ]);
      yield* fixture.fs.makeDirectory(fixture.config.stateDir, { recursive: true });
      const cachePath = `${fixture.config.stateDir}/${SCAN_CACHE_FILE_NAME}`;
      const savedUsage = JSON.stringify({ tokens: 12345, cost: 1.25 });
      yield* fixture.fs.writeFileString(cachePath, savedUsage);
      expect((yield* fixture.service.runNow).counts.removed).toBe(1);
      expect(yield* fixture.fs.readFileString(cachePath)).toBe(savedUsage);
    }),
  ),
);

it.live.each(["thread.settled", "stopped", "ready"] as const)(
  "leaves settled cleanup to the regular sweeps after %s",
  (trigger) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* pausedMeasurementFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeSettledAfterDays: 0,
        });
        fixture.setSettings({
          storageCleanup: {
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            worktreeSettledAfterDays: 0,
          },
        });
        const thread = shell({
          branch: "feature",
          worktreePath: fixture.worktree,
          settledAt: at(0),
        });
        fixture.setThreads([thread]);
        const handled = yield* Deferred.make<void>();
        yield* fixture.activate(
          Stream.fromEffect(Deferred.await(fixture.measuring)).pipe(
            Stream.flatMap(() => Stream.range(0, 19)),
            Stream.map((index): OrchestrationV2DomainEvent =>
              trigger === "thread.settled"
                ? {
                    id: EventId.make(`settled-${index}`),
                    type: "thread.settled",
                    threadId: thread.id,
                    occurredAt: at(0),
                    payload: { ...thread, lastVisitedAt: null },
                  }
                : sessionUpdated(index, trigger),
            ),
            Stream.concat(
              Stream.fromEffect(Deferred.succeed(handled, undefined)).pipe(Stream.drain),
            ),
          ),
        );
        yield* Deferred.await(handled);
        yield* Deferred.succeed(fixture.resume, undefined);
        yield* fixture.service.drain;
        // SCIENT-FORK:START archived-worktree-retention — one sweep: its read plus the two
        // pre-removal rechecks, which reread the archived and queued-run snapshot.
        expect(fixture.snapshotReads()).toBe(3);
        // SCIENT-FORK:END archived-worktree-retention
      }),
    ),
);
