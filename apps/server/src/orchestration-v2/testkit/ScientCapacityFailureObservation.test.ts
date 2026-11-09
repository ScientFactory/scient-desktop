import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailure,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { ScientCapacityFailureObservation } from "./ScientCapacityFailureObservation.test-support.ts";

const threadId = ThreadId.make("capacity-race:sql-failure");
const occurredAt = DateTime.makeUnsafe("2026-10-05T00:00:00Z");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const errorEvent = (failure: OrchestrationV2ProviderFailure) =>
  ({
    id: EventId.make("diagnostic-error"),
    type: "turn-item.updated",
    threadId,
    occurredAt,
    payload: {
      id: TurnItemId.make("diagnostic-error-item"),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "failed",
      title: "Provider error",
      startedAt: occurredAt,
      completedAt: occurredAt,
      updatedAt: occurredAt,
      type: "error",
      failure,
    },
  }) satisfies Extract<OrchestrationV2DomainEvent, { readonly type: "turn-item.updated" }>;

it.effect("selects only capacity-race error failures and redacts common credential forms", () =>
  Effect.gen(function* () {
    let snapshot: unknown;
    const observation = new ScientCapacityFailureObservation("/missing/db", (value) => {
      snapshot = value;
    });
    const failure = {
      class: "transport_error",
      message: "Stream closed; Bearer secret-token; api_key=credential-canary",
      code: "ERR_STREAM_CLOSED",
      retryable: null,
      prompt: "failure-prompt-canary",
      parameters: ["sql-parameter-canary"],
      files: ["/private/file-canary"],
    } satisfies OrchestrationV2ProviderFailure & {
      readonly prompt: string;
      readonly parameters: ReadonlyArray<string>;
      readonly files: ReadonlyArray<string>;
    };
    const selected = errorEvent(failure);
    const foreignThreadId = ThreadId.make("unrelated-thread");
    const foreign = errorEvent({ ...failure, message: "foreign-error-canary" });
    const mismatched = errorEvent({ ...failure, message: "mismatched-error-canary" });
    const prompt: OrchestrationV2DomainEvent = {
      ...selected,
      id: EventId.make("diagnostic-prompt"),
      payload: {
        ...selected.payload,
        type: "assistant_message",
        messageId: MessageId.make("diagnostic-prompt-message"),
        text: "assistant-content-canary",
        streaming: false,
      },
    };
    yield* observation.forward(
      "writeWithEffects",
      [
        { ...selected, payload: { ...selected.payload, title: "title-content-canary" } },
        {
          ...foreign,
          threadId: foreignThreadId,
          payload: { ...foreign.payload, threadId: foreignThreadId },
        },
        { ...mismatched, payload: { ...mismatched.payload, threadId: foreignThreadId } },
        prompt,
      ],
      Effect.void,
    );
    yield* observation
      .beforeCleanup(Effect.fail("original wait failed"), Effect.succeed(null))
      .pipe(Effect.exit);
    const text = encodeJson(snapshot);
    assert.include(text, "Stream closed; Bearer [REDACTED]; api_key=[REDACTED]");
    assert.include(text, "ERR_STREAM_CLOSED");
    for (const excluded of [
      "secret-token",
      "credential-canary",
      "failure-prompt-canary",
      "sql-parameter-canary",
      "file-canary",
      "foreign-error-canary",
      "mismatched-error-canary",
      "assistant-content-canary",
      "title-content-canary",
    ])
      assert.notInclude(text, excluded);
    const unrelated = Effect.succeed({ committed: true });
    assert.strictEqual(
      observation.forward(
        "unrelated",
        [
          {
            ...foreign,
            threadId: foreignThreadId,
            payload: { ...foreign.payload, threadId: foreignThreadId },
          },
        ],
        unrelated,
      ),
      unrelated,
    );
  }),
);
