import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  ProjectId,
  type Project,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  RelayAgentActivityPublishProofPayload,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import {
  RELAY_ACTIVITY_PUBLISH_TYP,
  RelayJwtError,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";

import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as EnvironmentKeys from "../cloud/environmentKeys.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  isAgentActivityPublishingEnabledValue,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
// SCIENT-FORK:START — Scient Accounts: what Accounts says waits for the person.
import { AccountsError } from "@t3tools/contracts";
import { AccountsService } from "../scient/accounts/AccountsService.ts";
// SCIENT-FORK:END
import * as AgentAwarenessRelay from "./AgentAwarenessRelay.ts";

const THREAD_ID = ThreadId.make("relay-thread");
const SECOND_THREAD_ID = ThreadId.make("relay-thread-2");
const PROJECT_ID = ProjectId.make("relay-project");
const NOW = "2026-09-04T12:00:00.000Z";
const ENVIRONMENT_ID = EnvironmentId.make("relay-environment");
const RELAY_URL = "https://relay.example.test";

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
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
    status: "running",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe(NOW),
    updatedAt: DateTime.makeUnsafe(NOW),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

const CHILD_THREAD_ID = ThreadId.make("relay-child-thread");

function waitingChild(
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return shell({
    id: CHILD_THREAD_ID,
    title: "Child",
    lineage: {
      rootThreadId: THREAD_ID,
      parentThreadId: THREAD_ID,
      relationshipToParent: "subagent",
    },
    createdBy: "agent",
    creationSource: "mcp",
    activityRunStatus: "running",
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("child-request"),
      kind: "command",
      createdAt: DateTime.makeUnsafe(NOW),
    },
    ...overrides,
  });
}

const PublishPayload = Schema.Struct({
  state: Schema.NullOr(RelayAgentActivityState),
  proof: Schema.String,
});
const decodePublishPayload = Schema.decodeUnknownSync(Schema.fromJsonString(PublishPayload));
const EnvironmentKeyPairJson = Schema.fromJsonString(
  Schema.Struct({ privateKey: Schema.String, publicKey: Schema.String }),
);
const decodeEnvironmentKeyPair = Schema.decodeUnknownOption(EnvironmentKeyPairJson);
const unused = () => Effect.die("Unexpected test dependency call");

describe("startup agent activity", () => {
  it("publishes active work and only terminal runs completed after startup", () => {
    const startedAt = DateTime.toEpochMillis(DateTime.makeUnsafe(NOW));
    const oldCompleted = ThreadId.make("old-completed");
    const newCompleted = ThreadId.make("new-completed");
    const oldFailed = ThreadId.make("old-failed");
    const newFailed = ThreadId.make("new-failed");
    const ids = AgentAwarenessRelay.resolveAgentAwarenessRelayActiveThreadIds({
      environmentId: EnvironmentId.make("relay-env"),
      startedAt,
      projects: [{ id: PROJECT_ID, title: "Project" }],
      threads: [
        shell(),
        shell({
          id: oldCompleted,
          status: "completed",
          latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T11:59:00.000Z"),
        }),
        shell({
          id: newCompleted,
          status: "completed",
          latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T12:00:01.000Z"),
        }),
        shell({
          id: oldFailed,
          status: "failed",
          latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T11:59:00.000Z"),
        }),
        shell({
          id: newFailed,
          status: "failed",
          latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T12:00:01.000Z"),
        }),
        shell({ id: ThreadId.make("idle"), status: "idle" }),
        shell({ id: ThreadId.make("missing-project"), projectId: ProjectId.make("missing") }),
      ],
    });
    assert.deepStrictEqual(ids, [THREAD_ID, newCompleted, newFailed]);
  });
});

const makeTestRelay = Effect.fnUntraced(function* (
  options: {
    // SCIENT-FORK:START — Scient Accounts: a relay answer can be held, as a slow relay holds it.
    readonly respond?: (attempt: number) => Response | Promise<Response>;
    // SCIENT-FORK:END
    readonly failSecretRead?: (name: string) => boolean;
    readonly linked?: boolean;
    readonly readShell?: (threadId: ThreadId) => Effect.Effect<OrchestrationV2ThreadShell | null>;
    /** Serves the project from this source instead of the default project. */
    readonly readProject?: (projectId: ProjectId) => Option.Option<Project>;
    readonly domainEvents?: Stream.Stream<OrchestrationV2DomainEvent>;
    readonly catchUpThreads?: ReadonlyArray<OrchestrationV2ThreadShell>;
    // SCIENT-FORK:START — Scient Accounts: what Accounts says waits for the person.
    readonly accounts?: AccountsService["Service"];
    /** Runs after a secret's value is read and before it is returned, as a slow store does. */
    readonly beforeSecretReturns?: (name: string) => Effect.Effect<void>;
    // SCIENT-FORK:END
  } = {},
) {
  const values = new Map<string, Uint8Array>(
    options.linked === false
      ? []
      : [
          [PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true")],
          [RELAY_URL_SECRET, new TextEncoder().encode("https://relay.example.test")],
          [RELAY_ISSUER_SECRET, new TextEncoder().encode("https://relay.example.test")],
          [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode("credential-1")],
        ],
  );
  const secretReads: string[] = [];
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) =>
      Effect.suspend(() => {
        secretReads.push(name);
        if (options.failSecretRead?.(name)) {
          return Effect.fail(
            new ServerSecretStore.SecretStoreReadError({
              resource: name,
              cause: "temporary read failure",
            }),
          );
        }
        // SCIENT-FORK:START — Scient Accounts: a read can return its value after a relink.
        const value = Option.fromUndefinedOr(values.get(name));
        return (options.beforeSecretReturns?.(name) ?? Effect.void).pipe(Effect.as(value));
        // SCIENT-FORK:END
      }),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    remove: (name) => Effect.sync(() => void values.delete(name)),
    getOrCreateRandom: unused,
  });
  const currentShell = yield* Ref.make<OrchestrationV2ThreadShell | null>(shell());
  const shellReads: ThreadId[] = [];
  const catchUp = { activitySnapshotReads: 0 };
  const threads = ThreadManagementService.ThreadManagementService.of({
    getThreadShell: unused,
    getThreadLinkMetadata: unused,
    getShellSnapshot: unused,
    getAgentAwarenessSnapshot: (threadId) =>
      threadId === undefined
        ? Effect.sync(() => {
            catchUp.activitySnapshotReads += 1;
            return { snapshotSequence: 1, threads: options.catchUpThreads ?? [] };
          })
        : Effect.sync(() => shellReads.push(threadId)).pipe(
            Effect.andThen(options.readShell?.(threadId) ?? Ref.get(currentShell)),
            Effect.map((thread) => ({
              snapshotSequence: 1,
              threads: thread === null ? [] : [thread],
            })),
          ),
    listActiveSubagentThreadIds: unused,
    listAppOwnedChildThreadIds: unused,
    countThreads: unused,
    listActiveShellIndex: () => Effect.succeed([]),
    listOlderSettledThreads: unused,
    readShellSnapshot: unused,
    getThreadTitles: unused,
    ensureLegacyTranscript: unused,
    dispatch: unused,
    searchThread: () => Effect.die("unused"),
    searchThreadStream: () => Stream.empty,
    getThreadHistoryPage: () => Effect.die("unused"),
    getTimelinePage: () => Effect.die("Unused timeline read"),
    getMessageCount: () => Effect.die("unused message count"),
    getRunCount: () => Effect.die("unused run count"),
    getMessagesById: () => Effect.die("unused messages by id"),
    getTurnItem: () => Effect.die("unused turn item read"),
    getThreadRecords: () => Effect.die("unused record read"),
    getThreadProjection: unused,
    getCheckpointContext: unused,
    getThreadSnapshot: unused,
    getThreadTranscript: unused,
    getThreadSnapshotWindow: unused,
    getProjectThreadRecords: () => Effect.die("unused project record read"),
    listProjectThreads: unused,
    sendToThread: unused,
    submitRunOutput: unused,
    assertProviderInstanceEnabled: unused,
    isProviderInstanceEnabledForProject: unused,
    hasReceipt: unused,
    waitForThread: unused,
    settleAfterRun: unused,
    settleThread: unused,
    interruptThread: unused,
    stopWorkflow: () => Effect.die("unused stopWorkflow"),
    forceStopThread: () => Effect.die("unused forceStopThread"),
    awaitBackgroundTasks: unused,
    stopDelegatedTasks: unused,
    getThreadEventSequence: unused,
    recoverDelegatedTask: unused,
    cancelDelegatedTask: unused,
    delegatedTaskResultPending: unused,
    streamStoredEvents: Stream.empty,
    streamStoredEventsFrom: () => Stream.empty,
    streamDomainEvents: options.domainEvents ?? Stream.empty,
  });
  const publications: Array<{
    readonly url: string;
    readonly authorization: string | null;
    readonly state: RelayAgentActivityState | null;
    readonly proof: string;
  }> = [];
  const fetch: typeof globalThis.fetch = Object.assign(
    (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const body = init?.body;
      if (typeof body !== "string" && !(body instanceof Uint8Array)) {
        return Promise.reject(new Error("Expected a serialized activity publish payload"));
      }
      const payload = decodePublishPayload(
        typeof body === "string" ? body : new TextDecoder().decode(body),
      );
      publications.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        state: payload.state,
        proof: payload.proof,
      });
      try {
        return Promise.resolve(
          options.respond?.(publications.length) ?? Response.json({ ok: true, deliveries: [] }),
        );
      } catch (error) {
        return Promise.reject(error);
      }
    },
    { preconnect: () => {} },
  );
  const project = {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace",
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
  const relay = yield* AgentAwarenessRelay.make.pipe(
    Effect.provide(EnvironmentKeys.layer),
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
    Effect.provideService(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
      getDescriptor: unused(),
    }),
    Effect.provideService(ProjectService.ProjectService, {
      create: unused,
      bootstrap: unused,
      update: unused,
      delete: unused,
      getByWorkspaceRoot: unused,
      workspaceScanDirectory: unused,
      snapshot: Effect.succeed({ projects: [project], updatedAt: NOW }),
      listPage: unused,
      getShell: unused,
      listShells: unused,
      getById: (projectId) =>
        Effect.succeed(options.readProject?.(projectId) ?? Option.some(project)),
    }),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provide(NodeCrypto.layer),
    // SCIENT-FORK:START — Scient Accounts: what Accounts says waits for the person.
    (effect) =>
      options.accounts === undefined
        ? effect
        : Effect.provideService(effect, AccountsService, options.accounts),
    // SCIENT-FORK:END
  );
  // The relay generates and persists its own signing key pair; read it back so a
  // test can verify the proof it attaches to a publish.
  const keyPairBytes = yield* secrets
    .get("cloud-link-ed25519-key-pair")
    .pipe(Effect.map((bytes) => Option.map(bytes, (value) => new TextDecoder().decode(value))));
  const keyPair = yield* Option.match(Option.flatMap(keyPairBytes, decodeEnvironmentKeyPair), {
    onNone: () => Effect.die("The relay did not persist an environment signing key pair"),
    onSome: Effect.succeed,
  });
  return {
    relay,
    secrets,
    secretReads,
    currentShell,
    shellReads,
    publications,
    catchUp,
    keyPair,
  };
});

