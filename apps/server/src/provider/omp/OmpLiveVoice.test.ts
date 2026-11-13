import { assert, it } from "@effect/vitest";
import type { OmpRpcClient } from "effect-omp-rpc/client";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { makeOmpLiveVoice } from "./OmpLiveVoice.ts";

/** A client that answers live commands and records what was sent. */
const fakeClient = () => {
  const sent: Array<Record<string, unknown>> = [];
  const client = {
    command: (body: Record<string, unknown> & { readonly type: string }) =>
      Effect.sync(() => {
        sent.push(body);
        return {
          type: "response" as const,
          command: body.type,
          success: true,
          data:
            body.type === "live_connect"
              ? { voice: "sol", sdpAnswer: "v=0 answer" }
              : body.type === "live_mute"
                ? { muted: body.muted }
                : undefined,
        };
      }),
  } as unknown as OmpRpcClient;
  return { client, sent };
};

it.effect("answers the offer, then passes the agent's frames until the call ends", () =>
  Effect.gen(function* () {
    const { client, sent } = fakeClient();
    const live = makeOmpLiveVoice(client);
    const call = yield* Stream.runCollect(live.runtime.call("v=0 offer")).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* live.onFrame({ type: "live_phase", phase: "listening" });
    yield* live.onFrame({ type: "live_levels", input: 0.4, output: 0 });
    yield* live.onFrame({
      type: "live_transcript",
      role: "user",
      turn: 1,
      text: "Hi",
      final: true,
    });
    yield* live.onFrame({ type: "live_delegation", text: " list my open PRs " });
    yield* live.onFrame({ type: "live_end" });
    const events = yield* Fiber.join(call);
    assert.deepStrictEqual(events, [
      { type: "answer", sdpAnswer: "v=0 answer", voice: "sol" },
      { type: "phase", phase: "listening" },
      { type: "transcript", role: "user", turn: 1, text: "Hi", final: true },
      { type: "request", text: "list my open PRs" },
      { type: "ended" },
    ]);
    assert.deepStrictEqual(sent[0], {
      type: "live_connect",
      sdpOffer: "v=0 offer",
      hostDelegation: true,
    });
    // The agent ended the call itself, so nothing hangs up twice.
    assert.isFalse(sent.some((body) => body.type === "live_stop"));
  }),
);

it.effect("hangs up when the window stops listening, and allows a new call", () =>
  Effect.gen(function* () {
    const { client, sent } = fakeClient();
    const live = makeOmpLiveVoice(client);
    const first = yield* Stream.runHead(live.runtime.call("offer"));
    assert.strictEqual(first._tag === "Some" && first.value.type, "answer");
    assert.deepStrictEqual(sent.at(-1), { type: "live_stop" });
    yield* Stream.runHead(live.runtime.call("offer"));
    assert.strictEqual(sent.filter((body) => body.type === "live_connect").length, 2);
  }),
);

it.effect("refuses a second call and ends a call when the agent stops", () =>
  Effect.gen(function* () {
    const { client } = fakeClient();
    const live = makeOmpLiveVoice(client);
    const call = yield* Stream.runCollect(live.runtime.call("offer")).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const second = yield* Stream.runCollect(live.runtime.call("offer")).pipe(Effect.flip);
    assert.strictEqual(second.reason, "call-active");
    assert.isTrue(yield* live.runtime.mute(true));
    yield* live.onProcessEnded;
    const events = yield* Fiber.join(call);
    assert.deepStrictEqual(events.at(-1), { type: "ended", error: "Scient Agent stopped." });
  }),
);
