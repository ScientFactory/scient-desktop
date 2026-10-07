/**
 * Scient's provider connection and managed-runtime RPCs: the connection and
 * runtime handlers, the explicit managed-runtime refresh, and the redaction
 * that keeps authorization material from read-only clients.
 *
 * @module ProviderConnectionRpcHandlers
 */
import {
  AuthOrchestrationOperateScope,
  type ProviderConnectionOperation,
  type ProviderInstanceId,
  type ServerProvider,
  WS_METHODS,
  WsServerManagementRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import type * as ProviderInstanceRegistry from "../../provider/Services/ProviderInstanceRegistry.ts";
import type { ScientRpcHandlerSubset, ScientRpcObservers } from "../ScientRpcObservers.ts";
import * as ManagedRuntimeCatalog from "./ManagedRuntimeCatalog.ts";
import { reconcileManagedRuntimeProviders } from "./ManagedRuntimeCatalogReconciler.ts";
import type * as ProviderConnectionManager from "./ProviderConnectionManager.ts";
import type * as ProviderRuntimeManager from "./ProviderRuntimeManager.ts";

const hasAuthorizationMaterial = (
  operation: ProviderConnectionOperation | null | undefined,
): operation is ProviderConnectionOperation =>
  operation !== null &&
  operation !== undefined &&
  (operation.authorizationUrl !== undefined ||
    operation.userCode !== undefined ||
    operation.instructions !== undefined);

const withoutAuthorizationMaterial = (
  operation: ProviderConnectionOperation,
): ProviderConnectionOperation => {
  const redactedOperation = { ...operation };
  delete redactedOperation.authorizationUrl;
  delete redactedOperation.authorizationUrlKind;
  delete redactedOperation.userCode;
  // The provider's own wording can repeat the device code.
  delete redactedOperation.instructions;
  return redactedOperation;
};

const redactProviderAuthorizationForReadOnlyClient = (provider: ServerProvider): ServerProvider => {
  const connection = provider.connection;
  if (connection === undefined) return provider;
  const { operation, accountOperation } = connection;
  if (!hasAuthorizationMaterial(operation) && !hasAuthorizationMaterial(accountOperation)) {
    return provider;
  }
  return {
    ...provider,
    connection: {
      ...connection,
      ...(hasAuthorizationMaterial(operation)
        ? { operation: withoutAuthorizationMaterial(operation) }
        : {}),
      ...(hasAuthorizationMaterial(accountOperation)
        ? { accountOperation: withoutAuthorizationMaterial(accountOperation) }
        : {}),
    },
  };
};

/** Read-only sessions see providers without authorization material. */
export const providerProjectionForSession = (currentSession: {
  readonly scopes: EnvironmentAuth.AuthenticatedSession["scopes"];
}) =>
  currentSession.scopes.includes(AuthOrchestrationOperateScope)
    ? (providers: ReadonlyArray<ServerProvider>) => providers
    : (providers: ReadonlyArray<ServerProvider>) =>
        providers.map(redactProviderAuthorizationForReadOnlyClient);

/** The managed-runtime part of an explicit `serverRefreshProviders` request. */
export const refreshManagedRuntimes = (
  input: { readonly instanceId?: ProviderInstanceId | undefined },
  {
    providerInstances,
    providerRuntimeManager,
    managedRuntimeCatalog,
  }: {
    readonly providerInstances: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];
    readonly providerRuntimeManager: ProviderRuntimeManager.ProviderRuntimeManager["Service"];
    readonly managedRuntimeCatalog: ManagedRuntimeCatalog.ManagedRuntimeCatalogService;
  },
) =>
  Effect.gen(function* () {
    // An explicit runtime refresh re-checks a runtime that fell back
    // after a failed check; switching back waits for running work.
    const reselectInstances = yield* providerInstances.listInstances;
    yield* Effect.forEach(
      reselectInstances.filter(
        (instance) => input.instanceId === undefined || input.instanceId === instance.instanceId,
      ),
      (instance) => providerRuntimeManager.reselect(instance.instanceId).pipe(Effect.forkDetach),
      { discard: true },
    );
    const before = yield* managedRuntimeCatalog.current;
    const after = yield* managedRuntimeCatalog.refreshNow;
    const changedProviders = ManagedRuntimeCatalog.changedManagedRuntimeProviders(before, after);
    if (changedProviders.length > 0) {
      // Refresh publishes an async event for the process
      // reconciler. Reconcile here too so this explicit RPC
      // returns new actions without a UI race.
      yield* reconcileManagedRuntimeProviders(changedProviders);
    }
  });

export const makeProviderConnectionRpcHandlers = ({
  observeRpcEffect,
  providerConnectionManager,
  providerRuntimeManager,
}: Pick<ScientRpcObservers, "observeRpcEffect"> & {
  readonly providerConnectionManager: ProviderConnectionManager.ProviderConnectionManager["Service"];
  readonly providerRuntimeManager: ProviderRuntimeManager.ProviderRuntimeManager["Service"];
}) =>
  ({
    [WS_METHODS.serverStartProviderConnection]: (input) =>
      observeRpcEffect(
        WS_METHODS.serverStartProviderConnection,
        providerConnectionManager.start(input),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverCancelProviderConnection]: (input) =>
      observeRpcEffect(
        WS_METHODS.serverCancelProviderConnection,
        providerConnectionManager.cancel(input),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverSubmitProviderAuthorizationCode]: (input) =>
      observeRpcEffect(
        WS_METHODS.serverSubmitProviderAuthorizationCode,
        providerConnectionManager.submitAuthorizationCode(input),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverDisconnectProvider]: (input) =>
      observeRpcEffect(
        WS_METHODS.serverDisconnectProvider,
        providerConnectionManager.disconnect(input),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverPlanProviderRuntime]: (input) =>
      observeRpcEffect(WS_METHODS.serverPlanProviderRuntime, providerRuntimeManager.plan(input), {
        "rpc.aggregate": "server",
      }),
    [WS_METHODS.serverStartProviderRuntime]: (input) =>
      observeRpcEffect(WS_METHODS.serverStartProviderRuntime, providerRuntimeManager.start(input), {
        "rpc.aggregate": "server",
      }),
    [WS_METHODS.serverCancelProviderRuntime]: (input) =>
      observeRpcEffect(
        WS_METHODS.serverCancelProviderRuntime,
        providerRuntimeManager.cancel(input),
        { "rpc.aggregate": "server" },
      ),
  }) satisfies ScientRpcHandlerSubset<
    typeof WsServerManagementRpcGroup,
    | typeof WS_METHODS.serverStartProviderConnection
    | typeof WS_METHODS.serverCancelProviderConnection
    | typeof WS_METHODS.serverSubmitProviderAuthorizationCode
    | typeof WS_METHODS.serverDisconnectProvider
    | typeof WS_METHODS.serverPlanProviderRuntime
    | typeof WS_METHODS.serverStartProviderRuntime
    | typeof WS_METHODS.serverCancelProviderRuntime
  >;
