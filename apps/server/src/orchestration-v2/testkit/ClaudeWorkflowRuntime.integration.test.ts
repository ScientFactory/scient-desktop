import * as Crypto from "effect/Crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Claude from "../Adapters/ClaudeAdapterV2.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as Registry from "../ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";
import { CLAUDE_MODEL_SELECTION } from "./fixtures/shared.ts";

const settings = Schema.decodeSync(ClaudeSettings)({});
const nativeSession = "00000000-0000-4000-8000-000000000961";
const sdkFrame = (frame: unknown): SDKMessage => frame as SDKMessage;

it.live("ingests coordinator-owned workflow members after successful root settlement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("claude-workflow-runtime");
      const fileSystem = yield* FileSystem.FileSystem;
      const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-workflow-attachments-",
      });
      const messages = yield* Queue.unbounded<SDKMessage>();
      const offered = yield* Deferred.make<void>();
      const adapter = Claude.makeClaudeAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId: Claude.CLAUDE_DEFAULT_INSTANCE_ID,
        settings,
        environment: {},
        attachmentsDir,
        fileSystem,
        path: yield* Path.Path,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        queryRunner: {
          allocateSessionId: Effect.succeed(nativeSession),
          open: () =>
            Effect.succeed({
              setPermissionMode: () =>
                Effect.die("Permission-mode mutation is outside this fixture."),
              messages: Stream.fromQueue(messages),
              offer: (message) =>
                Queue.offer(
                  messages,
                  sdkFrame({
                    ...message,
                    session_id: nativeSession,
                    parent_tool_use_id: null,
                  }),
                ).pipe(Effect.andThen(Deferred.succeed(offered, undefined)), Effect.asVoid),
              setModel: () => Effect.void,
              interrupt: Effect.void,
              close: Queue.shutdown(messages),
            }),
          forkSession: () => Effect.die("unused native workflow fork"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          assertComplete: Effect.void,
        },
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const now = DateTime.formatIso(yield* DateTime.now);
        const projectId = ProjectId.make("project:claude-workflow-runtime");
        const threadId = ThreadId.make("thread:claude-workflow-runtime");
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make("project:workflow:created"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Workflow",
            workspaceRoot: cwd,
            defaultModelSelection: CLAUDE_MODEL_SELECTION,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        const waitForProjection = Effect.fnUntraced(function* (
          predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
        ) {
          // Capture a durable cursor before reading SQL. Replay plus the subscribed
          // live tail closes the commit/read race without polling or fixed sleeps.
          const cursor = yield* orchestrator.getThreadEventSequence(threadId);
          const pull = yield* Stream.toPull(
            orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
          );
          const initial = yield* orchestrator.getThreadProjection(threadId);
          const found = yield* Stream.concat(
            Stream.succeed(initial),
            Stream.fromPull(Effect.succeed(pull)).pipe(
              Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
            ),
          ).pipe(
            Stream.filter(predicate),
            Stream.runHead,
            Effect.timeout("10 seconds"),
            Effect.tapCause(() =>
              orchestrator
                .getThreadProjection(threadId)
                .pipe(
                  Effect.flatMap((projection) =>
                    Effect.logError(
                      "Synthetic workflow convergence",
                      projection.runs,
                      projection.subagents,
                      projection.nodes,
                    ),
                  ),
                ),
            ),
          );
          return yield* Option.match(found, {
            onNone: () => Effect.die("Native workflow projection did not converge."),
            onSome: Effect.succeed,
          });
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("workflow:create"),
          threadId,
          projectId,
          createdBy: "user",
          creationSource: "web",
          title: "Workflow",
          modelSelection: CLAUDE_MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("workflow:start"),
          threadId,
          messageId: MessageId.make("workflow:prompt"),
          createdBy: "user",
          creationSource: "web",
          text: "Audit",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
        yield* Deferred.await(offered).pipe(
          Effect.timeout("10 seconds"),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const projection = yield* orchestrator.getThreadProjection(threadId);
              yield* Effect.logError(
                "Synthetic workflow did not reach SDK offer",
                projection.runs,
                projection.attempts,
                projection.providerThreads,
              );
              return yield* Effect.failCause(cause);
            }),
          ),
        );
        const progress = (tokens: number) =>
          sdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: "runtime-workflow",
            description: "Inspect",
            workflow_progress: [
              { type: "workflow_phase", index: 0, title: "Inspect" },
              {
                type: "workflow_agent",
                index: 0,
                label: "Reader",
                state: "running",
                startedAt: "2026-10-04T00:00:00.000Z",
                attempt: 1,
                tokens,
              },
            ],
            uuid: "00000000-0000-4000-8000-000000000962",
            session_id: nativeSession,
          });
        yield* Queue.offerAll(messages, [
          sdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: "runtime-workflow",
            task_type: "local_workflow",
            description: "Audit",
            is_backgrounded: true,
            uuid: "00000000-0000-4000-8000-000000000963",
            session_id: nativeSession,
          }),
          progress(40),
          sdkFrame({
            type: "result",
            subtype: "success",
            duration_ms: 10,
            duration_api_ms: 10,
            is_error: false,
            num_turns: 1,
            result: "Background workflow started",
            stop_reason: "end_turn",
            terminal_reason: "success",
            total_cost_usd: 0,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            modelUsage: {},
            permission_denials: [],
            uuid: "00000000-0000-4000-8000-000000000964",
            session_id: nativeSession,
          }),
        ]);
        const settled = yield* waitForProjection(
          (projection) =>
            projection.runs.at(-1)?.status === "completed" &&
            projection.subagents.some((member) => member.presentation?.kind === "workflow_agent"),
        );
        const member = settled.subagents.find(
          (candidate) => candidate.presentation?.kind === "workflow_agent",
        );
        assert.isDefined(member);
        assert.equal(member?.status, "running");
        assert.isNull(member?.runId);
        assert.isNull(member?.nativeTaskRef);
        assert.isNull(member?.childThreadId);
        yield* Queue.offer(messages, progress(65));
        const live = yield* waitForProjection((projection) =>
          projection.subagents.some(
            (candidate) =>
              candidate.id === member?.id && candidate.presentation?.usage?.totalTokens === 65,
          ),
        );
        assert.equal(live.nodes.find((node) => node.id === member?.id)?.countsForRun, false);
        yield* Queue.offer(
          messages,
          sdkFrame({
            type: "system",
            subtype: "task_notification",
            task_id: "runtime-workflow",
            status: "completed",
            summary: "Audit complete",
            output_file: "/synthetic/workflow-output",
            uuid: "00000000-0000-4000-8000-000000000965",
            session_id: nativeSession,
          }),
        );
        const final = yield* waitForProjection(
          (projection) =>
            projection.subagents.some(
              (candidate) => candidate.id === member?.id && candidate.status === "completed",
            ) &&
            projection.nodes.some((node) => node.id === member?.id && node.status === "completed"),
        );
        assert.equal(final.runs.at(-1)?.status, "completed");
        assert.equal(
          final.subagents.find((candidate) => candidate.id === member?.id)?.presentation?.usage
            ?.totalTokens,
          65,
        );
        assert.lengthOf(
          final.subagents.filter((candidate) => candidate.presentation?.kind === "workflow_agent"),
          1,
        );
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "claude-workflow-runtime" },
            Registry.layerSingle(adapter),
            { configureMcp: false },
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  ),
);
