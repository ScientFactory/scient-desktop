import { describe, expect, it } from "vite-plus/test";
import * as Redacted from "effect/Redacted";
import {
  ProviderInstanceId,
  type CustomModel,
  type CustomModelConnection,
} from "@t3tools/contracts";

import type { ResolvedModelConnection } from "../../customModels.ts";
import { buildOmpCustomModelPayload } from "./OmpCustomModels.ts";

const instanceId = ProviderInstanceId.make("omp-test");

const model: CustomModel = {
  id: "model",
  modelId: "vendor/model",
  name: "Vendor model",
  configurationMode: "manual",
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  images: false,
  imageInput: "enabled",
  reasoning: true,
  reasoningOverride: {
    supported: true,
    levels: ["low", "high", "max"],
  },
  instanceIds: [instanceId],
};

const connection = (
  overrides: Partial<CustomModelConnection> & {
    readonly apiKey?: Redacted.Redacted<string> | null;
  } = {},
): ResolvedModelConnection => ({
  id: "local",
  name: "Local",
  protocol: "openai-completions",
  baseUrl: "http://127.0.0.1:11434/v1",
  credentialId: "credential",
  apiKey: Redacted.make("secret-value"),
  models: [model],
  ...overrides,
});

describe("OMP custom model projection", () => {
  it("maps capabilities while keeping API keys out of the provider payload", () => {
    const result = buildOmpCustomModelPayload([connection()]);
    expect(result.payload).toHaveLength(1);
    expect(result.payload[0]).toMatchObject({
      id: "scient_local",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
      models: [
        {
          id: "vendor/model",
          name: "Vendor model",
          reasoning: true,
          thinking: { mode: "effort", efforts: ["low", "high", "max"] },
          input: ["text", "image"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    });
    expect(result.payload[0]!.apiKey).toMatch(/^SCIENT_OMP_MODEL_KEY_/u);
    expect(Object.values(result.environment)).toEqual(["secret-value"]);
    expect(JSON.stringify(result.payload)).not.toContain("secret-value");
  });

  it("does not fill missing manual limits from provider evidence", () => {
    const {
      contextWindow: _contextWindow,
      maxOutputTokens: _maxOutputTokens,
      ...withoutLimits
    } = model;
    const result = buildOmpCustomModelPayload([
      connection({
        models: [
          {
            ...withoutLimits,
            reasoningMetadata: {
              status: "known",
              source: "provider",
              checkedAt: "2026-01-01T00:00:00.000Z",
              stale: false,
              supported: false,
              levels: [],
              contextWindow: 128000,
              maxOutputTokens: 4096,
            },
          },
        ],
      }),
    ]);
    expect(result.payload).toEqual([]);
  });

  it("does not publish incomplete or credential-error connections", () => {
    const {
      contextWindow: _contextWindow,
      maxOutputTokens: _maxOutputTokens,
      ...withoutLimits
    } = model;
    const incomplete = connection({ models: [withoutLimits] });
    const unavailable: ResolvedModelConnection = {
      id: "unavailable",
      name: "Unavailable",
      protocol: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
      credentialId: "missing",
      models: [model],
      credentialError: "Re-enter the API key.",
    };
    const result = buildOmpCustomModelPayload([incomplete, unavailable]);
    expect(result.payload).toEqual([]);
    expect(result.environment).toEqual({});
  });

  it("supports keyless connections without putting a secret in the environment", () => {
    const result = buildOmpCustomModelPayload([connection({ credentialId: null, apiKey: null })]);
    expect(result.payload[0]!.apiKey).toBe("scient-keyless");
    expect(result.environment).toEqual({});
  });

  it("passes a supported default reasoning level to OMP", () => {
    const result = buildOmpCustomModelPayload([
      connection({
        models: [{ ...model, defaultReasoningLevel: "high" }],
      }),
    ]);
    expect(result.payload[0]!.models[0]).toMatchObject({
      thinking: { efforts: ["low", "high", "max"], defaultLevel: "high" },
    });
  });

  it("preserves Anthropic budget-mode evidence", () => {
    const { reasoningOverride: _reasoningOverride, ...withoutOverride } = model;
    const result = buildOmpCustomModelPayload([
      connection({
        protocol: "anthropic-messages",
        models: [
          {
            ...withoutOverride,
            reasoning: true,
            reasoningMetadata: {
              status: "known",
              source: "provider",
              checkedAt: "2026-01-01T00:00:00.000Z",
              stale: false,
              supported: true,
              levels: ["low", "high"],
              mode: "budget",
              contextWindow: 128000,
              maxOutputTokens: 8192,
            },
          },
        ],
      }),
    ]);
    expect(result.payload[0]!.models[0]).toMatchObject({
      reasoning: true,
      thinking: { mode: "budget", efforts: ["low", "high"] },
    });
  });

  it("maps the off level to OMP's non-reasoning state", () => {
    const result = buildOmpCustomModelPayload([
      connection({
        models: [
          {
            ...model,
            reasoningOverride: { supported: true, levels: ["off"] },
          },
        ],
      }),
    ]);
    expect(result.payload[0]!.models[0]).toMatchObject({ reasoning: false });
    expect(result.payload[0]!.models[0]).not.toHaveProperty("thinking");
  });

  it("does not advertise reasoning levels when the model is explicitly unsupported", () => {
    const result = buildOmpCustomModelPayload([
      connection({
        models: [
          {
            ...model,
            reasoning: true,
            reasoningOverride: { supported: false, levels: ["low", "high"] },
          },
        ],
      }),
    ]);
    expect(result.payload[0]!.models[0]).toMatchObject({ reasoning: false });
    expect(result.payload[0]!.models[0]).not.toHaveProperty("thinking");
  });

  it("keeps environment names stable when connection order changes", () => {
    const first = buildOmpCustomModelPayload([connection()]);
    const second = buildOmpCustomModelPayload([
      connection({ id: "other", models: [{ ...model, id: "other-model" }] }),
      connection(),
    ]);
    expect(first.payload[0]!.apiKey).toBe(second.payload[1]!.apiKey);
  });
});
