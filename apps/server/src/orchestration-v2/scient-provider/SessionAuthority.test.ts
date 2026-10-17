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
    id: RunId.make("run:spawning"),
    ordinal: 1,
    status: "completed",
    providerInstanceId: instanceId,
    providerThreadId,
    runtimeMode: "approval-required",
    interactionMode: "plan",
    ...overrides,
  }) as OrchestrationV2Run;

const records = (input: {
  readonly runs?: ReadonlyArray<OrchestrationV2Run>;
  readonly tasks?: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
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
    attempts: [],
    providerThreads: [
      {
        id: providerThreadId,
        appThreadId: threadId,
        providerSessionId,
        providerInstanceId: instanceId,
        pendingBackgroundTasks: input.tasks ?? [subagent()],
      },
    ],
  }) as unknown as ProjectionRecords<"runs" | "attempts" | "providerThreads">;

const resolvePolicy = (projection: ProjectionRecords<"runs" | "attempts" | "providerThreads">) =>
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

it.effect.each([
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
