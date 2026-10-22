import { assert, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { resolveThreadServerOrigin, type ThreadTools, waitForRun } from "./thread.ts";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

it.effect.each(["http://127.0.0.1:3773", "http://localhost:3773", "http://[::1]:3773"])(
  "uses the recorded local authority: %s",
  (origin) =>
    Effect.gen(function* () {
      assert.equal(yield* resolveThreadServerOrigin({ origin, port: 3773 }), origin);
    }),
);

it.effect.each([
  "https://127.0.0.1:3773",
  "http://remote.example:3773",
  "http://127.attacker.example:3773",
  "http://127.0.0.1:3774",
  "http://user:password@127.0.0.1:3773",
  "http://127.0.0.1:3773/mcp",
  "http://127.0.0.1:3773/?destination=remote",
  "http://127.0.0.1:3773/#remote",
  "not a URL",
])("rejects a nonlocal or mismatched saved authority: %s", (origin) =>
  Effect.gen(function* () {
    const result = yield* resolveThreadServerOrigin({ origin, port: 3773 }).pipe(Effect.flip);
    assert.equal(result._tag, "ThreadUsageError");
  }),
);

/** Answers each tool call with the next scripted response for that tool. */
const scriptedTools = (script: Record<string, Array<unknown>>) => {
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  const call = ((tool: string, args: unknown) => {
    calls.push({ tool, args });
    const next = script[tool]?.shift();
    return next === undefined ? Effect.die(`unscripted ${tool} call`) : Effect.succeed(next);
  }) as ThreadTools["call"];
  return { tools: { call } satisfies ThreadTools, calls };
};

it.effect("--wait follows the sent run to its continuation's terminal status", () =>
  Effect.gen(function* () {
    const continuation = RunId.make("run-2");
    const { tools, calls } = scriptedTools({
      scient_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId: continuation, status: "failed", timedOut: false },
      ],
      scient_thread_inspect: [{ thread: { pendingRequestCount: 0 } }],
    });

    const outcome = yield* waitForRun(tools, threadId, runId);

    assert.deepStrictEqual(outcome, { type: "ended", runId: continuation, status: "failed" });
    assert.deepStrictEqual(
      calls.filter((entry) => entry.tool === "scient_thread_wait").map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000 },
        { threadId, runId, timeoutMs: 15_000 },
      ],
    );
  }),
);

it.effect("--wait stops when the thread waits for an answer instead of polling forever", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      scient_thread_wait: [
        { threadId, runId, status: "queued", timedOut: true },
        { threadId, runId, status: "queued", timedOut: true },
      ],
      scient_thread_inspect: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), { type: "needs_input" });
  }),
);

it.effect("--wait reports its run's result when a later run is the one waiting", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      scient_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId, status: "completed", timedOut: false },
      ],
      scient_thread_inspect: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId,
      status: "completed",
    });
  }),
);
