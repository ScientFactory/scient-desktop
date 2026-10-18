import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import type { ProjectionRecords } from "../ProjectionStore.ts";
import { makeSessionAuthority } from "./SessionAuthority.ts";

const threadId = ThreadId.make("thread:authority");
const instanceId = ProviderInstanceId.make("codex");
const otherInstanceId = ProviderInstanceId.make("codex-other");
const providerSessionId = ProviderSessionId.make("provider-session:authority");
const reboundSessionId = ProviderSessionId.make("provider-session:after-restart");
const providerThreadId = ProviderThreadId.make("provider-thread:authority");
const credentialId = "mcp-credential:authority";
const rootNodeId = NodeId.make("node:root");
const attemptId = RunAttemptId.make("attempt:active");

type Modes = {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
};
const approvalPlan: Modes = { runtimeMode: "approval-required", interactionMode: "plan" };
const fullAccess: Modes = { runtimeMode: "full-access", interactionMode: "default" };
const autoEditsPlan: Modes = { runtimeMode: "auto-accept-edits", interactionMode: "plan" };

const runtime = {
  providerSessionId,
  instanceId,
} as unknown as ProviderAdapterV2SessionRuntime;

const pendingSubagent = (
  providerInstanceId: ProviderInstanceId = instanceId,
): OrchestrationV2PendingBackgroundTask => ({
  taskId: "task:subagent",
  kind: "subagent",
  providerInstanceId,
});

const run = (id: string, overrides: Partial<OrchestrationV2Run> = {}) =>
  ({
    id: RunId.make(id),
    ordinal: 1,
    status: "completed",
    rootNodeId,
    activeAttemptId: null,
    providerInstanceId: instanceId,
    providerThreadId,
    ...fullAccess,
    ...overrides,
  }) as OrchestrationV2Run;

/** A run the native owner is executing now, with its live attempt. */
const activeRun = (status: "starting" | "running", captured: Modes) =>
  run("run:active", { status, activeAttemptId: attemptId, ...captured });

const fixture = (
  input: {
    readonly runs?: ReadonlyArray<OrchestrationV2Run>;
    readonly threadModes?: Modes;
    readonly pending?: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
    readonly activeRunId?: RunId | null;
    readonly shellInstanceId?: ProviderInstanceId;
    readonly providerThreadSessionId?: ProviderSessionId;
    readonly archived?: boolean;
  } = {},
) => {
  const archivedAt = input.archived === true ? "2026-10-17T00:00:00.000Z" : null;
  const runs = input.runs ?? [];
  const projection = {
    thread: { id: threadId, providerInstanceId: instanceId, archivedAt, deletedAt: null },
    runs,
    attempts: runs.some((candidate) => candidate.activeAttemptId === attemptId)
      ? [
          {
            id: attemptId,
            runId: RunId.make("run:active"),
            rootNodeId,
            status: "running",
            providerInstanceId: instanceId,
            providerThreadId,
          },
        ]
      : [],
    providerThreads: [
      {
        id: providerThreadId,
        appThreadId: threadId,
        providerSessionId: input.providerThreadSessionId ?? providerSessionId,
        providerInstanceId: instanceId,
      },
    ],
  } as unknown as ProjectionRecords<"runs" | "attempts" | "providerThreads">;
  const shell = {
    id: threadId,
    providerInstanceId: input.shellInstanceId ?? instanceId,
    archivedAt,
    activeRunId:
      input.activeRunId ??
      runs.find((candidate) => candidate.activeAttemptId === attemptId)?.id ??
      null,
    pendingBackgroundTasks: input.pending ?? [pendingSubagent()],
    ...(input.threadModes ?? approvalPlan),
  } as unknown as OrchestrationV2ThreadShell;
  return { projection, shell };
};

