import * as NodeVM from "node:vm";
import { expect, it, vi } from "vite-plus/test";
import {
  PI_CUSTOM_MODELS_EXTENSION,
  piCustomModelReasoning,
  piNativeProviderId,
} from "./PiCustomModels.ts";
import { piDiscoveredModelToServerProviderModel } from "./PiModel.ts";

it("inherits only from an exact native endpoint and API format", () => {
  expect(piNativeProviderId("https://api.openai.com/v1", "openai-responses")).toBe("openai");
  expect(piNativeProviderId("https://api.openai.com/v1", "openai-completions")).toBeUndefined();
  expect(piNativeProviderId("https://proxy.example/v1", "openai-responses")).toBeUndefined();
  expect(piNativeProviderId("http://127.0.0.1:1234/v1", "openai-responses")).toBeUndefined();
});

it("applies explicit reasoning overrides without a derived metadata snapshot", () => {
  const model = {
    id: "fixture",
    modelId: "fixture",
    name: "Fixture",
    images: false,
    reasoning: false,
    instanceIds: [],
    reasoningOverride: { supported: true, levels: ["low", "high"] as const },
  };
  const config = piCustomModelReasoning(model, "openai-completions");
  const result = piDiscoveredModelToServerProviderModel({
    provider: "scient_fixture",
    id: model.modelId,
    name: model.name,
    ...config,
  });
  expect(result?.capabilities?.optionDescriptors?.[0]).toMatchObject({
    options: [{ id: "low" }, { id: "high" }],
  });
  expect(config.compat).toMatchObject({ supportsReasoningEffort: true });
  expect(
    piCustomModelReasoning(
      { ...model, reasoningOverride: { supported: false, levels: [] } },
      "openai-completions",
    ).reasoning,
  ).toBe(false);
  const { reasoningOverride: _override, ...unknown } = model;
  expect(piCustomModelReasoning(unknown, "openai-completions").reasoning).toBe(false);
});

it.each([false, true])(
  "inherits native reasoning independently of automatic capacity (%s)",
  async (automatic) => {
    const source = {
      id: "fixture",
      api: "openai-responses",
      provider: "openai",
      name: "Native",
      contextWindow: 200000,
      maxTokens: 64000,
      reasoning: true,
      input: ["text", "image"],
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        xhigh: null,
        max: "max",
      },
      compat: { nativeFixture: true },
    };
    const manual = {
      id: "fixture",
      name: "Saved",
      automatic,
      imageInput: "automatic",
      input: ["text"],
      contextWindow: 32000,
      maxTokens: 4096,
      reasoning: false,
      thinkingLevelMap: Object.fromEntries(
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [level, null]),
      ),
    };
    const pi = { registerProvider: vi.fn(), registerCommand: vi.fn(), on: vi.fn() };
    const install = NodeVM.runInNewContext(
      `(${PI_CUSTOM_MODELS_EXTENSION.replace(/^import .*;$/gm, "").replace("export default", "")})`,
      {
        process: { env: {} },
        AbortSignal,
        builtinProviders: () => [
          {
            id: "openai",
            getModels: () => [
              source,
              { ...source, id: "fixture-disabled" },
              { ...source, id: "override" },
            ],
          },
        ],
        getApiProvider: () => {
          throw new Error("Discovery must not generate a request");
        },
        fetch: async () => ({
          ok: true,
          json: async () => [
            {
              id: "scient_fixture",
              nativeProviderId: "openai",
              literalKey: "synthetic",
              config: {
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                models: [
                  manual,
                  { ...manual, id: "fixture-disabled", imageInput: "disabled" },
                  { ...manual, id: "unknown", automatic: false },
                  {
                    ...manual,
                    id: "override",
                    reasoningOverride: true,
                    thinkingLevelMap: { ...manual.thinkingLevelMap, low: "low" },
                    reasoning: true,
                  },
                ],
              },
            },
          ],
        }),
      },
    ) as (runtime: typeof pi) => Promise<void>;
    await install(pi);
    const provider = pi.registerProvider.mock.calls[0]![0] as {
      getModels: () => Array<typeof source>;
    };
    const [inherited, disabled, unknown, overridden] = provider.getModels();
    expect(inherited?.input).toEqual(["text", "image"]);
    expect(disabled?.input).toEqual(["text"]);
    expect(inherited).toMatchObject({
      reasoning: true,
      thinkingLevelMap: source.thinkingLevelMap,
      compat: source.compat,
      contextWindow: automatic ? 200000 : 32000,
      maxTokens: automatic ? 64000 : 4096,
    });
    expect(
      piDiscoveredModelToServerProviderModel(inherited!)?.capabilities?.optionDescriptors?.[0],
    ).toMatchObject({
      options: [{ id: "low" }, { id: "high" }, { id: "max" }],
    });
    expect(unknown?.reasoning).toBe(false);
    expect(overridden?.thinkingLevelMap).toEqual({ ...manual.thinkingLevelMap, low: "low" });
  },
);

