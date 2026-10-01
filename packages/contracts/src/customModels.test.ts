import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  CustomModelSaveInput,
  CustomModelsSettings,
  validateCustomModelConnection,
  customModelImageInput,
  droidAdaptiveClaudeLevels,
  supportsModelConnections,
} from "./customModels.ts";
import { ServerSettingsPatch } from "./settings.ts";

const connection = {
  id: "one",
  name: "Local",
  protocol: "openai-completions" as const,
  baseUrl: "http://127.0.0.1:8080/v1",
  models: [],
};
const decode = Schema.decodeUnknownSync(Schema.toCodecJson(CustomModelSaveInput));
const encode = Schema.encodeSync(Schema.toCodecJson(CustomModelSaveInput));
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeSettings = Schema.decodeUnknownSync(CustomModelsSettings);
describe("custom model contracts", () => {
  it("knows the Claude model ids Droid sends adaptive thinking for", () => {
    // Each id was sent through Droid 0.213.0 and 0.230.0 with a wire-capture stub.
    for (const modelId of [
      "claude-opus-4-7",
      "claude-opus-4-7-fast",
      "claude-opus-4-7@20260101",
      "claude-opus-4-8",
      "bedrock/anthropic.claude-opus-4-7",
      "CLAUDE-OPUS-4-7",
      "opus 4.7",
      "claude-opus-5",
      "claude-opus-5-fast",
      "claude-opus-5-20270101",
      "claude-sonnet-5",
      "claude-fable-5",
    ])
      expect(droidAdaptiveClaudeLevels(modelId), modelId).toEqual(["xhigh", "max"]);
    for (const modelId of [
      "claude-opus-4-6",
      "claude-opus-4-6-fast",
      "claude-sonnet-4-6",
      "claude-sonnet-4-6-20260101",
      "us.anthropic.claude-sonnet-4-6-v1:0",
      "anthropic/claude-opus-4.6",
      "sonnet4.6",
    ])
      expect(droidAdaptiveClaudeLevels(modelId), modelId).toEqual(["max"]);
    // Budget thinking, always-on thinking, or no entry in Droid's table.
    for (const modelId of [
      "plain-anthropic",
      "claude-sonnet-4-5",
      "claude-opus-4-5",
      "claude-opus-4-1",
      "claude-opus-4",
      "claude-sonnet-4",
      "claude-haiku-4-5",
      "claude-haiku-4-6",
      "claude-3-7-sonnet-20250219",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-fable-5.1",
      "claude-opus-9",
      "kimi-k2",
      "glm-4.6",
    ])
      expect(droidAdaptiveClaudeLevels(modelId), modelId).toBeUndefined();
  });
  it("preserves legacy image choices and round-trips the independent override", () => {
    const legacy = {
      id: "m",
      modelId: "m",
      name: "M",
      images: false,
      reasoning: false,
      instanceIds: [],
    };
    expect(customModelImageInput(legacy)).toBe("disabled");
    expect(customModelImageInput({ ...legacy, images: true })).toBe("enabled");
    expect(customModelImageInput({ ...legacy, configurationMode: "automatic" })).toBe("automatic");
    for (const imageInput of ["automatic", "enabled", "disabled"] as const) {
      const saved = decode(
        encode(
          decode({
            revision: 0,
            connection: { ...connection, models: [{ ...legacy, imageInput }] },
          }),
        ),
      ).connection.models[0]!;
      expect(customModelImageInput(saved)).toBe(imageInput);
      expect(customModelImageInput({ ...saved, configurationMode: "automatic" })).toBe(imageInput);
    }
  });
  it("round-trips a default preference independently of automatic capabilities", () => {
    const input = {
      revision: 0,
      connection: {
        ...connection,
        models: [
          {
            id: "luna",
            modelId: "gpt-5.6-luna",
            name: "Luna",
            configurationMode: "automatic",
            images: false,
            reasoning: false,
            instanceIds: [],
            defaultReasoningLevel: "high",
          },
        ],
      },
    };
    const restored = decode(encode(decode(input))).connection.models[0]!;
    expect(restored.defaultReasoningLevel).toBe("high");
    expect(restored.configurationMode).toBe("automatic");
    expect(restored.reasoningOverride).toBeUndefined();
    expect(restored.reasoningMetadata).toBeUndefined();
    expect(() =>
      decode({
        ...input,
        connection: {
          ...input.connection,
          models: [{ ...input.connection.models[0], defaultReasoningLevel: "invented" }],
        },
      }),
    ).toThrow();
  });
  it("allows automatic models without invented limits but requires explicit manual limits", () => {
    const model = {
      id: "m",
      modelId: "m",
      name: "M",
      images: false,
      reasoning: false,
      instanceIds: [],
    };
    const automatic = {
      ...connection,
      models: [{ ...model, configurationMode: "automatic" as const }],
    };
    expect(decode({ revision: 0, connection: automatic }).connection.models[0]).not.toHaveProperty(
      "contextWindow",
    );
    expect(validateCustomModelConnection(automatic)).toBeUndefined();
    expect(validateCustomModelConnection({ ...connection, models: [model] })).toBe(
      "Enter valid context and output limits.",
    );
    expect(
      validateCustomModelConnection({
        ...connection,
        models: [{ ...model, contextWindow: 32000, maxOutputTokens: 4096 }],
      }),
    ).toBeUndefined();
  });
  it("allows OMP to consume the shared model connection contracts", () => {
    for (const protocol of [
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
    ] as const) {
      expect(supportsModelConnections("omp", protocol)).toBe(true);
    }
    expect(supportsModelConnections("omp", "unsupported" as never)).toBe(false);
  });

  it("defaults old settings to an empty catalog", () => {
    expect(decodeSettings({})).toEqual({ revision: 0, connections: [] });
  });
  it("accepts legacy connections and bounds the display hint to four characters", () => {
    const legacy = { ...connection, credentialId: "opaque-reference" };
    expect(decodeSettings({ connections: [legacy] }).connections[0]).not.toHaveProperty(
      "apiKeySuffix",
    );
    expect(
      decodeSettings({ connections: [{ ...legacy, apiKeySuffix: "a7X9" }] }).connections[0]
        ?.apiKeySuffix,
    ).toBe("a7X9");
    expect(() =>
      decodeSettings({ connections: [{ ...legacy, apiKeySuffix: "too-long" }] }),
    ).toThrow();
  });
  it("decodes API keys as redacted values and omits caller-supplied credential references", () => {
    const value = decode({
      revision: 0,
      connection: { ...connection, credentialId: "not-owned", apiKeySuffix: "fake" },
      apiKey: "synthetic-key",
    });
    expect(String(value.apiKey)).not.toContain("synthetic-key");
    expect(value.connection).not.toHaveProperty("credentialId");
    expect(value.connection).not.toHaveProperty("apiKeySuffix");
    expect(encode(value)).toMatchObject({ apiKey: "synthetic-key" });
  });
  it("does not permit metadata or secrets through ordinary settings patches", () => {
    expect(
      decodePatch({ customModels: { revision: 42, connections: [connection] } }),
    ).not.toHaveProperty("customModels");
  });
  it.each([
    "file:///tmp/model",
    "ftp://host",
    "https://user:pass@host",
    "https://host/?key=abc",
    "https://host/#key",
    "not a url",
  ])("rejects unsafe endpoint syntax: %s", (baseUrl) => {
    expect(validateCustomModelConnection({ ...connection, baseUrl })).toBeDefined();
  });
  it.each(["http://localhost:8080/v1", "http://[::1]:8080/v1", "https://api.example.com/v1"])(
    "accepts custom endpoint %s",
    (baseUrl) => {
      expect(validateCustomModelConnection({ ...connection, baseUrl })).toBeUndefined();
    },
  );
});
