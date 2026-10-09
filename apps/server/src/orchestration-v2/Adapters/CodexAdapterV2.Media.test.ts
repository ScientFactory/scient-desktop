import * as ThreadCommandExecutor from "../ThreadCommandExecutor.ts";
import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderCitationPresentation,
  RunAttemptId,
  type ModelSelection,
  EnvironmentId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as Logger from "effect/Logger";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import type { McpCapability } from "../../mcp/McpInvocationContext.ts";
import { SCIENT_ORCHESTRATION_INSTRUCTIONS } from "../../provider/ScientProviderInstructions.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderEventIngestor from "../ProviderEventIngestor.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  makeCodexReplayTranscript,
  codexReplayPreamble,
  makeCodexReplayTurn,
  makeCodexReplayHarness,
  makeCodexTestTurnInput,
  assistantMessages,
  CODEX_TEST_MODEL_SELECTION,
  DEFAULT_CODEX_SETTINGS,
  encodeUnknownJson,
  CODEX_TEST_RUNTIME_POLICY,
} from "./CodexAdapterV2.replay.testkit.ts";
import { describe } from "@effect/vitest";

describe("CodexAdapterV2 post-settle continuation", () => {
  const decodeCitationPresentation = Schema.decodeUnknownEffect(ProviderCitationPresentation);

  const imageStoresLayer = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
    Layer.provide(SqlitePersistenceMemory),
  );

  const imageSinkLayer = EventSink.layer.pipe(
    Layer.provide(Layer.merge(imageStoresLayer, SqlitePersistenceMemory)),
  );

  const imagePersistenceLayer = Layer.mergeAll(
    imageStoresLayer,
    imageSinkLayer,
    ProviderEventIngestor.layer.pipe(
      Layer.provide(Layer.mergeAll(imageStoresLayer, imageSinkLayer, IdAllocator.layer)),
    ),
    IdAllocator.layer,
  ).pipe(Layer.provideMerge(Layer.merge(NodeServices.layer, ThreadCommandExecutor.layer)));

  it.effect("keeps an asynchronous Codex question actionable after the turn completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "async-question-thread";
        const nativeTurnId = "async-question-turn";
        const usage = {
          totalTokens: 15,
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 5,
          reasoningOutputTokens: 1,
        };
        const transcript = makeCodexReplayTranscript({
          scenario: "async-question-and-billed-usage",
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId,
              prompt: "Continue while I decide.",
            }),
            {
              type: "emit_inbound",
              label: "question",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: {
                    type: "agentMessage",
                    id: "async-question-item",
                    text: "Which branch?",
                    delivery: "async",
                    questions: [{ title: "Which branch?", options: ["main", "dev"] }],
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "usage",
              frame: {
                method: "thread/tokenUsage/updated",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  tokenUsage: { total: usage, last: usage, modelContextWindow: 200_000 },
                },
              },
            },
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
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("async-question-attempt"),
            text: "Continue while I decide.",
          }),
        );
        yield* harness.firstTerminal;
        const requests = harness.events.flatMap((event) =>
          event.type === "runtime_request.updated" ? [event.runtimeRequest] : [],
        );
        assert.lengthOf(requests, 1);
        assert.equal(requests[0]?.status, "pending");
        assert.deepEqual(requests[0]?.responseCapability, { type: "message" });
        const questionItem = harness.events.find(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
        );
        assert.equal(questionItem?.type, "turn_item.updated");
        if (
          questionItem?.type === "turn_item.updated" &&
          questionItem.turnItem.type === "user_input_request"
        ) {
          assert.deepEqual(
            questionItem.turnItem.questions[0]?.options.map((option) => option.label),
            ["main", "dev"],
          );
          assert.equal(questionItem.turnItem.responseMode, "message");
        }
        const questionNode = harness.events.find(
          (event) => event.type === "node.updated" && event.node.id === requests[0]?.nodeId,
        );
        assert.equal(
          questionNode?.type === "node.updated" && questionNode.node.countsForRun,
          false,
        );
        const contextReport = harness.events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.tokenUsage !== undefined,
        );
        assert.equal(contextReport?.type, "provider_turn.updated");
        if (contextReport?.type === "provider_turn.updated") {
          assert.equal(
            contextReport.providerTurn.runAttemptId,
            RunAttemptId.make("async-question-attempt"),
          );
          assert.equal(contextReport.providerTurn.providerThreadId, harness.providerThread.id);
          assert.equal(contextReport.providerTurn.tokenUsage?.usedTokens, 15);
          assert.equal(contextReport.providerTurn.tokenUsage?.maxTokens, 200_000);
        }
        const completed = harness.events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        );
        assert.equal(completed?.type, "provider_turn.updated");
        if (completed?.type === "provider_turn.updated") {
          assert.deepEqual(completed.providerTurn.turnTokenUsage, {
            usageStatus: "complete",
            usageScope: "main_agent",
            hasSubagents: false,
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 5,
            reasoningTokens: 1,
          });
        }
        assert.isEmpty(assistantMessages(harness.events));
      }).pipe(
        Effect.provide(
          Layer.merge(
            IdAllocator.layer,
            Layer.merge(NodeServices.layer, ThreadCommandExecutor.layer),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "persists native web-search citations as portable links in both assistant representations",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const nativeThreadId = "citation-thread";
          const nativeTurnId = "citation-turn";
          const raw = "Evidence 😀 \uE200cite\uE202turn0search0\uE202turn0search1\uE201.";
          const expected = 'Evidence 😀 [1](<https://example.test/source> "Study").';
          const transcript = makeCodexReplayTranscript({
            scenario: "native-citations",
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Find evidence" }),
              {
                type: "emit_inbound",
                frame: {
                  method: "item/completed",
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    item: {
                      type: "webSearch",
                      id: "search",
                      query: "evidence",
                      action: { type: "search", query: "evidence" },
                      results: [
                        ["turn0search0", { url: "https://example.test/source", title: "Study" }],
                        {
                          ref_id: "turn0search1",
                          url: "https://example.test/source",
                          title: "Duplicate source",
                        },
                        { ref_id: "unsafe", url: "javascript:alert(1)", title: "Unsafe" },
                      ],
                    },
                  },
                },
              },
              {
                type: "emit_inbound",
                frame: {
                  method: "item/completed",
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    item: {
                      type: "agentMessage",
                      id: "citation-answer",
                      text: raw,
                      phase: "final_answer",
                    },
                  },
                },
              },
              {
                type: "emit_inbound",
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
          const now = yield* DateTime.now;
          const input = makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("citation-attempt"),
            text: "Find evidence",
          });
          yield* harness.runtime.startTurn(input);
          yield* harness.firstTerminal;
          const message = harness.events.find(
            (event) => event.type === "message.updated" && event.message.role === "assistant",
          );
          if (message?.type !== "message.updated")
            return yield* Effect.die("Missing native cited answer");
          assert.equal(message.message.text, expected);
          const sink = yield* EventSink.EventSinkV2;
          const ids = yield* IdAllocator.IdAllocatorV2;
          yield* sink.write({
            events: [
              {
                id: yield* ids.allocate.event({ threadId: harness.threadId }),
                threadId: harness.threadId,
                type: "thread.created",
                occurredAt: now,
                payload: input.appThread,
              },
            ],
          });
          const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
          for (const event of harness.events) {
            if (
              event.type !== "message.updated" &&
              event.type !== "turn_item.updated" &&
              event.type !== "node.updated"
            )
              continue;
            yield* ingestor.ingestNormalized({
              providerSessionId: harness.runtime.providerSession.id,
              providerInstanceId: CODEX_TEST_MODEL_SELECTION.instanceId,
              threadId: harness.threadId,
              event,
            });
          }
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const projected = yield* projections.getThreadProjection(harness.threadId);
          assert.equal(
            projected.messages.find((entry) => entry.id === message.message.id)?.text,
            expected,
          );
          const item = projected.turnItems.find(
            (entry) => entry.type === "assistant_message" && entry.messageId === message.message.id,
          );
          if (item?.type !== "assistant_message")
            return yield* Effect.die("Missing native cited assistant item");
          assert.equal(item.text, expected);
          const store = yield* EventStore.EventStoreV2;
          const persisted = yield* store
            .read({ threadId: harness.threadId })
            .pipe(Stream.runCollect);
          const rebuilt = yield* Effect.gen(function* () {
            const replay = yield* ProjectionStore.ProjectionStoreV2;
            for (const row of persisted) yield* replay.apply(row.event);
            return yield* replay.getThreadProjection(harness.threadId);
          }).pipe(Effect.provide(ProjectionStore.layerMemory));
          assert.equal(
            rebuilt.messages.find((entry) => entry.id === message.message.id)?.text,
            expected,
          );
          const rebuiltItem = rebuilt.turnItems.find((entry) => entry.id === item.id);
          if (rebuiltItem?.type !== "assistant_message")
            return yield* Effect.die("Missing rebuilt cited assistant item");
          assert.equal(rebuiltItem.text, expected);
          assert.isFalse(rebuilt.messages.some((entry) => entry.text.includes("javascript:")));
        }).pipe(Effect.provide(imagePersistenceLayer)),
      ),
  );

  it.effect.each(
    (["oversized", "expanded-url"] as const).map((catalog) => ({
      caseTitle: `preserves a native unresolved answer with a ${catalog} catalog as bounded inert metadata`,
      catalog,
    })),
  )("$caseTitle", ({ catalog }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "bounded-citation-thread";
        const nativeTurnId = "bounded-citation-turn";
        const text = "Raw \uE200cite\uE202s127\uE202missing\uE201";
        const results =
          catalog === "oversized"
            ? Array.from({ length: 140 }, (_, i) => ({
                ref_id: `s${i}`,
                url: `https://example.test/${i}`,
              }))
            : [
                {
                  ref_id: "s127",
                  url: `https://example.test/${"א".repeat(7000)}`,
                  title: "Unicode",
                },
              ];
        const transcript = makeCodexReplayTranscript({
          scenario: `bounded-${catalog}`,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Find evidence" }),
            {
              type: "emit_inbound",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: {
                    type: "webSearch",
                    id: "search",
                    query: "evidence",
                    action: { type: "search", query: "evidence" },
                    results,
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: { type: "agentMessage", id: "answer", text, phase: "final_answer" },
                },
              },
            },
            {
              type: "emit_inbound",
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
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make(`bounded-${catalog}`),
            text: "Find evidence",
          }),
        );
        yield* harness.firstTerminal;
        const event = harness.events.find(
          (entry) =>
            entry.type === "message.updated" &&
            entry.message.role === "assistant" &&
            !entry.message.streaming,
        );
        assert.ok(event?.type === "message.updated");
        assert.equal(event.message.text, text);
        assert.ok(event.message.citationPresentation);
        const metadata = yield* decodeCitationPresentation(event.message.citationPresentation);
        assert.deepEqual(
          metadata.sources,
          catalog === "oversized" ? [{ id: "s127", url: "https://example.test/127" }] : [],
        );
        const item = harness.events.find(
          (entry) =>
            entry.type === "turn_item.updated" &&
            entry.turnItem.type === "assistant_message" &&
            !entry.turnItem.streaming,
        );
        assert.ok(item?.type === "turn_item.updated" && item.turnItem.type === "assistant_message");
        assert.equal(item.turnItem.text, text);
        assert.deepEqual(item.turnItem.citationPresentation, metadata);
      }).pipe(Effect.provide(imagePersistenceLayer)),
    ),
  );

  it.effect.each(
    (["saved", "default-path", "missing", "foreign", "failed"] as const).map((outcome) => ({
      caseTitle: `projects native Codex generated images with ${outcome} materialization`,
      outcome,
    })),
  )("$caseTitle", ({ outcome }) => {
    const logs: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      logs.push(message);
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "scient-codex-images-" });
        const nativeThreadId = `images-${outcome}`;
        const nativeTurnId = `image-turn-${outcome}`;
        const imageId = "generated-image";
        const imageRoot = path.join(home, "generated_images", nativeThreadId);
        yield* fs.makeDirectory(imageRoot, { recursive: true });
        const sourcePath = path.join(outcome === "foreign" ? home : imageRoot, `${imageId}.png`);
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
        if (outcome !== "missing") yield* fs.writeFile(sourcePath, bytes);
        const imageEvent: CodexReplay.CodexAppServerReplayEntry = {
          type: "emit_inbound",
          label: "native generated image",
          frame: {
            method: "item/completed",
            params: {
              threadId: nativeThreadId,
              turnId: nativeTurnId,
              item: {
                type: "imageGeneration",
                id: imageId,
                status: outcome === "failed" ? "failed" : "completed",
                result: "not-projected-inline-base64",
                ...(outcome === "default-path" ? {} : { savedPath: sourcePath }),
              },
            },
          },
        };
        const replayContext = "Repeat generated image receipt after source removal";
        const initialImages = yield* Deferred.make<void>();
        const durableReplay = yield* Deferred.make<void>();
        let receivedImages = 0;
        const transcript = makeCodexReplayTranscript({
          scenario: `images-${outcome}`,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Draw an image" }),
            {
              type: "emit_inbound",
              label: "ordinary image view is not generated output",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: {
                    id: "ordinary-image-view",
                    type: "imageView",
                    path: sourcePath,
                    result: "ordinary-view-metadata",
                  },
                },
              },
            },
            imageEvent,
            { ...imageEvent, label: "duplicate native image receipt" },
            ...(outcome !== "saved"
              ? []
              : [
                  {
                    type: "expect_outbound" as const,
                    label: "causal receipt replay trigger",
                    frame: {
                      id: 4,
                      method: "thread/inject_items",
                      params: {
                        threadId: nativeThreadId,
                        items: historyResponseItems([], replayContext),
                      },
                    },
                  },
                  { type: "emit_inbound" as const, frame: { id: 4, result: {} } },
                  { ...imageEvent, label: "native replay after source removal" },
                ]),
            {
              type: "emit_inbound",
              label: "final text",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: {
                    type: "agentMessage",
                    id: "image-final-answer",
                    text: "The image is ready.",
                    phase: "final_answer",
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "completed",
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
        const harness = yield* makeCodexReplayHarness(
          transcript,
          (event) => {
            if (event.type !== "message.updated" || event.message.text === "The image is ready.")
              return Effect.void;
            receivedImages += 1;
            return receivedImages === 2
              ? Deferred.succeed(initialImages, undefined)
              : receivedImages === 3
                ? Deferred.succeed(durableReplay, undefined)
                : Effect.void;
          },
          undefined,
          undefined,
          false,
          { ...DEFAULT_CODEX_SETTINGS, homePath: home },
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`image-attempt-${outcome}`),
            text: "Draw an image",
          }),
        );
        if (outcome === "saved") {
          yield* Deferred.await(initialImages);
          yield* fs.remove(sourcePath);
          if (harness.runtime.injectHistory === undefined)
            return yield* Effect.die("Missing native replay trigger");
          yield* harness.runtime.injectHistory({
            providerThread: harness.providerThread,
            context: replayContext,
            messages: [],
          });
          yield* Deferred.await(durableReplay);
        }
        yield* harness.firstTerminal;
        const imageMessages = harness.events.filter(
          (event) =>
            event.type === "message.updated" &&
            event.message.role === "assistant" &&
            event.message.text !== "The image is ready.",
        );
        assert.lengthOf(imageMessages, outcome === "saved" ? 3 : 2);
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "message.updated" &&
              event.message.attachments.some((attachment) =>
                attachment.id.includes("ordinary-image-view"),
              ),
          ),
        );
        const first = imageMessages[0];
        const replay = imageMessages[1];
        if (first?.type !== "message.updated" || replay?.type !== "message.updated")
          return yield* Effect.die("Missing image messages");
        assert.equal(first.message.id, replay.message.id);
        assert.deepEqual(first.message.attachments, replay.message.attachments);
        for (const receipt of imageMessages)
          if (receipt.type === "message.updated") {
            assert.equal(receipt.message.id, first.message.id);
            assert.deepEqual(receipt.message.attachments, first.message.attachments);
          }
        const turnItem = harness.events.find(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.messageId === first.message.id,
        );
        if (
          turnItem?.type !== "turn_item.updated" ||
          turnItem.turnItem.type !== "assistant_message"
        )
          return yield* Effect.die("Missing image assistant item");
        assert.deepEqual(turnItem.turnItem.attachments, first.message.attachments);
        assert.equal(turnItem.turnItem.text, first.message.text);
        assert.equal(first.message.streaming, false);
        if (outcome === "saved" || outcome === "default-path") {
          assert.equal(first.message.text, "");
          assert.lengthOf(first.message.attachments, 1);
          const attachment = first.message.attachments[0];
          if (attachment?.type !== "image") return yield* Effect.die("Missing image attachment");
          const durablePath = resolveAttachmentPath({
            attachmentsDir: harness.serverConfig.attachmentsDir,
            attachment,
          });
          if (!durablePath) return yield* Effect.die("Missing durable attachment path");
          assert.deepEqual(yield* fs.readFile(durablePath), bytes);
          assert.notEqual(durablePath, sourcePath);
        } else {
          assert.isEmpty(first.message.attachments);
          assert.include(first.message.text, "Scient could not attach it");
          assert.notInclude(first.message.text, sourcePath);
        }
        assert.isTrue(
          harness.events.some(
            (event) =>
              event.type === "message.updated" && event.message.text === "The image is ready.",
          ),
        );
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "message.updated" &&
              event.message.text.includes("not-projected-inline-base64"),
          ),
        );
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        const sink = yield* EventSink.EventSinkV2;
        const store = yield* EventStore.EventStoreV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const now = yield* DateTime.now;
        const appThread = makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make(`image-attempt-${outcome}`),
          text: "Draw an image",
        }).appThread;
        yield* sink.write({
          events: [
            {
              id: yield* ids.allocate.event({ threadId: harness.threadId }),
              threadId: harness.threadId,
              type: "thread.created",
              occurredAt: now,
              payload: appThread,
            },
          ],
        });
        for (const event of harness.events) {
          if (
            event.type !== "message.updated" &&
            event.type !== "turn_item.updated" &&
            event.type !== "node.updated"
          )
            continue;
          yield* ingestor.ingestNormalized({
            providerSessionId: harness.runtime.providerSession.id,
            providerInstanceId: CODEX_TEST_MODEL_SELECTION.instanceId,
            threadId: harness.threadId,
            event,
          });
        }
        const projected = yield* projections.getThreadProjection(harness.threadId);
        assert.lengthOf(
          projected.messages.filter((message) => message.id === first.message.id),
          1,
        );
        assert.deepEqual(
          projected.messages.find((message) => message.id === first.message.id)?.attachments,
          first.message.attachments,
        );
        const projectedItem = projected.turnItems.find(
          (item) => item.type === "assistant_message" && item.messageId === first.message.id,
        );
        if (projectedItem?.type !== "assistant_message")
          return yield* Effect.die("Missing persisted image item");
        assert.deepEqual(projectedItem.attachments, first.message.attachments);
        const stored = yield* store.read({ threadId: harness.threadId }).pipe(Stream.runCollect);
        const rebuilt = yield* Effect.gen(function* () {
          const replayed = yield* ProjectionStore.ProjectionStoreV2;
          for (const row of stored) yield* replayed.apply(row.event);
          return yield* replayed.getThreadProjection(harness.threadId);
        }).pipe(Effect.provide(ProjectionStore.layerMemory));
        assert.deepEqual(
          rebuilt.messages.find((message) => message.id === first.message.id)?.attachments,
          first.message.attachments,
        );
        const rebuiltItem = rebuilt.turnItems.find(
          (item) => item.type === "assistant_message" && item.messageId === first.message.id,
        );
        if (rebuiltItem?.type !== "assistant_message")
          return yield* Effect.die("Missing rebuilt image item");
        assert.deepEqual(rebuiltItem.attachments, first.message.attachments);
        assert.equal(rebuiltItem.text, first.message.text);
        const warnings = logs.filter(
          (message) =>
            Array.isArray(message) &&
            message[0] === "orchestration-v2.codex.generated-image-import-failed",
        );
        assert.lengthOf(warnings, outcome === "saved" || outcome === "default-path" ? 0 : 2);
        if (outcome === "missing" || outcome === "foreign" || outcome === "failed") {
          const encoded = encodeUnknownJson(warnings);
          assert.include(
            encoded,
            outcome === "missing"
              ? "ENOENT"
              : outcome === "foreign"
                ? "outside_authorized_root"
                : "provider_generation_failed",
          );
          assert.notInclude(encoded, home);
          assert.notInclude(encoded, sourcePath);
        }
      }).pipe(Effect.provide(imagePersistenceLayer)),
    ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect.each(
    (
      [
        {
          name: "preserves runtime guidance and restores it after compaction with MCP=false",
          hasMcp: false,
          mode: "default",
          grants: false,
        },
        {
          name: "preserves runtime guidance and restores it after compaction with MCP=true",
          hasMcp: true,
          mode: "default",
          grants: true,
        },
        {
          name: "keeps native plan instructions separate from granted Scient awareness",
          hasMcp: true,
          mode: "plan",
          grants: true,
        },
        {
          name: "delivers native Scient identity with no capability grants in default mode",
          hasMcp: true,
          mode: "default",
          grants: false,
        },
        {
          name: "delivers native Scient identity with no capability grants in plan mode",
          hasMcp: true,
          mode: "plan",
          grants: false,
        },
      ] as const
    ).map((scenario) => ({ caseTitle: scenario.name, scenario })),
  )("$caseTitle", ({ scenario }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "context-thread";
        const nativeTurnId = "context-turn";
        const { hasMcp } = scenario;
        const runtimePolicy = { ...CODEX_TEST_RUNTIME_POLICY, interactionMode: scenario.mode };
        const capabilities = new Set<McpCapability>(
          scenario.grants ? ["preview", "documents:build", "compute:inventory", "skills:read"] : [],
        );
        const modelSelection: ModelSelection = {
          ...CODEX_TEST_MODEL_SELECTION,
          options: [{ id: "reasoningEffort", value: "high" }],
        };
        const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId,
          codexInput: [{ type: "text", text: "work" }],
          runtimePolicy,
          modelSelection,
          hasT3Mcp: hasMcp,
          mcpCapabilities: capabilities,
        });
        assert.include(
          params.additionalContext?.t3_code_runtime?.value ?? "",
          "Codex harness, as gpt-5.4 with high reasoning effort",
        );
        if (!hasMcp) {
          assert.deepEqual(Object.keys(params.additionalContext ?? {}), [
            "t3_code_runtime",
            "scient_awareness",
          ]);
          assert.notInclude(
            params.additionalContext?.scient_awareness?.value ?? "",
            "scient_skill_load",
          );
        } else if (scenario.grants) {
          assert.include(
            params.additionalContext?.t3_code_orchestration?.value ?? "",
            "delegate_task",
          );
          assert.include(
            params.additionalContext?.scient_awareness?.value ?? "",
            "scient_pdf_build",
          );
          assert.include(
            params.additionalContext?.scient_awareness?.value ?? "",
            "scient_compute_inventory",
          );
          assert.include(
            params.additionalContext?.scient_awareness?.value ?? "",
            "scient_skill_load",
          );
          assert.notInclude(params.additionalContext?.scient_awareness?.value ?? "", "device_list");
        }
        const awareness = params.additionalContext?.scient_awareness?.value ?? "";
        assert.include(awareness, "## Scient");
        assert.include(awareness, "workspace-relative Markdown images");
        assert.include(awareness, "diagram declaration before its contents");
        assert.include(awareness, "Create workspace files for standalone deliverables");
        assert.include(awareness, "clickable project-relative Markdown links");
        if (scenario.grants) {
          assert.include(awareness, "Scient browser");
          assert.include(awareness, "preview_open");
          assert.include(awareness, "another browser system only when");
        } else {
          for (const absent of [
            "Scient browser",
            "preview_status",
            "preview_open",
            "device_open",
            "scient_skill_load",
            "scient_pdf_build",
            "scient_compute_inventory",
          ])
            assert.notInclude(awareness, absent);
        }
        if (hasMcp) {
          assert.equal(
            (params.additionalContext?.t3_code_orchestration?.value ?? "") +
              (params.additionalContext?.t3_code_workspace?.value ?? ""),
            SCIENT_ORCHESTRATION_INSTRUCTIONS,
          );
          assert.equal(params.additionalContext?.t3_code_orchestration?.kind, "application");
          assert.deepEqual(Object.keys(params.additionalContext ?? {}), [
            "t3_code_orchestration",
            "t3_code_workspace",
            "t3_code_runtime",
            "scient_awareness",
          ]);
          for (const entry of Object.values(params.additionalContext ?? {})) {
            assert.isAtMost(Buffer.byteLength(entry.value, "utf8"), 4_000);
          }
          const modeInstructions = params.collaborationMode?.settings.developer_instructions ?? "";
          assert.match(modeInstructions, /^<collaboration_mode>[\s\S]*<\/collaboration_mode>$/);
          assert.notMatch(
            modeInstructions,
            /runtime_info|pull_request_linking|preview_|device_|## Scient/,
          );
          assert.equal(params.collaborationMode?.mode, scenario.mode);
        }
        const entries = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "work" });
        const transcript = makeCodexReplayTranscript({
          scenario: "restore-context",
          entries: [
            ...entries.slice(0, 5),
            {
              type: "expect_outbound",
              label: "context turn",
              frame: { id: 3, method: "turn/start", params },
            },
            ...entries.slice(6),
            {
              type: "emit_inbound",
              label: "compacted",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: { type: "contextCompaction", id: "compact-context" },
                },
              },
            },
            {
              type: "expect_outbound",
              label: "restore context",
              frame: {
                id: 4,
                method: "thread/inject_items",
                params: {
                  threadId: nativeThreadId,
                  items: Object.entries(params.additionalContext ?? {}).map(([key, entry]) => ({
                    type: "message",
                    role: "developer",
                    content: [{ type: "input_text", text: `<${key}>${entry.value}</${key}>` }],
                  })),
                },
              },
            },
            { type: "emit_inbound", label: "restored", frame: { id: 4, result: {} } },
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
        if (hasMcp)
          McpProviderSession.setMcpProviderSession({
            environmentId: EnvironmentId.make("test"),
            threadId: harness.threadId,
            providerSessionId: "context-session",
            providerInstanceId: ProviderInstanceId.make("codex"),
            endpoint: "http://127.0.0.1:43123/mcp",
            authorizationHeader: "Bearer test",
            capabilities,
          });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => McpProviderSession.clearMcpProviderSession(harness.threadId)),
        );
        yield* harness.runtime.startTurn({
          ...makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("context-attempt"),
            text: "work",
          }),
          modelSelection,
          runtimePolicy,
        });
        yield* harness.firstTerminal;
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }).pipe(
        Effect.provide(
          Layer.merge(
            IdAllocator.layer,
            Layer.merge(NodeServices.layer, ThreadCommandExecutor.layer),
          ),
        ),
      ),
    ),
  );
});
