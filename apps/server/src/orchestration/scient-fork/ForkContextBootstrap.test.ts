import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ChatAttachment,
  type OrchestrationMessage,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ScientForkContextBootstrap,
  ScientForkContextBootstrapLive,
} from "./ForkContextBootstrap.ts";

const NOW = "2026-08-08T12:00:00.000Z";
const THREAD = ThreadId.make("fork-thread");

function attachment(index: number): ChatAttachment {
  return {
    type: "image",
    id: `image-${index}`,
    name: `image-${index}.png`,
    mimeType: "image/png",
    sizeBytes: 100,
  };
}

function message(input: {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
}): OrchestrationMessage {
  return {
    id: MessageId.make(input.id),
    role: input.role,
    text: input.text,
    ...(input.attachments ? { attachments: input.attachments } : {}),
    turnId: input.role === "assistant" ? TurnId.make(`turn-${input.id}`) : null,
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function thread(messages: ReadonlyArray<OrchestrationMessage>): OrchestrationThread {
  return {
    id: THREAD,
    projectId: ProjectId.make("project-1"),
    title: "Retained investigation",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    deletedAt: null,
    messages: [...messages],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId: THREAD,
      status: "idle",
      providerName: null,
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW,
    },
  };
}

const layer = ScientForkContextBootstrapLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(layer)("ScientForkContextBootstrap", (it) => {
  const reset = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM scient_thread_lineage`;
    return sql;
  });

  const insertFork = (status = "ready", forkPointTurnCount = 2) =>
    Effect.gen(function* () {
      const sql = yield* reset;
      yield* sql`
        INSERT INTO scient_thread_lineage (
          thread_id,
          forked_from_thread_id,
          fork_point_turn_count,
          workspace_mode,
          provider_mode,
          provider_bootstrap_status,
          fidelity_mode,
          status,
          checkpoint_status,
          workspace_status,
          attempt_count,
          created_at,
          updated_at
        ) VALUES (
          ${THREAD},
          'origin-thread',
          ${forkPointTurnCount},
          'local',
          'transcript-bootstrap',
          'pending',
          'transcript-bootstrap',
          ${status},
          'ready',
          'shared',
          1,
          ${NOW},
          ${NOW}
        )
      `;
    });

  it.effect("passes ordinary threads through unchanged", () =>
    Effect.gen(function* () {
      yield* reset;
      const service = yield* ScientForkContextBootstrap;
      const current = message({ id: "current", role: "user", text: "Continue" });
      const prepared = yield* service.prepareTurn({
        thread: thread([current]),
        currentMessageId: current.id,
        messageText: current.text,
        attachments: [],
      });
      assert.deepStrictEqual(prepared, {
        input: "Continue",
        attachments: [],
        bootstrapPending: false,
      });
    }),
  );

  it.effect("injects the retained transcript exactly once and persists completion", () =>
    Effect.gen(function* () {
      yield* insertFork();
      const service = yield* ScientForkContextBootstrap;
      const current = message({ id: "current", role: "user", text: "What next?" });
      const forkThread = thread([
        message({ id: "user-1", role: "user", text: "Inspect the evidence" }),
        message({ id: "assistant-1", role: "assistant", text: "The evidence is consistent." }),
        current,
      ]);

      const first = yield* service.prepareTurn({
        thread: forkThread,
        currentMessageId: current.id,
        messageText: current.text,
        attachments: [],
      });
      assert.strictEqual(first.bootstrapPending, true);
      assert.match(first.input, /Inspect the evidence/);
      assert.match(first.input, /The evidence is consistent/);
      assert.match(first.input, /"latestUserMessage":"What next\?"/);

      yield* service.markAccepted(THREAD);
      const second = yield* service.prepareTurn({
        thread: forkThread,
        currentMessageId: current.id,
        messageText: current.text,
        attachments: [],
      });
      assert.deepStrictEqual(second, {
        input: "What next?",
        attachments: [],
        bootstrapPending: false,
      });
    }),
  );

  it.effect("passes the first post-fork turn through at the valid turn-zero boundary", () =>
    Effect.gen(function* () {
      yield* insertFork("ready", 0);
      const service = yield* ScientForkContextBootstrap;
      const currentAttachment = attachment(1);
      const current = message({
        id: "current",
        role: "user",
        text: "Start a different approach",
        attachments: [currentAttachment],
      });
      const prepared = yield* service.prepareTurn({
        thread: thread([current]),
        currentMessageId: current.id,
        messageText: current.text,
        attachments: [currentAttachment],
      });
      assert.deepStrictEqual(prepared, {
        input: "Start a different approach",
        attachments: [currentAttachment],
        bootstrapPending: true,
      });
    }),
  );

  it.effect("retains recent context as valid JSON within the input budget", () =>
    Effect.gen(function* () {
      yield* insertFork();
      const service = yield* ScientForkContextBootstrap;
      const prior = Array.from({ length: 40 }, (_, index) =>
        message({
          id: `prior-${index}`,
          role: index % 2 === 0 ? "user" : "assistant",
          text: `${index}:${"x".repeat(5_000)}`,
        }),
      );
      const current = message({ id: "current", role: "user", text: "Latest" });
      const prepared = yield* service.prepareTurn({
        thread: thread([...prior, current]),
        currentMessageId: current.id,
        messageText: current.text,
        attachments: [],
      });
      assert.isBelow(prepared.input.length, 120_001);
      const json = prepared.input
        .split("\n\nLATEST_USER_MESSAGE_JSON\n", 1)[0]!
        .replace("SCIENT_FORK_CONTEXT_JSON\n", "");
      // @effect-diagnostics-next-line preferSchemaOverJson:off - validates the emitted prompt DTO.
      const parsed = JSON.parse(json) as {
        omittedOlderMessageCount: number;
        transcript: ReadonlyArray<{ text: string }>;
      };
      assert.isAbove(parsed.omittedOlderMessageCount, 0);
      assert.match(parsed.transcript.at(-1)?.text ?? "", /^39:/);
    }),
  );

  it.effect("prioritizes the latest message images without exceeding the provider limit", () =>
    Effect.gen(function* () {
      yield* insertFork();
      const service = yield* ScientForkContextBootstrap;
      const prior = Array.from({ length: 10 }, (_, index) =>
        message({
          id: `prior-${index}`,
          role: index % 2 === 0 ? "user" : "assistant",
          text: `message ${index}`,
          attachments: [attachment(index)],
        }),
      );
      const currentAttachment = attachment(20);
      const current = message({
        id: "current",
        role: "user",
        text: "Compare these",
        attachments: [currentAttachment],
      });
      const prepared = yield* service.prepareTurn({
        thread: thread([...prior, current]),
        currentMessageId: current.id,
        messageText: current.text,
        attachments: [currentAttachment],
      });
      assert.strictEqual(prepared.attachments.length, 8);
      assert.isTrue(prepared.attachments.some((item) => item.id === currentAttachment.id));
      assert.isTrue(prepared.attachments.some((item) => item.id === "image-9"));
      assert.isFalse(prepared.attachments.some((item) => item.id === "image-0"));
      assert.match(prepared.input, /"omittedRetainedAttachmentCount":3/);
    }),
  );

  it.effect("refuses to send before the fork workspace is ready", () =>
    Effect.gen(function* () {
      yield* insertFork("provisioning");
      const service = yield* ScientForkContextBootstrap;
      const current = message({ id: "current", role: "user", text: "Continue" });
      const result = yield* Effect.result(
        service.prepareTurn({
          thread: thread([message({ id: "prior", role: "assistant", text: "Prior" }), current]),
          currentMessageId: current.id,
          messageText: current.text,
          attachments: [],
        }),
      );
      assert.strictEqual(result._tag, "Failure");
    }),
  );

  it.effect("fails closed when durable fork state is corrupt", () =>
    Effect.gen(function* () {
      yield* insertFork();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE scient_thread_lineage
        SET provider_bootstrap_status = 'unexpected'
        WHERE thread_id = ${THREAD}
      `;
      const service = yield* ScientForkContextBootstrap;
      const current = message({ id: "current", role: "user", text: "Continue" });
      const result = yield* Effect.result(
        service.prepareTurn({
          thread: thread([message({ id: "prior", role: "assistant", text: "Prior" }), current]),
          currentMessageId: current.id,
          messageText: current.text,
          attachments: [],
        }),
      );
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure.detail, "The stored fork context state is invalid.");
      }
    }),
  );
});
