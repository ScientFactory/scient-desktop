import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ModelReasoningMetadata } from "@t3tools/contracts";
import { makeModelReasoningResolver, type ModelReasoningResolveInput } from "./modelReasoning.ts";

const START = Date.parse("2026-09-06T12:00:00.000Z");
const decodeMetadata = Schema.decodeUnknownSync(ModelReasoningMetadata);
const router: ModelReasoningResolveInput = {
  baseUrl: "https://openrouter.ai/api/v1",
  protocol: "openai-completions",
  modelId: "vendor/model",
};
const anthropic: ModelReasoningResolveInput = {
  baseUrl: "https://api.anthropic.com/v1",
  protocol: "anthropic-messages",
  modelId: "claude-test",
  apiKey: "synthetic-test-key",
};
const response = (body: unknown) => new Response(JSON.stringify(body));
const routerBody = (reasoning: unknown) => ({ data: [{ id: router.modelId, reasoning }] });
const support = (supported: boolean) => ({ supported });
const anthropicBody = (thinking: unknown, effort?: unknown) => ({
  id: "resolved-model-id",
  capabilities: { thinking, ...(effort === undefined ? {} : { effort }) },
});
const adaptive = { supported: true, types: { adaptive: support(true), enabled: support(false) } };
function fixture(body: unknown) {
  let time = START;
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response(body));
  const resolver = makeModelReasoningResolver({ fetch, now: () => time });
  return {
    fetch,
    resolver,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("verified model capabilities", () => {
  it("keeps capabilities optional and rejects nonpositive or noninteger contract limits", () => {
    const metadata = {
      status: "unknown",
      source: "provider",
      checkedAt: "test",
      stale: false,
      supported: null,
      levels: [],
    };
    expect(
      decodeMetadata({
        ...metadata,
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        images: false,
      }),
    ).toMatchObject({ contextWindow: 200_000, maxOutputTokens: 8_192, images: false });
    for (const field of ["contextWindow", "maxOutputTokens"]) {
      for (const value of [0, -1, 1.5, "8192", Infinity]) {
        expect(() => decodeMetadata({ ...metadata, [field]: value })).toThrow();
      }
    }
  });

  it.each([true, false])(
    "reads Anthropic limits and image_input=%s independently of reasoning",
    async (images) => {
      const { fetch, resolver } = fixture({
        id: "resolved-model-id",
        max_input_tokens: 200_000,
        max_tokens: 64_000,
        capabilities: { image_input: support(images) },
      });
      const result = await resolver.resolve(anthropic);
      expect(result).toMatchObject({
        status: "unknown",
        supported: null,
        source: "provider",
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        images,
      });
      expect(decodeMetadata(result)).toEqual(result);
      expect(resolver.peek(anthropic)).toEqual(result);
      expect(await resolver.resolve(anthropic)).toEqual(result);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, null, 0, -1, 1.5, "128000"])(
    "omits invalid Anthropic limits %j without losing reasoning",
    async (limit) => {
      const { resolver } = fixture({
        ...anthropicBody(adaptive, { supported: true, high: support(true) }),
        max_input_tokens: limit,
        max_tokens: limit,
      });
      const result = await resolver.resolve(anthropic);
      expect(result).toMatchObject({ status: "known", levels: ["high"] });
      expect(result).not.toHaveProperty("contextWindow");
      expect(result).not.toHaveProperty("maxOutputTokens");
      expect(result).not.toHaveProperty("images");
    },
  );

  it("reuses the exact OpenRouter catalog for capabilities across model switches", async () => {
    const { fetch, resolver, advance } = fixture({
      data: [
        {
          id: "vendor/a",
          context_length: 200_000,
          top_provider: { max_completion_tokens: 32_000 },
          architecture: { input_modalities: ["text", "image"] },
        },
        {
          id: "vendor/b",
          context_length: 100_000,
          top_provider: { max_completion_tokens: 8_192 },
          architecture: { input_modalities: ["text"] },
        },
        { id: "vendor/malformed", reasoning: "invalid", context_length: 100_000 },
      ],
    });
    const first = await resolver.resolve({ ...router, modelId: "vendor/a" });
    expect(first).toMatchObject({
      source: "provider",
      status: "unknown",
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      images: true,
    });
    advance(3_000_000);
    const second = resolver.peek({ ...router, modelId: "vendor/b" });
    expect(second).toMatchObject({
      checkedAt: first.checkedAt,
      contextWindow: 100_000,
      maxOutputTokens: 8_192,
      images: false,
    });
    expect(await resolver.resolve({ ...router, modelId: "vendor/b" })).toEqual(second);
    expect(await resolver.resolve({ ...router, modelId: "vendor/malformed" })).toMatchObject({
      status: "unknown",
    });
    expect(await resolver.resolve({ ...router, modelId: "vendor/a" })).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(600_001);
    expect(resolver.peek({ ...router, modelId: "vendor/b" }).stale).toBe(true);
    await resolver.resolve({ ...router, modelId: "vendor/b" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not fabricate missing OpenRouter output limits or image support", async () => {
    const { resolver } = fixture({
      data: [
        {
          id: router.modelId,
          context_length: 100_000,
          top_provider: { max_completion_tokens: null },
          architecture: { output_modalities: ["image"] },
          reasoning: { supported_efforts: ["high"] },
        },
      ],
    });
    const result = await resolver.resolve(router);
    expect(result).toMatchObject({ contextWindow: 100_000, levels: ["high"] });
    expect(result).not.toHaveProperty("maxOutputTokens");
    expect(result).not.toHaveProperty("images");
  });

  it("does not borrow capabilities from another model, canonical slug or duplicate identity", async () => {
    const entry = {
      id: "vendor/concrete",
      canonical_slug: router.modelId,
      context_length: 100_000,
      top_provider: { max_completion_tokens: 8_192 },
      architecture: { input_modalities: ["image"] },
    };
    const { resolver } = fixture({
      data: [entry, { ...entry, id: "duplicate" }, { ...entry, id: "duplicate" }],
    });
    for (const modelId of [router.modelId, "duplicate", "vendor/concrete:free"]) {
      const result = await resolver.resolve({ ...router, modelId });
      expect(result).not.toHaveProperty("contextWindow");
      expect(result).not.toHaveProperty("maxOutputTokens");
      expect(result).not.toHaveProperty("images");
    }
  });

  it("retains capability-only evidence on transport failures and isolates key rotation", async () => {
    const { fetch, resolver, advance } = fixture({
      id: "resolved-model-id",
      max_input_tokens: 200_000,
      max_tokens: 64_000,
    });
    const first = await resolver.resolve(anthropic);
    advance(3_600_001);
    fetch.mockRejectedValue(new Error("synthetic-secret"));
    expect(await resolver.resolve(anthropic)).toMatchObject({
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      checkedAt: first.checkedAt,
      stale: true,
    });
    const rotated = await resolver.resolve({ ...anthropic, apiKey: "synthetic-rotated" });
    expect(rotated).not.toHaveProperty("contextWindow");
    expect(rotated).not.toHaveProperty("maxOutputTokens");
    expect(JSON.stringify(rotated)).not.toContain("synthetic-secret");
  });

  it.each([
    ["gpt-6-astra", 1_050_000, 128_000],
    ["gpt-5.6-luna", 1_050_000, 128_000],
    ["gpt-4.1", 1_047_576, 32_768],
    ["gpt-5.1", 400_000, 128_000],
    ["gpt-5.2", 400_000, 128_000],
    ["gpt-5.4", 1_050_000, 128_000],
    ["gpt-5.5", 1_050_000, 128_000],
  ])(
    "uses reviewed exact OpenAI capacities for %s with no IO",
    async (modelId, contextWindow, maxOutputTokens) => {
      const { fetch, resolver } = fixture({});
      const input = { ...router, baseUrl: "https://api.openai.com/v1", modelId: String(modelId) };
      const result = await resolver.resolve(input);
      expect(result).toMatchObject({
        contextWindow,
        maxOutputTokens,
        images: true,
        source: "catalog",
      });
      expect(resolver.peek(input)).toEqual(result);
      for (const mismatch of [
        { ...input, modelId: `${modelId}-unreviewed` },
        { ...input, baseUrl: "https://api.x.ai/v1" },
        { ...input, baseUrl: "https://proxy.example/v1" },
        { ...input, protocol: "anthropic-messages" as const },
      ]) {
        expect(await resolver.resolve(mismatch)).not.toHaveProperty("contextWindow");
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["grok-4.5", "grok-4.6"])(
    "keeps the unreported xAI output limit absent for %s",
    async (modelId) => {
      const { fetch, resolver } = fixture({});
      const result = await resolver.resolve({ ...router, baseUrl: "https://api.x.ai/v1", modelId });
      expect(result).toMatchObject({ source: "catalog", contextWindow: 500_000, images: true });
      expect(result).not.toHaveProperty("maxOutputTokens");
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe("reasoning evidence", () => {
  it("recognizes Scient's exact Anthropic root preset and uses the v1 metadata API", async () => {
    const { fetch, resolver } = fixture(
      anthropicBody(adaptive, { supported: true, high: support(true) }),
    );
    const result = await resolver.resolve({ ...anthropic, baseUrl: "https://api.anthropic.com" });
    expect(result).toMatchObject({ status: "known", levels: ["high"] });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/models/claude-test");
  });
  it.each([true, false])(
    "never turns nonadaptive Anthropic effort flags into a menu (effort=%s)",
    async (supported) => {
      const { resolver } = fixture(
        anthropicBody(
          { supported: true, types: { enabled: support(true), adaptive: support(false) } },
          { supported, low: support(true), high: support(true) },
        ),
      );
      const result = await resolver.resolve(anthropic);
      expect(result).toMatchObject({
        status: "unknown",
        supported: true,
        mode: "budget",
        levels: [],
      });
      expect(result.detail).toContain("budget-specific");
      expect(result).not.toHaveProperty("defaultLevel");
    },
  );

  it("discloses OpenRouter budget-only controls without claiming an effort selector", async () => {
    const { resolver } = fixture(routerBody({ supports_max_tokens: true }));
    const result = await resolver.resolve(router);
    expect(result).toMatchObject({
      status: "unknown",
      supported: true,
      mode: "budget",
      levels: [],
    });
    expect(result.detail).toContain("budget-specific");
  });

  it.each([
    [{ default_effort: "high" }, undefined],
    [{ default_effort: "none" }, undefined],
    [{ default_effort: "high", default_enabled: true }, "high"],
    [{ default_effort: "high", mandatory: true }, "high"],
    [{ default_effort: "high", default_enabled: false }, "off"],
    [{ default_effort: "high", default_enabled: false, mandatory: true }, undefined],
  ])("distinguishes enabling presets from effective defaults %j", async (defaults, expected) => {
    const { resolver } = fixture(routerBody({ supported_efforts: ["none", "high"], ...defaults }));
    const result = await resolver.resolve(router);
    if (expected === undefined) expect(result).not.toHaveProperty("defaultLevel");
    else expect(result.defaultLevel).toBe(expected);
  });
  it("exports the shared schema with optional fields", () => {
    const metadata = {
      status: "unknown",
      source: "unknown",
      checkedAt: "test",
      stale: false,
      supported: null,
      levels: [],
    };
    expect(decodeMetadata(metadata)).toEqual(metadata);
    expect(() => decodeMetadata({ ...metadata, levels: ["none"] })).toThrow();
  });

  it.each([
    "https://example.com/v1",
    "http://openrouter.ai/api/v1",
    "https://openrouter.ai/api/v2",
    "https://openrouter.ai/api/v1/models",
    "https://openrouter.ai/api/v1?key=secret",
    "https://openrouter.ai/api/v1#fragment",
    "https://user:pass@openrouter.ai/api/v1",
    "https://openrouter.ai.evil.test/api/v1",
    "https://api.anthropic.com/v1/proxy",
    "https://api.anthropic.com:444/v1",
    "https://api.anthropic.com/a/../v1",
    "https://api.anthropic.com/v1//",
    "https://api.openai.com/v1/proxy",
    "https://api.x.ai/v2",
  ])("never requests an unrecognized endpoint %s", async (baseUrl) => {
    const { fetch, resolver } = fixture({});
    expect(await resolver.resolve({ ...anthropic, baseUrl })).toMatchObject({
      status: "unknown",
      supported: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not send credentials on a protocol mismatch or without an Anthropic key", async () => {
    const { fetch, resolver } = fixture({});
    await resolver.resolve({ ...anthropic, protocol: "openai-completions" });
    await resolver.resolve({ ...router, protocol: "anthropic-messages" });
    const { apiKey: _, ...withoutKey } = anthropic;
    expect(await resolver.resolve(withoutKey)).toMatchObject({ status: "unknown" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}, { supported_efforts: [] }])(
    "does not infer unsupported from missing controls %j",
    async (reasoning) => {
      const { resolver } = fixture(routerBody(reasoning));
      const result = await resolver.resolve(router);
      expect(result.status).toBe("unknown");
      expect(result.supported).not.toBe(false);
      expect(result.levels).toEqual([]);
      expect(result).not.toHaveProperty("defaultLevel");
    },
  );

  it("preserves reasoning support without an effort ladder", async () => {
    const { resolver } = fixture({
      data: [{ id: router.modelId, supported_parameters: ["reasoning"] }],
    });
    expect(await resolver.resolve(router)).toMatchObject({
      status: "unknown",
      supported: true,
      levels: [],
    });
  });

  it("exposes null as gateway values, explicitly qualifying aliases", async () => {
    const { fetch, resolver } = fixture(routerBody({ supported_efforts: null }));
    const result = await resolver.resolve({ ...router, apiKey: "synthetic-secret" });
    expect(result).toMatchObject({
      status: "known",
      supported: true,
      levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    });
    expect(result.detail).toContain("same native level");
    expect(result).not.toHaveProperty("mandatory");
    expect(result).not.toHaveProperty("defaultLevel");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ headers: {}, redirect: "error" });
  });

  it("honors mandatory reasoning, deduplicates and orders verified levels", async () => {
    const { resolver } = fixture(
      routerBody({
        supported_efforts: ["high", "none", "low", "high"],
        mandatory: true,
        default_effort: "none",
      }),
    );
    expect(await resolver.resolve(router)).toMatchObject({
      levels: ["low", "high"],
      mandatory: true,
    });
    expect(await resolver.resolve(router)).not.toHaveProperty("defaultLevel");
  });

  it("does not expose off from null when mandatory", async () => {
    const { resolver } = fixture(routerBody({ supported_efforts: null, mandatory: true }));
    expect((await resolver.resolve(router)).levels).not.toContain("off");
  });

  it.each([
    { supported_efforts: "high" },
    { supported_efforts: ["off"] },
    { supported_efforts: ["high", "ultra"] },
    { supported_efforts: [null] },
    { mandatory: "false" },
    { default_effort: 1 },
    "reasoning",
    [],
  ])("fails closed on malformed reasoning %j", async (reasoning) => {
    const { resolver } = fixture(routerBody(reasoning));
    expect(await resolver.resolve(router)).toMatchObject({
      status: "unknown",
      supported: null,
      levels: [],
    });
  });

  it("uses a verified default only when consistent with the controls", async () => {
    const { resolver } = fixture(
      routerBody({
        supported_efforts: ["none", "high"],
        default_effort: "high",
        default_enabled: false,
      }),
    );
    expect(await resolver.resolve(router)).toMatchObject({ defaultLevel: "off" });
    const other = fixture(routerBody({ supported_efforts: ["low"], default_effort: "high" }));
    expect(await other.resolver.resolve(router)).not.toHaveProperty("defaultLevel");
  });

  it("does not borrow metadata via canonical slugs or dynamic aliases", async () => {
    const { resolver } = fixture({
      data: [
        {
          id: "vendor/concrete",
          canonical_slug: router.modelId,
          reasoning: { supported_efforts: ["high"] },
        },
        { id: "openrouter/auto" },
      ],
    });
    expect(await resolver.resolve(router)).toMatchObject({ status: "unknown" });
    expect(await resolver.resolve({ ...router, modelId: "openrouter/auto" })).toMatchObject({
      status: "unknown",
      supported: null,
    });
  });

  it("reads Anthropic thinking and explicit effort flags without defaults or off", async () => {
    const { fetch, resolver } = fixture(
      anthropicBody(adaptive, {
        supported: true,
        low: support(true),
        medium: support(false),
        high: support(true),
        max: support(true),
      }),
    );
    const result = await resolver.resolve(anthropic);
    expect(result).toMatchObject({
      status: "known",
      source: "provider",
      mode: "adaptive",
      supported: true,
      levels: ["low", "high", "max"],
    });
    expect(result).not.toHaveProperty("mandatory");
    expect(result).not.toHaveProperty("defaultLevel");
    expect(fetch.mock.calls[0]).toEqual([
      "https://api.anthropic.com/v1/models/claude-test",
      expect.objectContaining({
        redirect: "error",
        headers: { "x-api-key": "synthetic-test-key", "anthropic-version": "2023-06-01" },
      }),
    ]);
  });

  it("marks budget-only thinking as unknown controls and respects effort supported=false", async () => {
    const { resolver } = fixture(
      anthropicBody(
        { supported: true, types: { enabled: support(true) } },
        { supported: false, high: support(true) },
      ),
    );
    expect(await resolver.resolve(anthropic)).toMatchObject({
      status: "unknown",
      supported: true,
      mode: "budget",
      levels: [],
    });
  });

  it("accepts explicit unsupported thinking", async () => {
    const { resolver } = fixture(anthropicBody({ supported: false }));
    const result = await resolver.resolve(anthropic);
    expect(result).toMatchObject({ status: "known", supported: false, levels: [] });
    expect(result).not.toHaveProperty("defaultLevel");
  });

  it.each([
    {},
    { capabilities: null },
    anthropicBody(null),
    anthropicBody({ supported: "false" }),
    anthropicBody(adaptive, { supported: true, low: { supported: "yes" } }),
  ])("keeps missing or malformed Anthropic evidence unknown %j", async (body) => {
    const { resolver } = fixture(body);
    expect(await resolver.resolve(anthropic)).toMatchObject({ status: "unknown", supported: null });
  });

  it("uses reviewed exact IDs only, with catalog timestamps and expiration", async () => {
    const { fetch, resolver, advance } = fixture({});
    const input = { ...router, baseUrl: "https://api.openai.com/v1", modelId: "gpt-5.5" };
    expect(await resolver.resolve(input)).toMatchObject({
      source: "catalog",
      defaultLevel: "medium",
      stale: false,
      levels: ["off", "low", "medium", "high", "xhigh"],
    });
    expect(await resolver.resolve({ ...input, modelId: "gpt-5.5-custom" })).toMatchObject({
      status: "unknown",
    });
    expect(await resolver.resolve({ ...input, modelId: "gpt-4.1" })).toMatchObject({
      supported: false,
      levels: [],
    });
    expect(
      await resolver.resolve({ ...input, baseUrl: "https://api.x.ai/v1", modelId: "grok-4.5" }),
    ).toMatchObject({ mandatory: true, defaultLevel: "high", levels: ["low", "medium", "high"] });
    advance(31 * 24 * 60 * 60 * 1000);
    expect(await resolver.resolve(input)).toMatchObject({
      stale: true,
      checkedAt: "2026-09-06T00:00:00.000Z",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("bounded metadata IO and cache", () => {
  it("explicit recheck bypasses negative caches and coalesces concurrent requests", async () => {
    const { fetch, resolver } = fixture({});
    fetch.mockRejectedValueOnce(new Error("offline"));
    expect((await resolver.resolve(router)).status).toBe("unknown");
    fetch.mockImplementation(async () =>
      Response.json(routerBody({ supported_efforts: ["high"] })),
    );
    await resolver.resolve(router);
    expect(fetch).toHaveBeenCalledTimes(1);
    const results = await Promise.all([
      resolver.resolve(router, true),
      resolver.resolve(router, true),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(results[0]!.levels).toEqual(["high"]);
    await resolver.resolve({ ...router, apiKey: "another-synthetic-key" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("peek is synchronous, network-free, credential-isolated and marks expired evidence stale", async () => {
    const { fetch, resolver, advance } = fixture(
      anthropicBody(adaptive, { supported: true, high: support(true) }),
    );
    expect(resolver.peek(anthropic)).toMatchObject({ status: "unknown", supported: null });
    expect(
      resolver.peek({ ...router, baseUrl: "https://api.openai.com/v1", modelId: "gpt-6-astra" }),
    ).toMatchObject({ status: "known", source: "catalog" });
    expect(fetch).not.toHaveBeenCalled();
    const verified = await resolver.resolve(anthropic);
    expect(resolver.peek(anthropic)).toEqual(verified);
    advance(3_600_001);
    expect(resolver.peek(anthropic)).toMatchObject({
      stale: true,
      levels: ["high"],
      checkedAt: verified.checkedAt,
    });
    expect(resolver.peek({ ...anthropic, apiKey: "synthetic-rotated" })).toMatchObject({
      status: "unknown",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("peek uses an already cached OpenRouter catalog on model switch", async () => {
    const { fetch, resolver } = fixture({
      data: [
        { id: "a", reasoning: { supported_efforts: ["low"] } },
        { id: "b", reasoning: { supported_efforts: ["high"] } },
      ],
    });
    await resolver.resolve({ ...router, modelId: "a" });
    expect(resolver.peek({ ...router, modelId: "b" })).toMatchObject({
      levels: ["high"],
      stale: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("includes the user's exact Astra and Luna models with only verified defaults", async () => {
    const { fetch, resolver } = fixture({});
    const input = { ...router, baseUrl: "https://api.openai.com/v1" };
    const astra = await resolver.resolve({ ...input, modelId: "gpt-6-astra" });
    expect(astra).toMatchObject({
      status: "known",
      source: "catalog",
      mandatory: true,
      levels: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(astra).not.toHaveProperty("defaultLevel");
    expect(await resolver.resolve({ ...input, modelId: "gpt-5.6-luna" })).toMatchObject({
      defaultLevel: "medium",
      mandatory: false,
      levels: ["off", "low", "medium", "high", "xhigh", "max"],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps catalog evidence time when switching models and expires at the original TTL", async () => {
    const { fetch, resolver, advance } = fixture({
      data: [
        { id: "a", reasoning: { supported_efforts: ["low"] } },
        { id: "b", reasoning: { supported_efforts: ["high"] } },
      ],
    });
    const first = await resolver.resolve({ ...router, modelId: "a" });
    advance(3_000_000);
    expect(await resolver.resolve({ ...router, modelId: "b" })).toMatchObject({
      checkedAt: first.checkedAt,
    });
    advance(600_001);
    await resolver.resolve({ ...router, modelId: "b" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("coalesces OpenRouter catalogs across model IDs and caches the payload", async () => {
    const { fetch, resolver } = fixture({
      data: [
        { id: "a", reasoning: { supported_efforts: ["low"] } },
        { id: "b", reasoning: { supported_efforts: ["high"] } },
      ],
    });
    const results = await Promise.all(
      ["a", "b", "a"].map((modelId) => resolver.resolve({ ...router, modelId })),
    );
    expect(results.map((r) => r.levels)).toEqual([["low"], ["high"], ["low"]]);
    await resolver.resolve({ ...router, modelId: "c" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("coalesces keyed requests and isolates model switches, credentials, key rotation and protocols", async () => {
    const { fetch, resolver } = fixture(
      anthropicBody(adaptive, { supported: true, high: support(true) }),
    );
    await Promise.all([resolver.resolve(anthropic), resolver.resolve(anthropic)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await resolver.resolve({ ...anthropic, modelId: "other" });
    await resolver.resolve({ ...anthropic, credentialId: "new-identity" });
    await resolver.resolve({ ...anthropic, apiKey: "synthetic-rotated" });
    expect(fetch).toHaveBeenCalledTimes(4);
    await resolver.resolve(anthropic);
    expect(fetch).toHaveBeenCalledTimes(4);
    const or = fixture(routerBody({ supported_efforts: ["low"] }));
    await or.resolver.resolve(router);
    await or.resolver.resolve({ ...router, protocol: "openai-responses" });
    await or.resolver.resolve({ ...router, credentialId: "other" });
    expect(or.fetch).toHaveBeenCalledTimes(1);
  });

  it("negative-caches catalog failures across model IDs and retries after TTL", async () => {
    const { fetch, resolver, advance } = fixture({});
    fetch.mockRejectedValue(new Error("synthetic-secret"));
    const result = await resolver.resolve(router);
    await resolver.resolve({ ...router, modelId: "other" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    advance(60_001);
    await resolver.resolve(router);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retains last-good evidence and checkedAt through repeated failures and recovers", async () => {
    const { fetch, resolver, advance } = fixture(routerBody({ supported_efforts: ["high"] }));
    const original = await resolver.resolve(router);
    advance(3_600_001);
    fetch.mockRejectedValue(new Error("Authorization: synthetic-secret"));
    const stale = await resolver.resolve(router);
    expect(stale).toMatchObject({
      status: "known",
      stale: true,
      levels: ["high"],
      checkedAt: original.checkedAt,
    });
    advance(60_001);
    expect(await resolver.resolve(router)).toMatchObject({
      stale: true,
      checkedAt: original.checkedAt,
    });
    advance(60_001);
    fetch.mockImplementation(async () => response(routerBody({ supported_efforts: ["low"] })));
    expect(await resolver.resolve(router)).toMatchObject({ stale: false, levels: ["low"] });
  });

  it("retains good controls when a refresh loses capability fields", async () => {
    const { fetch, resolver, advance } = fixture(
      anthropicBody(adaptive, { supported: true, high: support(true) }),
    );
    await resolver.resolve(anthropic);
    advance(3_600_001);
    fetch.mockImplementation(async () => response(anthropicBody(null)));
    expect(await resolver.resolve(anthropic)).toMatchObject({ stale: true, levels: ["high"] });
  });

  it("does not allow caller mutation to poison shared cache", async () => {
    const { resolver } = fixture(routerBody({ supported_efforts: ["high"] }));
    const first = await resolver.resolve(router);
    (first.levels as string[]).push("off");
    expect((await resolver.resolve(router)).levels).toEqual(["high"]);
  });

  it("bounds a fetch that ignores abort without rejecting resolve", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => {}));
    const resolver = makeModelReasoningResolver({ fetch, now: () => START });
    const result = resolver.resolve(anthropic);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await result).toMatchObject({ status: "unknown", supported: null });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("bounds stalled response bodies too", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(new ReadableStream({ start() {} })));
    const result = makeModelReasoningResolver({ fetch, now: () => START }).resolve(anthropic);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await result).toMatchObject({ status: "unknown" });
  });

  it.each(["http", "redirect", "json", "length", "stream"])(
    "sanitizes %s failures and enforces response limits",
    async (kind) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
        if (kind === "http") return new Response("synthetic-secret", { status: 401 });
        if (kind === "redirect")
          return new Response(null, { status: 302, headers: { location: "https://evil.test" } });
        if (kind === "json") return new Response("synthetic-secret not JSON");
        if (kind === "length")
          return new Response("{}", { headers: { "content-length": String(9 * 1024 * 1024) } });
        return new Response(new Uint8Array(8 * 1024 * 1024 + 1));
      });
      const result = await makeModelReasoningResolver({ fetch, now: () => START }).resolve(
        anthropic,
      );
      expect(result).toMatchObject({ status: "unknown", supported: null });
      expect(JSON.stringify(result)).not.toContain("synthetic-secret");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds concurrent requests", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => {}));
    const resolver = makeModelReasoningResolver({ fetch, now: () => START });
    const requests = Array.from({ length: 20 }, (_, i) =>
      resolver.resolve({ ...anthropic, modelId: `model-${i}` }),
    );
    expect(fetch).toHaveBeenCalledTimes(16);
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await Promise.all(requests)).every((result) => result.status === "unknown")).toBe(true);
  });

  it("evicts bounded model cache entries", async () => {
    const { fetch, resolver } = fixture(anthropicBody({ supported: false }));
    for (let i = 0; i < 129; i++) await resolver.resolve({ ...anthropic, modelId: `model-${i}` });
    await resolver.resolve({ ...anthropic, modelId: "model-0" });
    expect(fetch).toHaveBeenCalledTimes(130);
  });
});
