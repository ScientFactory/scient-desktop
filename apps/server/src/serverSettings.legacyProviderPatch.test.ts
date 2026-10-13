import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ServerSettingsPatch } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "./serverSettings.ts";

const decodePatch = Schema.decodeUnknownEffect(ServerSettingsPatch);
const codexId = ProviderInstanceId.make("codex");
const codexWorkId = ProviderInstanceId.make("codex-work");

it.effect(
  "translates old provider patches into the default instance without losing other state",
  () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsService;
      yield* service.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Personal Codex",
            enabled: true,
            environment: [{ name: "CODEX_HOME", value: "/personal", sensitive: false }],
            config: {
              binaryPath: "codex-old",
              launch: { safe: true, preserve: true },
              retainedUnknown: { owner: "existing" },
            },
          },
          [codexWorkId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Work Codex",
            enabled: false,
            config: { binaryPath: "codex-work" },
          },
        },
      });

      // This is the exact shape older clients send through server.updateSettings.
      const patch = yield* decodePatch({
        providers: {
          codex: {
            binaryPath: "/legacy/codex",
            enabled: false,
            launch: { safe: false },
            futureOption: { opaque: ["retained", 7] },
          },
          futureDriver: {
            enabled: "malformed-but-preserved",
            futureConfig: { opaque: true },
          },
        },
      });
      const updated = yield* service.updateSettings(patch);

      expect(updated.providerInstances[codexId]).toEqual({
        driver: ProviderDriverKind.make("codex"),
        displayName: "Personal Codex",
        enabled: false,
        environment: [{ name: "CODEX_HOME", value: "/personal", sensitive: false }],
        config: {
          binaryPath: "/legacy/codex",
          launch: { safe: false, preserve: true },
          retainedUnknown: { owner: "existing" },
          futureOption: { opaque: ["retained", 7] },
        },
      });
      expect(updated.providerInstances[codexWorkId]).toEqual({
        driver: ProviderDriverKind.make("codex"),
        displayName: "Work Codex",
        enabled: false,
        config: { binaryPath: "codex-work" },
      });
      expect(updated.providerInstances[ProviderInstanceId.make("futureDriver")]).toEqual({
        driver: ProviderDriverKind.make("futureDriver"),
        config: {
          enabled: "malformed-but-preserved",
          futureConfig: { opaque: true },
        },
      });
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
);

it.effect("lets an explicit providerInstances patch take precedence over the legacy mirror", () =>
  Effect.gen(function* () {
    const service = yield* ServerSettingsService;
    const patch = yield* decodePatch({
      providers: { codex: { binaryPath: "/legacy/codex" } },
      providerInstances: {
        [codexId]: {
          driver: "codex",
          enabled: true,
          config: { binaryPath: "/canonical/codex" },
        },
      },
    });

    const updated = yield* service.updateSettings(patch);
    expect(updated.providerInstances).toEqual({
      [codexId]: {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        config: { binaryPath: "/canonical/codex" },
      },
    });
  }).pipe(Effect.provide(ServerSettingsService.layerTest())),
);

it.effect("rejects a legacy update when its default instance id belongs to another driver", () =>
  Effect.gen(function* () {
    const service = yield* ServerSettingsService;
    yield* service.updateSettings({
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { binaryPath: "claude" },
        },
      },
    });

    const patch = yield* decodePatch({ providers: { codex: { binaryPath: "/legacy/codex" } } });
    const error = yield* service.updateSettings(patch).pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "ServerSettingsError",
      operation: "normalize",
      providerInstanceId: codexId,
    });
  }).pipe(Effect.provide(ServerSettingsService.layerTest())),
);
