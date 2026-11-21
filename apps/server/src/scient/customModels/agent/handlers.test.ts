import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  customModelAttachmentKey,
  type CustomModelSaveInput,
  type CustomModelsSettings,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  SecretRef,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../../config.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "../../../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProviderInstanceRegistry } from "../../../provider/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as CustomModelsHandlers from "./handlers.ts";
import { CustomModelsToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:custom-models");
const projectId = ProjectId.make("project:custom-models");
const KEY_REF = SecretRef.make("secret-ref:openrouter");

/** Agents report only manually limited models as ready, as Oh My Pi does for an unknown router. */
const provider = (
  instanceId: string,
  enabled: boolean,
  customModels: () => CustomModelsSettings,
): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: instanceId,
    enabled,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    get modelConnections() {
      return customModels().connections.flatMap((connection) =>
        connection.models.map((model) => ({
          connectionId: connection.id,
          modelId: model.id,
          configurationKey: customModelAttachmentKey(connection, model),
          ...(model.configurationMode === "manual"
            ? { state: "available" as const }
            : { state: "needs_setup" as const, reason: "model_unavailable" as const }),
        })),
      );
    },
  }) as unknown as ServerProvider;

it.effect("adds, limits and removes a custom model through the agent tools", () =>
  Effect.gen(function* () {
    let customModels: CustomModelsSettings = { revision: 0, connections: [] };
    const saved: CustomModelSaveInput[] = [];
    const consumed: string[] = [];
    const providers = [
      provider("omp", true, () => customModels),
      provider("droid", false, () => customModels),
    ];

    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment:custom-models"),
        requestNamespace: "provider:custom-models",
        thread: {
          threadId,
          providerSessionId: "provider:custom-models",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
      }),
      Layer.mock(ProviderSessionManagerV2)({
        resolveMcpInvocationPolicy: () =>
          Effect.succeedSome({
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
          }),
      }),
      Layer.mock(ServerSettingsService)({
        getSettings: Effect.sync(() => ({ ...DEFAULT_SERVER_SETTINGS, customModels })),
        committedCustomModels: () => customModels,
        saveCustomModel: (input) =>
          Effect.sync(() => {
            saved.push(input);
            const before = customModels.connections.find(
              (entry) => entry.id === input.connection.id,
            );
            const key = input.apiKey === undefined ? undefined : Redacted.value(input.apiKey);
            const connection = {
              ...input.connection,
              credentialId: key === undefined ? (before?.credentialId ?? null) : "credential-1",
              apiKeySuffix: key === undefined ? (before?.apiKeySuffix ?? null) : key.slice(-4),
            };
            customModels = {
              revision: customModels.revision + 1,
              connections: [
                ...customModels.connections.filter((entry) => entry.id !== connection.id),
                connection,
              ],
            };
            return customModels;
          }),
        removeCustomModel: (input) =>
          Effect.sync(() => {
            customModels = {
              revision: customModels.revision + 1,
              connections: customModels.connections.filter(
                (entry) => entry.id !== input.connectionId,
              ),
            };
            return customModels;
          }),
      }),
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
      Layer.mock(ProviderInstanceRegistry)({}),
      // The test action is not called here; nothing reads the server config.
      Layer.succeed(ServerConfig, {} as never),
      Layer.mock(SecretRequests)({
        consume: (input) =>
          Effect.sync(() => {
            consumed.push(`${input.ref}@${input.projectId}`);
            return " sk-or-test-9876 ";
          }),
      }),
      Layer.mock(ProjectionStoreV2)({
        getThreadShell: () => Effect.succeed({ projectId } as never),
      }),
    );

    yield* Effect.gen(function* () {
      const toolkit = yield* CustomModelsToolkit;
      const manage = (
        params: Parameters<typeof toolkit.handle<"scient_custom_models_manage">>[1],
      ) =>
        toolkit.handle("scient_custom_models_manage", params).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts) => parts.at(-1)?.result as never),
        );

      const added: { lines: string[]; connectionId: string } = yield* manage({
        action: "save",
        connection: {
          name: "OpenRouter",
          baseUrl: "https://openrouter.ai/api/v1",
          protocol: "openai-completions",
        },
        model: "openrouter/free",
        name: "OpenRouter Free",
        secretRef: KEY_REF,
      });
      // The key is read once, for this thread's project, and trimmed; only its last 4 characters show.
      expect(consumed).toEqual([`${KEY_REF}@${projectId}`]);
      expect(Redacted.value(saved[0]!.apiKey!)).toBe("sk-or-test-9876");
      expect(saved[0]!.refreshModelId).toBe(saved[0]!.connection.models[0]!.id);
      // Only enabled agents that can use custom models are connected by default.
      expect(saved[0]!.connection.models[0]).toMatchObject({
        modelId: "openrouter/free",
        configurationMode: "automatic",
        instanceIds: ["omp"],
      });
      expect(added.lines).toEqual([
        "Saved OpenRouter Free on OpenRouter.",
        "Oh My Pi: needs setup: this agent has no limits for the model; save it with contextWindow and maxOutputTokens.",
      ]);
      const connectionId = added.connectionId;
      const listed = yield* toolkit.handle("scient_custom_models", {}).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((parts) => parts.at(-1)?.result as never),
      );
      expect(listed).toMatchObject({
        agents: [
          { agent: "omp", name: "Oh My Pi", enabled: true },
          { agent: "droid", enabled: false },
        ],
        connections: [
          {
            connectionId,
            name: "OpenRouter",
            key: "saved, ends in 9876",
            models: [
              {
                model: "openrouter/free",
                limits: "automatic: unknown read, unknown per reply",
                agents: [{ agent: "omp", status: expect.stringMatching(/^needs setup/) }],
              },
            ],
          },
        ],
      });

      expect(
        yield* manage({
          action: "save",
          connectionId,
          model: "openrouter/free",
          contextWindow: 200000,
        }),
      ).toMatchObject({ code: "invalid_request" });

      const limited: { lines: string[] } = yield* manage({
        action: "save",
        connectionId,
        model: "openrouter/free",
        contextWindow: 200_000,
        maxOutputTokens: 16_384,
      });
      expect(saved[1]!.apiKey).toBeUndefined();
      expect(saved[1]!.connection.models).toHaveLength(1);
      expect(saved[1]!.connection.models[0]).toMatchObject({
        id: saved[0]!.connection.models[0]!.id,
        name: "OpenRouter Free",
        configurationMode: "manual",
        contextWindow: 200_000,
        maxOutputTokens: 16_384,
      });
      expect(limited.lines).toEqual(["Saved OpenRouter Free on OpenRouter.", "Oh My Pi: ready."]);

      expect(
        yield* manage({ action: "remove", connectionId, model: "openrouter/free" }),
      ).toMatchObject({ code: "invalid_request" });
      const removed: { lines: string[] } = yield* manage({
        action: "remove",
        connectionId,
        wholeConnection: true,
      });
      expect(removed.lines).toEqual(["Removed OpenRouter, its models and its key."]);
      expect(customModels.connections).toEqual([]);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(CustomModelsHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);
