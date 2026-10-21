import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../../connection/runtime";

/**
 * Extensions state for one atom runtime. Queries re-read on every event of the
 * one revision feed (connectors, Scient plugins, delivery receipts), so the UI
 * only ever shows what the server committed.
 */
export function createExtensionsAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const changes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:extensions:changes",
    tag: WS_METHODS.extensionsSubscribeChanges,
  });
  const changesOf = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    changes({ environmentId, input: {} });

  /** Connectors (with where each is available), Scient plugins and agent support. */
  const inventory = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:extensions:list",
    tag: WS_METHODS.extensionsList,
    staleTimeMs: 30_000,
    idleTtlMs: 60_000,
    refreshTrigger: changesOf,
  });

  const refreshInventory = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.refresh(inventory({ environmentId, input: {} })));

  /**
   * Every change to connectors and Scient plugins of one
   * environment runs in order, across commands: they share one scheduler.
   */
  const mutationLane = {
    scheduler: createAtomCommandScheduler(),
    concurrency: {
      mode: "serial",
      key: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
        `extensions:${environmentId}`,
    },
    onSuccess: refreshInventory,
  } as const;

  const perConnector = {
    mode: "singleFlight",
    key: ({
      environmentId,
      input,
    }: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly connectorId: string };
    }) => JSON.stringify([environmentId, input.connectorId]),
  } as const;

  return {
    changes,
    inventory,
    deliveryReceipt: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:extensions:delivery-receipt",
      tag: WS_METHODS.extensionsDeliveryReceipt,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
      refreshTrigger: changesOf,
    }),
    /** Curated home-page sections; `installedConnectorId` follows the change feed. */
    discoverCatalog: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:extensions:discover-catalog",
      tag: WS_METHODS.extensionsDiscoverCatalog,
      staleTimeMs: 10 * 60_000,
      idleTtlMs: 10 * 60_000,
      refreshTrigger: changesOf,
    }),
    /** One curated or registry entry by exact name, whether or not any preview lists it. */
    discoverEntry: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:extensions:discover-entry",
      tag: WS_METHODS.extensionsDiscoverEntry,
      staleTimeMs: 10 * 60_000,
      idleTtlMs: 10 * 60_000,
      refreshTrigger: changesOf,
    }),
    /** One registry page per `{ query, category, cursor }`; the server caches registry reads. */
    discoverPage: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:extensions:discover",
      tag: WS_METHODS.extensionsDiscoverSearch,
      staleTimeMs: 10 * 60_000,
      idleTtlMs: 10 * 60_000,
      refreshTrigger: changesOf,
    }),
    addConnector: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:extensions:add-connector",
      tag: WS_METHODS.extensionsConnectorAdd,
      ...mutationLane,
    }),
    updateConnector: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:extensions:update-connector",
      tag: WS_METHODS.extensionsConnectorUpdate,
      ...mutationLane,
    }),
    removeConnector: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:extensions:remove-connector",
      tag: WS_METHODS.extensionsConnectorRemove,
      ...mutationLane,
    }),
    installScientPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:extensions:install-plugin",
      tag: WS_METHODS.extensionsPluginInstall,
      ...mutationLane,
    }),
    removeScientPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:extensions:remove-plugin",
      tag: WS_METHODS.extensionsPluginRemove,
      ...mutationLane,
    }),
    setScientPluginEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:extensions:set-plugin-enabled",
      tag: WS_METHODS.extensionsPluginSetEnabled,
      ...mutationLane,
    }),
    /** Starting sign-in or a test changes nothing until the server reports it. */
    startConnectorSignIn: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:extensions:start-connector-sign-in",
      tag: WS_METHODS.extensionsConnectorStartSignIn,
      concurrency: perConnector,
    }),
    testConnector: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:extensions:test-connector",
      tag: WS_METHODS.extensionsConnectorTest,
      concurrency: perConnector,
      onSuccess: refreshInventory,
    }),
    /** Provider snapshots carry the result; the server pushes them to every client. */
    actOnProviderPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:provider-plugins:act",
      tag: WS_METHODS.providerPluginsAct,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.instanceId]),
      },
    }),
  };
}

/**
 * The running action of one item and what it left to show. It lives outside
 * the item's component because a successful add replaces the entry's row with
 * its connector's row while that connector's sign-in is still opening.
 */
export interface ExtensionItemOperation {
  readonly busy: string | null;
  readonly error: string | null;
  /** The sign-in page the browser refused to open; offered as a link. */
  readonly blockedSignInUrl: string | null;
  /** The connector's `updatedAt` when its sign-in page opened. */
  readonly signInStartedAt: string | null;
}

export const IDLE_EXTENSION_ITEM_OPERATION: ExtensionItemOperation = {
  busy: null,
  error: null,
  blockedSignInUrl: null,
  signInStartedAt: null,
};

/** Keyed by `extensionItemOperationKey`; one per environment and item. */
export const extensionItemOperation = Atom.family((key: string) =>
  Atom.make<ExtensionItemOperation>(IDLE_EXTENSION_ITEM_OPERATION).pipe(
    Atom.keepAlive,
    Atom.withLabel(`extensions:item-operation:${key}`),
  ),
);

export function extensionItemOperationKey(environmentId: EnvironmentId, item: string): string {
  return JSON.stringify([environmentId, item]);
}

const extensionsAtoms = createExtensionsAtoms(connectionAtomRuntime);

export const extensionsChanges = extensionsAtoms.changes;
export const extensionsInventory = extensionsAtoms.inventory;
export const extensionsDeliveryReceipt = extensionsAtoms.deliveryReceipt;
export const extensionsDiscoverCatalog = extensionsAtoms.discoverCatalog;
export const extensionsDiscoverEntry = extensionsAtoms.discoverEntry;
export const extensionsDiscoverPage = extensionsAtoms.discoverPage;
export const addConnector = extensionsAtoms.addConnector;
export const updateConnector = extensionsAtoms.updateConnector;
export const removeConnector = extensionsAtoms.removeConnector;
export const installScientPlugin = extensionsAtoms.installScientPlugin;
export const removeScientPlugin = extensionsAtoms.removeScientPlugin;
export const setScientPluginEnabled = extensionsAtoms.setScientPluginEnabled;
export const startConnectorSignIn = extensionsAtoms.startConnectorSignIn;
export const testConnector = extensionsAtoms.testConnector;
export const actOnProviderPlugin = extensionsAtoms.actOnProviderPlugin;
