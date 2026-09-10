import { describe, vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  ProviderInstanceId,
  validateCustomModelConnection,
  type CustomModelConnection,
} from "@t3tools/contracts";
import type { ResolvedModelConnection } from "./customModels.ts";
import { makeCustomModelReasoning } from "./customModelReasoning.ts";
import { makeModelReasoningResolver } from "./modelReasoning.ts";
import { piCustomModelReasoning } from "./provider/pi/PiCustomModels.ts";

const connection: CustomModelConnection = {
  id: "one",
  name: "Local",
  baseUrl: "https://custom.test/v1",
  protocol: "openai-completions",
  credentialId: null,
  models: [
    {
      id: "model",
      modelId: "gpt-6-astra",
      name: "Alias",
      reasoning: true,
      images: false,
      contextWindow: 32000,
      maxOutputTokens: 4000,
      instanceIds: [ProviderInstanceId.make("pi")],
    },
  ],
};
const prepareMany = (
  service: ReturnType<typeof makeCustomModelReasoning>,
  connections: ReadonlyArray<ResolvedModelConnection>,
) => Effect.forEach(connections, (connection) => service.prepare(connection));

describe("custom model reasoning integration", () => {
  it.effect("discovers image support even with manual limits and reasoning", () =>
    Effect.gen(function* () {
      const evidence = {
        status: "unknown" as const,
        source: "provider" as const,
        checkedAt: "2026-09-06T00:00:00Z",
        stale: false,
        supported: null,
        levels: [],
        images: true,
      };
      const resolve = vi.fn(async () => evidence);
      const service = makeCustomModelReasoning({ resolve, peek: () => evidence });
      const prepared = yield* service.prepare({
        ...connection,
        apiKey: null,
        models: [
          {
            ...connection.models[0]!,
            imageInput: "automatic",
            configurationMode: "manual",
            reasoningOverride: { supported: false, levels: [] },
          },
        ],
      });
      expect(resolve).toHaveBeenCalledOnce();
      expect(prepared.models[0]?.reasoningMetadata?.images).toBe(true);
      expect(prepared.models[0]?.contextWindow).toBe(32000);
    }),
  );
  it.effect("does not fetch with a substitute credential when the saved key cannot be read", () =>
    Effect.gen(function* () {
      const unknown = {
        status: "unknown" as const,
        source: "unknown" as const,
        stale: false,
        checkedAt: "2026-09-06T00:00:00Z",
        supported: null,
        levels: [],
      };
      const resolve = vi.fn(async () => unknown);
      const service = makeCustomModelReasoning({ resolve, peek: () => unknown });
      const result = yield* service.prepare({ ...connection, credentialError: "Unavailable" });
      expect(result.models[0]?.reasoningMetadata).toEqual(unknown);
      expect(resolve).not.toHaveBeenCalled();
    }),
  );
  it.effect("retains persisted evidence after a failed lookup only for the same model", () =>
    Effect.gen(function* () {
      const unknown = {
        status: "unknown" as const,
        source: "unknown" as const,
        stale: false,
        checkedAt: "2026-09-06T00:00:00Z",
        supported: null,
        levels: [],
      };
      const metadata = {
        ...unknown,
        status: "known" as const,
        source: "provider" as const,
        supported: true,
        levels: ["high" as const],
        contextWindow: 200000,
        maxOutputTokens: 32000,
      };
      const service = makeCustomModelReasoning({
        resolve: async () => unknown,
        peek: () => unknown,
      });
      const previous = {
        ...connection,
        models: [{ ...connection.models[0]!, reasoningMetadata: metadata }],
      };
      const same = yield* service.prepare({ ...connection, apiKey: null }, previous);
      expect(same.models[0]?.reasoningMetadata).toMatchObject({ ...metadata, stale: true });
      const different = yield* service.prepare(
        { ...connection, apiKey: null, models: [{ ...connection.models[0]!, modelId: "other" }] },
        previous,
      );
      expect(different.models[0]?.reasoningMetadata).toEqual(unknown);
      const detachedIdentity = yield* service.prepare({ ...connection, apiKey: null });
      expect(detachedIdentity.models[0]?.reasoningMetadata).toEqual(unknown);
      const previousOverride = {
        ...connection,
        models: [
          {
            ...connection.models[0]!,
            configurationMode: "automatic" as const,
            reasoningOverride: { supported: true, levels: ["high" as const] },
            reasoningMetadata: { ...metadata, source: "manual" as const },
          },
        ],
      };
      const removedOverride = yield* service.prepare(
        {
          ...connection,
          apiKey: null,
          models: [{ ...connection.models[0]!, configurationMode: "automatic" }],
        },
        previousOverride,
      );
      expect(removedOverride.models[0]?.reasoningMetadata).toMatchObject({
        ...unknown,
        stale: true,
        contextWindow: 200000,
        maxOutputTokens: 32000,
      });
      expect(removedOverride.models[0]?.reasoningOverride).toBeUndefined();
    }),
  );
  it.effect("preserves the preference without changing provider evidence", () =>
    Effect.gen(function* () {
      const metadata = {
        status: "known" as const,
        source: "provider" as const,
        checkedAt: "2026-09-06T00:00:00Z",
        stale: false,
        supported: true,
        levels: ["medium", "high"] as const,
        defaultLevel: "medium" as const,
      };
      const service = makeCustomModelReasoning({
        resolve: async () => metadata,
        peek: () => metadata,
      });
      const [result] = yield* prepareMany(service, [
        {
          ...connection,
          apiKey: null,
          models: [{ ...connection.models[0]!, defaultReasoningLevel: "high" }],
        },
      ]);
      expect(result?.models[0]?.defaultReasoningLevel).toBe("high");
      expect(result?.models[0]?.reasoningMetadata).toEqual(metadata);
      expect(result?.models[0]?.reasoningOverride).toBeUndefined();
    }),
  );
  it.effect("keeps automatic capacity independent of a manual reasoning override", () =>
    Effect.gen(function* () {
      const metadata = {
        status: "known" as const,
        source: "provider" as const,
        checkedAt: "2026-09-06T00:00:00.000Z",
        stale: false,
        supported: true,
        levels: ["high" as const],
        contextWindow: 200000,
        maxOutputTokens: 32000,
        images: true,
      };
      const service = makeCustomModelReasoning({
        resolve: async () => metadata,
        peek: () => metadata,
      });
      const enriched = yield* prepareMany(service, [
        {
          ...connection,
          apiKey: null,
          models: [
            {
              ...connection.models[0]!,
              configurationMode: "automatic",
              reasoningOverride: { supported: false, levels: [] },
            },
          ],
        },
      ]);
      expect(enriched[0]?.models[0]?.reasoningMetadata).toMatchObject({
        source: "manual",
        supported: false,
        levels: [],
        contextWindow: 200000,
        maxOutputTokens: 32000,
        images: true,
      });
    }),
  );
  it.effect("bounds explicit setup and falls back to cached evidence", () =>
    Effect.gen(function* () {
      const cached = {
        status: "known" as const,
        source: "provider" as const,
        supported: true,
        checkedAt: "2026-09-06T00:00:00.000Z",
        stale: true,
        levels: ["high" as const],
      };
      const service = makeCustomModelReasoning({
        resolve: () => new Promise(() => {}),
        peek: () => cached,
      });
      const fiber = yield* prepareMany(service, [{ ...connection, apiKey: null }]).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("5 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result[0]?.models[0]?.reasoningMetadata).toEqual(cached);
    }),
  );
  it.effect(
    "does not trust a client-supplied metadata claim or infer capabilities from an alias",
    () =>
      Effect.gen(function* () {
        const fetch = vi.fn<typeof globalThis.fetch>();
        const service = makeCustomModelReasoning(makeModelReasoningResolver({ fetch }));
        const result = yield* prepareMany(service, [
          {
            ...connection,
            apiKey: Redacted.make("secret"),
            models: [
              {
                ...connection.models[0]!,
                reasoningMetadata: {
                  status: "known",
                  source: "provider",
                  supported: true,
                  levels: ["max"],
                  checkedAt: "2026-09-06T00:00:00.000Z",
                  stale: false,
                },
              },
            ],
          },
        ]);
        const model = result[0]!.models[0]!;
        expect(model.reasoningMetadata).toMatchObject({
          status: "unknown",
          supported: null,
          levels: [],
        });
        expect(fetch).not.toHaveBeenCalled();
        expect(piCustomModelReasoning(model, connection.protocol)).toMatchObject({
          reasoning: false,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: null,
            medium: null,
            high: null,
            xhigh: null,
            max: null,
          },
        });
      }),
  );

  it.effect("keeps manual provenance and sends only explicitly configured levels to Pi", () =>
    Effect.gen(function* () {
      const service = makeCustomModelReasoning();
      const result = yield* prepareMany(service, [
        {
          ...connection,
          apiKey: null,
          models: [
            {
              ...connection.models[0]!,
              reasoningOverride: {
                supported: true,
                levels: ["low", "high", "max"],
                defaultLevel: "max",
              },
            },
          ],
        },
      ]);
      const model = result[0]!.models[0]!;
      expect(model.reasoningMetadata).toMatchObject({
        source: "manual",
        status: "known",
        defaultLevel: "max",
      });
      expect(piCustomModelReasoning(model, connection.protocol)).toEqual({
        reasoning: true,
        compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          xhigh: null,
          max: "max",
        },
      });
      expect(connection.models[0]?.reasoningOverride).toBeUndefined();
      expect(connection.models[0]?.reasoningMetadata).toBeUndefined();
    }),
  );

  it("maps verified Off to none and uses adaptive transport only when reported", () => {
    const model = {
      ...connection.models[0]!,
      reasoningMetadata: {
        status: "known" as const,
        source: "provider" as const,
        checkedAt: "2026-09-06T00:00:00.000Z",
        supported: true,
        stale: false,
        levels: ["off" as const, "high" as const],
        mode: "adaptive" as const,
      },
    };
    expect(piCustomModelReasoning(model, "anthropic-messages")).toMatchObject({
      compat: { forceAdaptiveThinking: true },
      thinkingLevelMap: { off: "none", high: "high", max: null },
    });
    expect(
      piCustomModelReasoning(model, "openai-completions", "https://api.x.ai/v1"),
    ).toMatchObject({
      compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
    });
    expect(
      piCustomModelReasoning(model, "openai-completions", "https://openrouter.ai/api/v1"),
    ).toMatchObject({
      compat: { supportsReasoningEffort: true, thinkingFormat: "openrouter" },
    });
  });

  it("rejects manual defaults outside the explicit supported list", () => {
    expect(
      validateCustomModelConnection({
        ...connection,
        models: [
          {
            ...connection.models[0]!,
            reasoningOverride: { supported: true, levels: ["high"], defaultLevel: "medium" },
          },
        ],
      }),
    ).toBe("Choose supported reasoning levels and a default from that list.");
  });
});
