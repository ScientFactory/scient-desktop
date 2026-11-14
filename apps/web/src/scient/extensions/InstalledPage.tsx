import type {
  ProviderInstanceId,
  ScientPluginSummary,
  ServerProviderMcpServer,
} from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { SettingsSearchTarget } from "../../components/settings/settingsLayout";
import { searchableSetting } from "../../components/settings/settingsSearch";
import { useAtomCommand } from "../../state/use-atom-command";
import { actOnProviderPlugin } from "./extensionsState";
import { openAuthorizationPage } from "./openAuthorizationPage";
import { Button } from "../../components/ui/button";
import { NativeSelect } from "../../components/ui/select";
import { AddYourOwn, MakeConnector } from "./AddYourOwn";
import {
  ConnectorItem,
  PluginItem,
  ProviderPluginItem,
  ProviderServerItem,
} from "./ExtensionItems";
import {
  ExtensionsPage,
  ExtensionsSection,
  ExtensionsTopBar,
  SectionAction,
  SectionShowAllToggle,
  MutedLine,
  useExtensionsEnvironment,
} from "./ExtensionsPage";
import { ExtensionTable } from "./ExtensionRow";
import {
  catalogEntries,
  collectProviderExtensionGroups,
  connectorsReach,
  type ExtensionKind,
  type ProviderExtensionGroup,
  showsKind,
  worksWithOptions,
} from "./extensionsView";
import { providerInventoryMessage } from "./providerInventory";
import { useWindowFocusRefresh } from "./useWindowFocusRefresh";
import { AccountServiceItem, connectedAccountServices } from "./AccountServicePages";
import {
  type AccountService,
  accountServiceForApp,
  accountServiceOfServer,
} from "./accountServices";
import { AgentSkills } from "../skills/AgentSkills";
import { PersonalSkillsSection } from "../skills/PersonalSkillsSection";
import { ProjectSkills } from "../skills/ProjectSkills";
import { ScientSkillsLibrary, ScientSkillsTitle } from "../skills/ScientSkillsLibrary";

/** Rows the table shows before "Show all". */
const PREVIEW_ROWS = 24;

/** The row's kind for a provider's own server: a ChatGPT app, a claude.ai connector, or MCP. */
const serverType = (scope: string | undefined) =>
  scope === "chatgpt" ? "ChatGPT app" : scope === "claudeai" ? "claude.ai connector" : "MCP server";

/**
 * Each agent's own plugins, apps and servers as rows, each thing once:
 * - a service several agents reach (Gmail and the like) is already its own row;
 * - a ChatGPT app is one row naming every agent whose ChatGPT account has it;
 * - an agent's plugin named like one of those, or like another of its plugins, adds no row.
 */
function agentRows(
  groups: ReadonlyArray<ProviderExtensionGroup>,
  services: ReadonlyArray<AccountService>,
) {
  const key = (name: string) => name.trim().toLowerCase();
  const apps = new Map<
    string,
    Array<{ readonly group: ProviderExtensionGroup; readonly server: ServerProviderMcpServer }>
  >();
  const others: Array<{
    readonly group: ProviderExtensionGroup;
    readonly server: ServerProviderMcpServer;
  }> = [];
  for (const group of groups)
    for (const server of group.mcpServers) {
      if (accountServiceOfServer(group.provider, server)) continue;
      if (server.scope === "chatgpt") {
        const list = apps.get(key(server.name)) ?? [];
        list.push({ group, server });
        apps.set(key(server.name), list);
      } else others.push({ group, server });
    }
  const covered = new Set([...services.map((service) => key(service.name)), ...apps.keys()]);
  const rows: ReactNode[] = [];
  for (const group of groups) {
    const seen = new Set<string>();
    for (const { plugin, cwd } of group.plugins) {
      const name = key(plugin.displayName ?? plugin.name);
      if (covered.has(name) || seen.has(name)) continue;
      seen.add(name);
      rows.push(
        <ProviderPluginItem
          key={`${group.provider.instanceId}:plugin:${cwd ?? ""}:${plugin.id}`}
          provider={group.provider}
          label={group.label}
          plugin={plugin}
          workspace={cwd}
        />,
      );
    }
  }
  for (const [name, list] of apps) {
    const first = list[0]!;
    rows.push(
      <ProviderServerItem
        key={`app:${name}`}
        provider={first.group.provider}
        label={first.group.label}
        server={first.server}
        type="ChatGPT app"
        serviceId={
          accountServiceForApp({ name: first.server.name, installUrl: first.server.connectUrl })?.id
        }
        audience={{
          layer: "account",
          connected: list
            .filter(({ server }) => server.status === "connected")
            .map(({ group }) => ({ instanceId: group.provider.instanceId, label: group.label })),
          pending: [],
        }}
      />,
    );
  }
  for (const { group, server } of others)
    rows.push(
      <ProviderServerItem
        key={`${group.provider.instanceId}:server:${server.name}`}
        provider={group.provider}
        label={group.label}
        server={server}
        type={serverType(server.scope)}
      />,
    );
  return rows;
}

