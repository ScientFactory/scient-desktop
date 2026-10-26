import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { ScientPluginRegistry } from "./ExtensionsServices.ts";
import { makePluginContents } from "./PluginContents.ts";

it.effect("settles a stalled skill document with an actionable error", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.mergeAll(
        Layer.mock(ProviderRegistry)({}),
        Layer.mock(ScientPluginRegistry)({ skillDocument: () => Effect.never }),
      ),
    );
    const contents = makePluginContents(
      Context.get(context, ProviderRegistry),
      Context.get(context, ScientPluginRegistry),
    );
    const pending = yield* contents
      .document({ pluginId: "papers", skillId: "research" })
      .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("15 seconds");
    const result = yield* Fiber.join(pending);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.message).toContain("did not respond");
  }),
);
