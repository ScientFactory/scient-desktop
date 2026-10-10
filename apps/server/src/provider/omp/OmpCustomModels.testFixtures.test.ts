import { describe, expect, it } from "@effect/vitest";
import { ProviderRuntimeEvent } from "@t3tools/contracts";
import type { OmpRpcNotification } from "effect-omp-rpc/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { watchAdapterTextTurn, watchRpcTextTurn } from "./OmpCustomModels.testFixtures.ts";

const nativeEnd = (stopReason: string, isTerminal = true): OmpRpcNotification => ({
  _tag: "Event",
  event: {
    type: "agent_end",
    isTerminal,
    messages: [
      {
        role: "assistant",
        stopReason,
        content: [
          { type: "thinking", thinking: "Not answer text." },
          { type: "text", text: "CUSTOM_" },
          { type: "text", text: "MODEL_OK" },
        ],
      },
    ],
  },
});
const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const runtimeEvent = (type: string, payload: unknown) =>
  decodeRuntimeEvent({
    type,
    eventId: "qualification-event",
    provider: "scient",
    sessionId: "qualification-session",
    threadId: "qualification-thread",
    createdAt: "2026-10-02T00:00:00.000Z",
    payload,
  });
const textDelta = (delta: string, streamKind = "assistant_text") =>
  runtimeEvent("content.delta", { streamKind, delta });

describe("custom model live qualification outcomes", () => {
  it.effect("returns only assistant text from a successful native terminal", () =>
    Effect.gen(function* () {
      const completed = yield* watchRpcTextTurn(Stream.make(nativeEnd("stop")));
      expect(yield* completed).toBe("CUSTOM_MODEL_OK");
    }),
  );

  it.effect("ignores a nonterminal native end and rejects the later failed answer", () =>
    Effect.gen(function* () {
      const completed = yield* watchRpcTextTurn(
        Stream.make(nativeEnd("stop", false), nativeEnd("error")),
      );
      expect((yield* completed.pipe(Effect.flip)).message).toContain(
        "without a successful assistant answer",
      );
    }),
  );

  it.effect("rejects a native aborted answer even when it contains the requested text", () =>
    Effect.gen(function* () {
      const completed = yield* watchRpcTextTurn(Stream.make(nativeEnd("aborted")));
      expect((yield* completed.pipe(Effect.flip)).message).toContain(
        "without a successful assistant answer",
      );
    }),
  );

  it.effect("fails on a rejected prompt without waiting for agent_end or stream closure", () =>
    Effect.gen(function* () {
      const completed = yield* watchRpcTextTurn(
        Stream.concat(
          Stream.make({
            _tag: "Event",
            event: { type: "prompt_result", status: "error" },
          } satisfies OmpRpcNotification),
          Stream.never,
        ),
      );
      expect((yield* completed.pipe(Effect.flip)).message).toBe("RPC prompt error.");
    }),
  );

  it.effect("fails on a protocol error without waiting for another notification", () =>
    Effect.gen(function* () {
      const completed = yield* watchRpcTextTurn(
        Stream.concat(
          Stream.make({
            _tag: "ProtocolFailure",
            detail: "bad frame",
          } satisfies OmpRpcNotification),
          Stream.never,
        ),
      );
      expect((yield* completed.pipe(Effect.flip)).message).toBe("RPC protocol failure.");
    }),
  );

  it.effect("collects adapter assistant deltas only and requires successful completion", () =>
    Effect.gen(function* () {
      const completed = yield* watchAdapterTextTurn(
        Stream.make(
          textDelta("Do not include reasoning", "reasoning_text"),
          textDelta("CUSTOM_"),
          textDelta("ADAPTER_OK"),
          runtimeEvent("turn.completed", { state: "completed" }),
        ),
      );
      expect(yield* completed).toBe("CUSTOM_ADAPTER_OK");
    }),
  );

  it.effect.each(
    (
      [
        ["turn.completed", { state: "failed" }],
        ["turn.aborted", { reason: "cancelled" }],
        ["session.exited", { reason: "stopped" }],
      ] as const
    ).map(([type, payload]) => ({
      caseTitle: `rejects ${type} ${JSON.stringify(payload)} despite the requested text`,
      type,
      payload,
    })),
  )("$caseTitle", ({ type, payload }) =>
    Effect.gen(function* () {
      const completed = yield* watchAdapterTextTurn(
        Stream.concat(
          Stream.make(textDelta("CUSTOM_ADAPTER_OK"), runtimeEvent(type, payload)),
          Stream.never,
        ),
      );
      expect(yield* completed.pipe(Effect.flip)).toBeInstanceOf(Error);
    }),
  );

  it.effect("fails if the native stream closes before any terminal outcome", () =>
    Effect.gen(function* () {
      const completed = yield* watchRpcTextTurn(Stream.empty);
      expect((yield* completed.pipe(Effect.flip)).message).toContain("stream ended");
    }),
  );
});
