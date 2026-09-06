import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ServerSettingsError,
} from "@t3tools/contracts";
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
        getSettings: Effect.sync(snapshot),
        subscribeChanges: PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription)),
      },
      update: (next: ReadonlyArray<ResolvedModelConnection>) =>
        Effect.gen(function* () {
          current = next;
          yield* PubSub.publish(pubsub, snapshot());
        }),
    };
  });

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
          const overlay = buildDroidCustomModelsSettings([{ ...source, models: [model] }]);
          expect(overlay.settings.customModels[0]?.noImageSupport).toBe(
            !(imageInput === "enabled" || (imageInput === "automatic" && images === true)),
          );
        }
      }
    },
  );

  it.effect("preserves a Droid process on failed checks and keeps watching for revocation", () =>
    Effect.gen(function* () {
      const fixture = yield* fixtureSettings([connection("openai-responses", "original")]);
      let failing = false;
      let prompts = 0;
      const failedCheck = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      const factory = yield* makeDroidCustomModelsRuntimeFactory(
        {
          ...fixture.settings,
          getSettings: Effect.gen(function* () {
            if (failing) {
              yield* Deferred.succeed(failedCheck, undefined);
              return yield* new ServerSettingsError({
                settingsPath: "fixture",
                operation: "read-file",
                cause: "synthetic",
              });
            }
            return yield* fixture.settings.getSettings;
          }),
        },
        instanceId,
        () =>
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
      failing = true;
      yield* fixture.update([connection("openai-responses", "original")]);
      yield* Deferred.await(failedCheck);
      const blocked = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "blocked" }] })
        .pipe(Effect.result);
      expect(blocked._tag).toBe("Failure");
      expect(prompts).toBe(0);
      expect(yield* Deferred.isDone(closed)).toBe(false);
      failing = false;
      yield* runtime.prompt({ prompt: [{ type: "text", text: "recovered" }] });
      expect(prompts).toBe(1);
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
    const result = buildDroidCustomModelsSettings(sources).settings.customModels;
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
    const result = buildDroidCustomModelsSettings([{ ...source, models }, legacy]);
    expect(result.settings.customModels.map((entry) => entry.id)).toEqual([
      droidCustomModelId("router", "ready"),
      droidCustomModelId("router", "incomplete"),
      droidCustomModelId("router", "malformed"),
      droidCustomModelId("router", "ready:free"),
      droidCustomModelId("legacy", "legacy-model"),
    ]);
    expect(result.settings.customModels.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4]);
    expect(result.settings.customModels[0]).toMatchObject({
      maxContextLimit: 200_000,
      maxOutputTokens: 64_000,
      noImageSupport: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const entry of result.settings.customModels.slice(1, 4)) {
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
    const entries = buildDroidCustomModelsSettings([{ ...source, models: [model] }]).settings
      .customModels;
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
    expect(
      buildDroidCustomModelsSettings([{ ...source, models: [model] }]).settings.customModels[0],
    ).toMatchObject({
      maxContextLimit: 200_000,
      maxOutputTokens: 64_000,
      reasoningEffort: "high",
      enableThinking: true,
      noImageSupport: true,
    });
    const unknownReasoning = buildDroidCustomModelsSettings([
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
    ]).settings.customModels;
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
    expect(
      resolveDroidCustomReasoningOptions(options, [
        { ...sources[0]!, protocol: "anthropic-messages" },
      ]),
    ).toBe(options);
    const native = [
      { ...options[0]!, currentValue: "native-model" },
      options[1]!,
    ] as ReadonlyArray<SessionConfigOption>;
    expect(resolveDroidCustomReasoningOptions(native, sources)).toBe(native);
    expect(buildDroidCustomModelsSettings(sources).settings.customModels[0]?.reasoningEffort).toBe(
      "max",
    );
  });
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

  it("projects every Scient protocol onto Droid's native BYOK providers", () => {
    const { settings: result, environment } = buildDroidCustomModelsSettings([
      connection("openai-completions", "chat"),
      connection("openai-responses", "responses"),
      connection("anthropic-messages", "anthropic"),
    ]);
    expect(result.customModels.map((model) => model.provider)).toEqual([
      "generic-chat-completion-api",
      "openai",
      "anthropic",
    ]);
    expect(result.customModels.map((model) => model.index)).toEqual([0, 1, 2]);
    expect(result.customModels[0]).toMatchObject({
      model: "upstream/chat",
      displayName: "chat model",
      maxContextLimit: 128_000,
      maxOutputTokens: 8_192,
      noImageSupport: false,
      enableThinking: true,
    });
    expect(Object.values(environment)).toEqual([
      "chat-secret",
      "responses-secret",
      "anthropic-secret",
    ]);
    expect(JSON.stringify(result)).not.toContain("chat-secret");
  });

  it("uses stable ids, supports keyless endpoints, and omits unavailable credentials", () => {
    const keylessSource = connection("openai-completions", "local");
    const keyless: ResolvedModelConnection = { ...keylessSource, apiKey: null };
    const brokenSource = connection("openai-completions", "broken");
    const { apiKey: _apiKey, ...brokenWithoutKey } = brokenSource;
    const unavailable: ResolvedModelConnection = {
      ...brokenWithoutKey,
      credentialError: "Re-enter the API key.",
    };
    const { settings: result, environment } = buildDroidCustomModelsSettings([
      keyless,
      unavailable,
    ]);
    expect(environment).toEqual({});
    expect(result.customModels).toHaveLength(1);
    expect(result.customModels[0]).not.toHaveProperty("apiKey");
    expect(result.customModels[0]!.id).toBe(droidCustomModelId("local", "local-model"));
    expect(droidCustomModelId("local", "local-model")).toBe(
      droidCustomModelId("local", "local-model"),
    );
    expect(droidCustomModelId("other", "local-model")).not.toBe(
      droidCustomModelId("local", "local-model"),
    );
  });

  it.effect("creates a private per-process overlay and removes it with the runtime scope", () => {
    let overlayPath = "";
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
          expect(yield* fs.readFileString(overlayPath)).not.toContain("scoped-secret");
          expect(Object.values(capturedInput!.environment!)).toContain("scoped-secret");
          expect((yield* fs.stat(overlayPath)).mode & 0o777).toBe(0o600);
        }),
      );
      expect(yield* fs.exists(overlayPath)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer));
  });

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

  it("keeps special key characters literal through Droid's single-pass environment expansion", () => {
    const literal = "token-${HOME}-$suffix-!command";
    const source = { ...connection("openai-responses", "literal"), apiKey: Redacted.make(literal) };
    const { settings, environment } = buildDroidCustomModelsSettings([source]);
    const reference = settings.customModels[0]!.apiKey as string;
    expect(reference).toMatch(/^\$\{SCIENT_DROID_KEY_[a-f0-9]{32}\}$/);
    expect(environment[reference.slice(2, -1)]).toBe(literal);
    expect(process.env[reference.slice(2, -1)]).toBeUndefined();
    expect(JSON.stringify(settings)).not.toContain(literal);
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
