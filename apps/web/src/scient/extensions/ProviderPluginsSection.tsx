import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { searchableSetting } from "../../components/settings/settingsSearch";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { toastManager } from "../../components/ui/toast";
import { ensureLocalApi } from "../../localApi";
import { useAtomCommand } from "../../state/use-atom-command";
import { actOnProviderPlugin } from "./extensionsState";
import { ActionError, commandFailureMessage, SignInBlockedNotice } from "./ExtensionsFeedback";
import {
  MCP_SERVER_STATUS_PRESENTATION,
  type ProviderExtensionGroup,
  workspaceLabel,
} from "./extensionsView";
import { openAuthorizationPage } from "./openAuthorizationPage";

/**
 * Plugins and MCP servers a provider instance manages itself. Scient offers an
 * action only where the provider reports it can perform it.
 */
export function ProviderPluginsSection({
  environmentId,
  groups,
  canWrite,
}: {
  readonly environmentId: EnvironmentId;
  readonly groups: ReadonlyArray<ProviderExtensionGroup>;
  readonly canWrite: boolean;
}) {
  const act = useAtomCommand(actOnProviderPlugin, { reportFailure: true });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /** The last action's outcome, shown on the row it came from. */
  const [feedback, setFeedback] = useState<{
    readonly key: string;
    readonly error: string | null;
    readonly blockedUrl: string | null;
  } | null>(null);
  const locked = !canWrite || busyKey !== null;
  const feedbackFor = (key: string) =>
    feedback?.key === key ? (
      <div className="grid gap-1 pb-2">
        <ActionError message={feedback.error} />
        <SignInBlockedNotice url={feedback.blockedUrl} />
      </div>
    ) : null;

  return (
    <SettingsSection {...searchableSetting("extensions-provider-plugins")}>
      {groups.length === 0 ? (
        <SettingsRow
          title="Nothing reported"
          description="Providers that publish their plugins or MCP servers appear here."
        />
      ) : null}
      {groups.map(({ provider, label, plugins, mcpServers }) => (
        <div key={provider.instanceId} data-provider-group={provider.instanceId}>
          <div className="flex items-center gap-2 px-3 pt-3 sm:px-4">
            <ProviderInstanceIcon
              driverKind={provider.driver}
              displayName={label}
              accentColor={provider.accentColor}
              className="size-5"
              iconClassName="size-4"
            />
            <h3 className="flex-1 text-sm font-medium">{label}</h3>
            <Link
              to="/settings/skills/external"
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Skills
            </Link>
          </div>
          {plugins.map(({ plugin, cwd }) => {
            const key = `plugin:${provider.instanceId}:${cwd ?? ""}:${plugin.id}`;
            const name = plugin.displayName ?? plugin.name;
            return (
              <SettingsRow
                key={key}
                title={name}
                description={plugin.description}
                status={[
                  plugin.version,
                  plugin.marketplace,
                  cwd ? `Workspace ${workspaceLabel(cwd)}` : null,
                  plugin.enabled ? "On" : "Off",
                ]
                  .filter(Boolean)
                  .join(" · ")}
                control={
                  plugin.canUninstall === true ? (
                    <Button
                      size="xs"
                      variant="destructive-outline"
                      disabled={locked}
                      onClick={async () => {
                        const confirmed = await ensureLocalApi().dialogs.confirm(
                          `Uninstall ${name} from ${label}?`,
                          { variant: "destructive" },
                        );
                        if (!confirmed || locked) return;
                        setBusyKey(key);
                        setFeedback(null);
                        try {
                          const result = await act({
                            environmentId,
                            input: {
                              instanceId: provider.instanceId,
                              action: { type: "uninstall", pluginId: plugin.id },
                              ...(cwd ? { cwd } : {}),
                            },
                          });
                          const error = commandFailureMessage(result);
                          if (error !== null) setFeedback({ key, error, blockedUrl: null });
                        } finally {
                          setBusyKey(null);
                        }
                      }}
                    >
                      Uninstall
                    </Button>
                  ) : undefined
                }
              >
                {feedbackFor(key)}
              </SettingsRow>
            );
          })}
          {mcpServers.map((server) => {
            const key = `mcp:${provider.instanceId}:${server.name}`;
            const status = MCP_SERVER_STATUS_PRESENTATION[server.status];
            return (
              <SettingsRow
                key={key}
                data-mcp-server={server.name}
                title={server.name}
                description={server.error}
                status={
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={status.tone}>{status.label}</Badge>
                    <span>
                      {[
                        "MCP server",
                        server.toolCount === undefined
                          ? null
                          : `${server.toolCount} ${server.toolCount === 1 ? "tool" : "tools"}`,
                        server.scope,
                        server.pluginId ? `From ${server.pluginId}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                }
                control={
                  server.canStartSignIn === true ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={locked}
                      onClick={async () => {
                        if (locked) return;
                        setBusyKey(key);
                        setFeedback(null);
                        let error: string | null = null;
                        try {
                          const opening = await openAuthorizationPage(async () => {
                            const result = await act({
                              environmentId,
                              input: {
                                instanceId: provider.instanceId,
                                action: { type: "mcp-sign-in", serverName: server.name },
                              },
                            });
                            error = commandFailureMessage(result);
                            if (result._tag !== "Success") return null;
                            if (!result.value.authorizationUrl) {
                              toastManager.add({
                                type: "info",
                                title: `${label} started sign-in for ${server.name}`,
                              });
                            }
                            return result.value.authorizationUrl ?? null;
                          });
                          const blockedUrl = opening.outcome === "blocked" ? opening.url : null;
                          if (error !== null || blockedUrl !== null) {
                            setFeedback({ key, error, blockedUrl });
                          }
                        } finally {
                          setBusyKey(null);
                        }
                      }}
                    >
                      Sign in
                    </Button>
                  ) : undefined
                }
              >
                {feedbackFor(key)}
              </SettingsRow>
            );
          })}
        </div>
      ))}
    </SettingsSection>
  );
}