describe("AgentAwarenessRelay", () => {
  it("requires an explicit opt-in before publishing agent activity", () => {
    assert.isFalse(isAgentActivityPublishingEnabledValue(null));
    assert.isFalse(isAgentActivityPublishingEnabledValue("false"));
    assert.isFalse(isAgentActivityPublishingEnabledValue("TRUE"));
    assert.isTrue(isAgentActivityPublishingEnabledValue("true"));
  });

  it.effect("signs the publish proof over the published state and rejects tampering", () =>
    Effect.gen(function* () {
      const { relay, keyPair, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      const proof = publications[0]?.proof;
      assert.isDefined(proof);
      const verify = (token: string) =>
        verifyRelayJwt(RelayAgentActivityPublishProofPayload, {
          publicKey: keyPair.publicKey,
          token,
          typ: RELAY_ACTIVITY_PUBLISH_TYP,
          issuer: `t3-env:${ENVIRONMENT_ID}`,
          audience: RELAY_URL,
        }).pipe(Effect.provide(NodeCrypto.layerSignature));

      const payload = yield* verify(proof!);
      assert.deepEqual(payload.environmentId, ENVIRONMENT_ID);
      assert.deepEqual(payload.threadId, THREAD_ID);
      assert.deepEqual(payload.state, publications[0]?.state);

      const [header, body, signature = ""] = proof!.split(".");
      const corrupted = `${signature.startsWith("a") ? "b" : "a"}${signature.slice(1)}`;
      const rejection = yield* verify(`${header}.${body}.${corrupted}`).pipe(Effect.flip);
      assert.instanceOf(rejection, RelayJwtError);
    }),
  );

  it.effect("publishes a null state while the thread's project is gone", () =>
    Effect.gen(function* () {
      const { relay, publications } = yield* makeTestRelay({ readProject: () => Option.none() });
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 0);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 1);
      assert.isNull(publications[0]?.state);
    }),
  );

  it.effect("publishes the parent as needing approval while its subagent waits", () =>
    Effect.gen(function* () {
      const shells = yield* Ref.make(
        new Map<ThreadId, OrchestrationV2ThreadShell>([
          [THREAD_ID, shell({ status: "running" })],
          [CHILD_THREAD_ID, waitingChild({ pendingRuntimeRequest: null })],
        ]),
      );
      const setShell = (next: OrchestrationV2ThreadShell) =>
        Ref.update(shells, (current) => new Map(current).set(next.id, next));
      const { relay, publications } = yield* makeTestRelay({
        readShell: (threadId) =>
          Ref.get(shells).pipe(Effect.map((current) => current.get(threadId) ?? null)),
      });
      yield* relay.publishThread(THREAD_ID);
      yield* setShell(shell({ status: "completed" }));
      yield* setShell(waitingChild());
      yield* relay.publishThread(CHILD_THREAD_ID);
      assert.equal(publications.length, 2);
      assert.isTrue(publications[1]?.url.includes(`/threads/${THREAD_ID}/`) ?? false);
      assert.equal(publications[1]?.state?.phase, "waiting_for_approval");

      // A rename keeps the same request's alert time, so the phone doesn't re-alert.
      yield* setShell(
        shell({
          status: "completed",
          title: "Renamed thread",
          updatedAt: DateTime.makeUnsafe("2026-09-04T12:01:00.000Z"),
        }),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 3);
      assert.equal(publications[2]?.state?.threadTitle, "Renamed thread");
      assert.equal(publications[2]?.state?.updatedAt, publications[1]?.state?.updatedAt);

      yield* setShell(waitingChild({ pendingRuntimeRequest: null }));
      yield* relay.publishThread(CHILD_THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 4);
      assert.equal(publications[3]?.state?.phase, "completed");
    }),
  );

  it.effect("publishes the parent as needing input when its subagent raises a secret card", () =>
    Effect.gen(function* () {
      const now = DateTime.makeUnsafe(NOW);
      const child = waitingChild({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("child-secret-card"),
          kind: "user_input",
          createdAt: now,
          blocking: true,
          userOnly: true,
        },
      });
      const parent = shell({ status: "completed" });
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const pulls = yield* Queue.unbounded<void>();
      const { relay, publications } = yield* makeTestRelay({
        readShell: (threadId) => Effect.succeed(threadId === child.id ? child : parent),
        domainEvents: Stream.fromEffectRepeat(
          Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
        ),
      });
      yield* relay.start();
      yield* Queue.take(pulls);
      const runId = RunId.make("run:child-secret-card");
      // Recording a secret card emits only this event for the child.
      yield* Queue.offer(events, {
        id: EventId.make("event:child-secret-card"),
        type: "turn-item.updated",
        threadId: CHILD_THREAD_ID,
        runId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("child-secret-card"),
          threadId: CHILD_THREAD_ID,
          runId,
          nodeId: NodeId.make("node:child-secret-card"),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "waiting",
          title: "SMS code",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "secret_request",
          label: "SMS code",
          reason: "The agent needs the code.",
          secretStatus: "pending",
        },
      });
      yield* Queue.take(pulls);
      yield* relay.drain;
      assert.equal(publications.length, 1);
      assert.isTrue(publications[0]?.url.includes(`/threads/${THREAD_ID}/`) ?? false);
      assert.equal(publications[0]?.state?.phase, "waiting_for_input");
    }),
  );

  it.effect(
    "clears the parent's input wait when the user steers its subagent past a link card",
    () =>
      Effect.gen(function* () {
        const now = DateTime.makeUnsafe(NOW);
        let child = waitingChild({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("child-link-card"),
            kind: "user_input",
            createdAt: now,
            blocking: true,
            userOnly: true,
          },
        });
        const parent = shell({ status: "completed" });
        const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const pulls = yield* Queue.unbounded<void>();
        const { relay, publications } = yield* makeTestRelay({
          readShell: (threadId) => Effect.succeed(threadId === child.id ? child : parent),
          domainEvents: Stream.fromEffectRepeat(
            Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
          ),
        });
        yield* relay.start();
        yield* Queue.take(pulls);
        const runId = RunId.make("run:child-link-card");
        const item = {
          threadId: CHILD_THREAD_ID,
          runId,
          nodeId: NodeId.make("node:child-link-card"),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          title: null,
          startedAt: now,
          updatedAt: now,
        } as const;
        yield* Queue.offer(events, {
          id: EventId.make("event:child-link-card"),
          type: "turn-item.updated",
          threadId: CHILD_THREAD_ID,
          runId,
          occurredAt: now,
          payload: {
            ...item,
            id: TurnItemId.make("child-link-card"),
            ordinal: 1,
            status: "waiting",
            completedAt: null,
            type: "link_request",
            url: "https://example.com/login",
            label: "Sign in",
            reason: "The agent needs you to sign in.",
            linkStatus: "pending",
          },
        });
        yield* Queue.take(pulls);
        yield* relay.drain;
        assert.equal(publications[0]?.state?.phase, "waiting_for_input");

        // Steering a running child records only these events for it; the
        // projection then stops counting the link card as pending.
        child = waitingChild({ pendingRuntimeRequest: null });
        yield* Queue.offer(events, {
          id: EventId.make("event:child-steer"),
          type: "turn-item.updated",
          threadId: CHILD_THREAD_ID,
          runId,
          occurredAt: now,
          payload: {
            ...item,
            id: TurnItemId.make("child-steer"),
            ordinal: 2,
            status: "completed",
            completedAt: now,
            createdBy: "user",
            creationSource: "web",
            type: "user_message",
            messageId: MessageId.make("message:child-steer"),
            inputIntent: "steer",
            text: "Skip the login.",
            attachments: [],
          },
        });
        yield* Queue.take(pulls);
        // The relay confirms a move into completed before publishing it.
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.equal(publications.length, 2);
        assert.equal(publications[1]?.state?.phase, "completed");
      }),
  );

  it.effect("republishes a completed parent for its waiting child after a relink", () =>
    Effect.gen(function* () {
      const parent = shell({ status: "completed" });
      const child = waitingChild();
      const { relay, secrets, publications } = yield* makeTestRelay({
        catchUpThreads: [parent, child],
        readShell: (id) => Effect.succeed(id === child.id ? child : parent),
      });
      yield* relay.start();
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.equal(publications.length, 1);
      assert.equal(publications[0]?.state?.phase, "waiting_for_approval");

      yield* secrets.set(
        RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
        new TextEncoder().encode("credential-2"),
      );
      yield* relay.requestCatchUp();
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.state?.phase, "waiting_for_approval");
    }),
  );

  it.effect("keeps a child's alert time when the parent's own request comes and goes", () =>
    Effect.gen(function* () {
      const shells = yield* Ref.make(
        new Map<ThreadId, OrchestrationV2ThreadShell>([
          [THREAD_ID, shell()],
          [CHILD_THREAD_ID, waitingChild()],
        ]),
      );
      const setParent = (next: OrchestrationV2ThreadShell) =>
        Ref.update(shells, (current) => new Map(current).set(THREAD_ID, next));
      const { relay, publications } = yield* makeTestRelay({
        readShell: (threadId) =>
          Ref.get(shells).pipe(Effect.map((current) => current.get(threadId) ?? null)),
      });
      yield* relay.publishThread(CHILD_THREAD_ID);
      yield* setParent(
        shell({
          updatedAt: DateTime.makeUnsafe("2026-09-04T12:01:00.000Z"),
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("parent-request"),
            kind: "command",
            createdAt: DateTime.makeUnsafe("2026-09-04T12:01:00.000Z"),
          },
        }),
      );
      yield* relay.publishThread(THREAD_ID);
      yield* setParent(shell({ updatedAt: DateTime.makeUnsafe("2026-09-04T12:02:00.000Z") }));
      yield* relay.publishThread(THREAD_ID);
      assert.deepStrictEqual(
        publications.map(({ state }) => state?.phase),
        ["waiting_for_approval", "waiting_for_approval", "waiting_for_approval"],
      );
      assert.equal(publications[2]?.state?.updatedAt, publications[0]?.state?.updatedAt);
    }),
  );

  it.effect("coalesces queued updates and reruns a thread dirtied during publishing", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const rerunStarted = yield* Deferred.make<void>();
      const releaseRerun = yield* Deferred.make<void>();
      const processed: Array<{ threadId: ThreadId; revision: number }> = [];
      let revision = 1;
      const worker = yield* AgentAwarenessRelay.makeAgentAwarenessPublishWorker((threadId) =>
        Effect.gen(function* () {
          const currentRevision = revision;
          const index = processed.length;
          processed.push({ threadId, revision: currentRevision });
          if (index === 0) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          } else if (threadId === THREAD_ID) {
            yield* Deferred.succeed(rerunStarted, undefined);
            yield* Deferred.await(releaseRerun);
          }
        }),
      );
      yield* worker.enqueue(THREAD_ID);
      yield* Deferred.await(started);
      revision = 2;
      for (let i = 0; i < 100; i++) {
        yield* worker.enqueue(SECOND_THREAD_ID);
        yield* worker.enqueue(THREAD_ID);
      }
      const drained = yield* Deferred.make<void>();
      const draining = yield* worker.drain.pipe(
        Effect.andThen(Deferred.succeed(drained, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(rerunStarted);
      assert.isFalse(yield* Deferred.isDone(drained));
      yield* Deferred.succeed(releaseRerun, undefined);
      yield* Fiber.join(draining);
      assert.deepEqual(processed, [
        { threadId: THREAD_ID, revision: 1 },
        { threadId: SECOND_THREAD_ID, revision: 2 },
        { threadId: THREAD_ID, revision: 2 },
      ]);
    }),
  );

  it.effect("deduplicates state and republishes title changes", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(
        currentShell,
        shell({ updatedAt: DateTime.makeUnsafe("2026-09-04T13:00:00Z") }),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 1);
      yield* Ref.set(currentShell, shell({ title: "Renamed thread" }));
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.state?.threadTitle, "Renamed thread");
    }),
  );

  it.effect("republishes unchanged state with fresh credentials after relinking", () =>
    Effect.gen(function* () {
      const { relay, secrets, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* secrets.set(
        RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
        new TextEncoder().encode("credential-2"),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 2);
      assert.equal(publications[0]?.authorization, "Bearer credential-1");
      assert.equal(publications[1]?.authorization, "Bearer credential-2");
      yield* secrets.set(
        RELAY_URL_SECRET,
        new TextEncoder().encode("https://new-relay.example.test"),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 3);
      assert.isTrue(publications[2]?.url.startsWith("https://new-relay.example.test/") ?? false);
    }),
  );

  it.effect.each(["completed", "failed"] as const)(
    "publishes a tombstone when a %s thread is settled through a domain event",
    (status) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const pulls = yield* Queue.unbounded<void>();
        const { relay, currentShell, publications } = yield* makeTestRelay({
          domainEvents: Stream.fromEffectRepeat(
            Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
          ),
        });
        yield* relay.start();
        yield* Queue.take(pulls);
        yield* relay.publishThread(THREAD_ID);
        const terminal = shell({ status });
        yield* Ref.set(currentShell, terminal);
        yield* relay.publishThread(THREAD_ID);
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.equal(publications[1]?.state?.phase, status);

        const now = yield* DateTime.now;
        const settled = {
          ...terminal,
          settledOverride: "settled" as const,
          settledAt: now,
          lastVisitedAt: null,
        };
        yield* Ref.set(currentShell, settled);
        yield* Queue.offer(events, {
          id: EventId.make("event:settled"),
          type: "thread.settled",
          threadId: THREAD_ID,
          occurredAt: now,
          payload: settled,
        });
        yield* Queue.take(pulls);
        yield* relay.drain;
        assert.equal(publications.length, 2);
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.equal(publications.length, 3);
        assert.equal(publications[2]?.state, null);
      }),
  );

  it.effect("holds a completion through a continuation gap, then publishes it once", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, shell({ status: "completed" }));
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, shell());
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase),
        ["running"],
      );

      yield* Ref.set(currentShell, shell({ status: "completed" }));
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 1);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase),
        ["running", "completed"],
      );
    }),
  );

  it.effect(
    "clears a completion that landed while snoozed, even when processed after the wake",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(NOW)));
        const { relay, currentShell, publications } = yield* makeTestRelay();
        const snooze = {
          snoozedAt: DateTime.makeUnsafe(NOW),
          snoozedUntil: DateTime.makeUnsafe("2026-09-04T13:00:00.000Z"),
        };
        yield* Ref.set(currentShell, shell(snooze));
        yield* relay.publishThread(THREAD_ID);
        yield* TestClock.adjust("2 hours");
        yield* Ref.set(
          currentShell,
          shell({
            ...snooze,
            status: "completed",
            latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T12:30:00.000Z"),
          }),
        );
        yield* relay.publishThread(THREAD_ID);
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.deepEqual(
          publications.map((publication) => publication.state?.phase ?? null),
          ["running", null],
        );
      }),
  );

  it.effect("still publishes a completion when the thread settles during the hold", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      const completed = shell({ status: "completed" });
      yield* Ref.set(currentShell, completed);
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, {
        ...completed,
        settledOverride: "settled",
        settledAt: yield* DateTime.now,
        lastVisitedAt: null,
      });
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        ["running", "completed"],
      );

      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        ["running", "completed", null],
      );
    }),
  );

  it.effect("publishes a cleared thread's tombstone once while it stays cleared", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      const completed = shell({ status: "completed" });
      yield* Ref.set(currentShell, completed);
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      yield* Ref.set(currentShell, {
        ...completed,
        settledOverride: "settled",
        settledAt: yield* DateTime.now,
        lastVisitedAt: null,
      });
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        ["running", "completed", null],
      );

      for (let i = 0; i < 3; i++) {
        yield* relay.publishThread(THREAD_ID);
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
      }
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        ["running", "completed", null],
      );
    }),
  );

  it.effect("does not alert an old completion after publishing its thread's tombstone", () =>
    Effect.gen(function* () {
      const oldCompleted = shell({
        status: "completed",
        latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T11:59:00.000Z"),
      });
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(NOW)));
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* Ref.set(currentShell, {
        ...oldCompleted,
        settledOverride: "settled",
        settledAt: DateTime.makeUnsafe(NOW),
        lastVisitedAt: null,
      });
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state),
        [null],
      );

      yield* Ref.set(currentShell, oldCompleted);
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state),
        [null],
      );
    }),
  );

  it.effect("alerts a completion settled during its hold after an earlier tombstone", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(NOW)));
      const { relay, currentShell, publications } = yield* makeTestRelay();
      const settledAt = DateTime.makeUnsafe(NOW);
      yield* Ref.set(currentShell, {
        ...shell({ status: "completed" }),
        settledOverride: "settled",
        settledAt,
        lastVisitedAt: null,
      });
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;

      const completed = shell({
        status: "completed",
        latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T12:00:06.000Z"),
      });
      yield* Ref.set(currentShell, completed);
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, {
        ...completed,
        settledOverride: "settled",
        settledAt,
        lastVisitedAt: null,
      });
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        [null, "completed", null],
      );
    }),
  );

  it.effect("drops a held completion when a queued continuation hides the thread", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, shell({ status: "completed" }));
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, shell({ status: "queued" }));
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.notInclude(
        publications.map((publication) => publication.state?.phase ?? null),
        "completed",
      );
    }),
  );

  it.effect("retries a failed completion even after the thread settles", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay({
        respond: (attempt) =>
          attempt === 2
            ? new Response("unavailable", { status: 503 })
            : Response.json({ ok: true, deliveries: [] }),
      });
      yield* relay.publishThread(THREAD_ID);
      const completed = shell({ status: "completed" });
      yield* Ref.set(currentShell, completed);
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      yield* Ref.set(currentShell, {
        ...completed,
        settledOverride: "settled",
        settledAt: yield* DateTime.now,
        lastVisitedAt: null,
      });
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        ["running", "completed", "completed"],
      );

      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.at(-1)?.state ?? null, null);
    }),
  );

  it.effect("delivers a completion once the network returns after the retry budget runs out", () =>
    Effect.gen(function* () {
      let networkUp = true;
      const delivered: Array<string | null> = [];
      const { relay, currentShell, publications } = yield* makeTestRelay({
        respond: (attempt) => {
          if (!networkUp) throw new TypeError("fetch failed: getaddrinfo EAI_AGAIN");
          delivered.push(publications[attempt - 1]?.state?.phase ?? null);
          return Response.json({ ok: true, deliveries: [] });
        },
      });
      yield* relay.publishThread(THREAD_ID);
      networkUp = false;
      yield* Ref.set(currentShell, shell({ status: "completed" }));
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      for (const delay of [
        "1 second",
        "2 seconds",
        "4 seconds",
        "8 seconds",
        "16 seconds",
      ] as const) {
        yield* TestClock.adjust(delay);
        yield* relay.drain;
      }
      assert.equal(publications.length, 7);
      assert.deepEqual(delivered, ["running"]);

      networkUp = true;
      yield* TestClock.adjust("10 minutes");
      yield* relay.drain;
      assert.deepEqual(delivered, ["running", "completed"]);
    }),
  );

  it.effect("keeps settled live work until its awaited monitor finishes", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      const held = shell({
        status: "completed",
        settledOverride: "settled",
        pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor", awaited: true }],
      });
      yield* Ref.set(currentShell, held);
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 1);
      assert.equal(publications[0]?.state?.phase, "running");

      yield* Ref.set(currentShell, { ...held, pendingBackgroundTasks: [] });
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.state, null);
    }),
  );
  it.effect("publishes a held completion when its background item ends, not on tool output", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const pulls = yield* Queue.unbounded<void>();
      const { relay, shellReads, publications } = yield* makeTestRelay({
        readShell: (threadId) => store.getThreadShell(threadId).pipe(Effect.orDie),
        domainEvents: Stream.fromEffectRepeat(
          Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
        ),
      });
      yield* relay.start();
      yield* Queue.take(pulls);
      const deliver = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
        yield* store.apply(event);
        yield* Queue.offer(events, event);
        yield* Queue.take(pulls);
        yield* relay.drain;
      });

      const now = yield* DateTime.now;
      const runId = RunId.make("run:held-item");
      const run = {
        id: runId,
        threadId: THREAD_ID,
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
        providerThreadId: null,
        userMessageId: MessageId.make("message:held-item"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const item = (
        id: string,
        fields: Pick<OrchestrationV2TurnItem, "status"> &
          (
            | { readonly type: "dynamic_tool"; readonly toolName: string; readonly input: unknown }
            | {
                readonly type: "assistant_message";
                readonly messageId: MessageId;
                readonly text: string;
                readonly streaming: boolean;
              }
          ),
      ): OrchestrationV2TurnItem => ({
        id: TurnItemId.make(id),
        threadId: THREAD_ID,
        runId,
        nodeId: NodeId.make("node:held-item"),
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        ...fields,
      });
      const itemEvent = (id: string, payload: OrchestrationV2TurnItem) =>
        ({
          id: EventId.make(id),
          type: "turn-item.updated",
          threadId: THREAD_ID,
          runId,
          occurredAt: now,
          payload,
        }) satisfies OrchestrationV2DomainEvent;
      const background = { type: "dynamic_tool" as const, toolName: "watch", input: {} };

      yield* deliver({
        id: EventId.make("event:held-item:thread"),
        type: "thread.created",
        threadId: THREAD_ID,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Thread",
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* deliver({
        id: EventId.make("event:held-item:run"),
        type: "run.created",
        threadId: THREAD_ID,
        runId,
        occurredAt: now,
        payload: run,
      });
      yield* deliver(
        itemEvent("event:held-item:tool", item("item:tool", { ...background, status: "running" })),
      );
      yield* deliver({
        id: EventId.make("event:held-item:run-completed"),
        type: "run.updated",
        threadId: THREAD_ID,
        runId,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase),
        ["running"],
      );

      const readsBeforeOutput = shellReads.length;
      yield* deliver(
        itemEvent(
          "event:held-item:reply",
          item("item:reply", {
            type: "assistant_message",
            messageId: MessageId.make("message:held-item:reply"),
            text: "Still watching",
            streaming: true,
            status: "running",
          }),
        ),
      );
      yield* deliver(
        itemEvent("event:held-item:tick", item("item:tool", { ...background, status: "running" })),
      );
      assert.equal(shellReads.length, readsBeforeOutput);

      yield* deliver(
        itemEvent("event:held-item:end", item("item:tool", { ...background, status: "completed" })),
      );
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase),
        ["running", "completed"],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ProjectionStore.layer.pipe(
          Layer.provide(NodeCrypto.layer),
          Layer.provide(SqlitePersistence.layerMemory),
        ),
      ),
    ),
  );
});

