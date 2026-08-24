import { it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, vi } from "vite-plus/test";

import type { ProviderRegistryShape } from "../../provider/Services/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "../../provider/testUtils/providerRegistryMock.ts";
import type { ServerSettingsService } from "../../serverSettings.ts";
import { makeVoiceTranscriptCorrection } from "./VoiceTranscriptCorrection.ts";
import type { ProviderVoiceTranscriptCorrection } from "../../provider/ProviderDriver.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return decodeProvider({
    instanceId,
    driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated", required: true },
    checkedAt: "2026-08-24T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  });
}

function settings(): ServerSettingsService["Service"] {
  const current = {
    ...DEFAULT_SERVER_SETTINGS,
    textGenerationModelSelection: createModelSelection(instanceId, "gpt-5.6"),
  };
  return {
    start: Effect.void,
    ready: Effect.void,
    getSettings: Effect.succeed(current),
    updateSettings: () => Effect.succeed(current),
    streamChanges: Stream.make(current),
    subscribeChanges: Effect.succeed(Stream.make(current)),
  };
}

function registry(input: {
  readonly provider?: ServerProvider;
  readonly correction?: ProviderVoiceTranscriptCorrection;
}): ProviderRegistryShape {
  return {
    ...makeProviderRegistryMock(input.provider ? [input.provider] : []),
    getVoiceTranscriptCorrectionForInstance: () => Effect.succeed(input.correction),
  };
}

describe("makeVoiceTranscriptCorrection", () => {
  it.effect("routes through the selected provider instance and model", () =>
    Effect.gen(function* () {
      const correct = vi.fn<ProviderVoiceTranscriptCorrection["correct"]>(() =>
        Effect.succeed({ text: "Hello, world." }),
      );
      const service = makeVoiceTranscriptCorrection({
        registry: registry({ provider: provider(), correction: { correct } }),
        serverSettings: settings(),
      });

      const result = yield* service.correct({ transcript: "helo world" });

      expect(result).toEqual({ text: "Hello, world.", provider: "codex" });
      expect(correct).toHaveBeenCalledWith({
        transcript: "helo world",
        modelSelection: expect.objectContaining({ instanceId, model: "gpt-5.6" }),
      });
    }),
  );

  it.effect("does not invoke correction when the selected provider is unauthenticated", () =>
    Effect.gen(function* () {
      const correct = vi.fn<ProviderVoiceTranscriptCorrection["correct"]>(() =>
        Effect.succeed({ text: "unused" }),
      );
      const service = makeVoiceTranscriptCorrection({
        registry: registry({
          provider: provider({ auth: { status: "unauthenticated", required: true } }),
          correction: { correct },
        }),
        serverSettings: settings(),
      });

      const result = yield* service.correct({ transcript: "raw" }).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.kind).toBe("authentication");
      expect(correct).not.toHaveBeenCalled();
    }),
  );

  it.effect("reports unsupported without invoking a provider", () =>
    Effect.gen(function* () {
      const service = makeVoiceTranscriptCorrection({
        registry: registry({ provider: provider() }),
        serverSettings: settings(),
      });

      const result = yield* service.correct({ transcript: "raw" }).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.kind).toBe("unsupported");
    }),
  );

  it.live("applies the hard deadline to a hung provider", () =>
    Effect.gen(function* () {
      const service = makeVoiceTranscriptCorrection({
        registry: registry({
          provider: provider(),
          correction: { correct: () => Effect.never },
        }),
        serverSettings: settings(),
        timeoutMs: 1,
      });

      const result = yield* service.correct({ transcript: "raw" }).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.kind).toBe("timeout");
    }),
  );
});
