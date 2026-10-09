import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import { CursorAgentSdkRunner } from "@t3tools/provider-cursor/server/CursorAgentSdk";
import type { CursorDriverEnv } from "@t3tools/provider-cursor/server";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";

import * as ServerConfig from "../../config.ts";
import * as ManagedRuntimeCatalog from "../../scient/providerLifecycle/ManagedRuntimeCatalog.ts";
import { CursorDriver, type CursorDriverCompositionEnv } from "./CursorDriverComposition.ts";
import { makeProviderInstanceRegistry } from "../ProviderInstanceRegistry.ts";
import { layerTestProviderHost } from "@t3tools/provider-testing/host";

const instanceId = ProviderInstanceId.make("cursor-scient-composition");
const noApiKeyId = ProviderInstanceId.make("cursor-no-api-key");
const legacyTokenId = ProviderInstanceId.make("cursor-legacy-token");
const apiKeyId = ProviderInstanceId.make("cursor-api-key");

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-cursor-composition-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  layerTestProviderHost({ runBackgroundWork: false }).pipe(Layer.provide(NodeServices.layer)),
  ManagedRuntimeCatalog.layerTest,
  IdAllocator.layer,
  Layer.succeed(CursorAgentSdkRunner, {
    assertComplete: Effect.void,
    open: () => Effect.die("This registry composition test must not open a Cursor session"),
  }),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("Disabled Cursor must not make an HTTP request")),
  ),
);

it.layer(testLayer)("CursorDriver app composition", (it) => {
  it.effect("registers Scient runtime actions and decorates the live registry snapshot", () =>
    Effect.gen(function* () {
      const configMap: ProviderInstanceConfigMap = {
        [instanceId]: {
          driver: ProviderDriverKind.make("cursor"),
          displayName: "Cursor account",
          enabled: true,
          environment: [{ name: "CURSOR_API_KEY", value: "", sensitive: true }],
          config: CursorDriver.defaultConfig(),
        },
      };
      const { registry } = yield* makeProviderInstanceRegistry<
        CursorDriverEnv | CursorDriverCompositionEnv
      >({
        drivers: [CursorDriver],
        configMap,
      });

      const instance = yield* registry.getInstance(instanceId);
      expect(instance).toBeDefined();
      expect(instance?.managedRuntimeActions).toBeDefined();
      expect(instance?.connectionActions?.methods).toEqual(["cursor_browser"]);

      const snapshot = yield* instance!.snapshot.getSnapshot;
      expect(snapshot.connection?.runtime).toBeDefined();
      expect(snapshot.connection?.methods).toEqual(["cursor_browser"]);
      expect(snapshot.connection?.canDisconnect).toBe(false);
      expect(Array.isArray(snapshot.connection?.runtime?.actions)).toBe(true);
      expect(snapshot.connection?.runtime?.source).toBeDefined();
    }).pipe(Effect.scoped),
  );

  it.effect("offers browser sign-in unless an explicit API key is configured", () =>
    Effect.gen(function* () {
      const makeEntry = (environment: ReadonlyArray<{ name: string; value: string }>) => ({
        driver: ProviderDriverKind.make("cursor"),
        enabled: true,
        environment: environment.map(({ name, value }) => ({ name, value, sensitive: true })),
        config: CursorDriver.defaultConfig(),
      });
      const configMap: ProviderInstanceConfigMap = {
        [noApiKeyId]: makeEntry([{ name: "CURSOR_API_KEY", value: "" }]),
        [legacyTokenId]: makeEntry([
          { name: "CURSOR_API_KEY", value: "  " },
          { name: "CURSOR_AUTH_TOKEN", value: "legacy-token" },
        ]),
        [apiKeyId]: makeEntry([{ name: "CURSOR_API_KEY", value: "explicit-api-key" }]),
      };
      const { registry } = yield* makeProviderInstanceRegistry<
        CursorDriverEnv | CursorDriverCompositionEnv
      >({
        drivers: [CursorDriver],
        configMap,
      });

      const instanceFor = (id: ProviderInstanceId) =>
        Effect.gen(function* () {
          const instance = yield* registry.getInstance(id);
          expect(instance).toBeDefined();
          return instance!;
        });
      const snapshotFor = (id: ProviderInstanceId) =>
        Effect.gen(function* () {
          const instance = yield* instanceFor(id);
          return yield* instance.snapshot.getSnapshot;
        });

      const withoutApiKey = yield* snapshotFor(noApiKeyId);
      const withLegacyToken = yield* snapshotFor(legacyTokenId);
      const withApiKey = yield* snapshotFor(apiKeyId);
      const withoutApiKeyInstance = yield* instanceFor(noApiKeyId);
      const withLegacyTokenInstance = yield* instanceFor(legacyTokenId);
      const withApiKeyInstance = yield* instanceFor(apiKeyId);

      expect(withoutApiKey.connection?.methods).toEqual(["cursor_browser"]);
      expect(withoutApiKey.setup?.canAuthenticate).toBe(true);
      expect(withoutApiKeyInstance.connectionActions?.methods).toEqual(["cursor_browser"]);
      expect(withLegacyToken.connection?.methods).toEqual(["cursor_browser"]);
      expect(withLegacyToken.setup?.canAuthenticate).toBe(true);
      expect(withLegacyTokenInstance.connectionActions?.methods).toEqual(["cursor_browser"]);
      expect(withApiKey.connection?.methods).toEqual([]);
      expect(withApiKey.setup?.canAuthenticate).toBe(false);
      expect(withApiKeyInstance.connectionActions).toBeUndefined();
    }).pipe(Effect.scoped),
  );
});