it.effect("catches up after startup without polling after success", () =>
  Effect.gen(function* () {
    const { relay, secrets, secretReads, catchUp, publications } = yield* makeTestRelay({
      catchUpThreads: [shell()],
    });
    yield* relay.start();
    yield* TestClock.adjust("1 second");
    yield* relay.drain;
    assert.equal(catchUp.activitySnapshotReads, 1);
    assert.equal(publications.length, 1);
    assert.include(publications[0]?.state, {
      threadId: THREAD_ID,
      projectTitle: "Project",
      threadTitle: "Thread",
      phase: "running",
    });

    yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("false"));
    yield* relay.requestCatchUp();
    yield* TestClock.adjust("1 second");
    assert.equal(catchUp.activitySnapshotReads, 1);

    yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true"));
    yield* relay.requestCatchUp();
    yield* TestClock.adjust("1 second");
    assert.equal(catchUp.activitySnapshotReads, 2);

    const readsBeforeIdle = secretReads.length;
    yield* TestClock.adjust("10 minutes");
    assert.equal(catchUp.activitySnapshotReads, 2);
    assert.equal(secretReads.length, readsBeforeIdle);

    yield* secrets.set(
      RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
      new TextEncoder().encode("credential-2"),
    );
    yield* relay.requestCatchUp();
    yield* TestClock.adjust("1 second");
    yield* relay.drain;
    assert.equal(catchUp.activitySnapshotReads, 3);
    assert.equal(publications.length, 2);
    assert.equal(publications[1]?.state?.threadId, THREAD_ID);
  }),
);

