import type {
  ConnectorSummary,
  ConnectorTestResult,
  DiscoverEntry,
  GrantScope,
  ScientPluginSummary,
  ServerProvider,
  ServerProviderMcpServer,
  ServerProviderPlugin,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { toastManager } from "../../components/ui/toast";
import { ensureLocalApi } from "../../localApi";
import { useAtomCommand } from "../../state/use-atom-command";
import { commandFailureMessage } from "./ExtensionsFeedback";
import { useExtensionsEnvironment } from "./ExtensionsPage";
import {
  actOnProviderPlugin,
  addConnector,
  removeConnector,
  removeScientPlugin,
  setScientPluginEnabled,
  startConnectorSignIn,
  testConnector,
  updateConnector,
} from "./extensionsState";
import { entryAddTarget, entryName, installableRemotes } from "./extensionsView";
import { openAuthorizationPage } from "./openAuthorizationPage";

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

function useActionLock() {
  const { canWrite } = useExtensionsEnvironment();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blockedSignInUrl, setBlockedSignInUrl] = useState<string | null>(null);
  const locked = !canWrite || busy !== null;

  /** Runs one command for this item; the item unlocks whatever happens. */
  const run = async <A>(
    action: string,
    execute: () => Promise<AtomCommandResult<A, unknown>>,
  ): Promise<AtomCommandResult<A, unknown> | null> => {
    if (locked) return null;
    setBusy(action);
    setError(null);
    setBlockedSignInUrl(null);
    // `Promise#finally`, not a `finally` block: React Compiler cannot compile
    // `try`/`finally`, and the item must unlock even on a defect.
    const result = await execute().finally(() => setBusy(null));
    setError(commandFailureMessage(result));
    return result;
  };

  /**
   * Starts a sign-in whose URL `request` obtains. The page opens in the user's
   * browser, or its URL stays here as a link when the browser blocks it.
   */
  const signIn = async (action: string, request: () => Promise<string | null>) => {
    if (locked) return "not-started" as const;
    setBusy(action);
    setError(null);
    setBlockedSignInUrl(null);
    const opening = await openAuthorizationPage(request).finally(() => setBusy(null));
    if (opening.outcome === "blocked") setBlockedSignInUrl(opening.url);
    return opening.outcome;
  };

  return {
    busy,
    locked,
    feedback: { error, blockedSignInUrl } satisfies ActionFeedbackState,
    setError,
    run,
    signIn,
  };
}

async function confirmDestructive(message: string): Promise<boolean> {
  return ensureLocalApi().dialogs.confirm(message, { variant: "destructive" });
}

export function useConnectorActions(connector: ConnectorSummary): ConnectorActionsState {
  const { environmentId, callbackOrigin } = useExtensionsEnvironment();
  const lock = useActionLock();
  const update = useAtomCommand(updateConnector, { reportFailure: true });
  const remove = useAtomCommand(removeConnector, { reportFailure: true });
  const test = useAtomCommand(testConnector, { reportFailure: true });
  const startSignIn = useAtomCommand(startConnectorSignIn, { reportFailure: true });
  const [testResult, setTestResult] = useState<ConnectorTestResult | null>(null);
  const [signInStartedAt, setSignInStartedAt] = useState<string | null>(null);
  const connectorId = connector.connectorId;

  return {
    ...lock,
    testResult,
    /** Sign-in opened and the server has not reported a change since. */
    waitingForSignIn: signInStartedAt !== null && signInStartedAt === connector.updatedAt,
    canSignIn: !lock.locked && callbackOrigin !== null,
    signIn: async () => {
      if (callbackOrigin === null) return;
      const outcome = await lock.signIn("sign-in", async () => {
        const result = await startSignIn({
          environmentId,
          input: { connectorId, callbackOrigin },
        });
        lock.setError(commandFailureMessage(result));
        return result._tag === "Success" ? result.value.authorizationUrl : null;
      });
      if (outcome !== "not-started") setSignInStartedAt(connector.updatedAt);
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
 * server asks for it.
 */
export function useAddEntry(entry: DiscoverEntry) {
  const { environmentId, callbackOrigin } = useExtensionsEnvironment();
  const lock = useActionLock();
  const add = useAtomCommand(addConnector, { reportFailure: true });
  const startSignIn = useAtomCommand(startConnectorSignIn, { reportFailure: true });
  const remote = installableRemotes(entry)[0];

  return {
    ...lock,
    canAdd: entry.installable && remote !== undefined,
    add: async () => {
      if (!entry.installable || remote === undefined) return;
      const result = await lock.run("add", () =>
        add({
          environmentId,
          input: {
            target: entryAddTarget(entry, remote.url),
            displayName: entryName(entry),
            ...(entry.description?.trim()
              ? { description: entry.description.trim().slice(0, 1000) }
              : {}),
          },
        }),
      );
      if (result?._tag !== "Success") return;
      if (result.value.nextStep === "ready") {
        toastManager.add({ type: "success", title: `${result.value.connector.displayName} added` });
        return;
      }
      if (callbackOrigin === null) return;
      const connectorId = result.value.connector.connectorId;
      await lock.signIn("sign-in", async () => {
        const started = await startSignIn({
          environmentId,
          input: { connectorId, callbackOrigin },
        });
        lock.setError(commandFailureMessage(started));
        return started._tag === "Success" ? started.value.authorizationUrl : null;
      });
    },
  };
}

export function usePluginActions(plugin: ScientPluginSummary): PluginActionsState {
  const { environmentId } = useExtensionsEnvironment();
  const lock = useActionLock();
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
  const lock = useActionLock();
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
  const lock = useActionLock();
  const act = useAtomCommand(actOnProviderPlugin, { reportFailure: true });
  return {
    ...lock,
    signIn: () =>
      lock.signIn("sign-in", async () => {
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
          toastManager.add({ type: "info", title: `${label} started sign-in for ${server.name}` });
        }
        return result.value.authorizationUrl ?? null;
      }),
  };
}
