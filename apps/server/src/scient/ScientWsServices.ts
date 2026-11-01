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
import * as DataTables from "./data/DataTables.ts";
import * as NotebookStore from "./notebook/NotebookStore.ts";
import { ScientificRuntimePreferences } from "./compute/ScientificRuntimePreferences.ts";
import { ConversationExportService } from "./conversationExport/ConversationExportService.ts";
import { EditorFlush } from "./editorFlush/EditorFlush.ts";
import * as ProviderConnectionManager from "./providerLifecycle/ProviderConnectionManager.ts";
import * as ProviderLifecycleCoordinator from "./providerLifecycle/ProviderLifecycleCoordinator.ts";
import * as ProviderRuntimeManager from "./providerLifecycle/ProviderRuntimeManager.ts";

// SCIENT-FORK:START — Scient Accounts: capture the shared owner for each client connection.
import { AccountsService } from "./accounts/AccountsService.ts";
import { accountsForRpc } from "./accounts/AccountsRpcHandlers.ts";
// SCIENT-FORK:END

export const captureScientWsServices = Effect.gen(function* () {
  // SCIENT-FORK:START — Scient Accounts: preserve one owner across WebSocket connections.
  const accounts = yield* accountsForRpc;
  // SCIENT-FORK:END
  const analysis = yield* AnalysisService.AnalysisService;
  const compute = yield* ComputeSessionService.ComputeSessionService;
  const dataTables = yield* DataTables.DataTables;
  const notebooks = yield* NotebookStore.NotebookStore;
  const runtimePreferences = yield* ScientificRuntimePreferences;
  const conversationExports = yield* ConversationExportService;
  const editorFlush = yield* EditorFlush;
  const providerConnectionManager = yield* ProviderConnectionManager.ProviderConnectionManager;
  const providerLifecycleCoordinator =
    yield* ProviderLifecycleCoordinator.ProviderLifecycleCoordinator;
  const providerRuntimeManager = yield* ProviderRuntimeManager.ProviderRuntimeManager;
  return Layer.mergeAll(
    // SCIENT-FORK:START — Scient Accounts: reuse the captured owner.
    Layer.succeed(AccountsService, accounts),
    // SCIENT-FORK:END
    Layer.succeed(
      ProviderLifecycleCoordinator.ProviderLifecycleCoordinator,
      providerLifecycleCoordinator,
    ),
    Layer.succeed(ProviderConnectionManager.ProviderConnectionManager, providerConnectionManager),
    Layer.succeed(ProviderRuntimeManager.ProviderRuntimeManager, providerRuntimeManager),
    Layer.succeed(AnalysisService.AnalysisService, analysis),
    Layer.succeed(ComputeSessionService.ComputeSessionService, compute),
    Layer.succeed(DataTables.DataTables, dataTables),
    Layer.succeed(NotebookStore.NotebookStore, notebooks),
    Layer.succeed(ScientificRuntimePreferences, runtimePreferences),
    Layer.succeed(ConversationExportService, conversationExports),
    Layer.succeed(EditorFlush, editorFlush),
  );
});