// SCIENT-FORK:START — Scient Accounts: a background sign-in's notice reaches the phone.
it.effect("pushes a background sign-in's notice, which has no chat, as needing approval", () =>
  Effect.gen(function* () {
    const renewal = ThreadId.make("scient-accounts-renewal");
    const { relay, publications } = yield* makeTestRelay({
      readShell: (threadId) => (threadId === renewal ? Effect.succeed(null) : Effect.never),
      accounts: {
        snapshot: Effect.succeed({ approvals: [], handoffs: [], needsYou: [] }),
        changes: Stream.make({
          approvals: [],
          handoffs: [],
          needsYou: [
            {
              needId: "sign-in:acc_gov",
              name: "gov.il",
              detail: "Waiting for a code",
              accountId: "acc_gov",
              threadId: renewal,
            },
          ],
        }),
      } as unknown as AccountsService["Service"],
    });
    // The Accounts change reaches the relay's queue, then the queue publishes.
    yield* Effect.yieldNow;
    yield* relay.drain;
    // regression: a thread with no shell published nothing, so a locked phone saw only the SMS.
    const pushed = publications.find((entry) => entry.state?.threadId === renewal);
    assert.equal(pushed?.state?.phase, "waiting_for_approval");
    assert.equal(pushed?.state?.detail, "gov.il: Waiting for a code");
  }),
);

