import { assert, it } from "@effect/vitest";
import { historicalSubagentsToRuntime } from "../../../../../packages/client-runtime/src/state/historicalSubagentRuntime.ts";
import { deriveAgentPanelModel } from "../../../../../packages/client-runtime/src/state/subagentRuntime.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as Registry from "../ProviderAdapterRegistry.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as LegacyImporter from "../legacy/LegacyV1ThreadImporter.ts";
import { ConversationForkService } from "./ConversationForkService.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../testkit/ReplayFixtureWorkspace.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "fixture" };
const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "historical-turn-fork" },
  Registry.layerFromAdapters([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Historical forks must not execute a provider"),
    },
  ]),
  { configureMcp: false },
);
const testLayer = LegacyImporter.layer.pipe(
  Layer.provideMerge(runtime),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.live(
  "forks a migrated assistant through trailing same-turn history and starts user forks before the whole recorded turn",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("historical-turn-fork");
        const sql = yield* SqlClient.SqlClient;
        const source = ThreadId.make("historical-turn-source");
        const projectId = ProjectId.make("historical-turn-project");
        const now = "2026-01-01T00:00:00.000Z";
        yield* (yield* ProjectStore.ProjectStoreV2).apply({
          sequence: 1,
          eventId: EventId.make("historical-turn-project-created"),
          type: "project.created",
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId,
            title: "Historical turns",
            workspaceRoot: cwd,
            scripts: [],
            defaultModelSelection: modelSelection,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${source}, ${projectId}, 'Historical turns', '{"instanceId":"codex","model":"fixture"}', 'full-access', 'default', ${now}, ${now})`;
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, turn_id, is_streaming, created_at, updated_at)
      VALUES ('prior', ${source}, 'assistant', 'Prior answer', 'prior-turn', 0, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'),
        ('turn-start', ${source}, 'user', 'Original question', 'same-turn', 0, '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'),
        ('turn-steer', ${source}, 'user', 'Clarification during the turn', 'same-turn', 0, '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z'),
        ('clicked-answer', ${source}, 'assistant', 'Clicked answer', 'same-turn', 0, '2026-01-01T00:00:04.000Z', '2026-01-01T00:00:04.000Z'),
        ('trailing-reasoning', ${source}, 'reasoning', 'Trailing thought', 'same-turn', 0, '2026-01-01T00:00:05.000Z', '2026-01-01T00:00:05.000Z'),
        ('trailing-system', ${source}, 'system', 'Trailing system history', 'same-turn', 0, '2026-01-01T00:00:06.000Z', '2026-01-01T00:00:06.000Z'),
        ('next-turn', ${source}, 'user', 'Excluded next turn', 'next-turn', 0, '2026-01-01T00:00:10.000Z', '2026-01-01T00:00:10.000Z')`;
        yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
      VALUES ('task-start', ${source}, 'same-turn', 'info', 'task.started', 'Workflow', '{"taskId":"audit","taskType":"local_workflow","title":"Audit"}', '2026-01-01T00:00:06.500Z'),
        ('task-member', ${source}, 'same-turn', 'info', 'task.progress', 'Reader', '{"taskId":"reader","parentAgentId":"audit","phaseIndex":0,"status":"running","title":"Reader"}', '2026-01-01T00:00:06.600Z'),
        ('trailing-tool', ${source}, 'same-turn', 'tool', 'tool.completed', 'Trailing result', '{"toolName":"read_file","output":"Late result"}', '2026-01-01T00:00:07.000Z')`;
        yield* sql`INSERT INTO projection_pending_approvals (request_id, thread_id, turn_id, status, created_at)
      VALUES ('trailing-approval', ${source}, 'same-turn', 'pending', '2026-01-01T00:00:08.000Z')`;
        yield* sql`INSERT INTO projection_thread_proposed_plans (plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at)
      VALUES ('trailing-plan', ${source}, 'same-turn', '# Trailing plan', '2026-01-01T00:00:09.000Z', '2026-01-01T00:00:09.000Z')`;
        const importer = yield* LegacyImporter.LegacyV1ThreadImporter;
        yield* importer.reconcileShells;
        yield* importer.ensureTranscript(source);
        const forks = yield* ConversationForkService;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const command = {
          type: "thread.fork" as const,
          commandId: CommandId.make("historical-answer-fork"),
          originThreadId: source,
          newThreadId: ThreadId.make("historical-answer-child"),
          sourceAssistantMessageId: MessageId.make("clicked-answer"),
          workspaceMode: "local" as const,
        };
        const receipt = yield* forks.dispatch(command);
        const child = yield* store.getThreadProjection(command.newThreadId);
        assert.equal(child.turnItems.length, 12);
        const boundary = child.visibleTurnItems.at(-1);
        assert.ok(boundary?.item.type === "fork");
        assert.equal(boundary.visibility, "local");
        assert.deepEqual(boundary.item.source, {
          type: "message",
          threadId: source,
          messageId: command.sourceAssistantMessageId,
          position: "after",
        });
        assert.isNull(boundary.item.runId);
        assert.isNull(boundary.item.nodeId);
        assert.isNull(boundary.item.providerTurnId);
        assert.isUndefined(boundary.item.providerThreadId);
        const storedBoundary = yield* store.getTimelinePage(command.newThreadId, {
          itemId: boundary.item.id,
          limit: 1,
        });
        assert.deepEqual(storedBoundary.items, [boundary]);
        const roster = historicalSubagentsToRuntime(child.turnItems);
        assert.equal(roster.length, 2);
        assert.isTrue(roster.every((agent) => agent.historical === true));
        assert.isTrue(roster.every((agent) => agent.id.startsWith(`historical:${source}:`)));
        assert.equal(deriveAgentPanelModel({ agents: roster }).liveCount, 0);
        assert.isFalse(
          child.turnItems.some(
            (item) => item.type === "user_message" && item.text === "Excluded next turn",
          ),
        );
        assert.isTrue(
          child.turnItems.some(
            (item) => item.type === "reasoning" && item.text === "Trailing thought",
          ),
        );
        assert.isTrue(
          child.turnItems.some(
            (item) =>
              item.type === "dynamic_tool" &&
              item.toolName === "read_file" &&
              item.output === "Late result",
          ),
        );
        assert.isTrue(
          child.turnItems.some(
            (item) => item.type === "proposed_plan" && item.markdown === "# Trailing plan",
          ),
        );
        assert.isTrue(
          child.turnItems.some(
            (item) =>
              item.type === "dynamic_tool" &&
              item.toolName === "historical_approval" &&
              item.status === "interrupted",
          ),
        );
        assert.deepEqual(child.runs, []);
        assert.deepEqual(child.runtimeRequests, []);
        assert.deepEqual(child.providerSessions, []);
        assert.isTrue(
          child.turnItems.filter((item) => item.historyTurnId === TurnId.make("same-turn"))
            .length === 10,
        );
        assert.equal((yield* forks.dispatch(command)).sequence, receipt.sequence);
        for (const sourceUserMessageId of ["turn-start", "turn-steer"]) {
          const newThreadId = ThreadId.make(`historical-user-child:${sourceUserMessageId}`);
          yield* forks.dispatch({
            ...command,
            commandId: CommandId.make(`historical-user-fork:${sourceUserMessageId}`),
            newThreadId,
            sourceAssistantMessageId: undefined,
            sourceUserMessageId: MessageId.make(sourceUserMessageId),
          });
          const beforeTurn = yield* store.getThreadProjection(newThreadId);
          assert.equal(beforeTurn.turnItems.length, 2);
          assert.equal(beforeTurn.turnItems[0]?.type, "assistant_message");
          if (beforeTurn.turnItems[0]?.type === "assistant_message")
            assert.equal(beforeTurn.turnItems[0].text, "Prior answer");
          const userBoundary = beforeTurn.turnItems[1];
          assert.ok(userBoundary?.type === "fork");
          assert.deepEqual(userBoundary.source, {
            type: "message",
            threadId: source,
            messageId: MessageId.make(sourceUserMessageId),
            position: "before",
          });
        }
      }).pipe(Effect.provide(testLayer), Effect.timeout("15 seconds")),
    ),
);
