import {
  EnvironmentId,
  ContextHandoffId,
  RunId,
  ProviderThreadId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layerMemory as SqlitePersistenceMemory } from "../../../persistence/Sqlite.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { readHandoffSummaryForInvocation } from "./handlers.ts";
import {
  HANDOFF_SUMMARY_PAGE_CHARS,
  ScientHandoffSummaryReadToolError,
  type ScientHandoffSummaryReadInput,
} from "./tools.ts";

const callerId = ThreadId.make("thread-read-caller");
const siblingId = ThreadId.make("thread-read-sibling");
const foreignId = ThreadId.make("thread-read-foreign");
const projectId = ProjectId.make("project-thread-read");
const instanceId = ProviderInstanceId.make("codex");
const now = DateTime.makeUnsafe("2026-10-04T10:00:00.000Z");
const TestLayer = ProjectionStore.layer.pipe(Layer.provide(SqlitePersistenceMemory));
const invocation = (
  capabilities: AgentInvocationContext.AgentInvocationScope["capabilities"] = new Set([
    "threads:read",
  ]),
) =>
  ({
    environmentId: EnvironmentId.make("environment-thread-read"),
    threadId: callerId,
    providerSessionId: "provider-session-thread-read",
    providerInstanceId: instanceId,
    capabilities,
    issuedAt: 1,
  }) satisfies AgentInvocationContext.AgentInvocationScope;
const read = (
  input: ScientHandoffSummaryReadInput,
  capabilities?: AgentInvocationContext.AgentInvocationScope["capabilities"],
) =>
  readHandoffSummaryForInvocation(input).pipe(
    Effect.provideService(AgentInvocationContext.AgentInvocationContext, invocation(capabilities)),
  );

const seedThread = Effect.fn("seedThreadReadFixture")(function* (
  id: ThreadId,
  options: { projectId?: ProjectId } = {},
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make(`create:${id}`),
    type: "thread.created",
    threadId: id,
    occurredAt: now,
    payload: {
      id,
      projectId: options.projectId ?? projectId,
      title: "Native thread read fixture",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: callerId },
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
});

describe("scient_handoff_summary_read", () => {
  it.effect(
    "pages retained handoff text using the caller's capability and exact thread entitlement",
    () =>
      Effect.gen(function* () {
        yield* seedThread(callerId);
        yield* seedThread(siblingId);
        yield* seedThread(foreignId, { projectId: ProjectId.make("other-project") });
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const handoffId = ContextHandoffId.make("read-summary");
        const summary = 'Original summary 🧪\n\\" ' + "retained ".repeat(3_000);
        yield* store.apply({
          id: EventId.make("summary-created"),
          type: "context-handoff.updated",
          threadId: callerId,
          occurredAt: now,
          payload: {
            id: handoffId,
            threadId: callerId,
            targetRunId: RunId.make("next"),
            fromProviderThreadIds: [],
            toProviderThreadId: ProviderThreadId.make("target"),
            coveredRunOrdinals: { from: 1, to: 1 },
            strategy: "manual_context",
            status: "ready",
            summaryMessageId: null,
            summaryText: summary,
            createdByProviderInstanceId: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        expect(yield* read({ threadId: callerId, contextHandoffId: handoffId })).toEqual({
          text: summary.slice(0, HANDOFF_SUMMARY_PAGE_CHARS),
          nextTextOffset: HANDOFF_SUMMARY_PAGE_CHARS,
        });
        expect(
          yield* read({ threadId: callerId, contextHandoffId: handoffId, textOffset: 31 }),
        ).toEqual({
          text: summary.slice(31, 31 + HANDOFF_SUMMARY_PAGE_CHARS),
          nextTextOffset: 31 + HANDOFF_SUMMARY_PAGE_CHARS,
        });
        expect(
          yield* read({
            threadId: callerId,
            contextHandoffId: handoffId,
            textOffset: HANDOFF_SUMMARY_PAGE_CHARS,
          }),
        ).toEqual({ text: summary.slice(HANDOFF_SUMMARY_PAGE_CHARS), nextTextOffset: null });
        expect(
          yield* read({ threadId: siblingId, contextHandoffId: handoffId }).pipe(Effect.flip),
        ).toMatchObject({ code: "thread_not_found" });
        expect(
          yield* read({ threadId: foreignId, contextHandoffId: handoffId }).pipe(Effect.flip),
        ).toMatchObject({ code: "thread_outside_project" });
        expect(
          yield* read(
            { threadId: callerId, contextHandoffId: handoffId },
            new Set(["sources:read"]),
          ).pipe(Effect.flip),
        ).toMatchObject({ code: "capability_denied" });
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("denies ungranted access before requiring persistence services", () =>
    Effect.gen(function* () {
      expect(
        yield* read(
          { threadId: callerId, contextHandoffId: ContextHandoffId.make("any") },
          new Set(["sources:read"]),
        ).pipe(Effect.flip),
      ).toBeInstanceOf(ScientHandoffSummaryReadToolError);
    }).pipe(Effect.provide(Layer.mock(ProjectionStore.ProjectionStoreV2)({}))),
  );
});