it.effect(
  "pushes a code notice naming its site, unsent, even when the sign-in already worked",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const delivered: string[] = [];
      const text = "gov.il: That code is Scient signing in to gov.il";
      const { relay, publications } = yield* makeTestRelay({
        readShell: () => Effect.succeed(null),
        accounts: {
          snapshot: Effect.succeed({ approvals: [], handoffs: [], needsYou: [] }),
          // The sign-in finished before the relay took the notice.
          changes: Stream.make({
            approvals: [],
            handoffs: [],
            needsYou: [
              {
                needId: "sign-in:acc_gov",
                name: "gov.il",
                detail: "That code is Scient signing in to gov.il",
                accountId: "acc_gov",
                threadId: ThreadId.make("scient-accounts-renewal"),
              },
            ],
            codeNotices: [
              { noticeId: "n1", accountId: "acc_gov", text, at: NOW, settled: "signed-in" },
            ],
          }),
          codeNoticeDelivered: (noticeId: string) =>
            Effect.sync(() => void delivered.push(noticeId)),
        } as unknown as AccountsService["Service"],
      });
      yield* Effect.repeat(Effect.yieldNow, { times: 10 });
      yield* relay.drain;
      const notice = publications.filter(
        (entry) => entry.state?.threadId === "scient-accounts-notice-n1",
      );
      // regression: the push named no site, and a quick sign-in could take it back unsent.
      assert.equal(notice[0]?.state?.phase, "waiting_for_approval");
      assert.equal(notice[0]?.state?.threadTitle, text);
      assert.deepEqual(delivered, ["n1"]);
      // The same words in Needs you aren't pushed twice.
      assert.isUndefined(
        publications.find((entry) => entry.state?.threadId === "scient-accounts-renewal"),
      );
    }),
);

