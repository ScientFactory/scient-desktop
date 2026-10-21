import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type {
  ConnectorAddResult,
  ConnectorSummary,
  ConnectorTestResult,
  DiscoverEntry,
  EnvironmentId,
  GrantScope,
  ScientPluginSummary,
  ServerProvider,
  ServerProviderMcpServer,
  ServerProviderPlugin,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { AtomRegistry } from "effect/reactivity";
import { useContext, useState } from "react";

import { toastManager } from "../../components/ui/toast";
import { ensureLocalApi } from "../../localApi";
import { useAtomCommand } from "../../state/use-atom-command";
import { commandFailureMessage } from "./ExtensionsFeedback";
import { useExtensionsEnvironment } from "./ExtensionsPage";
import {
  actOnProviderPlugin,
  addConnector,
  type ExtensionItemOperation,
  extensionItemOperation,
  extensionItemOperationKey,
  removeConnector,
  removeScientPlugin,
  setScientPluginEnabled,
  startConnectorSignIn,
  testConnector,
  updateConnector,
} from "./extensionsState";
import { entryAddTarget, entryName, installableRemotes } from "./extensionsView";
import { openAuthorizationPage, type SignInOpening } from "./openAuthorizationPage";

/**
 * What one item's last action left to show. Nothing here predicts the server:
 * lists re-read after every change, and only failures and notices stay local.
 */
export interface ActionFeedbackState {
  readonly error: string | null;
  /** The sign-in page the browser refused to open; offered as a link. */
  readonly blockedSignInUrl: string | null;
}

/** What every item's actions share: one action at a time, and its outcome. */
export interface ItemActionsState {
  readonly busy: string | null;
  /** No permission to change settings, or another action of this item is running. */
  readonly locked: boolean;
  readonly feedback: ActionFeedbackState;
}

export interface ConnectorActionsState extends ItemActionsState {
  readonly testResult: ConnectorTestResult | null;
  readonly waitingForSignIn: boolean;
  readonly canSignIn: boolean;
  readonly signIn: () => Promise<void>;
  readonly test: () => Promise<void>;
  readonly setEnabled: (enabled: boolean) => Promise<unknown>;
  /** Sends the whole new scope; the list re-reads the server's answer. */
  readonly setAvailability: (availability: GrantScope) => Promise<unknown>;
  readonly remove: () => Promise<void>;
}

export interface PluginActionsState extends ItemActionsState {
  readonly setEnabled: (enabled: boolean) => Promise<unknown>;
  readonly remove: () => Promise<void>;
}

type OperationPatch = (patch: Partial<ExtensionItemOperation>) => void;

/** Writes one item's shared operation state, whichever component shows that item now. */
function operationPatch(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  item: string,
): OperationPatch {
  const atom = extensionItemOperation(extensionItemOperationKey(environmentId, item));
  return (patch) => registry.set(atom, { ...registry.get(atom), ...patch });
}

const connectorItem = (connectorId: string) => `connector:${connectorId}`;

/**
 * Records how opening a sign-in page ended. `startedAt` is the connector's
 * `updatedAt`, so its views can wait for the server to report a change; null
 * for sign-ins that no connector tracks.
 */
function finishSignIn(patch: OperationPatch, opening: SignInOpening, startedAt: string | null) {
  patch({
    blockedSignInUrl: opening.outcome === "blocked" ? opening.url : null,
    ...(opening.outcome === "not-started" || startedAt === null
      ? {}
      : { signInStartedAt: startedAt }),
  });
}

/**
 * One action at a time for `item` (a connector, entry or plugin key), with its
 * outcome. The state is shared per environment and item, so it survives the
 * component that started the action being replaced by another view of the
 * same item.
 */
function useActionLock(item: string) {
  const { environmentId, canWrite } = useExtensionsEnvironment();
  const registry = useContext(RegistryContext);
  const operation = useAtomValue(
    extensionItemOperation(extensionItemOperationKey(environmentId, item)),
  );
  const patch = operationPatch(registry, environmentId, item);
  const locked = !canWrite || operation.busy !== null;

  /** Runs one command for this item; the item unlocks whatever happens. */
  const run = async <A>(
    action: string,
    execute: () => Promise<AtomCommandResult<A, unknown>>,
  ): Promise<AtomCommandResult<A, unknown> | null> => {
    if (locked) return null;
    patch({ busy: action, error: null, blockedSignInUrl: null });
    // `Promise#finally`, not a `finally` block: React Compiler cannot compile
    // `try`/`finally`, and the item must unlock even on a defect.
    const result = await execute().finally(() => patch({ busy: null }));
    patch({ error: commandFailureMessage(result) });
    return result;
  };

  /**
   * Starts a sign-in whose URL `request` obtains. The page opens in the user's
   * browser, or its URL stays here as a link when the browser blocks it.
   */
  const signIn = async (
    action: string,
    request: () => Promise<string | null>,
    startedAt: string | null,
  ): Promise<SignInOpening["outcome"]> => {
    if (locked) return "not-started";
    patch({ busy: action, error: null, blockedSignInUrl: null });
    const opening = await openAuthorizationPage(request).finally(() => patch({ busy: null }));
    finishSignIn(patch, opening, startedAt);
    return opening.outcome;
  };

  return {
    busy: operation.busy,
    locked,
    feedback: {
      error: operation.error,
      blockedSignInUrl: operation.blockedSignInUrl,
    } satisfies ActionFeedbackState,
    signInStartedAt: operation.signInStartedAt,
    patch,
    setError: (error: string | null) => patch({ error }),
    run,
    signIn,
  };
}

async function confirmDestructive(message: string): Promise<boolean> {
  return ensureLocalApi().dialogs.confirm(message, { variant: "destructive" });
}

export function useConnectorActions(connector: ConnectorSummary): ConnectorActionsState {
  const { environmentId, callbackOrigin } = useExtensionsEnvironment();
  const connectorId = connector.connectorId;
  const lock = useActionLock(connectorItem(connectorId));
  const update = useAtomCommand(updateConnector, { reportFailure: true });
  const remove = useAtomCommand(removeConnector, { reportFailure: true });
  const test = useAtomCommand(testConnector, { reportFailure: true });
  const startSignIn = useAtomCommand(startConnectorSignIn, { reportFailure: true });
  const [testResult, setTestResult] = useState<ConnectorTestResult | null>(null);

  return {
    busy: lock.busy,
    locked: lock.locked,
    feedback: lock.feedback,
    testResult,
    /** Sign-in opened and the server has not reported a change since. */
    waitingForSignIn: lock.signInStartedAt !== null && lock.signInStartedAt === connector.updatedAt,
    canSignIn: !lock.locked && callbackOrigin !== null,
    signIn: async () => {
      if (callbackOrigin === null) return;
      await lock.signIn(
        "sign-in",
        async () => {
          const result = await startSignIn({
            environmentId,
            input: { connectorId, callbackOrigin },
          });
          lock.setError(commandFailureMessage(result));
          return result._tag === "Success" ? result.value.authorizationUrl : null;
        },
        connector.updatedAt,
      );
    },
    test: async () => {
      const result = await lock.run("test", () => test({ environmentId, input: { connectorId } }));
      setTestResult(result?._tag === "Success" ? result.value : null);
    },
    setEnabled: (enabled: boolean) =>
      lock.run("enable", () => update({ environmentId, input: { connectorId, enabled } })),
    setAvailability: (availability: GrantScope) =>
      lock.run("availability", () =>
        update({ environmentId, input: { connectorId, availability } }),
      ),
    remove: async () => {
      if (lock.locked) return;
      const confirmed = await confirmDestructive(
        `Remove ${connector.displayName}? Its stored sign-in or key is deleted and agents stop receiving it.`,
      );
      if (confirmed)
        await lock.run("remove", () => remove({ environmentId, input: { connectorId } }));
    },
  };
}

/**
 * Adds a registry or curated entry in one step, then starts sign-in when the
 * server asks for it. The sign-in belongs to the new connector: its row and
 * page replace this entry's as soon as the lists re-read, and they show the
 * sign-in's progress and outcome.
 */
export function useAddEntry(entry: DiscoverEntry) {
  const { environmentId, callbackOrigin } = useExtensionsEnvironment();
  const registry = useContext(RegistryContext);
  const lock = useActionLock(`entry:${entry.name}`);
  const add = useAtomCommand(addConnector, { reportFailure: true });
  const startSignIn = useAtomCommand(startConnectorSignIn, { reportFailure: true });
  const remote = installableRemotes(entry)[0];

  return {
    busy: lock.busy,
    locked: lock.locked,
    feedback: lock.feedback,
    canAdd: entry.installable && remote !== undefined,
    add: async () => {
      if (!entry.installable || remote === undefined || lock.locked) return;
      const addEntry = () =>
        add({
          environmentId,
          input: {
            target: entryAddTarget(entry, remote.url),
            displayName: entryName(entry),
            ...(entry.description?.trim()
              ? { description: entry.description.trim().slice(0, 1000) }
              : {}),
          },
        });
      const announceReady = (result: AtomCommandResult<ConnectorAddResult, unknown> | null) => {
        if (result?._tag === "Success" && result.value.nextStep === "ready") {
          toastManager.add({
            type: "success",
            title: `${result.value.connector.displayName} added`,
          });
        }
      };
      if (callbackOrigin === null) {
        announceReady(await lock.run("add", addEntry));
        return;
      }
      // The sign-in page is opened through `openAuthorizationPage` from this
      // click, so the web build reserves its tab before the add is awaited.
      const steps: {
        added: AtomCommandResult<ConnectorAddResult, unknown> | null;
        signIn: { readonly patch: OperationPatch; readonly startedAt: string } | null;
      } = { added: null, signIn: null };
      lock.patch({ busy: "add", error: null, blockedSignInUrl: null });
      const opening = await openAuthorizationPage(async () => {
        const added = await addEntry();
        steps.added = added;
        if (added._tag !== "Success" || added.value.nextStep === "ready") return null;
        const connector = added.value.connector;
        const patchConnector = operationPatch(
          registry,
          environmentId,
          connectorItem(connector.connectorId),
        );
        steps.signIn = { patch: patchConnector, startedAt: connector.updatedAt };
        patchConnector({ busy: "sign-in", error: null, blockedSignInUrl: null });
        const started = await startSignIn({
          environmentId,
          input: { connectorId: connector.connectorId, callbackOrigin },
        });
        patchConnector({ error: commandFailureMessage(started) });
        return started._tag === "Success" ? started.value.authorizationUrl : null;
      }).finally(() => {
        lock.patch({ busy: null });
        steps.signIn?.patch({ busy: null });
      });
      lock.patch({ error: steps.added === null ? null : commandFailureMessage(steps.added) });
      announceReady(steps.added);
      if (steps.signIn !== null) finishSignIn(steps.signIn.patch, opening, steps.signIn.startedAt);
    },
  };
}

export function usePluginActions(plugin: ScientPluginSummary): PluginActionsState {
  const { environmentId } = useExtensionsEnvironment();
  const lock = useActionLock(`plugin:${plugin.pluginId}`);
  const setEnabled = useAtomCommand(setScientPluginEnabled, { reportFailure: true });
  const remove = useAtomCommand(removeScientPlugin, { reportFailure: true });
  const pluginId = plugin.pluginId;
  return {
    ...lock,
    setEnabled: (enabled: boolean) =>
      lock.run("enable", () => setEnabled({ environmentId, input: { pluginId, enabled } })),
    remove: async () => {
      if (lock.locked) return;
      const confirmed = await confirmDestructive(
        `Remove ${plugin.displayName}? Its skills and connected services are removed too.`,
      );
      if (confirmed) await lock.run("remove", () => remove({ environmentId, input: { pluginId } }));
    },
  };
}

export function useProviderPluginActions(
  provider: ServerProvider,
  label: string,
  plugin: ServerProviderPlugin,
  workspace: string | undefined,
) {
  const { environmentId } = useExtensionsEnvironment();
  const lock = useActionLock(`provider-plugin:${provider.instanceId}:${plugin.id}`);
  const act = useAtomCommand(actOnProviderPlugin, { reportFailure: true });
  return {
    ...lock,
    uninstall: async () => {
      if (lock.locked || plugin.canUninstall !== true) return;
      const confirmed = await confirmDestructive(
        `Uninstall ${plugin.displayName ?? plugin.name} from ${label}?`,
      );
      if (!confirmed) return;
      await lock.run("uninstall", () =>
        act({
          environmentId,
          input: {
            instanceId: provider.instanceId,
            action: { type: "uninstall", pluginId: plugin.id },
            ...(workspace ? { cwd: workspace } : {}),
          },
        }),
      );
    },
  };
}

export function useProviderServerActions(
  provider: ServerProvider,
  label: string,
  server: ServerProviderMcpServer,
) {
  const { environmentId } = useExtensionsEnvironment();
  const lock = useActionLock(`provider-server:${provider.instanceId}:${server.name}`);
  const act = useAtomCommand(actOnProviderPlugin, { reportFailure: true });
  return {
    ...lock,
    signIn: () =>
      lock.signIn(
        "sign-in",
        async () => {
          const result = await act({
            environmentId,
            input: {
              instanceId: provider.instanceId,
              action: { type: "mcp-sign-in", serverName: server.name },
            },
          });
          lock.setError(commandFailureMessage(result));
          if (result._tag !== "Success") return null;
          if (!result.value.authorizationUrl) {
            toastManager.add({
              type: "info",
              title: `${label} started sign-in for ${server.name}`,
            });
          }
          return result.value.authorizationUrl ?? null;
        },
        null,
      ),
  };
}
