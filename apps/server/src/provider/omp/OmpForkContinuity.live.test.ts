// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationMessage,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ScientForkContextDelivery,
  ScientForkContextDeliveryLive,
} from "../../orchestration-v2/scient-fork/ForkContextDelivery.ts";
import { nativeThreadKey } from "../../orchestration-v2/scient-fork/context/nativeThreadKey.ts";
import { makeOmpAdapter } from "../Layers/OmpAdapter.ts";
import * as OmpExecutableGate from "./OmpExecutableGate.ts";
import { makeOmpCustomModelsClientFactory } from "./OmpCustomModels.ts";
import { ompLiveInstance, ompQualifyBinary, ompQualifyTarget } from "./OmpLive.testFixtures.ts";

const layer = ScientForkContextDeliveryLive.pipe(
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(OmpExecutableGate.layer),
);
const now = "2026-09-29T00:00:00.000Z";
const marker = "inherited-context-6b2c9d";

describe.runIf(ompQualifyBinary)("real OMP fork continuity", () => {
  it.effect(
    "delivers history once across ten messages and a process restart",
    () =>
      Effect.gen(function* () {
        const root = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "scient-omp-fork-continuity-"),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
        );
        const requests: Array<Array<{ role: string; content: unknown }>> = [];
        const server = NodeHttp.createServer((request, response) => {
          let raw = "";
          request.on("data", (chunk) => {
            raw += chunk;
          });
          request.on("end", () => {
            requests.push(JSON.parse(raw).messages);
            response.writeHead(200, { "content-type": "text/event-stream" });
            for (const [delta, finish_reason] of [
              [{ role: "assistant", content: "Recorded." }, null],
              [{}, "stop"],
            ]) {
              response.write(
                `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 1, model: "continuity", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
              );
            }
            response.end("data: [DONE]\n\n");
          });
        });
        yield* Effect.promise(
          () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
              }),
          ),
        );
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("stub did not listen");
        const instanceId = ProviderInstanceId.make("omp-fork-continuity");
        const threadId = ThreadId.make("fork-continuity");
        const { environment, homePath } = ompLiveInstance(root, {
          blockEgress: true,
          baseEnv: { PATH: process.env.PATH ?? "" },
        });
        const factory = yield* makeOmpCustomModelsClientFactory(
          ompQualifyTarget,
          {
            resolveCustomModels: () =>
              Effect.succeed([
                {
                  id: "stub",
                  name: "Stub",
                  protocol: "openai-completions",
                  baseUrl: `http://127.0.0.1:${address.port}/v1`,
                  credentialId: null,
                  apiKey: null,
                  models: [
                    {
                      id: "continuity",
                      modelId: "continuity",
                      name: "Continuity",
                      configurationMode: "manual",
                      contextWindow: 128000,
                      maxOutputTokens: 4096,
                      images: false,
                      reasoning: false,
                      instanceIds: [instanceId],
                    },
                  ],
                },
              ]),
            subscribeChanges: Effect.succeed(Stream.never),
          },
          instanceId,
          NodePath.join(root, "state"),
        );
        const adapter = yield* makeOmpAdapter({
          target: ompQualifyTarget,
          binaryPath: ompQualifyBinary!,
          providerInstanceId: instanceId,
          stateDir: NodePath.join(root, "state"),
          attachmentsDir: root,
          environment,
          homePath,
          makeProcess: factory,
        });
        const terminals = yield* Queue.unbounded<ProviderRuntimeEvent>();
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            event.type === "turn.completed" || event.type === "turn.aborted"
              ? Queue.offer(terminals, event)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        const initial = yield* adapter.startSession({
          threadId,
          cwd: root,
          runtimeMode: "full-access",
        });
        expect(initial.nativeSessionId).toBeTruthy();
        expect(initial.resumeCursor).toBeUndefined();
        const key = nativeThreadKey(
          initial.provider,
          initial.resumeCursor,
          instanceId,
          initial.nativeSessionId,
        );
        expect(key).not.toBeNull();
        const sql = yield* SqlClient.SqlClient;
        const delivery = yield* ScientForkContextDelivery;
        yield* sql`INSERT INTO scient_context_transfers (thread_id, type, source_thread_id, status, created_at, updated_at) VALUES (${threadId}, 'fork', 'origin', 'pending', ${now}, ${now})`;
        const history: Array<OrchestrationMessage> = [
          {
            id: MessageId.make("inherited"),
            role: "user",
            text: marker,
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        ];
        let deliveries = 0;
        for (let index = 0; index < 10; index++) {
          const session = (yield* adapter.listSessions())[0]!;
          const message: OrchestrationMessage = {
            id: MessageId.make(`message-${index}`),
            role: "user",
            text: `Follow-up ${index}`,
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          };
          const thread: OrchestrationThread = {
            id: threadId,
            projectId: ProjectId.make("project"),
            title: "Fork",
            modelSelection: createModelSelection(instanceId, "scient_stub/continuity"),
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            latestTurn: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            deletedAt: null,
            messages: [...history, message],
            proposedPlans: [],
            pullRequests: [],
            activities: [],
            checkpoints: [],
            session: null,
          };
          const liveKey = nativeThreadKey(
            session.provider,
            session.resumeCursor,
            instanceId,
            session.nativeSessionId,
          );
          expect(liveKey).toBe(key);
          const context = yield* delivery.prepareTurn({
            thread,
            message,
            userText: message.text,
            attachments: [],
            nativeThreadKey: liveKey,
            sessionRunning: false,
            modelContextWindow: 128000,
          });
          expect(context.kind).toBe(index === 0 ? "deliver" : "none");
          if (context.kind === "deliver") {
            deliveries++;
            yield* delivery.beginDelivery({
              threadId,
              handoffId: context.handoffId,
              messageId: message.id,
              nativeThreadKey: liveKey,
              includedItemCount: context.includedItemCount,
              omittedItemCount: context.omittedItemCount,
              budgetTokens: context.budgetTokens,
            });
          }
          const sent = yield* adapter.sendTurn({
            threadId,
            input:
              context.kind === "deliver"
                ? `${context.contextPreamble}\n\n${message.text}`
                : message.text,
            attachments: [],
            modelSelection: thread.modelSelection,
            ...(context.kind === "deliver"
              ? { hasContextPreamble: true, originalInput: message.text }
              : {}),
          });
          if (context.kind === "deliver") {
            const accepted = (yield* adapter.listSessions())[0]!;
            yield* delivery.settleDelivery({
              threadId,
              handoffId: context.handoffId,
              outcome: {
                type: "accepted",
                nativeThreadKey: nativeThreadKey(
                  accepted.provider,
                  accepted.resumeCursor,
                  instanceId,
                  accepted.nativeSessionId,
                ),
              },
            });
          }
          const terminal = yield* Queue.take(terminals).pipe(Effect.timeout("30 seconds"));
          expect(terminal.type).toBe("turn.completed");
          expect(terminal.turnId).toBe(sent.turnId);
          yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_turn_count, checkpoint_files_json) VALUES (${threadId}, ${sent.turnId}, ${message.id}, 'completed', ${now}, ${index + 1}, '[]')`;
          history.push({ ...message, turnId: sent.turnId });
          const completed = (yield* adapter.listSessions())[0]!;
          expect(completed.resumeCursor).toBeDefined();
          expect(nativeThreadKey(completed.provider, completed.resumeCursor, instanceId)).toBe(key);
          if (index === 4) {
            yield* adapter.stopSession(threadId);
            yield* adapter.startSession({
              threadId,
              cwd: root,
              runtimeMode: "full-access",
              resumeCursor: completed.resumeCursor,
            });
          }
        }
        expect(deliveries).toBe(1);
        expect(requests).toHaveLength(10);
        for (const messages of requests) {
          expect(
            messages.filter(
              (message) =>
                message.role === "user" && JSON.stringify(message.content).includes(marker),
            ),
          ).toHaveLength(1);
        }
        const rows =
          yield* sql`SELECT native_thread_key FROM scient_context_handoffs WHERE thread_id = ${threadId}`;
        expect(rows).toEqual([{ native_thread_key: key }]);
        yield* adapter.stopAll();
      }).pipe(Effect.scoped, Effect.provide(layer)),
    180000,
  );
});
