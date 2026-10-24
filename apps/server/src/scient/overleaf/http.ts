import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type EnvironmentInternalError,
  ScientOverleafOperationError,
  type ScientOverleafPublication,
  type ScientOverleafRefusal,
  type ScientOverleafSyncResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import type { OverleafPublication } from "./OverleafCoordinator.ts";
import { OverleafSync, type OverleafCaller, type OverleafSyncOutcome } from "./OverleafSync.ts";
import type { ConflictChoice } from "./syncRules.ts";

/**
 * Errors a person or agent can act on leave as a fixed reason with a plain
 * message (contract section 11). Anything else is an internal error, logged on
 * the server; Git's own text and the token never reach the client.
 */
type TaggedFailure = { readonly _tag: string; readonly message: string };

/** `OverleafOperationActiveError` → `operation-active`; a `reason` field wins when present. */
const operationError = (error: TaggedFailure) => {
  const ownReason = (error as { readonly reason?: unknown }).reason;
  const reason =
    typeof ownReason === "string"
      ? ownReason
      : error._tag
          .replace(/^Overleaf|Error$/gu, "")
          .replace(/[A-Z]/gu, (letter, index: number) =>
            index === 0 ? letter.toLowerCase() : `-${letter.toLowerCase()}`,
          );
  return new ScientOverleafOperationError({ reason, message: error.message });
};

const ACTIONABLE = new Set([
  "OverleafSyncRefusedError",
  "OverleafOperationActiveError",
  "OverleafConnectionNotReadyError",
  "OverleafRetainedLimitError",
  "CheckoutSuspendedError",
  "CheckoutRecoveryRequiredError",
  "OverleafStateLockedError",
  "OverleafConnectionStaleError",
  "OverleafConnectionUnavailableError",
  "OverleafRequestReusedError",
  "OverleafRetentionUnavailableError",
]);

const mapErrors = <A, E extends TaggedFailure, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catch(
      (error): Effect.Effect<never, ScientOverleafOperationError | EnvironmentInternalError> =>
        ACTIONABLE.has(error._tag)
          ? Effect.fail(operationError(error))
          : failEnvironmentInternal("scient_overleaf_operation_failed", error),
    ),
  );

const refusalView = (refusal: { readonly reason: string } & object): ScientOverleafRefusal => ({
  reason: refusal.reason,
  ...("path" in refusal && typeof refusal.path === "string" ? { path: refusal.path } : {}),
});

const publicationView = (publication: OverleafPublication): ScientOverleafPublication => ({
  _tag: publication._tag,
  ...("reason" in publication ? { reason: publication.reason } : {}),
  ...("attemptNumber" in publication ? { attemptNumber: publication.attemptNumber } : {}),
});

const syncView = (outcome: OverleafSyncOutcome): ScientOverleafSyncResult => {
  switch (outcome._tag) {
    case "synced":
      return {
        _tag: "synced",
        review: outcome.review,
        outcome: outcome.adopted.outcome,
        interrupted: outcome.adopted.interrupted.length,
        markerPaths: outcome.adopted.markerPaths,
        publication: publicationView(outcome.publication),
        retried: outcome.retried,
        activity: outcome.activity,
        linkedElsewhere: outcome.linkedElsewhere,
      };
    case "needs-decision":
      return outcome;
    case "refused":
      return { _tag: "refused", refusal: refusalView(outcome.refusal) };
    case "duplicate":
      return { _tag: "duplicate", category: outcome.receipt.resultCategory };
    case "unsettled":
    case "cancelled":
      return outcome;
  }
};

const choicesOf = (
  choices: ReadonlyArray<{ readonly key: string; readonly choice: ConflictChoice }> | undefined,
) =>
  choices === undefined ? undefined : new Map(choices.map((entry) => [entry.key, entry.choice]));

const workspace = (workspaceRoot: string): OverleafCaller => ({ _tag: "workspace", workspaceRoot });

/**
 * Overleaf sync over HTTP. Reading the token's presence, connections, status,
 * a preview and kept copies needs the read scope; connecting, syncing,
 * recovering, restoring, disconnecting, relinking and changing the token need
 * operate scope. The service resolves the workspace and checks the binding.
 */
