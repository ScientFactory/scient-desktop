/**
 * The server-lifetime Scient services that every WebSocket connection's RPC
 * layer is built with. ws.ts captures them once for the route and provides
 * them to each connection, so all clients share the same instances.
 *
 * @module ScientWsServices
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AnalysisService from "./analysis/AnalysisService.ts";
import * as ComputeSessionService from "./compute/ComputeSessionService.ts";
import { ScientificRuntimePreferences } from "./compute/ScientificRuntimePreferences.ts";
import { ConversationExportService } from "./conversationExport/ConversationExportService.ts";
import * as ProviderConnectionManager from "./providerLifecycle/ProviderConnectionManager.ts";
import * as ProviderLifecycleCoordinator from "./providerLifecycle/ProviderLifecycleCoordinator.ts";
import * as ProviderRuntimeManager from "./providerLifecycle/ProviderRuntimeManager.ts";

export const captureScientWsServices = Effect.gen(function* () {
  const analysis = yield* AnalysisService.AnalysisService;
  const compute = yield* ComputeSessionService.ComputeSessionService;
  const runtimePreferences = yield* ScientificRuntimePreferences;
  const conversationExports = yield* ConversationExportService;
  const providerConnectionManager = yield* ProviderConnectionManager.ProviderConnectionManager;
  const providerLifecycleCoordinator =
    yield* ProviderLifecycleCoordinator.ProviderLifecycleCoordinator;
  const providerRuntimeManager = yield* ProviderRuntimeManager.ProviderRuntimeManager;
  return Layer.mergeAll(
    Layer.succeed(
      ProviderLifecycleCoordinator.ProviderLifecycleCoordinator,
      providerLifecycleCoordinator,
    ),
    Layer.succeed(ProviderConnectionManager.ProviderConnectionManager, providerConnectionManager),
    Layer.succeed(ProviderRuntimeManager.ProviderRuntimeManager, providerRuntimeManager),
    Layer.succeed(AnalysisService.AnalysisService, analysis),
    Layer.succeed(ComputeSessionService.ComputeSessionService, compute),
    Layer.succeed(ScientificRuntimePreferences, runtimePreferences),
    Layer.succeed(ConversationExportService, conversationExports),
  );
});
