import type {
  ProviderInstanceId,
  ScientPluginSummary,
  ServerProviderMcpServer,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { RefreshCwIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { SettingsSearchTarget } from "../../components/settings/settingsLayout";
import type { SettingsSearchItemId } from "../../components/settings/settingsSearch";
import { useAtomCommand } from "../../state/use-atom-command";
import { actOnProviderPlugin } from "./extensionsState";
import { openAuthorizationPage } from "./openAuthorizationPage";
import { Button } from "../../components/ui/button";
import { NativeSelect } from "../../components/ui/select";
import { AddYourOwn } from "./AddYourOwn";
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
  useRememberListPage,
} from "./ExtensionsPage";
import { ExtensionTable } from "./ExtensionRow";
import {
  collectProviderExtensionGroups,
  connectorsReach,
  type ExtensionKind,
  type ProviderExtensionGroup,
  providerAvailable,
  providerExtensionAudience,
  showsKind,
  worksWithOptions,
} from "./extensionsView";
import { useInstalledEntries } from "./installedEntries";
import { providerInventoryMessage } from "./providerInventoryCopy";
import { useWindowFocusRefresh } from "./useWindowFocusRefresh";
import { AccountServiceItem } from "./AccountServicePages";
import {
  type AccountService,
  accountServiceForApp,
  accountServiceOfServer,
  installedAccountServices,
} from "./accountServices";
import { AgentSkills } from "../skills/AgentSkills";
import { PersonalSkillsSection } from "../skills/PersonalSkillsSection";
import { ProjectSkills } from "../skills/ProjectSkills";
import { ScientSkillsLibrary, ScientSkillsTitle } from "../skills/ScientSkillsLibrary";

/** Rows the table shows before "Show all". */
const PREVIEW_ROWS = 24;

/** Codex's gateway to the ChatGPT apps, which the list already shows one by one. */
const isAppGateway = (group: ProviderExtensionGroup, server: ServerProviderMcpServer) =>
  group.provider.driver === "codex" && server.name === "codex_apps";

/**
 * Each agent's own plugins and servers, one row per installation. No row for a plugin another
 * agent shares, a project merely echoes, or whose app is listed; nor for a server a listed app,
 * its plugin or Codex's apps stand for, unless only its row offers a needed sign-in.
 */
function agentRows(
  groups: ReadonlyArray<ProviderExtensionGroup>,
  services: ReadonlyArray<AccountService>,
) {
  const listed = new Set(services.map((service) => service.id));
  const installations = new Set<string>();
  const rows: ReactNode[] = [];
  for (const group of groups)
    for (const { plugin, cwd } of group.plugins) {
      if (plugin.apps?.some((app) => listed.has(accountServiceForApp(app)?.id ?? ""))) continue;
      // Two agents that load the same plugin share its id; each agent's own plugins do not.
      const owner =
        providerExtensionAudience(group.provider, plugin).layer === "shared"
          ? "shared"
          : group.provider.instanceId;
      // Machine-wide plugins come first, so a project that reports the same one, in the same
      // state, adds nothing; one turned off for that project alone is its own row.
      const everywhere = `${owner}:${plugin.id}:${plugin.enabled}`;
      const id = cwd === undefined ? everywhere : `${everywhere}:${cwd}`;
      if (installations.has(id) || installations.has(everywhere)) continue;
      installations.add(id);
      rows.push(
        <ProviderPluginItem
          key={`${group.provider.instanceId}:plugin:${plugin.id}:${cwd ?? ""}`}
          provider={group.provider}
          label={group.label}
          plugin={plugin}
          workspace={cwd}
        />,
      );
    }
  for (const group of groups)
    for (const server of group.mcpServers) {
      const ofPlugin =
        Boolean(server.pluginId) || server.scope === "plugin" || server.name.startsWith("plugin:");
      // A plugin's server that waits for a sign-in keeps its row: the plugin's page has no such action.
      const needsRow = server.canStartSignIn === true || server.status === "needs-auth";
      if (
        (ofPlugin && !needsRow) ||
        isAppGateway(group, server) ||
        accountServiceOfServer(group.provider, server, services)
      )
        continue;
      rows.push(
        <ProviderServerItem
          key={`${group.provider.instanceId}:server:${server.name}`}
          provider={group.provider}
          label={group.label}
          server={server}
        />,
      );
    }
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
  readonly curated: ReturnType<typeof useInstalledEntries>;
  readonly plugins: ReadonlyArray<ScientPluginSummary>;
}) {
  const gt = useGT();
  const messages = useMessages();
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

  // What the person added in Scient first, then what each agent brings.
  const rows = [
    ...(connectorsShown ? (inventory?.connectors ?? []) : [])
      .filter(
        (connector) =>
          selected === null ||
          connector.agents === undefined ||
          connector.agents.includes(selected),
      )
      .map((connector) => (
        <ConnectorItem
          key={connector.connectorId}
          connector={connector}
          entry={curated.find((entry) => entry.installedConnectorId === connector.connectorId)}
        />
      )),
    ...plugins
      .filter((plugin) => plugin.origin !== "built-in")
      .map((plugin) => <PluginItem key={plugin.pluginId} plugin={plugin} />),
    ...accountServices.map((service) => (
      <AccountServiceItem key={`account:${service.id}`} service={service} />
    )),
    ...agentRows(groups, accountServices),
  ];
  const builtIn = plugins.filter((plugin) => plugin.origin === "built-in");
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
      id={"extensions-connected-services" satisfies SettingsSearchItemId}
      className="grid gap-10 outline-none"
    >
      <ExtensionsSection
        title={gt("Yours", { $context: "the user's own extensions" })}
        action={
          <div className="flex items-center gap-2">
            <SectionAction icon={RefreshCwIcon} disabled={!canWrite} onClick={refreshAgents}>
              {gt("Refresh")}
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
        {inventory === null && inventoryError ? (
          <MutedLine>
            <T>Unavailable.</T>
          </MutedLine>
        ) : null}
        {connectorsNote ? <MutedLine>{connectorsNote}</MutedLine> : null}
        {/* A read that ended with gaps says which below; the rows are what the agents reported. */}
        {providerInventory.phase !== "ready" && providerInventory.phase !== "partial" ? (
          <MutedLine>{providerInventoryMessage(providerInventory, messages)}</MutedLine>
        ) : null}
        {providerInventory.errors.map((error) => (
          <MutedLine key={error}>{error}</MutedLine>
        ))}
        {rows.length === 0 ? (
          <MutedLine>
            {inventory === null
              ? gt("Loading…")
              : gt("Nothing yet. Find something in Discover, or add your own.")}
          </MutedLine>
        ) : (
          <ExtensionTable
            label={
              selected
                ? gt("Yours, for this agent")
                : gt("Yours", { $context: "the user's own extensions" })
            }
          >
            {expanded ? rows : rows.slice(0, PREVIEW_ROWS)}
          </ExtensionTable>
        )}
        {chatGptApps || claudeConnectors ? (
          <div className="flex flex-wrap gap-2">
            {chatGptApps ? (
              <Button variant="ghost-muted" size="sm" onClick={() => addMore(CHATGPT_APPS_PAGE)}>
                <T>Add apps on ChatGPT</T>
              </Button>
            ) : null}
            {claudeConnectors ? (
              <Button
                variant="ghost-muted"
                size="sm"
                onClick={() => addMore(CLAUDE_CONNECTORS_PAGE)}
              >
                <T>Add connectors on claude.ai</T>
              </Button>
            ) : null}
          </div>
        ) : null}
      </ExtensionsSection>
      {builtIn.length > 0 ? (
        <ExtensionsSection
          id={"extensions-scient-plugins" satisfies SettingsSearchItemId}
          title={gt("Built into Scient")}
        >
          <ExtensionTable label={gt("Built into Scient")}>
            {builtIn.map((plugin) => (
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
  const gt = useGT();
  useRememberListPage(gt("Installed"));
  const { environmentId, inventory, inventoryError, providers, providerInventory, canWrite } =
    useExtensionsEnvironment();
  const [worksWith, setWorksWith] = useState<ProviderInstanceId | null>(null);
  // The agents this person has; ones Scient merely knows about are not worth filtering by.
  const options = worksWithOptions(inventory?.providerSupport ?? [], providers).filter((option) =>
    providers.some(
      (provider) => provider.instanceId === option.instanceId && providerAvailable(provider),
    ),
  );
  const selected = options.find((option) => option.instanceId === worksWith) ?? null;
  const groups = collectProviderExtensionGroups(
    providerInventory.providers,
    selected?.instanceId ?? null,
  );
  const curated = useInstalledEntries();
  // Each agent's inventory counts as it arrives; one that never reports holds nothing back.
  const accountServices = installedAccountServices(
    providerInventory.providers,
    selected?.instanceId ?? null,
  );
  const plugins = inventory?.plugins ?? [];

  return (
    <>
      <ExtensionsTopBar tab="installed" kind={kind}>
        <span className="flex items-center gap-2">
          <AddYourOwn kind={kind} />
          <span className="w-56">
            <NativeSelect
              size="sm"
              aria-label={gt("Works with")}
              value={worksWith ?? ""}
              onChange={(event) =>
                setWorksWith(
                  options.find((option) => option.instanceId === event.target.value)?.instanceId ??
                    null,
                )
              }
            >
              <option value="">{gt("Works with any agent")}</option>
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
        <MutedLine>
          <T>This connection can view extensions but not change them.</T>
        </MutedLine>
      ) : null}

      {showsKind(kind, "plugins") ? (
        <YoursTable
          selected={selected?.instanceId ?? null}
          connectorsShown={connectorsReach(selected)}
          connectorsNote={
            !connectorsReach(selected)
              ? (selected?.support?.reason ??
                (selected === null
                  ? gt("This agent does not support remote MCP servers.")
                  : gt("{agent} does not support remote MCP servers.", {
                      agent: selected.label,
                    })))
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
          <ExtensionsSection title={gt("Your skills")}>
            <PersonalSkillsSection environmentId={environmentId} providers={providers} />
          </ExtensionsSection>
          <ExtensionsSection title={<ScientSkillsTitle />}>
            <ScientSkillsLibrary environmentId={environmentId} providers={providers} onlyActive />
          </ExtensionsSection>
          <ExtensionsSection title={gt("Agent skills")}>
            <AgentSkills
              environmentId={environmentId}
              providers={providers}
              instanceId={selected?.instanceId ?? null}
            />
          </ExtensionsSection>
          <ExtensionsSection title={gt("Project skills")}>
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
