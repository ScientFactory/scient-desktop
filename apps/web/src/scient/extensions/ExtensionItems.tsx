import { AddConnectorDialog } from "./AddConnectorDialog";
import type {
  ConnectorSummary,
  ConnectorTestResult,
  DiscoverEntry,
  ScientPluginSummary,
  ServerProvider,
  ServerProviderMcpServer,
  ServerProviderPlugin,
  ProviderStoreApp,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { EllipsisIcon, PlusIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { actOnProviderPlugin } from "./extensionsState";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import {
  type ActionFeedbackState,
  type ConnectorActionsState,
  type PluginActionsState,
  useAddEntry,
  useActionLock,
  useConnectorActions,
  usePluginActions,
  useProviderPluginActions,
  useProviderServerActions,
} from "./extensionActions";
import { ActionError, SignInBlockedNotice } from "./ExtensionsFeedback";
import { useExtensionsEnvironment } from "./ExtensionsPage";
import { ExtensionRow, type ExtensionTarget } from "./ExtensionRow";
import {
  providerExtensionAudience,
  providerServerDisplayName,
  connectorActions,
  connectorStatusText,
  entryName,
  entryNeedsToken,
  entryTagline,
  pluginGlyph,
  MCP_SERVER_STATUS_TEXT,
  TEST_OUTCOME_LABELS,
} from "./extensionsView";

/** Navigates to a detail page, for menu items that cannot be links themselves. */
function useOpenExtension() {
  const navigate = useNavigate();
  return (target: ExtensionTarget) => {
    switch (target.kind) {
      case "provider-store":
        return void navigate({
          to: "/settings/extensions/item/store/$instanceId/$entryId",
          params: { instanceId: target.instanceId, entryId: target.entryId },
        });
      case "connector":
        return void navigate({
          to: "/settings/extensions/item/connector/$connectorId",
          params: { connectorId: target.connectorId },
        });
      case "server":
        return void navigate({
          to: "/settings/extensions/item/server/$",
          params: { _splat: target.name },
        });
      case "plugin":
        return void navigate({
          to: "/settings/extensions/item/plugin/$pluginId",
          params: { pluginId: target.pluginId },
        });
      case "provider-plugin":
        return void navigate({
          to: "/settings/extensions/item/provider/$instanceId/plugin/$pluginId",
          params: { instanceId: target.instanceId, pluginId: target.pluginId },
          search: (previous) => ({
            ...previous,
            ...(target.workspace ? { workspace: target.workspace } : {}),
          }),
        });
      case "provider-server":
        return void navigate({
          to: "/settings/extensions/item/provider/$instanceId/server/$serverName",
          params: { instanceId: target.instanceId, serverName: target.serverName },
        });
    }
  };
}

export function ActionFeedback({
  feedback,
  waitingForSignIn = false,
  testResult = null,
}: {
  readonly feedback: ActionFeedbackState;
  readonly waitingForSignIn?: boolean;
  readonly testResult?: ConnectorTestResult | null;
}) {
  return (
    <>
      <ActionError message={feedback.error} />
      <SignInBlockedNotice url={feedback.blockedSignInUrl} />
      {waitingForSignIn && feedback.blockedSignInUrl === null ? (
        <p className="text-xs text-muted-foreground">
          Finish signing in in your browser. This updates when the service confirms.
        </p>
      ) : null}
      {testResult ? (
        <p role="status" className="text-xs text-muted-foreground">
          {TEST_OUTCOME_LABELS[testResult.outcome]}
          {testResult.outcome === "ok"
            ? ` · ${testResult.tools.length} ${testResult.tools.length === 1 ? "tool" : "tools"}`
            : testResult.message
              ? ` · ${testResult.message}`
              : ""}
        </p>
      ) : null}
    </>
  );
}

function hasFeedback(feedback: ActionFeedbackState, extra: boolean): boolean {
  return feedback.error !== null || feedback.blockedSignInUrl !== null || extra;
}

/** The "⋯" of an added item. Open always works; changes need settings permission. */
function ItemMenu({
  name,
  target,
  children,
}: {
  readonly name: string;
  readonly target: ExtensionTarget | null;
  readonly children?: ReactNode;
}) {
  const open = useOpenExtension();
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-sm" variant="ghost-muted" aria-label={`More for ${name}`} />}
      >
        <EllipsisIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end">
        {target ? <MenuItem onClick={() => open(target)}>Open</MenuItem> : null}
        {target && children ? <MenuSeparator /> : null}
        {children}
      </MenuPopup>
    </Menu>
  );
}

/** Menu entries for a connector's row. */
function ConnectorMenuItems({
  connector,
  actions,
}: {
  readonly connector: ConnectorSummary;
  readonly actions: ConnectorActionsState;
}) {
  const allowed = connectorActions(connector);
  return (
    <>
      <MenuItem disabled={actions.locked || !allowed.canTest} onClick={() => void actions.test()}>
        Test
      </MenuItem>
      {connector.auth.type === "oauth" ? (
        <MenuItem disabled={!actions.canSignIn} onClick={() => void actions.signIn()}>
          {connector.status === "connected" ? "Sign in again" : "Sign in"}
        </MenuItem>
      ) : null}
      <MenuItem
        disabled={actions.locked}
        onClick={() => void actions.setEnabled(!connector.enabled)}
      >
        {connector.enabled ? "Turn off" : "Turn on"}
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        variant="destructive"
        disabled={actions.locked}
        onClick={() => void actions.remove()}
      >
        Remove
      </MenuItem>
    </>
  );
}

export function ConnectorItem({
  connector,
  entry,
}: {
  readonly connector: ConnectorSummary;
  /** The registry or curated entry it came from, for its icon and tagline. */
  readonly entry?: DiscoverEntry | undefined;
}) {
  const actions = useConnectorActions(connector);
  const target: ExtensionTarget = { kind: "connector", connectorId: connector.connectorId };
  return (
    <ExtensionRow
      target={target}
      name={entry ? entryName(entry) : connector.displayName}
      iconUrl={entry?.iconUrl ?? connector.iconUrl}
      tagline={(entry ? entryTagline(entry) : undefined) ?? connector.description ?? connector.url}
      status={actions.busy === "sign-in" ? "Opening sign-in…" : connectorStatusText(connector)}
      trailing={
        <ItemMenu name={entry ? entryName(entry) : connector.displayName} target={target}>
          <ConnectorMenuItems connector={connector} actions={actions} />
        </ItemMenu>
      }
      feedback={
        hasFeedback(actions.feedback, actions.waitingForSignIn || actions.testResult !== null) ? (
          <ActionFeedback
            feedback={actions.feedback}
            waitingForSignIn={actions.waitingForSignIn}
            testResult={actions.testResult}
          />
        ) : null
      }
    />
  );
}

/**
 * A registry or curated server. Once added it is its connector; until then
 * "+" adds it in one step, or opens its page when it cannot be added here.
 */
export function EntryItem({ entry }: { readonly entry: DiscoverEntry }) {
  const { inventory } = useExtensionsEnvironment();
  const connector =
    entry.installedConnectorId === undefined
      ? undefined
      : inventory?.connectors.find((item) => item.connectorId === entry.installedConnectorId);
  if (connector) return <ConnectorItem connector={connector} entry={entry} />;
  return <NewEntryItem entry={entry} />;
}

function NewEntryItem({ entry }: { readonly entry: DiscoverEntry }) {
  const { environmentId, callbackOrigin } = useExtensionsEnvironment();
  const [showToken, setShowToken] = useState(false);
  const actions = useAddEntry(entry);
  const open = useOpenExtension();
  const target: ExtensionTarget = { kind: "server", name: entry.name };
  const name = entryName(entry);
  return (
    <>
      <ExtensionRow
        target={target}
        name={name}
        iconUrl={entry.iconUrl}
        tagline={entryTagline(entry)}
        status={actions.busy === "add" ? "Adding…" : null}
        trailing={
          entry.installedConnectorId === undefined ? (
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label={actions.canAdd ? `Add ${name}` : `Why ${name} can't be added`}
              disabled={actions.canAdd && actions.locked}
              onClick={() =>
                entryNeedsToken(entry)
                  ? setShowToken(true)
                  : actions.canAdd
                    ? void actions.add()
                    : open(target)
              }
            >
              <PlusIcon aria-hidden />
            </Button>
          ) : null
        }
        feedback={
          hasFeedback(actions.feedback, false) ? (
            <ActionFeedback feedback={actions.feedback} />
          ) : null
        }
      />
      {showToken ? (
        <AddConnectorDialog
          open
          onOpenChange={setShowToken}
          environmentId={environmentId}
          callbackOrigin={callbackOrigin}
          entry={entry}
        />
      ) : null}
    </>
  );
}

function PluginMenuItems({
  plugin,
  actions,
}: {
  readonly plugin: ScientPluginSummary;
  readonly actions: PluginActionsState;
}) {
  if (!plugin.canSetEnabled && !plugin.canRemove) return null;
  return (
    <>
      {plugin.canSetEnabled ? (
        <MenuItem
          disabled={actions.locked}
          onClick={() => void actions.setEnabled(!plugin.enabled)}
        >
          {plugin.enabled ? "Turn off" : "Turn on"}
        </MenuItem>
      ) : null}
      {plugin.canRemove ? (
        <MenuItem
          variant="destructive"
          disabled={actions.locked}
          onClick={() => void actions.remove()}
        >
          Remove
        </MenuItem>
      ) : null}
    </>
  );
}

export function PluginItem({ plugin }: { readonly plugin: ScientPluginSummary }) {
  const actions = usePluginActions(plugin);
  const target: ExtensionTarget = { kind: "plugin", pluginId: plugin.pluginId };
  return (
    <ExtensionRow
      target={target}
      name={plugin.displayName}
      glyph={pluginGlyph(plugin)}
      tagline={plugin.description}
      status={plugin.origin === "bundle" && !plugin.enabled ? "Off" : null}
      trailing={
        <ItemMenu name={plugin.displayName} target={target}>
          <PluginMenuItems plugin={plugin} actions={actions} />
        </ItemMenu>
      }
      feedback={
        hasFeedback(actions.feedback, false) ? <ActionFeedback feedback={actions.feedback} /> : null
      }
    />
  );
}

export function ProviderPluginItem({
  provider,
  label,
  plugin,
  workspace,
}: {
  readonly provider: ServerProvider;
  readonly label: string;
  readonly plugin: ServerProviderPlugin;
  readonly workspace: string | undefined;
}) {
  const actions = useProviderPluginActions(provider, label, plugin, workspace);
  const name = plugin.displayName ?? plugin.name;
  const target: ExtensionTarget = {
    kind: "provider-plugin",
    instanceId: provider.instanceId,
    pluginId: plugin.id,
    workspace,
  };
  return (
    <ExtensionRow
      target={target}
      name={name}
      audience={providerExtensionAudience(provider, plugin)}
      tagline={[plugin.description, plugin.sourceLabel ?? `${label} plugin`]
        .filter(Boolean)
        .join(" · ")}
      status={
        !plugin.enabled
          ? "Off"
          : plugin.apps?.length
            ? plugin.apps.some((app) => !app.enabled)
              ? "Disabled in Codex"
              : plugin.apps.every((app) => app.connected)
                ? "Connected"
                : "Needs sign-in"
            : null
      }
      trailing={
        <ItemMenu name={name} target={target}>
          {plugin.canSetEnabled ? (
            <MenuItem
              disabled={actions.locked}
              onClick={() => void actions.setEnabled(!plugin.enabled)}
            >
              {plugin.enabled ? "Turn off" : "Turn on"}
            </MenuItem>
          ) : null}
          {plugin.canUninstall === true ? (
            <MenuItem
              variant="destructive"
              disabled={actions.locked}
              onClick={() => void actions.uninstall()}
            >
              Uninstall
            </MenuItem>
          ) : null}
        </ItemMenu>
      }
      feedback={
        hasFeedback(actions.feedback, false) ? <ActionFeedback feedback={actions.feedback} /> : null
      }
    />
  );
}

export function mcpServerSummary(server: ServerProviderMcpServer): string {
  return [
    server.toolCount === undefined
      ? null
      : `${server.toolCount} ${server.toolCount === 1 ? "tool" : "tools"}`,
    server.pluginId ? `from ${server.pluginId}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function ProviderServerItem({
  provider,
  label,
  server,
}: {
  readonly provider: ServerProvider;
  readonly label: string;
  readonly server: ServerProviderMcpServer;
}) {
  const actions = useProviderServerActions(provider, label, server);
  const target: ExtensionTarget = {
    kind: "provider-server",
    instanceId: provider.instanceId,
    serverName: server.name,
  };
  return (
    <ExtensionRow
      target={target}
      name={providerServerDisplayName(server)}
      audience={providerExtensionAudience(provider, server)}
      tagline={server.error ?? mcpServerSummary(server)}
      status={MCP_SERVER_STATUS_TEXT[server.status]}
      trailing={
        <ItemMenu name={server.name} target={target}>
          {server.canStartSignIn === true || server.connectUrl ? (
            <MenuItem disabled={actions.locked} onClick={() => void actions.signIn()}>
              {server.connectUrl ? "Connect on claude.ai" : "Sign in"}
            </MenuItem>
          ) : null}
        </ItemMenu>
      }
      feedback={
        hasFeedback(actions.feedback, false) ? <ActionFeedback feedback={actions.feedback} /> : null
      }
    />
  );
}

export function ProviderAppConnect({
  provider,
  pluginId,
  app,
  disabled = false,
  onConnectionChange,
}: {
  readonly provider: ServerProvider;
  readonly pluginId: string;
  readonly app: ProviderStoreApp;
  readonly disabled?: boolean;
  readonly onConnectionChange?: (() => void) | undefined;
}) {
  const { environmentId } = useExtensionsEnvironment();
  const act = useAtomCommand(actOnProviderPlugin);
  const waiting = useRef(false);
  const refreshContents = useEffectEvent(() => onConnectionChange?.());
  useEffect(() => {
    const refresh = () => {
      if (!waiting.current) return;
      waiting.current = false;
      void act({
        environmentId,
        input: {
          instanceId: provider.instanceId,
          action: { type: "refresh-inventory", connectionsOnly: true },
        },
      }).then(() => refreshContents());
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [act, environmentId, provider.instanceId]);
  const lock = useActionLock(
    JSON.stringify(["provider-app", provider.instanceId, pluginId, app.name]),
  );
  return (
    <>
      <Button
        size="sm"
        variant="ghost-primary"
        disabled={lock.locked || disabled || !app.enabled}
        onClick={() =>
          void lock.signIn(
            "sign-in",
            () => {
              waiting.current = true;
              return Promise.resolve(app.installUrl ?? null);
            },
            null,
          )
        }
      >
        Connect {app.name}
      </Button>
      <ActionFeedback feedback={lock.feedback} />
    </>
  );
}