const resolvePolicy = (
  { projection, shell }: ReturnType<typeof fixture>,
  presentedCredential = credentialId,
) =>
  Effect.gen(function* () {
    const sessions = yield* Ref.make(
      new Map([
        [
          String(providerSessionId),
          {
            runtime,
            exposedRuntime: runtime,
            scope: {} as Scope.Closeable,
            attachedThreadIds: new Set([threadId]),
            mcpCredentialIdByThread: new Map([[threadId, credentialId]]),
          },
        ],
      ]),
    );
    const authority = makeSessionAuthority({
      sessions,
      sessionKey: String,
      releasingRuntimes: new WeakSet(),
      readThreadRecords: () => Effect.succeed(projection),
      readThreadShell: () => Effect.succeed(shell),
    });
    return yield* authority.resolveMcpInvocationPolicy({
      threadId,
      providerInstanceId: instanceId,
      providerSessionId: presentedCredential,
    });
  });

it.effect.each([
  {
    caseTitle: "a running run after the thread's modes were lowered gets the lowered modes",
    input: { runs: [activeRun("running", fullAccess)], threadModes: approvalPlan },
    expected: approvalPlan,
  },
  {
    caseTitle: "a starting run after the thread's modes were lowered gets the lowered modes",
    input: { runs: [activeRun("starting", fullAccess)], threadModes: approvalPlan },
    expected: approvalPlan,
  },
  {
    caseTitle: "an active run under wider thread modes keeps its captured modes",
    input: { runs: [activeRun("running", approvalPlan)], threadModes: fullAccess },
    expected: approvalPlan,
  },
  {
    caseTitle: "an active run's captured and current modes are capped separately",
    input: {
      runs: [
        activeRun("running", { runtimeMode: "approval-required", interactionMode: "default" }),
      ],
      threadModes: { runtimeMode: "full-access", interactionMode: "plan" },
    },
    expected: approvalPlan,
  },
  {
    caseTitle: "a live background subagent gets the thread's current modes",
    input: { runs: [run("run:spawning", approvalPlan)], threadModes: autoEditsPlan },
    expected: autoEditsPlan,
  },
  {
    caseTitle: "a full-access follow-up cancelled before it started leaves the thread's modes",
    input: {
      runs: [run("run:spawning", approvalPlan), run("run:later", { status: "cancelled" })],
    },
    expected: approvalPlan,
  },
  {
    caseTitle: "a held run that started out of order leaves the thread's modes",
    input: {
      runs: [run("run:spawning", approvalPlan), run("run:later", { ordinal: 2 })],
    },
    expected: approvalPlan,
  },
  {
    caseTitle: "a provider thread rebound by restart leaves the thread's modes",
    input: { runs: [run("run:before-restart")], providerThreadSessionId: reboundSessionId },
    expected: approvalPlan,
  },
  {
    caseTitle: "a preparing run the shell reports as active gets the thread's modes",
    input: {
      runs: [run("run:preparing", { status: "preparing" })],
      activeRunId: RunId.make("run:preparing"),
      pending: [],
    },
    expected: approvalPlan,
  },
] as const)("$caseTitle", ({ input, expected }) =>
  Effect.gen(function* () {
    assert.deepEqual(yield* resolvePolicy(fixture(input)), Option.some(expected));
  }),
);

it.effect.each([
  { caseTitle: "no run is active and no subagent is pending", input: { pending: [] } },
  { caseTitle: "the thread is archived", input: { archived: true } },
  {
    caseTitle: "the thread switched to another provider instance",
    input: { shellInstanceId: otherInstanceId },
  },
  {
    caseTitle: "the pending subagent runs on another provider instance",
    input: { pending: [pendingSubagent(otherInstanceId)] },
  },
])("grants no write authority when $caseTitle", ({ input }) =>
  Effect.gen(function* () {
    assert.isTrue(Option.isNone(yield* resolvePolicy(fixture(input))));
  }),
);

it.effect("grants no write authority to a stale credential", () =>
  Effect.gen(function* () {
    assert.isTrue(Option.isNone(yield* resolvePolicy(fixture(), "mcp-credential:replaced")));
  }),
);