it.effect(
  "keeps a notice's row unchanged through its outcome, then retires both after its time",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const cleared: string[] = [];
      const text = "gov.il: That code is Scient signing in to gov.il";
      const notice = { noticeId: "n2", accountId: "acc_gov", text, at: NOW };
      const settled = {
        ...notice,
        delivered: true,
        settled: "signed-in",
        settledAt: "2026-09-04T12:00:03.000Z",
      };
      const { relay, publications } = yield* makeTestRelay({
        readShell: () => Effect.succeed(null),
        accounts: {
          snapshot: Effect.succeed({
            approvals: [],
            handoffs: [],
            needsYou: [],
            codeNotices: [notice],
          }),
          changes: Stream.make({
            approvals: [],
            handoffs: [],
            needsYou: [],
            codeNotices: [settled],
          }),
          codeNoticeDelivered: () => Effect.void,
          codeNoticeCleared: (noticeId: string, row: string) =>
            Effect.sync(() => void cleared.push(`${noticeId}:${row}`)),
        } as unknown as AccountsService["Service"],
      });
      yield* Effect.repeat(Effect.yieldNow, { times: 10 });
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      const rows = (threadId: string) =>
        publications.filter(
          (entry) =>
            entry.state?.threadId === threadId ||
            (entry.state === null && entry.url.includes(threadId)),
        );
      // regression: the outcome replaced the notice's waiting phase, so a queued push was dropped.
      const noticeRows = publications.filter(
        (entry) => entry.state?.threadId === "scient-accounts-notice-n2",
      );
      assert.deepEqual(
        noticeRows.map((entry) => entry.state?.phase),
        ["waiting_for_approval"],
      );
      const outcome = publications.find(
        (entry) => entry.state?.threadId === "scient-accounts-notice-n2-done",
      );
      assert.equal(outcome?.state?.phase, "completed");
      assert.equal(outcome?.state?.threadTitle, `${text} · Signed in`);
      // Silent, so it adds no second alert, and dated as it settled.
      // regression: it was backdated three minutes past the relay's alert window instead.
      assert.equal(outcome?.state?.silent, true);
      assert.equal(outcome?.state?.updatedAt, "2026-09-04T12:00:03.000Z");
      // Its time is up: both rows go, then Accounts lets the notice go.
      yield* TestClock.adjust("30 minutes");
      yield* Effect.repeat(Effect.yieldNow, { times: 10 });
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.isAtLeast(
        rows("scient-accounts-notice-n2").filter((entry) => entry.state === null).length,
        1,
      );
      // regression: only the notice row was acknowledged, so its outcome row's id could be lost.
      assert.deepEqual([...new Set(cleared)].toSorted(), ["n2:notice", "n2:settled"]);
    }),
);

it.effect("after a restart, retires a notice whose time ran out while it was down", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW) + 60 * 60 * 1000);
    const cleared: string[] = [];
    const old = {
      noticeId: "n3",
      accountId: "acc_gov",
      text: "gov.il: x",
      at: NOW,
      delivered: true,
    };
    const { relay } = yield* makeTestRelay({
      readShell: () => Effect.succeed(null),
      accounts: {
        snapshot: Effect.succeed({ approvals: [], handoffs: [], needsYou: [], codeNotices: [old] }),
        changes: Stream.empty,
        codeNoticeDelivered: () => Effect.void,
        codeNoticeCleared: (noticeId: string, row: string) =>
          Effect.sync(() => void cleared.push(`${noticeId}:${row}`)),
      } as unknown as AccountsService["Service"],
    });
    yield* Effect.repeat(Effect.yieldNow, { times: 10 });
    yield* TestClock.adjust("5 seconds");
    yield* relay.drain;
    // regression: a row published before the restart stood on the phone until it expired there.
    assert.include(cleared, "n3:notice");
  }),
);

it.effect("publishes the notice rows standing again after a relink", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const notice = { noticeId: "n4", accountId: "acc_gov", text: "gov.il: x", at: NOW };
    const { relay, secrets, publications } = yield* makeTestRelay({
      readShell: () => Effect.succeed(null),
      accounts: {
        snapshot: Effect.succeed({
          approvals: [],
          handoffs: [],
          needsYou: [],
          codeNotices: [notice],
        }),
        changes: Stream.empty,
        codeNoticeDelivered: () => Effect.void,
      } as unknown as AccountsService["Service"],
    });
    yield* Effect.repeat(Effect.yieldNow, { times: 10 });
    yield* relay.drain;
    yield* secrets.set(
      RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
      new TextEncoder().encode("credential-2"),
    );
    // The link's own catch-up, as after a relink.
    yield* relay.start();
    yield* TestClock.adjust("1 second");
    yield* Effect.repeat(Effect.yieldNow, { times: 10 });
    yield* relay.drain;
    const rows = publications.filter(
      (entry) => entry.state?.threadId === "scient-accounts-notice-n4",
    );
    // regression: catch-up after a relink republished chats only, so the notice row was lost there.
    assert.deepEqual(
      rows.map((entry) => entry.authorization),
      ["Bearer credential-1", "Bearer credential-2"],
    );
  }),
);

it.effect("retries a notice on its own queue, while the chats' queue is held up", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const notice = { noticeId: "n5", accountId: "acc_gov", text: "gov.il: x", at: NOW };
    const { relay, publications } = yield* makeTestRelay({
      // A chat whose read never ends holds the ordinary queue.
      readShell: (threadId) => (threadId === THREAD_ID ? Effect.never : Effect.succeed(null)),
      // The notice's first try fails.
      respond: (attempt) =>
        attempt === 1
          ? new Response("unavailable", { status: 503 })
          : Response.json({ ok: true, deliveries: [] }),
      accounts: {
        snapshot: Effect.succeed({ approvals: [], handoffs: [], needsYou: [] }),
        changes: Stream.fromEffect(
          Effect.succeed({ approvals: [], handoffs: [], needsYou: [], codeNotices: [notice] }).pipe(
            Effect.delay("1 millis"),
          ),
        ),
        codeNoticeDelivered: () => Effect.void,
      } as unknown as AccountsService["Service"],
    });
    yield* relay.publishThread(THREAD_ID).pipe(Effect.forkChild);
    yield* Effect.repeat(Effect.yieldNow, { times: 10 });
    yield* TestClock.adjust("1 millis");
    yield* Effect.repeat(Effect.yieldNow, { times: 10 });
    yield* TestClock.adjust("1 second");
    yield* Effect.repeat(Effect.yieldNow, { times: 20 });
    const rows = publications.filter(
      (entry) => entry.state?.threadId === "scient-accounts-notice-n5",
    );
    // regression: the retry went to the chats' queue and waited behind it.
    assert.equal(rows.length, 2);
  }),
);
/** Lets promises (a held relay answer) and the fibers waiting on them run, with no clock. */
const settle = Effect.repeat(
  Effect.promise(() => Promise.resolve()).pipe(Effect.andThen(Effect.yieldNow)),
  { times: 200 },
);

it.effect("republishes the notice rows on a relink while the chats' catch-up is held", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const notice = { noticeId: "n6", accountId: "acc_gov", text: "gov.il: x", at: NOW };
    const { relay, secrets, publications } = yield* makeTestRelay({
      // The chat the catch-up publishes never finishes reading, so that catch-up never ends.
      catchUpThreads: [shell()],
      readShell: (threadId) => (threadId === THREAD_ID ? Effect.never : Effect.succeed(null)),
      accounts: {
        snapshot: Effect.succeed({
          approvals: [],
          handoffs: [],
          needsYou: [],
          codeNotices: [notice],
        }),
        changes: Stream.empty,
        codeNoticeDelivered: () => Effect.void,
      } as unknown as AccountsService["Service"],
    });
    yield* relay.start();
    yield* TestClock.adjust("1 second");
    yield* settle;
    yield* secrets.set(
      RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
      new TextEncoder().encode("credential-2"),
    );
    yield* relay.requestCatchUp();
    yield* TestClock.adjust("1 second");
    yield* settle;
    const rows = publications.filter(
      (entry) => entry.state?.threadId === "scient-accounts-notice-n6",
    );
    // regression: the notice rows went again only from the catch-up, which the chat held.
    assert.deepEqual(
      rows.map((entry) => entry.authorization),
      ["Bearer credential-1", "Bearer credential-2"],
    );
  }),
);