/**
 * Everything this environment has, in one table like claude.ai's Connectors page: the services
 * the agents reach through their accounts, Scient's connectors, then each agent's own plugins,
 * apps and servers. A service several agents reach is one row naming them all. What comes built
 * into Scient follows in its own table.
 */
function YoursTable({
  selected,
  connectorsShown,
  connectorsNote,
  groups,
  accountServices,
  curated,
  plugins,
}: {
  readonly selected: ProviderInstanceId | null;
  readonly connectorsShown: boolean;
  readonly connectorsNote: string | undefined;
  readonly groups: ReadonlyArray<ProviderExtensionGroup>;
  readonly accountServices: ReadonlyArray<AccountService>;
  readonly curated: ReturnType<typeof catalogEntries>;
  readonly plugins: ReadonlyArray<ScientPluginSummary>;
}) {
  const [expanded, setExpanded] = useState(false);
  const { environmentId, canWrite, inventory, inventoryError, providerInventory } =
    useExtensionsEnvironment();
  const act = useAtomCommand(actOnProviderPlugin, { reportFailure: true });
  const waitingForConnection = useRef(false);
  const refreshAgents = () => {
    for (const group of groups)
      void act({
        environmentId,
        input: { instanceId: group.provider.instanceId, action: { type: "refresh-inventory" } },
      });
  };
  useWindowFocusRefresh(() => {
    if (!waitingForConnection.current) return;
    waitingForConnection.current = false;
    refreshAgents();
  });

  const rows = [
    ...accountServices.map((service) => (
      <AccountServiceItem key={`account:${service.id}`} service={service} />
    )),
    ...(connectorsShown ? (inventory?.connectors ?? []) : []).map((connector) => (
      <ConnectorItem
        key={connector.connectorId}
        connector={connector}
        entry={curated.find((entry) => entry.installedConnectorId === connector.connectorId)}
      />
    )),
    ...agentRows(groups, accountServices),
  ];
  // Where an agent's own account adds apps: ChatGPT for Codex and Scient Agent, claude.ai for Claude.
  const chatGptApps = groups.some(
    (group) =>
      (group.provider.driver === "scient" && group.provider.accountAppsAvailable === true) ||
      (group.provider.driver === "codex" && group.provider.auth.type === "chatgpt"),
  );
  const claudeConnectors = groups.some(
    (group) =>
      group.provider.driver === "claudeAgent" && group.provider.accountAppsAvailable === true,
  );
  const addMore = (url: string) => {
    waitingForConnection.current = true;
    void openAuthorizationPage(async () => url);
  };
  return (
    <SettingsSearchTarget
      id={searchableSetting("extensions-connected-services").id}
      className="grid gap-10 outline-none"
    >
      <ExtensionsSection
        title="Yours"
        action={
          <div className="flex items-center gap-2">
            <SectionAction icon={RefreshCwIcon} disabled={!canWrite} onClick={refreshAgents}>
              Refresh
            </SectionAction>
            {rows.length > PREVIEW_ROWS ? (
              <SectionShowAllToggle
                total={rows.length}
                expanded={expanded}
                onExpandedChange={setExpanded}
              />
            ) : null}
          </div>
        }
      >
        {inventory === null && inventoryError ? <MutedLine>Unavailable.</MutedLine> : null}
        {connectorsNote ? <MutedLine>{connectorsNote}</MutedLine> : null}
        {providerInventory.phase !== "ready" ? (
          <MutedLine>{providerInventoryMessage(providerInventory)}</MutedLine>
        ) : null}
        {providerInventory.errors.map((error) => (
          <MutedLine key={error}>{error}</MutedLine>
        ))}
        {rows.length === 0 ? (
          <MutedLine>
            {inventory === null
              ? "Loading…"
              : "Nothing yet. Find something in Discover, or add your own."}
          </MutedLine>
        ) : (
          <ExtensionTable label={selected ? "Yours, for this agent" : "Yours"}>
            {expanded ? rows : rows.slice(0, PREVIEW_ROWS)}
          </ExtensionTable>
        )}
        {chatGptApps || claudeConnectors ? (
          <div className="flex flex-wrap gap-2">
            {chatGptApps ? (
              <Button variant="ghost-muted" size="sm" onClick={() => addMore(CHATGPT_APPS_PAGE)}>
                Add apps on ChatGPT
              </Button>
            ) : null}
            {claudeConnectors ? (
              <Button
                variant="ghost-muted"
                size="sm"
                onClick={() => addMore(CLAUDE_CONNECTORS_PAGE)}
              >
                Add connectors on claude.ai
              </Button>
            ) : null}
          </div>
        ) : null}
      </ExtensionsSection>
      {plugins.length > 0 ? (
        <ExtensionsSection
          id={searchableSetting("extensions-scient-plugins").id}
          title="Built into Scient"
        >
          <ExtensionTable label="Built into Scient">
            {plugins.map((plugin) => (
              <PluginItem key={plugin.pluginId} plugin={plugin} />
            ))}
          </ExtensionTable>
        </ExtensionsSection>
      ) : null}
    </SettingsSearchTarget>
  );
}

