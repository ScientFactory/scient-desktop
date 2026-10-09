import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceEnvironment, ProviderInstanceId } from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "@t3tools/provider-core/server/ProviderEventLoggers";
import { layerTestProviderHost } from "@t3tools/provider-testing/host";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import { AcpRegistryDriver } from "./AppProviderDriverComposition.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const decodeEnvironment = Schema.decodeSync(ProviderInstanceEnvironment);

it.effect(
  "publishes Scient guidance from the production ACP Registry composition without probing disabled agents",
  () =>
    Effect.gen(function* () {
      const instance = yield* AcpRegistryDriver.create({
        instanceId: ProviderInstanceId.make("acp-disabled-composition"),
        displayName: "Disabled ACP",
        accentColor: undefined,
        enabled: false,
        config: decodeSettings({ enabled: false }),
        environment: decodeEnvironment([]),
      });
      const snapshot = yield* instance.snapshot.getSnapshot;
      expect(snapshot).toMatchObject({
        enabled: false,
        status: "disabled",
        message: "ACP Registry is disabled in Scient settings.",
      });
      expect(instance.managedRuntimeActions).toBeDefined();
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerTestProviderHost({ runBackgroundWork: false }),
          ServerSettings.layerTest(),
          IdAllocator.layer,
          Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
          Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
            inspect: () => Effect.die("A disabled agent must not be inspected"),
            resolve: () => Effect.die("A disabled agent must not be installed"),
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);
