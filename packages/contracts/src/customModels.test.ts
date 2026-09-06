import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  CustomModelSaveInput,
  CustomModelsSettings,
  validateCustomModelConnection,
  customModelImageInput,
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
