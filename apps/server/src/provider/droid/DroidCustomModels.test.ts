import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { type CustomModel, DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { DroidSettings } from "@t3tools/contracts";
import { checkDroidProviderStatusWithCapabilities } from "../Layers/DroidProvider.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import type { DroidAcpRuntimeFactory, DroidAcpRuntimeInput } from "../acp/DroidAcpSupport.ts";

import type { ResolvedModelConnection } from "../../customModels.ts";
import { makeModelReasoningResolver } from "../../modelReasoning.ts";
import { AcpRequestError } from "effect-acp/errors";
import type { SessionConfigOption } from "effect-acp/schema";
import {
  buildDroidCustomModelsSettings,
  droidCustomModelsSnapshot,
  droidCustomModelId,
  makeDroidCustomModelsRuntimeFactory,
  resolveDroidCustomReasoningOptions,
} from "./DroidCustomModels.ts";
import type { DroidOrgHookPolicy } from "./DroidOrgPolicy.ts";

const instanceId = ProviderInstanceId.make("droid_work");
const decodeDroidSettings = Schema.decodeSync(DroidSettings);
type AvailableConnection = ResolvedModelConnection & {
  readonly apiKey: Redacted.Redacted<string> | null;
  readonly credentialError?: never;
};

const connection = (
  protocol: ResolvedModelConnection["protocol"],
  id: string,
): AvailableConnection => ({
  id,
  name: id,
  protocol,
  baseUrl: `https://${id}.example/v1`,
  credentialId: `${id}-key`,
  apiKey: Redacted.make(`${id}-secret`),
  models: [
    {
      id: `${id}-model`,
      modelId: `upstream/${id}`,
      name: `${id} model`,
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      images: protocol !== "anthropic-messages",
      reasoning: true,
      instanceIds: [instanceId],
    },
  ],
});

const fixtureSettings = (initial: ReadonlyArray<ResolvedModelConnection>) =>
  Effect.gen(function* () {
    let current = initial;
    const pubsub = yield* PubSub.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
    const snapshot = () => ({
      ...DEFAULT_SERVER_SETTINGS,
      customModels: { revision: 0, connections: current },
    });
    return {
      settings: {
        resolveCustomModels: () => Effect.sync(() => current),
        committedCustomModels: () => snapshot().customModels,
        subscribeChanges: PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription)),
      },
      update: (next: ReadonlyArray<ResolvedModelConnection>) =>
        Effect.gen(function* () {
          current = next;
          yield* PubSub.publish(pubsub, snapshot());
        }),
    };
  });

/** Stand-in broker routes: the overlay's shape without a listener. */
const brokered = (connectionId: string) => ({
  baseUrl: `http://127.0.0.1:1/${connectionId}`,
  apiKey: `capability-${connectionId}`,
});
const overlay = (connections: ReadonlyArray<ResolvedModelConnection>) =>
  buildDroidCustomModelsSettings(connections, brokered).customModels;

const decodeOverlay = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      customModels: Schema.Array(Schema.Struct({ baseUrl: Schema.String, apiKey: Schema.String })),
    }),
  ),
);

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const runtimeInput: DroidAcpRuntimeInput = {
  childProcessSpawner: {} as never,
  droidSettings: { binaryPath: "droid" },
  cwd: "/tmp/project",
  clientInfo: { name: "test", version: "0" },
};
const stubRuntime = {
  start: () =>
    Effect.succeed({
      sessionId: "fixture",
      initializeResult: { protocolVersion: 1, agentCapabilities: {} },
      sessionSetupResult: { sessionId: "fixture" },
      modelConfigId: undefined,
    }),
  prompt: () => Effect.succeed({ stopReason: "end_turn" as const }),
} as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];

