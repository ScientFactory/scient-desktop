import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../TextGeneration.ts";

/** Run caller-level metadata tests through the real instance/model resolver. */
export const makeNativeTextGeneration = (
  driver: "pi" | "omp",
  instanceId: ProviderInstanceId,
  overrides: Partial<TextGeneration.TextGeneration["Service"]>,
) => {
  const textGeneration = TextGeneration.TextGeneration.of({
    generateCommitMessage: () => Effect.die("Unexpected commit generation"),
    generatePrContent: () => Effect.die("Unexpected pull-request generation"),
    generateBranchName: () => Effect.die("Unexpected branch generation"),
    generateThreadTitle: () => Effect.die("Unexpected title generation"),
    ...overrides,
  });
  const instance: ProviderInstance = {
    instanceId,
    driverKind: ProviderDriverKind.make(driver),
    continuationIdentity: { driverKind: ProviderDriverKind.make(driver), continuationKey: "test" },
    displayName: undefined,
    enabled: true,
    snapshot: {
      resolveMaintenance: () => Effect.die("Automatic generation must not resolve maintenance"),
      refresh: Effect.die("Automatic generation must not launch discovery"),
      streamChanges: Stream.empty,
      applyUsageLimits: () => Effect.void,
      getSnapshot: Effect.succeed({
        instanceId,
        driver: ProviderDriverKind.make(driver),
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "unknown" },
        checkedAt: "2026-10-02T00:00:00.000Z",
        models: [
          {
            slug: "local/native",
            name: "Local",
            isCustom: false,
            capabilities: null,
            isDefault: true,
          },
        ],
        slashCommands: [],
        skills: [],
      }),
    },
    orchestrationAdapter: {
      instanceId,
      driver: ProviderDriverKind.make(driver),
      getCapabilities: () => Effect.die("Metadata generation must not use orchestration"),
      planSelectionTransition: () => Effect.die("Metadata generation must not switch sessions"),
      openSession: () => Effect.die("Metadata generation must not open an agent session"),
    },
    textGeneration,
  };
  return TextGeneration.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry)({
          getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
        }),
        Layer.mock(SourceControlProviderRegistry)({
          resolveLink: () => Effect.die("No source-control link expected"),
        }),
      ),
    ),
  );
};

/** No explicit metadata selection: only this native instance is enabled. */
export const nativeOnlySettings = (driver: "pi" | "omp", instanceId: ProviderInstanceId) => ({
  providers: Object.fromEntries(
    Object.keys(DEFAULT_SERVER_SETTINGS.providers).map((key) => [key, { enabled: false }]),
  ),
  providerInstances: {
    [instanceId]: { driver: ProviderDriverKind.make(driver), enabled: true },
  },
});