it("uses the native transport for an exact service model supplied by newer endpoint metadata", async () => {
  const nativeStream = vi.fn((model: { provider: string }) => model.provider);
  const native = {
    id: "openai",
    getModels: () => [{ id: "older-model", api: "openai-responses" }],
    streamSimple: nativeStream,
  };
  const config = {
    name: "Newer model",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    models: [
      {
        id: "newer-model",
        name: "Newer model",
        automatic: true,
        contextWindow: 200000,
        maxTokens: 64000,
      },
    ],
  };
  const pi = { registerProvider: vi.fn(), registerCommand: vi.fn(), on: vi.fn() };
  const install = NodeVM.runInNewContext(
    `(${PI_CUSTOM_MODELS_EXTENSION.replace(/^import .*;$/gm, "").replace("export default", "")})`,
    {
      process: { env: {} },
      AbortSignal,
      builtinProviders: () => [native],
      getApiProvider: () => {
        throw new Error("Must retain the native service transport");
      },
      fetch: async () => ({
        ok: true,
        json: async () => [
          { id: "scient_newer", nativeProviderId: "openai", literalKey: "synthetic", config },
        ],
      }),
    },
  ) as (runtime: typeof pi) => Promise<void>;
  await install(pi);
  const provider = pi.registerProvider.mock.calls[0]![0] as {
    getModels: () => Array<{
      id: string;
      provider: string;
      contextWindow: number;
      maxTokens: number;
    }>;
    streamSimple: (model: object, context: object, options: object) => string;
  };
  const model = provider.getModels()[0]!;
  expect(model).toMatchObject({
    id: "newer-model",
    provider: "scient_newer",
    contextWindow: 200000,
    maxTokens: 64000,
  });
  expect(provider.streamSimple(model, {}, { apiKey: "synthetic" })).toBe("openai");
  expect(nativeStream).toHaveBeenCalledOnce();
});

it("refreshes changed registrations, preserves unchanged ones, and removes revoked connections", async () => {
  let connections = [{ id: "one", config: { apiKey: "synthetic", models: ["first"] } }];
  let refresh: ((args: string, context: { modelRegistry: undefined }) => Promise<void>) | undefined;
  const pi = {
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    on: vi.fn(),
    registerCommand: vi.fn((_name: string, command: { handler: NonNullable<typeof refresh> }) => {
      refresh = command.handler;
    }),
  };
  const install = NodeVM.runInNewContext(
    // Dependencies are supplied by the sandbox; execute the generated registration logic itself.
    `(${PI_CUSTOM_MODELS_EXTENSION.replace(/^import .*;$/gm, "").replace("export default", "")})`,
    {
      process: {
        env: { SCIENT_PI_MODELS_URL: "http://fixture/models", SCIENT_PI_MODELS_TOKEN: "fixture" },
      },
      AbortSignal,
      builtinProviders: () => [],
      getApiProvider: () => {
        throw new Error("Registration must not dispatch a model request");
      },
      fetch: async () => ({ ok: true, json: async () => connections }),
    },
  ) as (runtime: typeof pi) => Promise<void>;
  await install(pi);
  expect(pi.registerProvider).toHaveBeenCalledTimes(1);
  await refresh!("", { modelRegistry: undefined });
  expect(pi.registerProvider).toHaveBeenCalledTimes(1);
  expect(pi.unregisterProvider).not.toHaveBeenCalled();
  connections = [{ id: "one", config: { apiKey: "rotated-synthetic", models: ["second"] } }];
  await refresh!("", { modelRegistry: undefined });
  expect(pi.registerProvider).toHaveBeenCalledTimes(2);
  expect(pi.registerProvider).toHaveBeenLastCalledWith("one", connections[0]!.config);
  connections = [];
  await refresh!("", { modelRegistry: undefined });
  expect(pi.unregisterProvider.mock.calls).toEqual([["one"], ["one"]]);
});