describe("Droid custom model settings", () => {
  it.each(["automatic", "manual"] as const)(
    "resolves images independently of %s limits",
    (configurationMode) => {
      const source = connection("openai-responses", "vision");
      for (const imageInput of ["automatic", "enabled", "disabled"] as const) {
        for (const images of [true, false, undefined]) {
          const model = {
            ...source.models[0]!,
            configurationMode,
            imageInput,
            reasoningMetadata: {
              status: "unknown" as const,
              source: "provider" as const,
              checkedAt: "2026-09-06T00:00:00Z",
              stale: false,
              supported: null,
              levels: [],
              ...(images === undefined ? {} : { images }),
            },
          };
          const entries = overlay([{ ...source, models: [model] }]);
          expect(entries[0]?.noImageSupport).toBe(
            !(imageInput === "enabled" || (imageInput === "automatic" && images === true)),
          );
        }
      }
    },
  );

  it.effect("keeps a Droid process through unrelated changes and retires it on revocation", () =>
    Effect.gen(function* () {
      const fixture = yield* fixtureSettings([connection("openai-responses", "original")]);
      let prompts = 0;
      const closed = yield* Deferred.make<void>();
      const factory = yield* makeDroidCustomModelsRuntimeFactory(fixture.settings, instanceId, () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
          return {
            ...stubRuntime,
            prompt: () =>
              Effect.sync(() => {
                prompts++;
                return { stopReason: "end_turn" as const };
              }),
          };
        }),
      );
      const runtime = yield* factory(runtimeInput);
      yield* fixture.update([connection("openai-responses", "original")]);
      yield* runtime.prompt({ prompt: [{ type: "text", text: "unchanged" }] });
      expect(prompts).toBe(1);
      expect(yield* Deferred.isDone(closed)).toBe(false);
      yield* fixture.update([]);
      yield* Deferred.await(closed);
      expect(runtime.isConfigurationRetired?.()).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it("reuses automatic metadata without IO and preserves manual and legacy limits", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const resolver = makeModelReasoningResolver({
      fetch,
      now: () => Date.parse("2026-09-06T12:00:00Z"),
    });
    const source = {
      ...connection("openai-responses", "openai"),
      baseUrl: "https://api.openai.com/v1",
    };
    const metadata = await resolver.resolve({
      baseUrl: source.baseUrl,
      protocol: source.protocol,
      modelId: "gpt-6-astra",
    });
    const original = source.models[0]!;
    const automatic = {
      ...original,
      configurationMode: "automatic" as const,
      modelId: "gpt-6-astra",
      images: false,
      reasoningMetadata: metadata,
    };
    const sources = [
      {
        ...source,
        models: [
          automatic,
          { ...automatic, id: "manual", configurationMode: "manual" as const },
          { ...original, id: "legacy", reasoningMetadata: metadata },
        ],
      },
    ];
    const before = structuredClone(sources[0]!.models);
    const result = overlay(sources);
    expect(
      result.map((entry) => [entry.maxContextLimit, entry.maxOutputTokens, entry.noImageSupport]),
    ).toEqual([
      [1_050_000, 128_000, false],
      [128_000, 8_192, true],
      [128_000, 8_192, false],
    ]);
    expect(result[0]).toMatchObject({
      model: "gpt-6-astra",
      provider: "openai",
      enableThinking: true,
    });
    expect(sources[0]!.models).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("delegates unresolved automatic limits to Droid without borrowing saved values or other identities", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "vendor/ready",
              context_length: 200_000,
              top_provider: { max_completion_tokens: 64_000 },
              architecture: { input_modalities: ["text"] },
            },
            { id: "vendor/incomplete", context_length: 200_000 },
            { id: "vendor/malformed", reasoning: "invalid" },
          ],
        }),
      ),
    );
    const resolver = makeModelReasoningResolver({ fetch });
    const source = {
      ...connection("openai-completions", "router"),
      baseUrl: "https://openrouter.ai/api/v1",
    };
    const models = await Promise.all(
      ["ready", "incomplete", "malformed", "ready:free"].map(async (id) => ({
        ...source.models[0]!,
        id,
        modelId: `vendor/${id}`,
        configurationMode: "automatic" as const,
        reasoningMetadata: await resolver.resolve({
          baseUrl: source.baseUrl,
          protocol: source.protocol,
          modelId: `vendor/${id}`,
        }),
      })),
    );
    const legacy = connection("anthropic-messages", "legacy");
    const result = overlay([{ ...source, models }, legacy]);
    expect(result.map((entry) => entry.id)).toEqual([
      droidCustomModelId("router", "ready"),
      droidCustomModelId("router", "incomplete"),
      droidCustomModelId("router", "malformed"),
      droidCustomModelId("router", "ready:free"),
      droidCustomModelId("legacy", "legacy-model"),
    ]);
    expect(result.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4]);
    expect(result[0]).toMatchObject({
      maxContextLimit: 200_000,
      maxOutputTokens: 64_000,
      noImageSupport: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const entry of result.slice(1, 4)) {
      expect(entry.maxContextLimit).toBeUndefined();
      expect(entry.maxOutputTokens).toBeUndefined();
    }
  });

  it.each([
    {},
    { contextWindow: 200_000 },
    { maxOutputTokens: 8_192 },
    { contextWindow: 0, maxOutputTokens: 8_192 },
    { contextWindow: 200_000, maxOutputTokens: -1 },
    { contextWindow: 200_000, maxOutputTokens: 1.5 },
    { contextWindow: 8_192, maxOutputTokens: 200_000 },
  ])("omits incomplete or invalid automatic limits and uses native defaults %j", (limits) => {
    const source = connection("openai-completions", "invalid");
    const model = {
      ...source.models[0]!,
      configurationMode: "automatic" as const,
      reasoningMetadata: {
        status: "known" as const,
        supported: true,
        source: "provider" as const,
        stale: false,
        checkedAt: "test",
        levels: ["high" as const],
        ...limits,
      },
    };
    const entries = overlay([{ ...source, models: [model] }]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.maxContextLimit).toBeUndefined();
    expect(entries[0]!.maxOutputTokens).toBeUndefined();
  });

  it("uses retained limits independently of reasoning status and preserves enriched manual reasoning overrides", () => {
    const source = connection("openai-completions", "overridden");
    const { contextWindow: _context, maxOutputTokens: _output, ...saved } = source.models[0]!;
    const model = {
      ...saved,
      configurationMode: "automatic" as const,
      reasoningMetadata: {
        status: "known" as const,
        supported: true,
        source: "manual" as const,
        stale: true,
        checkedAt: "test",
        levels: ["high" as const],
        defaultLevel: "high" as const,
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
      },
    };
    expect(overlay([{ ...source, models: [model] }])[0]).toMatchObject({
      maxContextLimit: 200_000,
      maxOutputTokens: 64_000,
      reasoningEffort: "high",
      enableThinking: true,
      noImageSupport: true,
    });
    const unknownReasoning = overlay([
      {
        ...source,
        models: [
          {
            ...model,
            reasoningMetadata: {
              ...model.reasoningMetadata,
              status: "unknown",
              supported: null,
              levels: [],
            },
          },
        ],
      },
    ]);
    expect(unknownReasoning).toHaveLength(1);
    expect(unknownReasoning[0]).not.toHaveProperty("enableThinking");
    expect(unknownReasoning[0]).not.toHaveProperty("reasoningEffort");
  });

  it.effect(
    "forwards automatic models to Droid without requiring Scient to know native defaults",
    () =>
      Effect.gen(function* () {
        const source = connection("openai-completions", "selection");
        const missing = {
          ...source.models[0]!,
          id: "missing",
          configurationMode: "automatic" as const,
        };
        const fixture = yield* fixtureSettings([
          { ...source, models: [missing, ...source.models] },
        ]);
        const selected: string[] = [];
        const factory = yield* makeDroidCustomModelsRuntimeFactory(
          fixture.settings,
          instanceId,
          () =>
            Effect.succeed({
              ...stubRuntime,
              setModel: (id) =>
                Effect.sync(() => {
                  selected.push(id);
                }),
              getConfigOptions: Effect.succeed([]),
            }),
        );
        const runtime = yield* factory(runtimeInput);
        const automaticId = droidCustomModelId(source.id, missing.id);
        yield* runtime.setModel(automaticId);
        expect(selected).toEqual([automaticId]);
        expect(
          runtime.getReasoningMetadata?.(droidCustomModelId(source.id, missing.id)),
        ).toBeNull();
        const legacyId = droidCustomModelId(source.id, source.models[0]!.id);
        yield* runtime.setModel(legacyId);
        yield* runtime.setModel("native-model");
        expect(selected).toEqual([automaticId, legacyId, "native-model"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("corrects only the selected managed completions ladder and excludes remapped efforts", () => {
    const source = connection("openai-completions", "router");
    const model = {
      ...source.models[0]!,
      reasoningMetadata: {
        status: "known",
        source: "provider",
        supported: true,
        mode: "effort",
        levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        defaultLevel: "max",
        stale: false,
        checkedAt: "2026-09-06T00:00:00.000Z",
      } as const,
    };
    const sources = [{ ...source, models: [model] }];
    const options: ReadonlyArray<SessionConfigOption> = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: droidCustomModelId(source.id, model.id),
        options: [],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning",
        type: "select",
        currentValue: "low",
        options: ["off", "low", "medium", "high"].map((value) => ({ value, name: value })),
      },
    ];
    const corrected = resolveDroidCustomReasoningOptions(options, sources);
    expect(corrected[0]).toBe(options[0]);
    expect(corrected[1]?.currentValue).toBe("low");
    expect(
      corrected[1]?.type === "select" &&
        corrected[1].options.map((option) => ("value" in option ? option.value : "group")),
    ).toEqual(["low", "medium", "high", "max"]);
    expect(resolveDroidCustomReasoningOptions(options, [source])).toBe(options);
    // The same model over Messages is not one Droid knows as adaptive: no Off, no extra level.
    const messages = resolveDroidCustomReasoningOptions(options, [
      { ...sources[0]!, protocol: "anthropic-messages" },
    ]);
    expect(
      messages[1]?.type === "select" &&
        messages[1].options.map((option) => ("value" in option ? option.value : "group")),
    ).toEqual(["low", "medium", "high"]);
    const native = [
      { ...options[0]!, currentValue: "native-model" },
      options[1]!,
    ] as ReadonlyArray<SessionConfigOption>;
    expect(resolveDroidCustomReasoningOptions(native, sources)).toBe(native);
    expect(overlay(sources)[0]?.reasoningEffort).toBe("max");
  });
  it("configures the user's default level when the model has it, else the metadata default", () => {
    const source = connection("openai-responses", "pref");
    const known = {
      status: "known",
      source: "provider",
      supported: true,
      mode: "effort",
      levels: ["minimal", "low", "medium", "high", "xhigh"],
      defaultLevel: "medium",
      stale: false,
      checkedAt: "2026-09-06T00:00:00.000Z",
    } as const;
    const model = { ...source.models[0]!, reasoningMetadata: known };
    const effort = (defaultReasoningLevel?: CustomModel["defaultReasoningLevel"]) =>
      overlay([
        {
          ...source,
          models: [{ ...model, ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}) }],
        },
      ])[0]?.reasoningEffort;
    expect(effort()).toBe("medium");
    expect(effort("xhigh")).toBe("xhigh");
    expect(effort("minimal")).toBe("minimal");
    // Not one of this model's levels: the metadata default stands.
    expect(effort("max")).toBe("medium");
  });

  /** Droid's own ladder for a custom model, as one session reports it. */
  const droidLadder = (currentValue: string, advertised = ["off", "low", "medium", "high"]) =>
    [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue,
        options: [],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning",
        type: "select",
        currentValue: "high",
        options: advertised.map((value) => ({ value, name: value })),
      },
    ] satisfies ReadonlyArray<SessionConfigOption>;
  const ladderValues = (options: ReadonlyArray<SessionConfigOption>) =>
    options[1]?.type === "select"
      ? options[1].options.map((option) => ("value" in option ? option.value : "group"))
      : [];
  const knownReasoning = (mode: "effort" | "adaptive" | "budget", levels: ReadonlyArray<string>) =>
    ({
      status: "known",
      source: "provider",
      supported: true,
      mode,
      levels,
      defaultLevel: "medium",
      stale: false,
      checkedAt: "2026-09-06T00:00:00.000Z",
    }) as never;

  it("offers the configured level beyond Droid's ladder for Responses", () => {
    // Droid 0.213.0/0.230.0 advertise off/low/medium/high for custom models and
    // send the overlay's configured level when it is selected (also xhigh,
    // minimal and max); any other unlisted level is sent as the configured one.
    const responses = connection("openai-responses", "rsp");
    const rsp = {
      ...responses.models[0]!,
      defaultReasoningLevel: "minimal" as const,
      reasoningMetadata: knownReasoning("effort", ["minimal", "low", "medium", "high", "xhigh"]),
    };
    expect(
      ladderValues(
        resolveDroidCustomReasoningOptions(droidLadder(droidCustomModelId("rsp", rsp.id)), [
          { ...responses, models: [rsp] },
        ]),
      ),
    ).toEqual(["minimal", "low", "medium", "high"]);
  });

  it("offers Off, Max and Extra-high on Messages only for the model ids Droid sends them for", () => {
    // Droid 0.213.0/0.230.0 choose the Messages request by model id. Claude
    // models its own table knows as adaptive get effort levels whatever the
    // overlay configures; any other id gets budget thinking for low, medium
    // and high, and nothing for another level.
    const messages = connection("anthropic-messages", "ant");
    const manual = (
      modelId: string,
      levels: ReadonlyArray<"minimal" | "low" | "medium" | "high" | "xhigh" | "max">,
      defaultLevel: "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    ): AvailableConnection => ({
      ...messages,
      models: [
        {
          ...messages.models[0]!,
          modelId,
          defaultReasoningLevel: defaultLevel,
          reasoningOverride: { supported: true, levels, defaultLevel },
        },
      ],
    });
    const slug = droidCustomModelId("ant", messages.models[0]!.id);
    const offered = (source: AvailableConnection) =>
      ladderValues(resolveDroidCustomReasoningOptions(droidLadder(slug), [source]));
    const configured = (source: AvailableConnection) => overlay([source])[0]?.reasoningEffort;

    // Not a model Droid knows as adaptive: the extra level and Off are not offered,
    // and the overlay configures a level Droid sends.
    const plain = manual("plain-anthropic", ["low", "medium", "high", "max"], "max");
    expect(offered(plain)).toEqual(["low", "medium", "high"]);
    expect(configured(plain)).toBe("medium");
    const minimal = manual("kimi-k2", ["minimal", "low", "high"], "minimal");
    expect(offered(minimal)).toEqual(["low", "high"]);
    expect(configured(minimal)).toBe("high");
    // A Claude model with budget thinking: Droid answers Max with Off.
    expect(offered(manual("claude-sonnet-4-5", ["low", "medium", "high", "max"], "max"))).toEqual([
      "low",
      "medium",
      "high",
    ]);

    // Adaptive in Droid's table: both extra levels, whichever is the default.
    const opus47 = manual(
      "bedrock/anthropic.claude-opus-4-7",
      ["low", "medium", "high", "xhigh", "max"],
      "high",
    );
    expect(offered(opus47)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    expect(configured(opus47)).toBe("high");
    // Opus 4.6 has Max but no Extra-high in Droid: a default it would not apply is not configured.
    const opus46 = manual("claude-opus-4-6", ["low", "medium", "high", "xhigh", "max"], "xhigh");
    expect(offered(opus46)).toEqual(["off", "low", "medium", "high", "max"]);
    expect(configured(opus46)).toBe("medium");

    // Provider evidence follows the same rule: the model id decides.
    const evidence = (modelId: string): AvailableConnection => ({
      ...messages,
      models: [
        {
          ...messages.models[0]!,
          modelId,
          defaultReasoningLevel: "max",
          reasoningMetadata: knownReasoning("adaptive", ["low", "medium", "high", "max"]),
        },
      ],
    });
    expect(offered(evidence("claude-sonnet-4-6"))).toEqual(["off", "low", "medium", "high", "max"]);
    expect(offered(evidence("claude-opus-9"))).toEqual(["low", "medium", "high"]);
    expect(configured(evidence("claude-opus-9"))).toBe("medium");
  });

  it.effect("reports a Messages model's reasoning the way Droid applies it", () =>
    Effect.gen(function* () {
      const messages = connection("anthropic-messages", "ant");
      const override = {
        supported: true,
        levels: ["low", "medium", "high", "max"],
        defaultLevel: "max",
      } as const;
      const plain = { ...messages.models[0]!, id: "plain", modelId: "plain-anthropic" };
      const opus = { ...messages.models[0]!, id: "opus", modelId: "claude-opus-4-7" };
      const fixture = yield* fixtureSettings([
        {
          ...messages,
          models: [
            { ...plain, reasoningOverride: override },
            { ...opus, reasoningOverride: override },
          ],
        },
      ]);
      const factory = yield* makeDroidCustomModelsRuntimeFactory(fixture.settings, instanceId, () =>
        Effect.succeed(stubRuntime),
      );
      const runtime = yield* factory(runtimeInput);
      expect(runtime.getReasoningMetadata?.(droidCustomModelId("ant", "plain"))).toMatchObject({
        mode: "budget",
        levels: ["low", "medium", "high"],
      });
      expect(runtime.getReasoningMetadata?.(droidCustomModelId("ant", "opus"))).toMatchObject({
        mode: "adaptive",
        levels: ["low", "medium", "high", "max"],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resumes into a new overlay when the user's default level changes", () =>
    Effect.gen(function* () {
      const source = connection("openai-responses", "prefchange");
      const model = {
        ...source.models[0]!,
        reasoningMetadata: {
          status: "known",
          source: "provider",
          supported: true,
          mode: "effort",
          levels: ["low", "medium", "high", "xhigh"],
          defaultLevel: "medium",
          stale: false,
          checkedAt: "2026-09-06T00:00:00.000Z",
        } as const,
      };
      const fixture = yield* fixtureSettings([{ ...source, models: [model] }]);
      const factory = yield* makeDroidCustomModelsRuntimeFactory(fixture.settings, instanceId, () =>
        Effect.succeed(stubRuntime),
      );
      const runtime = yield* factory(runtimeInput);
      // A label-only preference that leaves the configured level alone keeps the process.
      yield* fixture.update([
        { ...source, models: [{ ...model, defaultReasoningLevel: "medium" }] },
      ]);
      yield* runtime.checkConfiguration!();
      expect(runtime.isConfigurationCurrent?.()).toBe(true);
      yield* fixture.update([
        { ...source, models: [{ ...model, defaultReasoningLevel: "xhigh" }] },
      ]);
      yield* runtime.checkConfiguration!();
      expect(runtime.isConfigurationCurrent?.()).toBe(false);
      expect(runtime.isConfigurationRetired?.()).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "discovers native and injected models over ACP, selects them, and refreshes after removal",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-droid-catalog-wire-" });
        const binaryPath = path.join(root, "droid");
        const agentPath = path.join(import.meta.dirname, "../../../scripts/acp-mock-agent.ts");
        yield* fs.writeFileString(
          binaryPath,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then echo "droid-cli 0.0.99"; exit 0; fi',
            'exec "$SCIENT_TEST_NODE" "$SCIENT_TEST_AGENT" "$@"',
            "",
          ].join("\n"),
        );
        yield* fs.chmod(binaryPath, 0o755);
        const sources = [
          connection("openai-completions", "chat"),
          connection("openai-responses", "responses"),
          connection("anthropic-messages", "anthropic"),
        ];
        sources[0] = {
          ...sources[0]!,
          models: sources[0]!.models.map((model) => ({
            ...model,
            configurationMode: "automatic",
            reasoningMetadata: {
              status: "known",
              supported: true,
              levels: ["high"],
              source: "provider",
              checkedAt: "2026-09-06T00:00:00Z",
              stale: true,
              contextWindow: 200_000,
              maxOutputTokens: 64_000,
              images: true,
            },
          })),
        };
        const fixture = yield* fixtureSettings(sources);
        const factory = yield* makeDroidCustomModelsRuntimeFactory(fixture.settings, instanceId);
        const settings = decodeDroidSettings({ enabled: true, binaryPath });
        const environment = {
          // Only the synthetic Droid executable is available; Pi is not needed for discovery or selection.
          PATH: root,
          HOME: root,
          SCIENT_TEST_NODE: process.execPath,
          SCIENT_TEST_AGENT: agentPath,
          T3_ACP_DROID_ASYNC_CONFIG_REFRESH: "1",
        };
        const before = yield* checkDroidProviderStatusWithCapabilities(
          settings,
          environment,
          factory,
        );
        const slugs = sources.map((source) => droidCustomModelId(source.id, source.models[0]!.id));
        expect(before.snapshot.status).toBe("ready");
        expect(before.snapshot.models.map((model) => model.slug)).toEqual(
          expect.arrayContaining(["custom:Ox-Alpha-0", ...slugs]),
        );
        expect(before.snapshot.models.every((model) => !model.isCustom)).toBe(true);
        expect(
          before.snapshot.models.find((model) => model.slug === slugs[0])?.capabilities,
          // The mock reports no ladder for injected models: metadata must not invent one.
        ).toEqual({
          optionDescriptors: [
            expect.objectContaining({
              id: "reasoningEffort",
              strictSelection: true,
              emptySelectionLabel: "Reasoning",
              options: [],
            }),
          ],
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* factory({
              childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
              droidSettings: settings,
              environment,
              cwd: root,
              clientInfo: { name: "scient-catalog-test", version: "0" },
            });
            yield* runtime.start();
            expect(runtime.getReasoningMetadata?.(slugs[0]!)).toEqual({
              status: "known",
              supported: true,
              levels: ["high"],
            });
            expect(runtime.getReasoningMetadata?.(slugs[1]!)).toBeNull();
            expect(runtime.getReasoningMetadata?.("custom:Ox-Alpha-0")).toBeUndefined();
            for (const slug of slugs) {
              yield* runtime.setModel(slug);
              expect(
                (yield* runtime.getConfigOptions).find((option) => option.category === "model")
                  ?.currentValue,
              ).toBe(slug);
              expect(
                (yield* runtime.prompt({ prompt: [{ type: "text", text: "synthetic test" }] }))
                  .stopReason,
              ).toBe("end_turn");
            }
          }),
        );
        yield* fixture.update([]);
        const after = yield* checkDroidProviderStatusWithCapabilities(
          settings,
          environment,
          factory,
        );
        expect(after.snapshot.models.some((model) => model.slug === "custom:Ox-Alpha-0")).toBe(
          true,
        );
        expect(after.snapshot.models.some((model) => slugs.includes(model.slug))).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("projects every Scient protocol onto Droid's native BYOK providers through the broker", () => {
    const result = overlay([
      connection("openai-completions", "chat"),
      connection("openai-responses", "responses"),
      connection("anthropic-messages", "anthropic"),
    ]);
    expect(result.map((model) => model.provider)).toEqual([
      "generic-chat-completion-api",
      "openai",
      "anthropic",
    ]);
    expect(result.map((model) => model.index)).toEqual([0, 1, 2]);
    expect(result[0]).toMatchObject({
      model: "upstream/chat",
      displayName: "chat model",
      baseUrl: "http://127.0.0.1:1/chat",
      apiKey: "capability-chat",
      maxContextLimit: 128_000,
      maxOutputTokens: 8_192,
      noImageSupport: false,
      enableThinking: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/-secret|\.example/);
  });

  it("uses stable ids, brokers keyless endpoints, and omits unavailable credentials", () => {
    const keylessSource = connection("openai-completions", "local");
    const keyless: ResolvedModelConnection = { ...keylessSource, apiKey: null };
    const brokenSource = connection("openai-completions", "broken");
    const { apiKey: _apiKey, ...brokenWithoutKey } = brokenSource;
    const unavailable: ResolvedModelConnection = {
      ...brokenWithoutKey,
      credentialError: "Re-enter the API key.",
    };
    const result = overlay([keyless, unavailable]);
    expect(result).toHaveLength(1);
    // Keyless requests pass through the broker too, for the per-turn request limits.
    expect(result[0]).toMatchObject({
      baseUrl: "http://127.0.0.1:1/local",
      apiKey: "capability-local",
    });
    expect(result[0]!.id).toBe(droidCustomModelId("local", "local-model"));
    expect(droidCustomModelId("local", "local-model")).toBe(
      droidCustomModelId("local", "local-model"),
    );
    expect(droidCustomModelId("other", "local-model")).not.toBe(
      droidCustomModelId("local", "local-model"),
    );
  });

  it.effect("creates a private per-process overlay and removes it with the runtime scope", () => {
    let overlayPath = "";
    let brokerUrl = "";
    let capturedInput: DroidAcpRuntimeInput | undefined;
    const makeRuntime: DroidAcpRuntimeFactory = (input) =>
      Effect.sync(() => {
        capturedInput = input;
        return {} as AcpSessionRuntime.AcpSessionRuntime["Service"];
      });
    const available = connection("openai-responses", "scoped");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* fixtureSettings([available]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const factory = yield* makeDroidCustomModelsRuntimeFactory(
            fixture.settings,
            instanceId,
            makeRuntime,
          );
          yield* factory({
            childProcessSpawner: {} as never,
            droidSettings: { binaryPath: "droid" },
            cwd: "/tmp/project",
            clientInfo: { name: "test", version: "0" },
          });
          overlayPath = capturedInput!.runtimeSettingsPath!;
          expect(overlayPath).toContain("scient-droid-models-");
          expect(yield* fs.exists(overlayPath)).toBe(true);
          const contents = yield* fs.readFileString(overlayPath);
          expect(contents).not.toContain("scoped-secret");
          expect(contents).not.toContain("scoped.example");
          // The key is in none of the inputs Droid's spawn is built from: its
          // environment, argv inputs or settings.
          expect(capturedInput!.environment).toBeUndefined();
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          expect(JSON.stringify(capturedInput)).not.toContain("scoped-secret");
          const decoded = decodeOverlay(contents).customModels[0]!;
          expect(decoded.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{24}$/);
          expect(decoded.apiKey).toMatch(/^scient-cap-[A-Za-z0-9_-]{43}$/);
          brokerUrl = decoded.baseUrl;
          expect((yield* fs.stat(overlayPath)).mode & 0o777).toBe(0o600);
        }),
      );
      expect(yield* fs.exists(overlayPath)).toBe(false);
      // The broker's listener ends with the runtime scope.
      const afterClose = yield* Effect.tryPromise(() =>
        // @effect-diagnostics-next-line globalFetchInEffect:off
        fetch(`${brokerUrl}/responses`, { method: "POST", body: "{}" }),
      ).pipe(Effect.exit);
      expect(afterClose._tag).toBe("Failure");
    }).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect("stops Droid's Factory conversation sync only when the setting is off", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* fixtureSettings([connection("openai-responses", "sync")]);
      const overlays: Array<string> = [];
      const factory = yield* makeDroidCustomModelsRuntimeFactory(
        fixture.settings,
        instanceId,
        (input) =>
          fs.readFileString(input.runtimeSettingsPath!).pipe(
            Effect.map((contents) => {
              overlays.push(contents);
              return {} as AcpSessionRuntime.AcpSessionRuntime["Service"];
            }),
            Effect.orDie,
          ),
      );
      for (const droidSettings of [
        { binaryPath: "droid" },
        decodeDroidSettings({ binaryPath: "droid" }),
        decodeDroidSettings({ binaryPath: "droid", cloudSessionSync: false }),
      ])
        yield* Effect.scoped(factory({ ...runtimeInput, droidSettings }));
      const syncSetting = overlays.map(
        (contents) => (decodeJson(contents) as { cloudSessionSync?: unknown }).cloudSessionSync,
      );
      // Droid's default (sync on) is left to Droid; off is written explicitly.
      expect(syncSetting).toEqual([undefined, undefined, false]);
      expect(decodeDroidSettings({}).cloudSessionSync).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("confirms tool refusal for background generation only where Droid enforces it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* fixtureSettings([connection("openai-completions", "guard")]);
      const guard = (policy: DroidOrgHookPolicy, runsOverlayHooks: boolean) =>
        Effect.gen(function* () {
          const factory = yield* makeDroidCustomModelsRuntimeFactory(
            fixture.settings,
            instanceId,
            (input) =>
              fs.readFileString(input.runtimeSettingsPath!).pipe(
                Effect.map(
                  (overlay) =>
                    ({
                      // Like Droid: SessionStart hooks run while the session starts,
                      // unless an organization policy dropped the overlay's hooks.
                      start: () =>
                        runsOverlayHooks
                          ? fs.writeFileString(
                              /echo started > \\"(.+?)\\"/.exec(overlay)![1]!,
                              "started",
                            )
                          : Effect.void,
                    }) as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"],
                ),
                Effect.orDie,
              ),
            () => Effect.succeed(policy),
          );
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* factory({ ...runtimeInput, modelTools: "disabled" });
              yield* runtime.start();
              return yield* runtime.backgroundToolGuard!();
            }),
          );
        });
      // One rule for every model. A custom model is offered no tools, but its endpoint
      // can still answer with a tool call, and only the hook refuses that; the
      // attached custom model in this process changes nothing.
      expect(yield* guard("managed-hooks-only", false)).toBe("disabled-by-policy");
      expect(yield* guard("unknown", true)).toBe("unconfirmed");
      // No policy source says so, but Droid did not run the overlay's hook.
      expect(yield* guard("overlay-hooks-allowed", false)).toBe("unconfirmed");
      expect(yield* guard("overlay-hooks-allowed", true)).toBe("enforced");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses every Droid tool call only in processes started without tools", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* fixtureSettings([connection("openai-responses", "tools")]);
      const overlays: Array<unknown> = [];
      const factory = yield* makeDroidCustomModelsRuntimeFactory(
        fixture.settings,
        instanceId,
        (input) =>
          fs.readFileString(input.runtimeSettingsPath!).pipe(
            Effect.map((contents) => {
              overlays.push(decodeJson(contents));
              return {} as AcpSessionRuntime.AcpSessionRuntime["Service"];
            }),
            Effect.orDie,
          ),
      );
      for (const modelTools of ["disabled", undefined] as const)
        yield* Effect.scoped(factory({ ...runtimeInput, ...(modelTools ? { modelTools } : {}) }));
      const [withoutTools, withTools] = overlays as Array<Record<string, unknown>>;
      // Droid runs PreToolUse hooks before every tool, MCP tools included; exit 2 refuses.
      // The SessionStart hook shows Scient that Droid runs the overlay's hooks at all.
      expect(withoutTools?.hooks).toEqual({
        PreToolUse: [{ hooks: [{ type: "command", command: "exit 2" }] }],
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: expect.stringMatching(/^echo started > ".+session-started"$/),
              },
            ],
          },
        ],
      });
      expect(withTools?.hooks).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("ignores other agents' attachments and connections when comparing process configuration", () => {
    const original = connection("openai-responses", "original");
    const unrelated = { ...connection("openai-responses", "other"), models: [] };
    expect(droidCustomModelsSnapshot([original], instanceId)).toEqual(
      droidCustomModelsSnapshot(
        [
          {
            ...original,
            models: original.models.map((model) => ({
              ...model,
              instanceIds: [...model.instanceIds, ProviderInstanceId.make("pi")],
            })),
          },
          unrelated,
        ],
        instanceId,
      ),
    );
    expect(droidCustomModelsSnapshot([original], instanceId)).not.toEqual(
      droidCustomModelsSnapshot([{ ...original, credentialId: "rotated" }], instanceId),
    );
  });

  it.effect("defers capability updates without retiring the current runtime", () =>
    Effect.gen(function* () {
      const original = connection("openai-completions", "capabilities");
      const metadata = {
        status: "known" as const,
        source: "provider" as const,
        checkedAt: "2026-09-06T00:00:00Z",
        stale: false,
        supported: true,
        levels: ["low", "high"] as const,
        mode: "effort" as const,
        contextWindow: 128000,
        maxOutputTokens: 8192,
      };
      const initial = {
        ...original,
        models: original.models.map((model) => ({
          ...model,
          configurationMode: "automatic" as const,
          reasoningMetadata: metadata,
        })),
      };
      const fixture = yield* fixtureSettings([initial]);
      const closed = yield* Deferred.make<void>();
      const factory = yield* makeDroidCustomModelsRuntimeFactory(fixture.settings, instanceId, () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
          return stubRuntime;
        }),
      );
      const runtime = yield* factory(runtimeInput);
      yield* fixture.update([
        {
          ...initial,
          name: "Renamed connection",
          models: initial.models.map((model) => ({
            ...model,
            name: "Renamed model",
            defaultReasoningLevel: "high",
            reasoningMetadata: { ...metadata, checkedAt: "2026-09-06T01:00:00Z", stale: true },
          })),
        },
      ]);
      yield* runtime.start();
      expect(yield* Deferred.isDone(closed)).toBe(false);
      expect(
        runtime.getDefaultReasoningLevel?.(droidCustomModelId(initial.id, initial.models[0]!.id)),
      ).toBe("high");
      yield* fixture.update([
        {
          ...initial,
          models: initial.models.map((model) => ({
            ...model,
            reasoningMetadata: { ...metadata, maxOutputTokens: 16384, levels: ["high"] },
          })),
        },
      ]);
      yield* runtime.checkConfiguration!();
      expect(yield* Deferred.isDone(closed)).toBe(false);
      expect(runtime.isConfigurationCurrent?.()).toBe(false);
      expect(runtime.isConfigurationRetired?.()).toBe(false);
      yield* runtime.prompt({ prompt: [] });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a runtime current when a connection's saved key is unavailable", () =>
    Effect.gen(function* () {
      const available = connection("openai-responses", "available");
      const { apiKey: _apiKey, ...withoutKey } = connection("openai-responses", "missing");
      const missing: ResolvedModelConnection = {
        ...withoutKey,
        credentialError: "Re-enter the API key for missing in Custom models.",
      };
      const fixture = yield* fixtureSettings([available, missing]);
      const closed = yield* Deferred.make<void>();
      const factory = yield* makeDroidCustomModelsRuntimeFactory(fixture.settings, instanceId, () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
          return stubRuntime;
        }),
      );
      const runtime = yield* factory(runtimeInput);
      yield* runtime.checkConfiguration!();
      expect(runtime.isConfigurationCurrent?.()).toBe(true);
      yield* runtime.prompt({ prompt: [] });
      expect(runtime.isConfigurationCurrent?.()).toBe(true);
      // Re-entering the key makes the model usable: pick it up on the next turn
      // without killing a process that never held the missing credential.
      yield* fixture.update([
        available,
        { ...withoutKey, credentialId: "re-entered", apiKey: Redacted.make("new-key") },
      ]);
      yield* runtime.checkConfiguration!();
      expect(runtime.isConfigurationCurrent?.()).toBe(false);
      expect(runtime.isConfigurationRetired?.()).toBe(false);
      expect(yield* Deferred.isDone(closed)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("says why Droid does not list a Scient model instead of its model list", () =>
    Effect.gen(function* () {
      const available = connection("openai-responses", "available");
      const { apiKey: _apiKey, ...withoutKey } = connection("openai-responses", "missing");
      const missing: ResolvedModelConnection = {
        ...withoutKey,
        credentialError: "Re-enter the API key for missing in Custom models.",
      };
      const detached = connection("openai-completions", "detached");
      const fixture = yield* fixtureSettings([available, missing, detached]);
      const factory = yield* makeDroidCustomModelsRuntimeFactory(fixture.settings, instanceId, () =>
        Effect.succeed(stubRuntime),
      );
      const runtime = yield* factory(runtimeInput);
      const describe = (slug: string) => runtime.describeUnavailableModel?.(slug);
      expect(describe(droidCustomModelId("missing", "missing-model"))).toBe(
        "Re-enter the API key for missing in Custom models.",
      );
      // Settings changed after this process started: the current catalog decides.
      yield* fixture.update([
        available,
        missing,
        { ...detached, models: [{ ...detached.models[0]!, instanceIds: [] }] },
      ]);
      expect(describe(droidCustomModelId("detached", "detached-model"))).toBe(
        '"detached model" isn\'t attached to this Droid. Select Droid under Use with in Settings > Custom models, or pick another model.',
      );
      yield* fixture.update([missing]);
      expect(describe(droidCustomModelId("available", "available-model"))).toBe(
        '"available model" was removed from Custom models. Pick another model.',
      );
      expect(describe(droidCustomModelId("never", "seen"))).toBe(
        "This custom model was removed from Custom models. Pick another model.",
      );
      expect(describe("claude-opus-4-6")).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not broker a key the broker could not recognize when an endpoint echoes it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const usable = connection("openai-responses", "usable");
      // Saved for Pi, where it works, and attached to Droid later.
      const spaced: ResolvedModelConnection = {
        ...connection("openai-completions", "spaced"),
        apiKey: Redacted.make("sk with\ttab"),
      };
      const fixture = yield* fixtureSettings([usable, spaced]);
      let overlayPath = "";
      const factory = yield* makeDroidCustomModelsRuntimeFactory(
        fixture.settings,
        instanceId,
        (input) =>
          Effect.sync(() => {
            overlayPath = input.runtimeSettingsPath!;
            return stubRuntime;
          }),
      );
      const runtime = yield* factory(runtimeInput);
      expect(runtime.describeUnavailableModel?.(droidCustomModelId("spaced", "spaced-model"))).toBe(
        "Droid cannot use the API key for spaced: it contains a space or a control character. Re-enter the key in Custom models.",
      );
      // Only the usable connection reaches Droid.
      expect(decodeOverlay(yield* fs.readFileString(overlayPath)).customModels).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports the context window each loaded custom model was given", () =>
    Effect.gen(function* () {
      const loaded = connection("openai-responses", "window");
      const fixture = yield* fixtureSettings([loaded]);
      const factory = yield* makeDroidCustomModelsRuntimeFactory(fixture.settings, instanceId, () =>
        Effect.succeed(stubRuntime),
      );
      const runtime = yield* factory(runtimeInput);
      expect(runtime.getContextWindow?.(droidCustomModelId("window", "window-model"))).toBe(
        128_000,
      );
      expect(runtime.getContextWindow?.("native-model")).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("leaves thinking to Droid when manual limits are saved with reasoning on Automatic", () => {
    const source = connection("openai-completions", "limits");
    const manual = {
      ...source.models[0]!,
      configurationMode: "manual" as const,
      // The editor saves new models with the legacy flag off.
      reasoning: false,
    };
    const unknown = {
      status: "unknown" as const,
      supported: null,
      levels: [],
      source: "provider" as const,
      checkedAt: "2026-09-06T00:00:00Z",
      stale: false,
    };
    const entries = overlay([
      {
        ...source,
        models: [
          manual,
          { ...manual, id: "unknown", reasoningMetadata: unknown },
          { ...manual, id: "override", reasoningOverride: { supported: false, levels: [] } },
          // Saved before configuration modes existed: the explicit flag stays authoritative.
          { ...source.models[0]!, id: "legacy", reasoning: false },
        ],
      },
    ]);
    expect(entries[0]).not.toHaveProperty("enableThinking");
    expect(entries[1]).not.toHaveProperty("enableThinking");
    expect(entries[2]).toMatchObject({ enableThinking: false });
    expect(entries[3]).toMatchObject({ enableThinking: false });
  });

  it.effect("retires only affected runtimes and rejects further use after key rotation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const original = connection("openai-responses", "original");
      const fixture = yield* fixtureSettings([original]);
      const closed = yield* Deferred.make<void>();
      let file = "";
      const factory = yield* makeDroidCustomModelsRuntimeFactory(
        fixture.settings,
        instanceId,
        (input) =>
          Effect.gen(function* () {
            file = input.runtimeSettingsPath!;
            yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
            return stubRuntime;
          }),
      );
      const runtime = yield* factory(runtimeInput);
      expect(runtime.isConfigurationCurrent?.()).toBe(true);
      yield* fixture.update([
        {
          ...original,
          models: original.models.map((m) => ({
            ...m,
            instanceIds: [...m.instanceIds, ProviderInstanceId.make("pi")],
          })),
        },
      ]);
      yield* runtime.start();
      expect(yield* Deferred.isDone(closed)).toBe(false);
      yield* fixture.update([
        { ...original, credentialId: "rotated", apiKey: Redacted.make("new-key") },
      ]);
      yield* Deferred.await(closed);
      expect(runtime.isConfigurationCurrent?.()).toBe(false);
      expect((yield* runtime.prompt({ prompt: [] }).pipe(Effect.flip))._tag).toBe(
        "AcpProcessExitedError",
      );
      expect(yield* fs.exists(file)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not miss a model removal while the runtime is being constructed", () =>
    Effect.gen(function* () {
      const fixture = yield* fixtureSettings([connection("openai-responses", "original")]);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      const factory = yield* makeDroidCustomModelsRuntimeFactory(fixture.settings, instanceId, () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return stubRuntime;
        }),
      );
      const pending = yield* factory(runtimeInput).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* fixture.update([]);
      yield* Deferred.await(closed);
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(pending))._tag).toBe("AcpProcessExitedError");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "removes the overlay immediately after construction failure without hiding the runtime error",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const fixture = yield* fixtureSettings([connection("openai-responses", "original")]);
        let file = "";
        const expected = new AcpRequestError({
          code: -32603,
          errorMessage: "synthetic construction failure",
        });
        const factory = yield* makeDroidCustomModelsRuntimeFactory(
          fixture.settings,
          instanceId,
          (input) =>
            Effect.gen(function* () {
              file = input.runtimeSettingsPath!;
              return yield* expected;
            }),
        );
        expect(yield* factory(runtimeInput).pipe(Effect.flip)).toBe(expected);
        expect(yield* fs.exists(file)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("cleans up a cancelled construction while its caller scope is still alive", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* fixtureSettings([connection("openai-responses", "original")]);
      const entered = yield* Deferred.make<string>();
      const factory = yield* makeDroidCustomModelsRuntimeFactory(
        fixture.settings,
        instanceId,
        (input) =>
          Deferred.succeed(entered, input.runtimeSettingsPath!).pipe(Effect.andThen(Effect.never)),
      );
      const pending = yield* factory(runtimeInput).pipe(Effect.forkChild);
      const file = yield* Deferred.await(entered);
      expect(yield* fs.exists(file)).toBe(true);
      yield* Fiber.interrupt(pending);
      expect(yield* fs.exists(file)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
