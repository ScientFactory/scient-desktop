import { describe, expect, it } from "@effect/vitest";
import type { OmpRpcNotification } from "effect-omp-rpc/client";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { watchRpcTextTurn } from "./OmpCustomModels.testFixtures.ts";

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

  it.effect("fails if the native stream closes before any terminal outcome", () =>
    Effect.gen(function* () {
      const completed = yield* watchRpcTextTurn(Stream.empty);
      expect((yield* completed.pipe(Effect.flip)).message).toContain("stream ended");
    }),
  );
});