const CHATGPT_APPS_PAGE = "https://chatgpt.com/apps";
const CLAUDE_CONNECTORS_PAGE = "https://claude.ai/customize/connectors";

function Installed({ kind }: { readonly kind: ExtensionKind | undefined }) {
  const {
    environmentId,
    inventory,
    inventoryError,
    catalog,
    providers,
    providerInventory,
    canWrite,
  } = useExtensionsEnvironment();
  const [worksWith, setWorksWith] = useState<ProviderInstanceId | null>(null);
  const options = worksWithOptions(inventory?.providerSupport ?? [], providers);
  const selected = options.find((option) => option.instanceId === worksWith) ?? null;
  const groups = collectProviderExtensionGroups(
    providerInventory.providers,
    selected?.instanceId ?? null,
  );
  const curated = catalogEntries(catalog);
  // Each agent's inventory counts as it arrives; one that never reports holds nothing back.
  const accountServices = connectedAccountServices(
    providerInventory.providers,
    selected?.instanceId ?? null,
  );
  const plugins = [
    ...(inventory?.plugins.filter((plugin) => plugin.origin === "bundle") ?? []),
    ...(inventory?.plugins.filter((plugin) => plugin.origin === "built-in") ?? []),
  ];

  return (
    <>
      <ExtensionsTopBar tab="installed" kind={kind}>
        <span className="flex items-center gap-2">
          <MakeConnector kind={kind} />
          <AddYourOwn kind={kind} />
          <span className="w-56">
            <NativeSelect
              size="sm"
              aria-label="Works with"
              value={worksWith ?? ""}
              onChange={(event) =>
                setWorksWith(
                  options.find((option) => option.instanceId === event.target.value)?.instanceId ??
                    null,
                )
              }
            >
              <option value="">Works with any agent</option>
              {options.map((option) => (
                <option key={option.instanceId} value={option.instanceId}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </span>
        </span>
      </ExtensionsTopBar>
      {inventoryError ? <MutedLine>{inventoryError}</MutedLine> : null}
      {inventory?.diagnostics.map((diagnostic) => (
        <p
          key={`${diagnostic.code}:${diagnostic.subject ?? ""}`}
          role="alert"
          className="text-sm text-destructive-foreground"
        >
          {diagnostic.message}
        </p>
      ))}
      {!canWrite ? (
        <MutedLine>This connection can view extensions but not change them.</MutedLine>
      ) : null}

      {showsKind(kind, "plugins") ? (
        <YoursTable
          selected={selected?.instanceId ?? null}
          connectorsShown={connectorsReach(selected)}
          connectorsNote={
            !connectorsReach(selected)
              ? (selected?.support?.reason ??
                `${selected?.label ?? "This agent"} does not support remote MCP servers.`)
              : selected?.support?.status === "conditional"
                ? selected.support.reason
                : undefined
          }
          groups={groups}
          accountServices={accountServices}
          curated={curated}
          plugins={plugins}
        />
      ) : null}

      {showsKind(kind, "skills") ? (
        <>
          <ExtensionsSection title="Your skills">
            <PersonalSkillsSection environmentId={environmentId} providers={providers} />
          </ExtensionsSection>
          <ExtensionsSection title={<ScientSkillsTitle />}>
            <ScientSkillsLibrary environmentId={environmentId} providers={providers} onlyActive />
          </ExtensionsSection>
          <ExtensionsSection title="Agent skills">
            <AgentSkills
              environmentId={environmentId}
              providers={providers}
              instanceId={selected?.instanceId ?? null}
            />
          </ExtensionsSection>
          <ExtensionsSection title="Project skills">
            <ProjectSkills environmentId={environmentId} />
          </ExtensionsSection>
        </>
      ) : null}
    </>
  );
}

/** Settings ▸ Extensions ▸ Installed: everything this environment already has. */
export function InstalledPage({ kind }: { readonly kind?: ExtensionKind | undefined }) {
  return (
    <ExtensionsPage loadProviderInventory={kind !== "skills"}>
      <Installed kind={kind} />
    </ExtensionsPage>
  );
}
