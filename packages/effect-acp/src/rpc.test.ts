import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as AcpSchema from "./_generated/schema.gen.ts";
import { LenientSetSessionConfigOptionResponse } from "./rpc.ts";

const decodeLenient = Schema.decodeUnknownEffect(LenientSetSessionConfigOptionResponse);
const decodeStrict = Schema.decodeUnknownEffect(AcpSchema.SetSessionConfigOptionResponse);

/**
 * Pins the Droid compatibility rule: `session/set_config_option` responses
 * may omit (or null out) `configOptions`. The tolerance lives in this
 * hand-written codec (`LenientSetSessionConfigOptionResponse`) rather than in
 * the generated schema, so `pnpm generate` cannot silently drop it — if this
 * test fails after a regeneration, the lenient codec needs revisiting.
 *
 * Absence must stay distinguishable from an authoritative empty inventory:
 * the session runtime treats a missing/null inventory as "the refreshed
 * state arrives via the async `config_option_update` notification" and must
 * not overwrite already-observed state with an empty list.
 */
describe("LenientSetSessionConfigOptionResponse", () => {
  it.effect("accepts the spec-shaped response", () =>
    Effect.gen(function* () {
      const spec = {
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select" as const,
            currentValue: "auto",
            options: [{ value: "auto", name: "Auto" }],
          },
        ],
      };
      const decoded = yield* decodeLenient(spec);
      expect(decoded.configOptions).toHaveLength(1);
    }),
  );

  it.effect("keeps an absent inventory absent (async acknowledgment shape)", () =>
    Effect.gen(function* () {
      // The strict generated schema rejects these; the real Factory Droid CLI
      // sends exactly them.
      yield* Effect.flip(decodeStrict({}));
      const decoded = yield* decodeLenient({});
      expect(decoded.configOptions).toBeUndefined();
      const decodedNull = yield* decodeLenient({ configOptions: null });
      expect(decodedNull.configOptions).toBeNull();
    }),
  );

  it.effect("still rejects non-array inventory values", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(decodeLenient({ configOptions: "nope" }));
      expect(failure).toBeDefined();
    }),
  );
});
