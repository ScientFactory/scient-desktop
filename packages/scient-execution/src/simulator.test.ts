import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { createSimulatedExecutionPort } from "./simulator.ts";

describe("simulated execution process port", () => {
  it.effect("uses the same stream, exit, and cancellation contract as host adapters", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const port = createSimulatedExecutionPort(() => ({
          steps: [{ output: { stream: "stdout", text: "ready\n" } }],
          exitCode: 0,
        }));
        const handle = yield* port.start({
          runId: "run-1" as never,
          executable: "simulator",
          args: [],
          cwd: "/project",
          environment: {},
        });
        expect(yield* Stream.runCollect(handle.output)).toEqual([
          { stream: "stdout", text: "ready\n" },
        ]);
        expect(yield* handle.exitCode).toBe(0);
        yield* handle.cancel;
        expect(yield* handle.exitCode).toBe(130);
      }),
    ),
  );
});
