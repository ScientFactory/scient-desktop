import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2Run,
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
const providerThreadId = ProviderThreadId.make("provider-thread:authority");
const credentialId = "mcp-credential:authority";

const runtime = {
  providerSessionId,
  instanceId,
} as unknown as ProviderAdapterV2SessionRuntime;

const subagent = (
  providerInstanceId: ProviderInstanceId = instanceId,
): OrchestrationV2PendingBackgroundTask => ({
  taskId: "task:subagent",
  kind: "subagent",
  providerInstanceId,
});

const settledRun = (overrides: Partial<OrchestrationV2Run> = {}) =>
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

const spawningRunId = RunId.make("run:spawning");

/** The native subagent record that names the run which started it. */
const subagentRecord = (runId: RunId = spawningRunId) => ({
  origin: "provider_native",
  threadId,
  runId,
  providerInstanceId: instanceId,
  nativeTaskRef: { driver: "codex", nativeId: "task:subagent", strength: "strong" },
});

/** An attempt that actually started the run on the provider thread. */
const startedAttempt = (runId: RunId = spawningRunId) => ({
  runId,
  providerThreadId,
  startedAt: "2026-10-17T00:00:00.000Z",
});

type Records = ProjectionRecords<"runs" | "attempts" | "providerThreads" | "subagents">;

const records = (input: {
  readonly runs?: ReadonlyArray<OrchestrationV2Run>;
  readonly tasks?: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly subagents?: ReadonlyArray<ReturnType<typeof subagentRecord>>;
  readonly attempts?: ReadonlyArray<ReturnType<typeof startedAttempt>>;
  readonly archived?: boolean;
}) =>
  ({
    thread: {
      id: threadId,
      providerInstanceId: instanceId,
      archivedAt: input.archived === true ? "2026-10-17T00:00:00.000Z" : null,
      deletedAt: null,
    },
    runs: input.runs ?? [settledRun()],
    attempts: input.attempts ?? [startedAttempt()],
    subagents: input.subagents ?? [subagentRecord()],
    providerThreads: [
      {
        id: providerThreadId,
        appThreadId: threadId,
        providerSessionId,
        providerInstanceId: instanceId,
        pendingBackgroundTasks: input.tasks ?? [subagent()],
      },
    ],
  }) as unknown as Records;

const resolvePolicy = (projection: Records) =>
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
    });
    return yield* authority.resolveMcpInvocationPolicy({
      threadId,
      providerInstanceId: instanceId,
      providerSessionId: credentialId,
    });
  });

it.effect("a live background subagent keeps the modes of the run that started it", () =>
  Effect.gen(function* () {
    const policy = yield* resolvePolicy(records({}));
    assert.deepEqual(
      policy,
      Option.some({ runtimeMode: "approval-required", interactionMode: "plan" }),
    );
  }),
);

const laterRunId = RunId.make("run:later");
const fullAccessRun = (overrides: Partial<OrchestrationV2Run> = {}) =>
  settledRun({
    id: laterRunId,
    ordinal: 2,
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  });

it.effect.each([
  {
    caseTitle: "a later full-access follow-up cancelled before it started",
    projection: records({ runs: [settledRun(), fullAccessRun({ status: "cancelled" })] }),
  },
  {
    caseTitle: "a held lower-ordinal run that started the subagent after a later run",
    projection: records({
      runs: [settledRun(), fullAccessRun()],
      attempts: [startedAttempt(), startedAttempt(laterRunId)],
    }),
  },
])("binds authority to the run that started the subagent: $caseTitle", ({ projection }) =>
  Effect.gen(function* () {
    assert.deepEqual(
      yield* resolvePolicy(projection),
      Option.some({ runtimeMode: "approval-required", interactionMode: "plan" }),
    );
  }),
);

it.effect.each([
  {
    caseTitle: "a subagent without a native record naming its run",
    projection: records({ subagents: [] }),
  },
  {
    caseTitle: "a subagent named by two native records",
    projection: records({
      runs: [settledRun(), fullAccessRun()],
      attempts: [startedAttempt(), startedAttempt(laterRunId)],
      subagents: [subagentRecord(), subagentRecord(laterRunId)],
    }),
  },
  { caseTitle: "a spawning run that never started", projection: records({ attempts: [] }) },
  { caseTitle: "no pending subagent", projection: records({ tasks: [] }) },
  {
    caseTitle: "only a background command",
    projection: records({ tasks: [{ taskId: "task:command", kind: "command" }] }),
  },
  {
    caseTitle: "a subagent on another provider instance",
    projection: records({ tasks: [subagent(otherInstanceId)] }),
  },
  { caseTitle: "an archived thread", projection: records({ archived: true }) },
  {
    caseTitle: "a spawning run without captured modes",
    projection: records({ runs: [settledRun({ runtimeMode: undefined })] }),
  },
  {
    caseTitle: "a spawning run on another provider instance",
    projection: records({ runs: [settledRun({ providerInstanceId: otherInstanceId })] }),
  },
  {
    caseTitle: "a run that is starting without an attempt",
    projection: records({ runs: [settledRun({ status: "starting" })] }),
  },
])("grants no write authority for $caseTitle", ({ projection }) =>
  Effect.gen(function* () {
    assert.isTrue(Option.isNone(yield* resolvePolicy(projection)));
  }),
);
