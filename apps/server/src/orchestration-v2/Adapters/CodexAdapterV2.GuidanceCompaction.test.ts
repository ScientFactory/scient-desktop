import { ProviderAdapterTurnStartError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId, type ModelSelection, EnvironmentId } from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import type { McpCapability } from "../../mcp/McpInvocationContext.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  makeCodexReplayTranscript,
  codexReplayPreamble,
  makeCodexReplayTurn,
  makeCodexReplayHarness,
  makeCodexTestTurnInput,
  CODEX_TEST_RUNTIME_POLICY,
  CODEX_TEST_MODEL_SELECTION,
} from "./CodexAdapterV2.replay.testkit.ts";
import { describe } from "@effect/vitest";

describe("CodexAdapterV2 post-settle continuation", () => {
  const isNativeStartReceiptError = Schema.is(ProviderAdapterTurnStartError);

  it.effect(
    "renders a structural trusted suffix once through the actual Codex start protocol",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const nativeThreadId = "trusted-suffix-thread";
          const nativeTurnId = "trusted-suffix-turn";
          const text = "[Scient selected skills for this turn:\nauthored marker\n]";
          const runtimeInstruction =
            "[Scient selected skills for this turn:\ntrusted orientation\n]";
          const sentPrompt = `${text}\n\n${runtimeInstruction}`;
          const transcript = makeCodexReplayTranscript({
            scenario: "structural-trusted-suffix",
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: text, sentPrompt }),
              {
                type: "emit_inbound",
                label: "done",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                  },
                },
              },
            ],
          });
          const harness = yield* makeCodexReplayHarness(transcript);
          const input = makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("trusted-suffix-attempt"),
            text,
          });
          yield* harness.runtime.startTurn({
            ...input,
            message: { ...input.message, runtimeInstruction },
          });
          yield* harness.firstTerminal;
          assert.equal(harness.terminalEvents()[0]?.status, "completed");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
  );

  it.effect(
    "preserves Auto review and full granted guidance below every entry limit in one native start packet",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          const nativeThreadId = "auto-full-guidance-thread";
          const nativeTurnId = "auto-full-guidance-turn";
          const prompt = "Review this change automatically.";
          const capabilities = new Set<McpCapability>([
            "preview",
            "device",
            "documents:build",
            "skills:read",
          ]);
          const runtimePolicy = {
            ...CODEX_TEST_RUNTIME_POLICY,
            runtimeMode: "auto" as const,
          };
          const modelSelection: ModelSelection = {
            ...CODEX_TEST_MODEL_SELECTION,
            options: [{ id: "reasoningEffort", value: "high" }],
          };
          const expected = yield* CodexAdapterV2.buildCodexTurnStartParams({
            nativeThreadId,
            codexInput: [{ type: "text", text: prompt }],
            runtimePolicy,
            modelSelection,
            hasT3Mcp: true,
            mcpCapabilities: capabilities,
          });
          const packetSchema = CodexSchema.V2TurnStartParams.pipe(
            Schema.fieldsAssign({
              collaborationMode: CodexSchema.ClientRequest__CollaborationMode,
              additionalContext: Schema.Record(
                Schema.String,
                CodexSchema.V2TurnStartParams__AdditionalContextEntry,
              ),
            }),
          );
          const decodePacket = Schema.decodeUnknownEffect(packetSchema);
          const packets = yield* Ref.make<ReadonlyArray<Schema.Schema.Type<typeof packetSchema>>>(
            [],
          );
          const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt });
          const transcript = makeCodexReplayTranscript({
            scenario: "auto-full-guidance-packet",
            entries: [
              ...preamble.slice(0, 5),
              {
                type: "expect_outbound",
                label: "Auto review with full granted context",
                frame: { id: 3, method: "turn/start", params: expected },
              },
              ...preamble.slice(6),
              {
                type: "emit_inbound",
                label: "done",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                  },
                },
              },
            ],
          });
          const harness = yield* makeCodexReplayHarness(transcript, undefined, (method, params) =>
            method === "turn/start"
              ? decodePacket(params).pipe(
                  Effect.orDie,
                  Effect.flatMap((packet) =>
                    Ref.update(packets, (current) => [...current, packet]),
                  ),
                )
              : Effect.void,
          );
          const registry = yield* McpSessionRegistry.__testing.make().pipe(
            Effect.provideService(
              HttpServer.HttpServer,
              HttpServer.HttpServer.of({
                address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
                serve: () => Effect.void,
              }),
            ),
            Effect.provideService(
              ServerEnvironment.ServerEnvironment,
              ServerEnvironment.ServerEnvironment.of({
                getEnvironmentId: Effect.succeed(EnvironmentId.make("auto-full-guidance")),
                getDescriptor: Effect.die("This packet fixture does not discover environments."),
              }),
            ),
          );
          const issued = yield* registry.issue({
            threadId: harness.threadId,
            providerInstanceId: modelSelection.instanceId,
            capabilities,
          });
          const scope = yield* registry.resolve(
            issued.config.authorizationHeader.replace(/^Bearer\s+/, ""),
          );
          assert.equal(scope?.thread.threadId, harness.threadId);
          assert.equal(scope?.thread.providerInstanceId, modelSelection.instanceId);
          assert.deepEqual(scope?.capabilities, capabilities);
          yield* sessions.set(issued.config);
          yield* Effect.addFinalizer(() =>
            registry
              .revokeThread(harness.threadId)
              .pipe(Effect.andThen(sessions.clear(harness.threadId))),
          );
          yield* harness.runtime.startTurn({
            ...makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("auto-full-guidance-attempt"),
              text: prompt,
            }),
            runtimePolicy,
            modelSelection,
          });
          yield* harness.firstTerminal;
          const delivered = yield* Ref.get(packets);
          assert.equal(delivered.length, 1);
          const packet = delivered[0]!;
          assert.equal(packet.threadId, nativeThreadId);
          assert.deepEqual(packet.input, [{ type: "text", text: prompt }]);
          assert.equal(packet.cwd, "/workspace");
          assert.equal(packet.model, "gpt-5.4");
          assert.equal(packet.effort, "high");
          assert.equal(packet.approvalPolicy, "on-request");
          assert.equal(packet.approvalsReviewer, "auto_review");
          assert.deepEqual(packet.sandboxPolicy, { type: "workspaceWrite" });
          assert.equal(packet.collaborationMode.mode, "default");
          assert.equal(packet.collaborationMode.settings.model, "gpt-5.4");
          assert.equal(packet.collaborationMode.settings.reasoning_effort, "high");
          assert.match(
            packet.collaborationMode.settings.developer_instructions ?? "",
            /^<collaboration_mode>[\s\S]*<\/collaboration_mode>$/,
          );
          assert.deepEqual(Object.keys(packet.additionalContext), [
            "t3_code_orchestration",
            "t3_code_workspace",
            "t3_code_runtime",
            "scient_awareness",
          ]);
          const awareness = packet.additionalContext.scient_awareness?.value ?? "";
          for (const required of [
            "preview_status",
            "preview_open",
            "device_list",
            "device_open",
            "scient_pdf_build",
            "scient_skill_load",
          ])
            assert.include(awareness, required);
          for (const [key, entry] of Object.entries(packet.additionalContext)) {
            assert.equal(entry.kind, "application");
            assert.isBelow(Buffer.byteLength(entry.value), 4_000, key);
          }
          assert.equal(harness.terminalEvents().length, 1);
          assert.equal(harness.terminalEvents()[0]?.status, "completed");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
  );

  it.effect.each([
    { compact: false, completed: false },
    { compact: true, completed: false },
    { compact: false, completed: true },
    { compact: true, completed: true },
  ])("retains correlated native acceptance before a failing start response: %s", (scenario) =>
    Effect.gen(function* () {
      const nativeThreadId = "accepted-before-response-thread";
      const nativeTurnId = "accepted-before-response-turn";
      const accepted = yield* Deferred.make<void>();
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "work" });
      const transcript = makeCodexReplayTranscript({
        scenario: `accepted-before-error-${scenario.compact}-${scenario.completed}`,
        entries: [
          ...preamble.slice(0, 5),
          ...(scenario.compact
            ? [
                {
                  type: "expect_outbound" as const,
                  frame: {
                    id: 3,
                    method: "thread/compact/start",
                    params: { threadId: nativeThreadId },
                  },
                },
              ]
            : preamble.slice(5, 6)),
          ...preamble.slice(7, 8),
          ...(scenario.completed
            ? [
                {
                  type: "emit_inbound" as const,
                  frame: {
                    method: "turn/completed",
                    params: {
                      threadId: nativeThreadId,
                      turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                    },
                  },
                },
              ]
            : []),
          // This actual request follows the observed native receipt (and terminal,
          // when present), so the failing start response cannot race its handler.
          {
            type: "expect_outbound",
            frame: {
              id: 4,
              method: "feedback/upload",
              params: {
                classification: "bug",
                includeLogs: true,
                threadId: nativeThreadId,
              },
            },
          },
          { type: "emit_inbound", frame: { id: 4, result: { threadId: "feedback" } } },
          {
            type: "emit_inbound",
            frame: {
              id: 3,
              error: { code: -32602, message: "Response failed after native acceptance" },
            },
          },
        ],
      });
      const h = yield* makeCodexReplayHarness(transcript, (event) =>
        event.type === "provider_turn.updated" && event.providerTurn.nativeAcceptance === "accepted"
          ? Deferred.succeed(accepted, undefined)
          : Effect.void,
      );
      const input = makeCodexTestTurnInput({
        threadId: h.threadId,
        providerThread: h.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("accepted-before-error-attempt"),
        text: "work",
      });
      const start = scenario.compact ? h.runtime.compactThread : h.runtime.startTurn;
      assert.ok(start);
      assert.ok(h.runtime.uploadFeedback);
      const failing = yield* start(input).pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(accepted);
      if (scenario.completed) yield* h.firstTerminal;
      yield* h.runtime.uploadFeedback({ providerThread: h.providerThread });
      const error = yield* Fiber.join(failing);
      if (!isNativeStartReceiptError(error))
        return yield* Effect.die("Expected native start error");
      const observed = h.events.find(
        (event) =>
          event.type === "provider_turn.updated" &&
          event.providerTurn.nativeAcceptance === "accepted",
      );
      assert.ok(observed?.type === "provider_turn.updated");
      assert.deepEqual(error.providerTurn, observed.providerTurn);
      assert.equal(error.providerTurn?.nativeTurnRef?.nativeId, nativeTurnId);
      assert.equal(error.providerTurn?.nativeAcceptance, "accepted");
      assert.ok(error.providerTurn?.acceptedAt);
      assert.equal(error.providerTurn?.runAttemptId, input.attemptId);
      assert.equal(error.providerTurn?.nodeId, input.rootNodeId);
      assert.equal(error.providerTurn?.providerThreadId, h.providerThread.id);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect.each([-32602, -32000])(
    "retains native compaction request refusal versus uncertainty: %s",
    (code) =>
      Effect.gen(function* () {
        const nativeThreadId = "compact-failed-thread";
        const transcript = makeCodexReplayTranscript({
          scenario: `native-compaction-failure-${code}`,
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId: "unused-turn",
              prompt: "unused",
            }).slice(0, 5),
            {
              type: "expect_outbound",
              label: "compact",
              frame: {
                id: 3,
                method: "thread/compact/start",
                params: { threadId: nativeThreadId },
              },
            },
            {
              type: "emit_inbound",
              label: "compact",
              frame: {
                id: 3,
                error: { code, message: "Native compaction refused or response uncertain" },
              },
            },
          ],
        });
        const h = yield* makeCodexReplayHarness(transcript);
        assert.ok(h.runtime.compactThread);
        const input = makeCodexTestTurnInput({
          threadId: h.threadId,
          providerThread: h.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("compact-failed-attempt"),
          text: "/compact",
        });
        const error = yield* h.runtime.compactThread(input).pipe(Effect.flip);
        if (!isNativeStartReceiptError(error))
          return yield* Effect.die("Expected exact compaction start error");
        assert.equal(error.providerTurn?.nativeAcceptance, code === -32602 ? "pending" : "unknown");
        assert.isUndefined(error.providerTurn?.acceptedAt);
        assert.isNull(error.providerTurn?.nativeTurnRef);
        assert.equal(error.providerTurn?.runAttemptId, input.attemptId);
        assert.equal(error.providerTurn?.nodeId, input.rootNodeId);
        assert.equal(error.providerTurn?.providerThreadId, h.providerThread.id);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
  );

  it.effect("compacts Codex with the native RPC and completes the compaction turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "compact-thread";
        const nativeTurnId = "compact-turn";
        const item = { type: "contextCompaction", id: "compact-item" };
        const transcript = makeCodexReplayTranscript({
          scenario: "native-compaction",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "unused" }).slice(0, 5),
            {
              type: "expect_outbound",
              label: "compact",
              frame: {
                id: 3,
                method: "thread/compact/start",
                params: { threadId: nativeThreadId },
              },
            },
            { type: "emit_inbound", label: "compact", frame: { id: 3, result: {} } },
            {
              type: "emit_inbound",
              label: "start",
              frame: {
                method: "turn/started",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
                },
              },
            },
            ...(["item/started", "item/completed"] as const).map((method) => ({
              type: "emit_inbound" as const,
              label: method,
              frame: { method, params: { threadId: nativeThreadId, turnId: nativeTurnId, item } },
            })),
            {
              type: "emit_inbound",
              label: "complete",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        assert.isDefined(harness.runtime.compactThread);
        yield* harness.runtime.compactThread!(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("compact-attempt"),
            text: "/compact",
          }),
        );
        yield* harness.firstTerminal;
        const items = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "compaction"
            ? [event.turnItem]
            : [],
        );
        assert.deepEqual(
          items.map((entry) => entry.status),
          ["running", "completed"],
        );
        assert.equal(items[0]?.id, items[1]?.id);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );
});
