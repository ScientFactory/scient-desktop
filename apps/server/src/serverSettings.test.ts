import * as NodeServices from "@effect/platform-node/NodeServices";
import path from "node:path";
import { DEFAULT_GIT_TEXT_GENERATION_MODEL, DEFAULT_MODEL_BY_PROVIDER } from "@synara/contracts";
import { Effect, FileSystem, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "./config";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-settings-test-",
}).pipe(Layer.provide(NodeServices.layer));
const makeTestLayer = Layer.merge(NodeServices.layer, serverConfigLayer);
const testLayer = Layer.merge(makeTestLayer, ServerSettingsLive.pipe(Layer.provide(makeTestLayer)));

const runWithSettings = <A, E>(
  effect: Effect.Effect<A, E, ServerSettingsService | ServerConfig | FileSystem.FileSystem>,
) => Effect.runPromise(effect.pipe(Effect.provide(testLayer)) as Effect.Effect<A, E, never>);

describe("ServerSettingsService", () => {
  it("loads defaults when settings file does not exist", async () => {
    const settings = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        yield* service.start;
        return yield* service.getSettings;
      }),
    );

    expect(settings.providers.codex.binaryPath).toBe("codex");
    expect(settings.providers.grok.binaryPath).toBe("grok");
    expect(settings.defaultThreadEnvMode).toBe("local");
    expect(settings.enableProviderUpdateChecks).toBe(true);
    expect(settings.telemetryPrivacyLevel).toBe("essential");
    expect(settings.textGenerationModelSelection).toEqual({
      provider: "codex",
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
    });
  });

  it("persists updates and reloads them", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* service.start;

        const updated = yield* service.updateSettings({
          telemetryPrivacyLevel: "product",
          enableAssistantStreaming: true,
          enableProviderUpdateChecks: false,
          providers: {
            codex: {
              binaryPath: "/usr/local/bin/codex",
              customModels: ["gpt-custom"],
            },
          },
        });
        const raw = yield* fs.readFileString(settingsPath);
        return { updated, parsed: JSON.parse(raw) as unknown };
      }),
    );

    expect(result.updated.enableAssistantStreaming).toBe(true);
    expect(result.updated.telemetryPrivacyLevel).toBe("product");
    expect(result.updated.enableProviderUpdateChecks).toBe(false);
    expect(result.updated.providers.codex.binaryPath).toBe("/usr/local/bin/codex");
    expect(result.parsed).toMatchObject({
      telemetryPrivacyLevel: "product",
      enableAssistantStreaming: true,
      enableProviderUpdateChecks: false,
      providers: {
        codex: {
          binaryPath: "/usr/local/bin/codex",
          customModels: ["gpt-custom"],
        },
      },
    });
  });

  it("migrates a persisted Gemini text-generation selection without discarding settings", async () => {
    const settings = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(path.dirname(settingsPath), { recursive: true });
        yield* fs.writeFileString(
          settingsPath,
          `${JSON.stringify({
            enableProviderUpdateChecks: false,
            textGenerationModelSelection: {
              provider: "gemini",
              model: "gemini-3.1-pro-preview",
            },
            providers: {
              codex: { binaryPath: "/custom/codex" },
            },
          })}\n`,
        );

        yield* service.start;
        return yield* service.getSettings;
      }),
    );

    expect(settings.textGenerationModelSelection).toEqual({
      provider: "antigravity",
      model: "Gemini 3.1 Pro",
    });
    expect(settings.enableProviderUpdateChecks).toBe(false);
    expect(settings.providers.codex.binaryPath).toBe("/custom/codex");
  });

  it("preserves a disabled legacy Gemini provider as disabled Antigravity", async () => {
    const settings = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(path.dirname(settingsPath), { recursive: true });
        yield* fs.writeFileString(
          settingsPath,
          `${JSON.stringify({
            textGenerationModelSelection: {
              provider: "gemini",
              model: "gemini-3.1-pro-preview",
            },
            providers: {
              gemini: { enabled: false, binaryPath: "/legacy/gemini" },
              codex: { binaryPath: "/custom/codex" },
            },
          })}\n`,
        );

        yield* service.start;
        return yield* service.getSettings;
      }),
    );

    expect(settings.providers.antigravity.enabled).toBe(false);
    expect(settings.providers.antigravity.binaryPath).toBe("agy");
    expect(settings.textGenerationModelSelection.provider).toBe("codex");
    expect(settings.providers.codex.binaryPath).toBe("/custom/codex");
  });

  it("resolves text generation selection away from disabled providers", async () => {
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        return yield* service.getSettings;
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            textGenerationModelSelection: {
              provider: "antigravity",
              model: DEFAULT_MODEL_BY_PROVIDER.antigravity,
            },
            providers: {
              antigravity: { enabled: false },
            },
          }),
        ),
      ),
    );

    expect(settings.textGenerationModelSelection.provider).toBe("codex");
    expect(settings.textGenerationModelSelection.model).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("advances only the changed provider's revision counter", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        yield* service.start;

        const initial = yield* service.getSnapshot;

        yield* service.updateSettings({ providers: { kilo: { binaryPath: "/custom/kilo" } } });
        const afterKilo = yield* service.getSnapshot;

        yield* service.updateSettings({ providers: { codex: { binaryPath: "/custom/codex" } } });
        const afterCodex = yield* service.getSnapshot;

        // Rewriting kilo with its current value is a no-op for its fingerprint.
        yield* service.updateSettings({ providers: { kilo: { binaryPath: "/custom/kilo" } } });
        const afterNoop = yield* service.getSnapshot;

        return { initial, afterKilo, afterCodex, afterNoop };
      }),
    );

    // Every provider starts at revision 0.
    expect(result.initial.providerRevisions.get("kilo")).toBe(0);
    expect(result.initial.providerRevisions.get("codex")).toBe(0);
    expect(result.initial.providerRevisions.get("grok")).toBe(0);

    // Changing kilo advances only kilo.
    expect(result.afterKilo.providerRevisions.get("kilo")).toBe(1);
    expect(result.afterKilo.providerRevisions.get("codex")).toBe(0);
    expect(result.afterKilo.providerRevisions.get("grok")).toBe(0);

    // Changing codex advances only codex; kilo stays put (per-provider isolation).
    expect(result.afterCodex.providerRevisions.get("kilo")).toBe(1);
    expect(result.afterCodex.providerRevisions.get("codex")).toBe(1);
    expect(result.afterCodex.providerRevisions.get("grok")).toBe(0);

    // A no-op write advances nothing.
    expect(result.afterNoop.providerRevisions.get("kilo")).toBe(1);
    expect(result.afterNoop.providerRevisions.get("codex")).toBe(1);
  });

  it("advances every provider's revision when the global update-check flag changes", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        yield* service.start;

        const initial = yield* service.getSnapshot;
        // enableProviderUpdateChecks is folded into every provider's fingerprint,
        // so toggling it invalidates every provider's confirmed-update authority.
        yield* service.updateSettings({ enableProviderUpdateChecks: false });
        const afterToggle = yield* service.getSnapshot;

        return { initial, afterToggle };
      }),
    );

    // Guard against a vacuously-passing loop over an empty map.
    expect(result.initial.providerRevisions.size).toBeGreaterThan(0);
    for (const provider of result.initial.providerRevisions.keys()) {
      expect(result.initial.providerRevisions.get(provider)).toBe(0);
      expect(result.afterToggle.providerRevisions.get(provider)).toBe(1);
    }
  });
});