export const scientOverleafHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientOverleaf",
  Effect.fnUntraced(function* (handlers) {
    const overleaf = yield* OverleafSync;
    return handlers
      .handle("tokenStatus", ({ endpoint }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* overleaf.tokenStatus;
        }),
      )
      .handle("saveToken", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* mapErrors(overleaf.saveToken(payload.token));
          return yield* overleaf.tokenStatus;
        }),
      )
      .handle("removeToken", ({ endpoint }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* mapErrors(overleaf.removeToken);
          return yield* overleaf.tokenStatus;
        }),
      )
      .handle("list", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const connections = yield* mapErrors(overleaf.list(workspace(payload.workspaceRoot)));
          return { connections };
        }),
      )
      .handle("connect", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const result = yield* mapErrors(
            overleaf.connect({
              caller: workspace(payload.workspaceRoot),
              folder: payload.folder,
              create: payload.create,
              project: payload.project,
              requestId: payload.requestId,
            }),
          );
          return result._tag === "connected"
            ? {
                _tag: "done" as const,
                connection: result.connection,
                reconnected: result.reconnected,
              }
            : result;
        }),
      )
      .handle("status", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* mapErrors(
            overleaf.status({
              caller: workspace(payload.workspaceRoot),
              connectionId: payload.connectionId,
            }),
          );
        }),
      )
      .handle("preview", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          // Preparing may finish an interrupted apply, which writes the folder.
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const choices = choicesOf(payload.choices);
          const result = yield* mapErrors(
            overleaf.preview({
              caller: workspace(payload.workspaceRoot),
              connectionId: payload.connectionId,
              ...(choices ? { choices } : {}),
            }),
          );
          switch (result._tag) {
            case "review":
              return result;
            case "refused":
              return { _tag: "refused" as const, refusal: refusalView(result.refusal) };
            case "recovered":
              return { _tag: "recovered" as const };
          }
        }),
      )
      .handle("sync", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const choices = choicesOf(payload.choices);
          const outcome = yield* mapErrors(
            overleaf.sync({
              caller: workspace(payload.workspaceRoot),
              connectionId: payload.connectionId,
              requestId: payload.requestId,
              ...(choices ? { choices } : {}),
            }),
          );
          return syncView(outcome);
        }),
      )
      .handle("recover", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const result = yield* mapErrors(
            overleaf.recover({
              caller: workspace(payload.workspaceRoot),
              connectionId: payload.connectionId,
            }),
          );
          return {
            recovered: result._tag === "recovered",
            accepted: result.attempts?.accepted ?? null,
            unresolved: result.attempts?.unresolved ?? null,
          };
        }),
      )
      .handle("keptCopies", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const copies = yield* mapErrors(
            overleaf.keptCopies({
              caller: workspace(payload.workspaceRoot),
              connectionId: payload.connectionId,
            }),
          );
          return { copies };
        }),
      )
      .handle("restoreKept", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const result = yield* mapErrors(
            overleaf.restoreKept({
              caller: workspace(payload.workspaceRoot),
              connectionId: payload.connectionId,
              requestId: payload.requestId,
              applyId: payload.applyId,
              kept: payload.kept,
              keptRevision: payload.keptRevision,
              currentRevision: payload.currentRevision,
            }),
          );
          return { _tag: result._tag };
        }),
      )
      .handle("disconnect", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* mapErrors(
            overleaf.disconnect({
              caller: workspace(payload.workspaceRoot),
              connectionId: payload.connectionId,
              requestId: payload.requestId,
            }),
          );
        }),
      )
      .handle("cancel", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* mapErrors(
            overleaf.cancel({
              caller: workspace(payload.workspaceRoot),
              connectionId: payload.connectionId,
            }),
          );
        }),
      )
      .handle("relink", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* mapErrors(
            overleaf.relink({
              caller: workspace(payload.workspaceRoot),
              connectionId: payload.connectionId,
              folder: payload.folder,
              requestId: payload.requestId,
            }),
          );
        }),
      );
  }),
);
