import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
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
const providerThreadId = ProviderThreadId.make("provider-thread:authority");
const credentialId = "mcp-credential:authority";
const spawningRunId = RunId.make("run:spawning");
const laterRunId = RunId.make("run:later");

const runtime = {
  providerSessionId,
  instanceId,
} as unknown as ProviderAdapterV2SessionRuntime;

const at = (seconds: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 17, 0, 0, seconds));

/** Pending work as the thread shell derives it, whatever the adapter's identity scheme. */
const pendingSubagent = (
  taskId = "task:subagent",
  providerInstanceId: ProviderInstanceId = instanceId,
): OrchestrationV2PendingBackgroundTask => ({ taskId, kind: "subagent", providerInstanceId });

const run = (overrides: Partial<OrchestrationV2Run> = {}) =>
  ({
    id: spawningRunId,
    ordinal: 1,
    status: "completed",
    providerInstanceId: instanceId,
    providerThreadId,
    runtimeMode: "approval-required",
    interactionMode: "plan",
    ...overrides,
  }) as OrchestrationV2Run;

const laterFullAccessRun = (overrides: Partial<OrchestrationV2Run> = {}) =>
  run({
    id: laterRunId,
    ordinal: 2,
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  });

/** An attempt that actually started its run on the credential's provider thread. */
const started = (runId: RunId, seconds: number) => ({
  runId,
  providerThreadId,
  startedAt: at(seconds),
});

type Records = ProjectionRecords<"runs" | "attempts" | "providerThreads">;

const fixture = (
  input: {
    readonly runs?: ReadonlyArray<OrchestrationV2Run>;
    readonly attempts?: ReadonlyArray<ReturnType<typeof started>>;
    readonly pending?: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
    readonly threadModes?: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    };
    readonly archived?: boolean;
  } = {},
) => {
  const archivedAt = input.archived === true ? at(0) : null;
  const projection = {
    thread: { id: threadId, providerInstanceId: instanceId, archivedAt, deletedAt: null },
    runs: input.runs ?? [run()],
    attempts: input.attempts ?? [started(spawningRunId, 1)],
    // Raw rosters are not consulted: Codex keeps pending subagents in turn items.
    providerThreads: [
      {
        id: providerThreadId,
        appThreadId: threadId,
        providerSessionId,
        providerInstanceId: instanceId,
        pendingBackgroundTasks: [],
      },
    ],
  } as unknown as Records;
  const shell = {
    id: threadId,
    providerInstanceId: instanceId,
    archivedAt,
    activeRunId: null,
    pendingBackgroundTasks: input.pending ?? [pendingSubagent()],
    ...(input.threadModes ?? { runtimeMode: "full-access", interactionMode: "default" }),
  } as unknown as OrchestrationV2ThreadShell;
  return { projection, shell };
};

const resolvePolicy = ({ projection, shell }: ReturnType<typeof fixture>) =>
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
      providerSessionId: credentialId,
    });
  });

it.effect.each([
  {
    caseTitle: "the last started run is narrower than the thread",
    input: {},
    expected: { runtimeMode: "approval-required", interactionMode: "plan" },
  },
  {
    caseTitle: "the thread is narrower than the last started run",
    input: {
      runs: [run({ runtimeMode: "full-access", interactionMode: "default" })],
      threadModes: { runtimeMode: "auto-accept-edits", interactionMode: "plan" },
    },
    expected: { runtimeMode: "auto-accept-edits", interactionMode: "plan" },
  },
  {
    caseTitle: "each mode is capped separately",
    input: {
      runs: [run({ runtimeMode: "approval-required", interactionMode: "default" })],
      threadModes: { runtimeMode: "full-access", interactionMode: "plan" },
    },
    expected: { runtimeMode: "approval-required", interactionMode: "plan" },
  },
  {
    caseTitle: "a later full-access follow-up cancelled before it started",
    input: { runs: [run(), laterFullAccessRun({ status: "cancelled" })] },
    expected: { runtimeMode: "approval-required", interactionMode: "plan" },
  },
  {
    caseTitle: "a held lower-ordinal run that started after a later-numbered run",
    input: {
      runs: [run(), laterFullAccessRun()],
      attempts: [started(laterRunId, 1), started(spawningRunId, 2)],
    },
    expected: { runtimeMode: "approval-required", interactionMode: "plan" },
  },
  {
    caseTitle: "a Codex subagent the shell derives from turn items",
    input: { pending: [pendingSubagent("call_codex_spawn")] },
    expected: { runtimeMode: "approval-required", interactionMode: "plan" },
  },
  {
    caseTitle: "a native-session or Muse subagent named by its node or item id",
    input: { pending: [pendingSubagent("node:subagent"), pendingSubagent("item:muse-agent")] },
    expected: { runtimeMode: "approval-required", interactionMode: "plan" },
  },
] as const)("a live background subagent is capped when $caseTitle", ({ input, expected }) =>
  Effect.gen(function* () {
    assert.deepEqual(yield* resolvePolicy(fixture(input)), Option.some(expected));
  }),
);

it.effect.each([
  { caseTitle: "no run on the session ever started", input: { attempts: [] } },
  { caseTitle: "the subagent is no longer pending", input: { pending: [] } },
  {
    caseTitle: "only a background command is pending",
    input: { pending: [{ taskId: "task:command", kind: "command" as const }] },
  },
  {
    caseTitle: "the subagent runs on another provider instance",
    input: { pending: [pendingSubagent("task:subagent", otherInstanceId)] },
  },
  { caseTitle: "the thread is archived", input: { archived: true } },
  {
    caseTitle: "the last started run lacks captured modes",
    input: { runs: [run({ runtimeMode: undefined })] },
  },
  {
    caseTitle: "the last started run is on another provider instance",
    input: { runs: [run({ providerInstanceId: otherInstanceId })] },
  },
  {
    caseTitle: "a run is starting without an attempt",
    input: { runs: [run({ status: "starting" })] },
  },
])("grants no write authority when $caseTitle", ({ input }) =>
  Effect.gen(function* () {
    assert.isTrue(Option.isNone(yield* resolvePolicy(fixture(input))));
  }),
);
