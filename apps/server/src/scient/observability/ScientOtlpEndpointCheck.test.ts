import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { guardOtlpEndpointCheck } from "./ScientOtlpEndpointCheck.ts";

it.effect("refuses explicit and saved-endpoint diagnostic requests without outbound work", () =>
  Effect.gen(function* () {
    let requests = 0;
    const service = guardOtlpEndpointCheck({
      check: () =>
        Effect.sync(() => {
          requests++;
          return { _tag: "Accepted" as const, latencyMs: 1 };
        }),
    });
    for (const signal of ["traces", "metrics", "logs"] as const) {
      assert.deepEqual(
        yield* service.check({ signal, url: `http://collector.invalid/v1/${signal}` }),
        { _tag: "Rejected", status: 403 },
      );
    }
    assert.equal(requests, 0);
  }),
);