it.effect("doesn't let a notice's answer from the old relay stand for the new one", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const notice = { noticeId: "n7", accountId: "acc_gov", text: "gov.il: x", at: NOW };
    const delivered: string[] = [];
    let release: (response: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => (release = resolve));
    const { relay, secrets, publications } = yield* makeTestRelay({
      readShell: () => Effect.succeed(null),
      // The old relay takes its time over the notice row's first publish.
      respond: (attempt) => (attempt === 1 ? held : Response.json({ ok: true, deliveries: [] })),
      accounts: {
        snapshot: Effect.succeed({
          approvals: [],
          handoffs: [],
          needsYou: [],
          codeNotices: [notice],
        }),
        changes: Stream.empty,
        codeNoticeDelivered: (noticeId: string) => Effect.sync(() => void delivered.push(noticeId)),
      } as unknown as AccountsService["Service"],
    });
    yield* settle;
    assert.equal(publications.length, 1);
    // Relinked meanwhile: the chats' next publish moves to the new relay.
    yield* secrets.set(
      RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
      new TextEncoder().encode("credential-2"),
    );
    yield* relay.publishThread(THREAD_ID);
    // Then the old relay's answer comes, and the link's catch-up runs.
    release(Response.json({ ok: true, deliveries: [] }));
    yield* settle;
    yield* relay.requestCatchUp();
    yield* settle;
    yield* relay.drain;
    const rows = publications.filter(
      (entry) => entry.state?.threadId === "scient-accounts-notice-n7",
    );
    // regression: the old answer recorded the row as published, so the new relay never got it.
    assert.deepEqual(
      rows.map((entry) => entry.authorization),
      ["Bearer credential-1", "Bearer credential-2"],
    );
    // Acknowledged once, for the new relay's answer.
    assert.deepEqual(delivered, ["n7"]);
  }),
);
it.effect("acknowledges nothing for an old relay's answer that comes after the new link", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const notice = { noticeId: "n8", accountId: "acc_gov", text: "gov.il: x", at: NOW };
    /** How many publishes had gone out at each acknowledgement. */
    const delivered: number[] = [];
    let release: (response: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => (release = resolve));
    const { relay, secrets, publications } = yield* makeTestRelay({
      readShell: () => Effect.succeed(null),
      respond: (attempt) => (attempt === 1 ? held : Response.json({ ok: true, deliveries: [] })),
      accounts: {
        snapshot: Effect.succeed({
          approvals: [],
          handoffs: [],
          needsYou: [],
          codeNotices: [notice],
        }),
        changes: Stream.empty,
        codeNoticeDelivered: () => Effect.sync(() => void delivered.push(publications.length)),
      } as unknown as AccountsService["Service"],
    });
    yield* settle;
    // The new link is committed while the old relay still holds the notice row's publish.
    yield* secrets.set(
      RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
      new TextEncoder().encode("credential-2"),
    );
    yield* relay.requestCatchUp();
    release(Response.json({ ok: true, deliveries: [] }));
    yield* settle;
    yield* relay.drain;
    const rows = publications.filter(
      (entry) => entry.state?.threadId === "scient-accounts-notice-n8",
    );
    assert.deepEqual(
      rows.map((entry) => entry.authorization),
      ["Bearer credential-1", "Bearer credential-2"],
    );
    // regression: no publish had read the new link yet, so the old answer was acknowledged.
    assert.deepEqual(delivered, [2]);
  }),
);

