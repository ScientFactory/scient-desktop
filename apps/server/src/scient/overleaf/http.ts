import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../../auth/http.ts";
import { OverleafSyncService } from "./OverleafSyncService.ts";

function handle<A>(
  endpointName: string,
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
  run: Effect.Effect<A, import("@t3tools/contracts").ScientOverleafOperationError>,
) {
  return Effect.gen(function* () {
    yield* annotateEnvironmentRequest(endpointName);
    yield* requireEnvironmentScope(scope);
    return yield* run;
  });
}

export const scientOverleafHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientOverleaf",
  Effect.fnUntraced(function* (handlers) {
    const overleaf = yield* OverleafSyncService;
    return handlers
      .handle("overview", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationReadScope,
          overleaf.overview(args.payload.workspaceRoot),
        ),
      )
      .handle("saveAccount", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationOperateScope,
          overleaf.saveAccount(args.payload),
        ),
      )
      .handle("removeAccount", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationOperateScope,
          overleaf.removeAccount(args.payload.accountId).pipe(Effect.as({ ok: true as const })),
        ),
      )
      .handle("preflightStart", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationOperateScope,
          overleaf.startPreflight(args.payload),
        ),
      )
      .handle("operationStatus", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationReadScope,
          overleaf.operationStatus(args.payload.operationId),
        ),
      )
      .handle("preflightComplete", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationOperateScope,
          overleaf.completePreflight(args.payload),
        ),
      )
      .handle("operationCancel", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationOperateScope,
          overleaf.cancelOperation(args.payload.operationId),
        ),
      )
      .handle("updateConnection", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationOperateScope,
          overleaf.updateConnection(args.payload),
        ),
      )
      .handle("syncStart", (args) =>
        handle(args.endpoint.name, AuthOrchestrationOperateScope, overleaf.startSync(args.payload)),
      )
      .handle("operationRetry", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationOperateScope,
          overleaf.retryOperation(args.payload.operationId),
        ),
      )
      .handle("confirmReview", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationOperateScope,
          overleaf.confirmReview(args.payload),
        ),
      )
      .handle("conflicts", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationReadScope,
          overleaf.conflicts(args.payload.operationId),
        ),
      )
      .handle("conflictDetail", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationReadScope,
          overleaf.conflictDetail(args.payload.operationId, args.payload.conflictId),
        ),
      )
      .handle("resolveConflict", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationOperateScope,
          overleaf.resolveConflict(args.payload),
        ),
      )
      .handle("continueOperation", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationOperateScope,
          overleaf.continueOperation(args.payload),
        ),
      )
      .handle("reconcileLocal", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationOperateScope,
          overleaf.reconcileLocal(args.payload.connectionId),
        ),
      )
      .handle("repair", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationOperateScope,
          overleaf.repair(args.payload.connectionId),
        ),
      )
      .handle("disconnect", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationOperateScope,
          overleaf.disconnect(args.payload),
        ),
      );
  }),
);
