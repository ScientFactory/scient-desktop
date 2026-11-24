import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { customModelMethods } from "./scientServerSettings.ts";
import * as ServerSettings from "./serverSettings.ts";

const pi = ProviderInstanceId.make("pi");
const catalog = {
  revision: 3,
  connections: [],
} satisfies typeof DEFAULT_SERVER_SETTINGS.customModels;

it.effect("a T3 settings double without custom-model members has no custom models", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const methods = customModelMethods(settings);
    assert.deepEqual(methods.committedCustomModels(), DEFAULT_SERVER_SETTINGS.customModels);
    assert.deepEqual(yield* methods.resolveCustomModels(pi), []);
    const saved = yield* methods
      .saveCustomModel({ revision: 0, connection: {} as never })
      .pipe(Effect.flip);
    assert.equal(saved._tag, "CustomModelError");
  }).pipe(
    Effect.provide(
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      }),
    ),
  ),
);

it.effect("the settings layers keep their own custom-model members", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    assert.deepEqual(customModelMethods(settings).committedCustomModels(), catalog);
  }).pipe(Effect.provide(ServerSettings.layerTest({ customModels: catalog }))),
);
