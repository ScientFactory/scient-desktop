import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeHarness, syntheticValue } from "./Accounts.testkit.ts";

it.effect("names the rows that hold the same key, never the key", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    const shared = syntheticValue();
    const key = (name: string, value: string) =>
      service.save({
        name,
        details: { kind: "api-key", sites: ["openrouter.ai"], auth: { type: "bearer" } },
        secrets: { token: { type: "scient", value } },
      });
    const first = yield* key("OpenRouter", shared);
    const second = yield* key("OpenRouter (model key)", shared);
    yield* key("Work OpenRouter", syntheticValue());
    const snapshot = yield* service.snapshot;
    expect(snapshot.sameKeys).toEqual([[first.accountId, second.accountId]]);
    expect(JSON.stringify(snapshot)).not.toContain(shared);
  }),
);
