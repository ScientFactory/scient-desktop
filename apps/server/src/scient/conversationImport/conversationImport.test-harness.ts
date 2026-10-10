/** Reuse the native import fixtures; execution services exist only for history controls. */
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layer as OrchestrationCommandReceiptRepositoryLive } from "../../persistence/OrchestrationCommandReceipts.ts";

import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  createNativeProjects,
  nativeImportTestLayer,
  nativeImportRuntimeTestLayer,
  type NativeImportTestControls,
} from "./conversationImport.native-test-harness.ts";
import { PROVIDER_ID } from "./conversationImport.test-fixtures.ts";

export type ImportTestControls = NativeImportTestControls;

export const importTestLayer = (controls: ImportTestControls = {}) =>
  OrchestrationCommandReceiptRepositoryLive.pipe(
    Layer.provideMerge(nativeImportTestLayer(controls)),
  );

/** Only history cases construct execution services; no provider or worker runs. */
export function importHistoryTestLayer() {
  const adapter = {
    instanceId: PROVIDER_ID,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Import history fixture must never execute a provider"),
  };
  return nativeImportRuntimeTestLayer(
    ProviderAdapterRegistry.layerFromAdapters([
      adapter,
      {
        ...adapter,
        instanceId: ProviderInstanceId.make("claude"),
        driver: ProviderDriverKind.make("claude"),
        getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
      },
    ]),
    { runEffectWorker: false },
  );
}

export const createProjects = createNativeProjects;