it.effect("lets no new link land while Accounts acknowledges a notice, and still reaches it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const notice = { noticeId: "n9", accountId: "acc_gov", text: "gov.il: x", at: NOW };
    const acknowledging = yield* Deferred.make<void>();
    let acknowledgements = 0;
    const { relay, secrets, publications } = yield* makeTestRelay({
      readShell: () => Effect.succeed(null),
      accounts: {
        snapshot: Effect.succeed({
          approvals: [],
          handoffs: [],
          needsYou: [],
          codeNotices: [notice],
        }),
        changes: Stream.empty,
        // The first acknowledgement takes its time.
        codeNoticeDelivered: () =>
          ++acknowledgements === 1 ? Deferred.await(acknowledging) : Effect.void,
      } as unknown as AccountsService["Service"],
    });
    yield* settle;
    // Relinked meanwhile; the chats' next publish reads the new link only once Accounts is done.
    yield* secrets.set(
      RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
      new TextEncoder().encode("credential-2"),
    );
    const chats = yield* relay.publishThread(THREAD_ID).pipe(Effect.forkChild);
    yield* settle;
    yield* Deferred.succeed(acknowledging, undefined);
    yield* Fiber.join(chats);
    yield* relay.requestCatchUp();
    yield* settle;
    yield* relay.drain;
    const rows = publications.filter(
      (entry) => entry.state?.threadId === "scient-accounts-notice-n9",
    );
    // regression: the old publish recorded its row after the reset, so nothing went to the new one.
    assert.deepEqual(
      rows.map((entry) => entry.authorization),
      ["Bearer credential-1", "Bearer credential-2"],
    );
  }),
);
it.effect("commits no acknowledgement from the old relay once the link changed under it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const notice = { noticeId: "n10", accountId: "acc_gov", text: "gov.il: x", at: NOW };
    const linkWritten = yield* Deferred.make<void>();
    /** Acknowledgements Accounts wrote. */
    const committed: string[] = [];
    let release: (response: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => (release = resolve));
    const { relay, secrets, publications } = yield* makeTestRelay({
      readShell: () => Effect.succeed(null),
      // The old relay takes the row, slowly; the new one refuses it for now.
      respond: (attempt) => (attempt === 1 ? held : new Response("unavailable", { status: 503 })),
      accounts: {
        snapshot: Effect.succeed({
          approvals: [],
          handoffs: [],
          needsYou: [],
          codeNotices: [notice],
        }),
        changes: Stream.empty,
        // Accounts asks, inside its write, whether the link is still the one acknowledged.
        codeNoticeDelivered: (noticeId: string, current?: () => boolean) =>
          Effect.sync(() => void (current?.() !== false && committed.push(noticeId))),
      } as unknown as AccountsService["Service"],
    });
    yield* settle;
    assert.equal(publications.length, 1);
    // The new link is being written when the old relay's answer comes.
    const relinking = yield* relay
      .replacingLink(
        secrets
          .set(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode("credential-2"))
          .pipe(Effect.andThen(Deferred.await(linkWritten))),
      )
      .pipe(Effect.forkChild);
    yield* settle;
    release(Response.json({ ok: true, deliveries: [] }));
    yield* settle;
    yield* Deferred.succeed(linkWritten, undefined);
    yield* Fiber.join(relinking);
    const rowsOf = () =>
      publications.filter((entry) => entry.state?.threadId === "scient-accounts-notice-n10");
    // The acknowledgement runs off the queue: wait for the row's publish on the new link.
    for (let tries = 0; tries < 50 && rowsOf().length < 2; tries++) yield* settle;
    const rows = rowsOf();
    assert.deepEqual(
      rows.map((entry) => entry.authorization),
      ["Bearer credential-1", "Bearer credential-2"],
    );
    // regression: the old acknowledgement committed after the relink, while the new relay refused.
    assert.deepEqual(committed, []);
  }),
);
it.effect("changes the link only after a notice acknowledgement's durable write", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const notice = { noticeId: "n11", accountId: "acc_gov", text: "gov.il: x", at: NOW };
    const writing = yield* Deferred.make<void>();
    /** What happened, in order: Accounts' check, its write landing, and the link change. */
    const events: string[] = [];
    const { relay, secrets, publications } = yield* makeTestRelay({
      readShell: () => Effect.succeed(null),
      accounts: {
        snapshot: Effect.succeed({
          approvals: [],
          handoffs: [],
          needsYou: [],
          codeNotices: [notice],
        }),
        changes: Stream.empty,
        // Accounts checks the link, then its write to disk takes its time.
        codeNoticeDelivered: (_noticeId: string, current?: () => boolean) =>
          Effect.suspend(() => {
            if (current?.() === false) return Effect.sync(() => void events.push("refused"));
            events.push("checked");
            return Deferred.await(writing).pipe(
              Effect.andThen(Effect.sync(() => void events.push("written"))),
            );
          }),
      } as unknown as AccountsService["Service"],
    });
    yield* settle;
    assert.deepEqual(events, ["checked"]);
    // The link changes while the acknowledgement is being written.
    const relinking = yield* relay
      .replacingLink(
        secrets
          .set(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode("credential-2"))
          .pipe(Effect.andThen(Effect.sync(() => void events.push("relinked")))),
      )
      .pipe(Effect.forkChild);
    yield* settle;
    // regression: the old acknowledgement's write landed after the relink, and survived it.
    assert.deepEqual(events, ["checked"]);
    yield* Deferred.succeed(writing, undefined);
    yield* Fiber.join(relinking);
    assert.deepEqual(events, ["checked", "written", "relinked"]);
    // The new link gets the row again, and its acknowledgement is its own.
    yield* relay.requestCatchUp();
    yield* settle;
    yield* relay.drain;
    const rows = publications.filter(
      (entry) => entry.state?.threadId === "scient-accounts-notice-n11",
    );
    assert.deepEqual(
      rows.map((entry) => entry.authorization),
      ["Bearer credential-1", "Bearer credential-2"],
    );
  }),
);
it.effect("never pairs a link read before a relink with the generation after it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const notice = { noticeId: "n12", accountId: "acc_gov", text: "gov.il: x", at: NOW };
    const reading = yield* Deferred.make<void>();
    const answer = yield* Deferred.make<void>();
    let held = false;
    /** The credential each acknowledgement was for: the newest publish's when Accounts wrote it. */
    const acknowledged: Array<string | null> = [];
    const { relay, secrets, publications } = yield* makeTestRelay({
      readShell: () => Effect.succeed(null),
      // The first read of the credential returns the old one only after the relink has run.
      beforeSecretReturns: (name) =>
        name === RELAY_ENVIRONMENT_CREDENTIAL_SECRET && !held
          ? Effect.sync(() => void (held = true)).pipe(
              Effect.andThen(Deferred.succeed(reading, undefined)),
              Effect.andThen(Deferred.await(answer)),
            )
          : Effect.void,
      accounts: {
        snapshot: Effect.succeed({
          approvals: [],
          handoffs: [],
          needsYou: [],
          codeNotices: [notice],
        }),
        changes: Stream.empty,
        codeNoticeDelivered: (_noticeId: string, current?: () => boolean) =>
          Effect.sync(
            () =>
              void (
                current?.() !== false &&
                acknowledged.push(publications.at(-1)?.authorization ?? null)
              ),
          ),
      } as unknown as AccountsService["Service"],
    });
    yield* Deferred.await(reading);
    const relinking = yield* relay
      .replacingLink(
        secrets.set(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode("credential-2")),
      )
      .pipe(Effect.forkChild);
    yield* settle;
    yield* Deferred.succeed(answer, undefined);
    yield* Fiber.join(relinking);
    yield* settle;
    yield* relay.drain;
    // regression: the old credential, read across the relink, got the new generation, so its
    // answer acknowledged the notice for the new link.
    assert.deepEqual(acknowledged, ["Bearer credential-2"]);
  }),
);
it.effect("lets a stuck acknowledgement hold neither the next notice nor a chat", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const stuck = { noticeId: "n13", accountId: "acc_gov", text: "gov.il: x", at: NOW };
    const next = { noticeId: "n14", accountId: "acc_gov", text: "gov.il: y", at: NOW };
    const { relay, publications } = yield* makeTestRelay({
      accounts: {
        snapshot: Effect.succeed({
          approvals: [],
          handoffs: [],
          needsYou: [],
          codeNotices: [stuck, next],
        }),
        changes: Stream.empty,
        // Accounts never finishes the first acknowledgement.
        codeNoticeDelivered: (noticeId: string) =>
          noticeId === "n13" ? Effect.never : Effect.void,
      } as unknown as AccountsService["Service"],
    });
    yield* settle;
    // A chat's publish finishes, though the first acknowledgement never does.
    yield* relay.publishThread(THREAD_ID);
    yield* settle;
    // regression: the notice queue and every link read waited on the stuck acknowledgement.
    assert.isTrue(
      publications.some((entry) => entry.state?.threadId === "scient-accounts-notice-n14"),
    );
    assert.isTrue(publications.some((entry) => entry.state?.threadId === THREAD_ID));
  }),
);
it.effect("lets a waiting link change go before link reads that come after it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const notice = { noticeId: "n15", accountId: "acc_gov", text: "gov.il: x", at: NOW };
    const writing = yield* Deferred.make<void>();
    const { relay, secrets, publications } = yield* makeTestRelay({
      accounts: {
        snapshot: Effect.succeed({
          approvals: [],
          handoffs: [],
          needsYou: [],
          codeNotices: [notice],
        }),
        changes: Stream.empty,
        // Accounts takes its time over the acknowledgement.
        codeNoticeDelivered: () => Deferred.await(writing),
      } as unknown as AccountsService["Service"],
    });
    yield* settle;
    const relinking = yield* relay
      .replacingLink(
        secrets.set(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode("credential-2")),
      )
      .pipe(Effect.forkChild);
    yield* settle;
    // A chat's publish reads the link while the change waits for the acknowledgement.
    const chats = yield* relay.publishThread(THREAD_ID).pipe(Effect.forkChild);
    yield* settle;
    yield* Deferred.succeed(writing, undefined);
    yield* Fiber.join(relinking);
    yield* Fiber.join(chats);
    // regression: new readers overtook the waiting change, so the chat went to the old link.
    assert.deepEqual(
      publications
        .filter((entry) => entry.state?.threadId === THREAD_ID)
        .map((entry) => entry.authorization),
      ["Bearer credential-2"],
    );
  }),
);

it.effect("changes the link anyway once an acknowledgement is stuck past the bound", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const notice = { noticeId: "n16", accountId: "acc_gov", text: "gov.il: x", at: NOW };
    const writeEnds = yield* Deferred.make<void>();
    const { relay, secrets } = yield* makeTestRelay({
      readShell: () => Effect.succeed(null),
      accounts: {
        snapshot: Effect.succeed({
          approvals: [],
          handoffs: [],
          needsYou: [],
          codeNotices: [notice],
        }),
        changes: Stream.empty,
        // Accounts' write can't be interrupted, and doesn't end while the link changes.
        codeNoticeDelivered: () => Effect.uninterruptible(Deferred.await(writeEnds)),
      } as unknown as AccountsService["Service"],
    });
    yield* settle;
    const relinking = yield* relay
      .replacingLink(
        secrets.set(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode("credential-2")),
      )
      .pipe(Effect.forkChild);
    yield* settle;
    // regression: the change waited on Accounts' write for ever.
    yield* TestClock.adjust("16 seconds");
    yield* Fiber.join(relinking);
    assert.equal(
      new TextDecoder().decode(
        Option.getOrThrow(yield* secrets.get(RELAY_ENVIRONMENT_CREDENTIAL_SECRET)),
      ),
      "credential-2",
    );
    yield* Deferred.succeed(writeEnds, undefined);
  }),
);

it.effect("retries an acknowledgement Accounts couldn't write until it lands", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const notice = { noticeId: "n17", accountId: "acc_gov", text: "gov.il: x", at: NOW };
    let tries = 0;
    let landed = false;
    const { relay } = yield* makeTestRelay({
      readShell: () => Effect.succeed(null),
      accounts: {
        snapshot: Effect.succeed({
          approvals: [],
          handoffs: [],
          needsYou: [],
          codeNotices: [notice],
        }),
        changes: Stream.empty,
        // The write fails six times, more than the retry waits there are, then works.
        codeNoticeDelivered: () =>
          ++tries <= 6
            ? Effect.fail(new AccountsError({ reason: "unavailable", message: "Synthetic: disk." }))
            : Effect.sync(() => void (landed = true)),
      } as unknown as AccountsService["Service"],
    });
    yield* settle;
    for (let minute = 0; minute < 40; minute++) {
      yield* TestClock.adjust("1 minute");
      yield* settle;
    }
    // regression: write failures were swallowed as done, and the retries ran out.
    assert.equal(tries, 7);
    assert.isTrue(landed);
    yield* relay.drain;
  }),
);
// SCIENT-FORK:END
