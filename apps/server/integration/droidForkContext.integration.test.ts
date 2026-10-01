/**
 * A stopped, unsent Droid prompt and the conversation history it carried,
 * through the real adapter, runtime ingestion, projection and context
 * delivery: nothing here stands in for the reconciliation.
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DroidSettings,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeDroidAdapter } from "../src/provider/Layers/DroidAdapter.ts";
import { scriptedDroid } from "../src/provider/testUtils/scriptedDroid.ts";
import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";

const decodeDroidSettings = Schema.decodeSync(DroidSettings);
const DROID = ProviderDriverKind.make("droid");
const PROJECT = ProjectId.make("project-droid-import");
const THREAD = ThreadId.make("thread-droid-import");
const IMPORTED_TURN = TurnId.make("imported-turn-1");
const NOW = "2026-09-30T10:00:00.000Z";
const modelSelection = { instanceId: ProviderInstanceId.make("droid"), model: "droid-native" };

it.live(
  "sends an imported conversation's history with the next message when Stop won before the first was sent",
  () =>
    Effect.gen(function* () {
      const droid = yield* scriptedDroid(`
function onPrompt(message) {
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Understood." } });
  reply(message, { stopReason: "end_turn" });
}`);
      // Hold the first send before it reaches the adapter, as when the thread is still starting.
      const entered = yield* Deferred.make<void>();
      const stopRequested = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let sends = 0;
      const harness = yield* Effect.acquireRelease(
        makeOrchestrationIntegrationHarness({
          provider: DROID,
          makeAdapter: makeDroidAdapter(decodeDroidSettings({ binaryPath: droid.binaryPath })).pipe(
            Effect.orDie,
            Effect.map((adapter) => ({
              ...adapter,
              sendTurn: (input: Parameters<typeof adapter.sendTurn>[0]) =>
                Effect.suspend(() =>
                  ++sends === 1
                    ? Deferred.succeed(entered, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                        Effect.andThen(adapter.sendTurn(input)),
                      )
                    : adapter.sendTurn(input),
                ),
              captureTurnStop: (threadId: ThreadId) =>
                adapter.captureTurnStop!(threadId).pipe(
                  Effect.map((stop) => ({
                    ...stop,
                    interrupt: stop.interrupt.pipe(
                      Effect.ensuring(Deferred.succeed(stopRequested, undefined)),
                    ),
                  })),
                ),
            })),
          ),
        }),
        (harness) => harness.dispose,
      );

      yield* harness.engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project"),
        projectId: PROJECT,
        title: "Droid import",
        workspaceRoot: harness.workspaceDir,
        defaultModelSelection: modelSelection,
        createdAt: NOW,
      });
      yield* harness.engine.dispatch({
        type: "thread.conversation.import",
        commandId: CommandId.make("cmd-import"),
        threadId: THREAD,
        projectId: PROJECT,
        title: "Imported conversation",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        messages: [
          {
            messageId: MessageId.make("imported-user-1"),
            role: "user",
            text: "Which city did we pick for the workshop?",
            turnId: null,
            createdAt: "2026-09-29T09:00:00.000Z",
            updatedAt: "2026-09-29T09:00:00.000Z",
          },
          {
            messageId: MessageId.make("imported-assistant-1"),
            role: "assistant",
            text: "We picked Poseidonis for the workshop.",
            turnId: IMPORTED_TURN,
            createdAt: "2026-09-29T09:00:05.000Z",
            updatedAt: "2026-09-29T09:00:05.000Z",
          },
        ],
        proposedPlans: [],
        activities: [],
        inheritedTurnIds: [IMPORTED_TURN],
        turns: [
          {
            turnId: IMPORTED_TURN,
            userMessageId: MessageId.make("imported-user-1"),
            assistantMessageId: MessageId.make("imported-assistant-1"),
            requestedAt: "2026-09-29T09:00:00.000Z",
            completedAt: "2026-09-29T09:00:05.000Z",
          },
        ],
        origin: {
          source: "markdown",
          exportId: "export-1",
          sourceThreadId: null,
          packageDigest: `sha256:${"a".repeat(64)}`,
          sourceFormat: "markdown",
          sourceFormatVersion: 1,
          importedAt: NOW,
          omissions: [],
        },
        createdAt: NOW,
      });

      const send = (id: string, text: string, createdAt: string) =>
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-turn-${id}`),
          threadId: THREAD,
          message: { messageId: MessageId.make(id), role: "user", text, attachments: [] },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt,
        });
      const prompts = droid
        .readLog()
        .pipe(
          Effect.map((messages) =>
            messages.flatMap((message) =>
              message.method === "session/prompt"
                ? [
                    ((message.params?.prompt ?? []) as ReadonlyArray<{ readonly text?: string }>)
                      .map((part) => part.text ?? "")
                      .join(""),
                  ]
                : [],
            ),
          ),
        );

      yield* send(
        "message-1",
        "First message, stopped before it is sent.",
        "2026-09-30T10:01:00.000Z",
      );
      yield* Deferred.await(entered);
      yield* harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-stop"),
        threadId: THREAD,
        createdAt: "2026-09-30T10:01:01.000Z",
      });
      yield* Deferred.await(stopRequested);
      yield* Deferred.succeed(release, undefined);
      yield* harness.waitForThread(
        THREAD,
        (thread) => thread.session?.status === "stopped" || thread.session?.status === "ready",
      );
      assert.deepEqual(yield* prompts, []);

      yield* send("message-2", "Second message.", "2026-09-30T10:02:00.000Z");
      yield* harness.waitForThread(THREAD, (thread) =>
        thread.messages.some(
          (message) => message.role === "assistant" && message.text === "Understood.",
        ),
      );
      const sent = yield* prompts;
      assert.lengthOf(sent, 1);
      assert.include(sent[0], "Second message.");
      // Droid never received the first message, so it has not received the history either.
      assert.include(sent[0], "We picked Poseidonis for the workshop.");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  90_000,
);
