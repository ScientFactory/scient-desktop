import { it } from "@effect/vitest";
import {
  AccountId,
  CloudSpeechError,
  DEFAULT_SERVER_SETTINGS,
  SecretProviderId,
} from "@t3tools/contracts";
import { Effect, Layer, Redacted } from "effect";
import { expect } from "vite-plus/test";

import { AccountsService } from "../scient/accounts/AccountsService.ts";
import { makeHarness } from "../scient/accounts/Accounts.testkit.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { LegacySpeechKeys, layer } from "./LegacySpeechKeys.ts";

it.effect(
  "retries an interrupted transfer, rotates the authoritative key, and preserves a deleted slot",
  () =>
    Effect.gen(function* () {
      const accountStore = yield* makeHarness();
      const external = {
        provider: SecretProviderId.make("fixture-vault"),
        reference: "op://Synthetic/Voice/token",
      };
      const original = "synthetic-original-speech-key";
      const replacement = "synthetic-replacement-speech-key";
      const settingsLayer = ServerSettingsService.layerTest({
        cloudSpeechCredentials: { openai: original, xai: external },
      });
      yield* Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        let interrupted = true;
        const keysLayer = layer.pipe(
          Layer.provide(Layer.succeed(AccountsService, accountStore.service)),
          Layer.provide(
            Layer.succeed(ServerSettingsService, {
              ...settings,
              commitLegacySpeechTransfer: (...args) => {
                if (interrupted) {
                  interrupted = false;
                  return settings.commitLegacySpeechTransfer!(
                    args[0],
                    "different fixture",
                    args[2],
                  );
                }
                return settings.commitLegacySpeechTransfer!(...args);
              },
            }),
          ),
        );
        const keys = yield* Effect.provide(LegacySpeechKeys, keysLayer);
        expect((yield* Effect.flip(keys.get("openai")))._tag).toBe("CloudSpeechError");
        expect((yield* settings.getSettings).legacySpeechAccountIds?.openai).toBeUndefined();
        expect((yield* accountStore.service.snapshot).accounts).toHaveLength(1);
        expect(yield* keys.get("xai")).toEqual(external);

        const migrated = yield* keys.get("openai");
        if (typeof migrated !== "object" || !("accountId" in migrated)) {
          return yield* new CloudSpeechError({ provider: "openai", reason: "unavailable" });
        }
        const current = yield* settings.getSettings;
        expect(current.cloudSpeechCredentials.openai).toBe("");
        expect(current.legacySpeechAccountIds?.openai).toBe(migrated.accountId);
        expect((yield* accountStore.service.snapshot).accounts).toHaveLength(1);
        expect(yield* keys.get("openai")).toEqual(migrated);

        yield* keys.set("openai", Redacted.make(replacement));
        const value = yield* keys.key("openai", migrated.accountId);
        expect(Redacted.value(value) === replacement).toBe(true);
        expect((yield* settings.getSettings).cloudSpeechCredentials.openai).toBe("");

        yield* keys.set("openai", null);
        expect(yield* keys.get("openai")).toEqual(migrated);
        expect((yield* Effect.flip(keys.key("openai", migrated.accountId))).reason).toBe(
          "missing-key",
        );
        expect((yield* accountStore.service.snapshot).accounts).toHaveLength(0);
        expect((yield* settings.getSettings).cloudSpeechCredentials.xai).toEqual(external);
        expect(JSON.stringify(yield* settings.getSettings)).not.toContain(replacement);
        expect(DEFAULT_SERVER_SETTINGS.cloudSpeechCredentials.openai).toBe("");
      }).pipe(Effect.provide(settingsLayer));
    }),
);

it.effect(
  "resumes retirement after publishing a reference without reviving a removed account",
  () =>
    Effect.gen(function* () {
      const accountStore = yield* makeHarness();
      const accountId = AccountId.make("acc_legacy_speech_openai");
      const settingsLayer = ServerSettingsService.layerTest({
        legacySpeechAccountIds: { openai: accountId },
        cloudSpeechCredentials: { openai: "synthetic-unretired-key" },
      });
      yield* Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const keys = yield* LegacySpeechKeys;
        expect(yield* keys.get("openai")).toEqual({ accountId });
        expect((yield* settings.getSettings).cloudSpeechCredentials.openai).toBe("");
        expect((yield* accountStore.service.snapshot).accounts).toHaveLength(0);
        expect((yield* Effect.flip(keys.key("openai", accountId))).reason).toBe("missing-key");
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(AccountsService, accountStore.service),
        Effect.provide(settingsLayer),
      );
    }),
);

it.effect(
  "detaches a migrated key when setting an external reference and keeps it detached after clear",
  () =>
    Effect.gen(function* () {
      const accountStore = yield* makeHarness();
      const settingsLayer = ServerSettingsService.layerTest({
        cloudSpeechCredentials: { openai: "synthetic-original" },
      });
      yield* Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const keysLayer = layer.pipe(
          Layer.provide(Layer.succeed(AccountsService, accountStore.service)),
          Layer.provide(Layer.succeed(ServerSettingsService, settings)),
        );
        const keys = yield* Effect.provide(LegacySpeechKeys, keysLayer);
        const migrated = yield* keys.get("openai");
        expect(migrated).toEqual({ accountId: "acc_legacy_speech_openai" });
        const external = {
          provider: SecretProviderId.make("fixture-vault"),
          reference: "op://Synthetic/Voice/token",
        };
        yield* keys.set("openai", external);
        expect(yield* keys.get("openai")).toEqual(external);
        expect((yield* settings.getSettings).legacySpeechAccountIds?.openai).toBeUndefined();
        yield* keys.set("openai", null);
        const restarted = yield* Effect.provide(LegacySpeechKeys, keysLayer);
        expect(yield* restarted.get("openai")).toBe("");
        expect((yield* accountStore.service.snapshot).accounts).toHaveLength(1);
      }).pipe(Effect.provide(settingsLayer));
    }),
);
