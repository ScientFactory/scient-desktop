import type { ProviderInstanceId } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useRef, useState } from "react";

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
import { ExtensionGrid } from "./ExtensionRow";
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
  accountServiceAudience,
  accountServiceOfServer,
  accountServiceRoutes,
} from "./accountServices";
import { AgentSkills } from "../skills/AgentSkills";
import { PersonalSkillsSection } from "../skills/PersonalSkillsSection";
import { ProjectSkills } from "../skills/ProjectSkills";
import { ScientSkillsLibrary, ScientSkillsTitle } from "../skills/ScientSkillsLibrary";

/** Rows a provider section shows before "Show all". */
const PROVIDER_PREVIEW_ROWS = 6;

function ProviderSection({
  group,
  kind,
}: {
  readonly group: ProviderExtensionGroup;
  readonly kind: ExtensionKind | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const { environmentId, canWrite, providerInventory } = useExtensionsEnvironment();
  const serviceAudience = (service: AccountService | undefined) =>
    service
      ? accountServiceAudience(accountServiceRoutes(service, providerInventory.providers))
      : undefined;
  const act = useAtomCommand(actOnProviderPlugin, { reportFailure: true });
  const waitingForConnection = useRef(false);
  useWindowFocusRefresh(() => {
    if (!waitingForConnection.current) return;
    waitingForConnection.current = false;
    void act({
      environmentId,
      input: { instanceId: group.provider.instanceId, action: { type: "refresh-inventory" } },
    });
  });
  const rows = [
    ...(showsKind(kind, "plugins") ? group.plugins : []).map(({ plugin, cwd }) => (
      <ProviderPluginItem
        key={`plugin:${cwd ?? ""}:${plugin.id}`}
        provider={group.provider}
        label={group.label}
        plugin={plugin}
        workspace={cwd}
      />
    )),
    ...(showsKind(kind, "plugins") ? group.mcpServers : [])
      // Codex already shows the apps its plugins bring inside those plugins' rows.
      .filter(
        (server) =>
          !(
            group.provider.driver === "codex" &&
            server.scope === "chatgpt" &&
            group.plugins.some(({ plugin }) =>
              (plugin.apps ?? []).some((app) => app.name === server.name),
            )
          ),
      )
      .map((server) => (
        <ProviderServerItem
          key={`server:${server.name}`}
          provider={group.provider}
          label={group.label}
          server={server}
          // Gmail, Calendar and Drive open their one page, which shows every agent.
          serviceId={accountServiceOfServer(group.provider, server)?.id}
          audience={serviceAudience(accountServiceOfServer(group.provider, server))}
        />
      )),
  ];
  const title = `From ${group.label}`;
  // Where the agent's own account adds apps: claude.ai for Claude, ChatGPT for Scient Agent.
  const accountAppsPage =
    group.provider.driver === "claudeAgent"
      ? { url: "https://claude.ai/customize/connectors", label: "Add more on claude.ai" }
      : group.provider.driver === "scient"
        ? { url: "https://chatgpt.com/apps", label: "Add more on ChatGPT" }
        : undefined;
  return (
    <ExtensionsSection
      title={title}
      action={
        <div className="flex items-center gap-2">
          <SectionAction
            icon={RefreshCwIcon}
            disabled={!canWrite}
            onClick={() =>
              void act({
                environmentId,
                input: {
                  instanceId: group.provider.instanceId,
                  action: { type: "refresh-inventory" },
                },
              })
            }
          >
            Refresh
          </SectionAction>
          {rows.length > PROVIDER_PREVIEW_ROWS ? (
            <SectionShowAllToggle
              total={rows.length}
              expanded={expanded}
              onExpandedChange={setExpanded}
            />
          ) : null}
        </div>
      }
    >
      {group.provider.driver === "claudeAgent" && group.provider.accountAppsAvailable !== true ? (
        <MutedLine>claude.ai connectors need a Claude account sign-in.</MutedLine>
      ) : null}
      {rows.length === 0 ? <MutedLine>None yet.</MutedLine> : null}
      <ExtensionGrid label={title}>
        {expanded ? rows : rows.slice(0, PROVIDER_PREVIEW_ROWS)}
      </ExtensionGrid>
      {accountAppsPage && group.provider.accountAppsAvailable === true ? (
        <div>
          <Button
            variant="ghost-muted"
            size="sm"
            onClick={() => {
              waitingForConnection.current = true;
              void openAuthorizationPage(async () => accountAppsPage.url);
            }}
          >
            {accountAppsPage.label}
          </Button>
        </div>
      ) : null}
    </ExtensionsSection>
  );
}

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
        <ExtensionsSection
          id={searchableSetting("extensions-connected-services").id}
          title="Connected services"
        >
          {inventory === null ? (
            <MutedLine>{inventoryError ? "Unavailable." : "Loading…"}</MutedLine>
          ) : !connectorsReach(selected) && accountServices.length === 0 ? (
            <MutedLine>
              {selected?.support?.reason ??
                `${selected?.label ?? "This agent"} does not support remote MCP servers.`}
            </MutedLine>
          ) : inventory.connectors.length === 0 && accountServices.length === 0 ? (
            <MutedLine>None yet. Find one in Discover, or add your own.</MutedLine>
          ) : (
            <>
              {selected?.support?.status === "conditional" && selected.support.reason ? (
                <MutedLine>{selected.support.reason}</MutedLine>
              ) : null}
              <ExtensionGrid label="Connected services">
                {accountServices.map((service) => (
                  <AccountServiceItem key={`account:${service.id}`} service={service} />
                ))}
                {(connectorsReach(selected) ? inventory.connectors : []).map((connector) => (
                  <ConnectorItem
                    key={connector.connectorId}
                    connector={connector}
                    entry={curated.find(
                      (entry) => entry.installedConnectorId === connector.connectorId,
                    )}
                  />
                ))}
              </ExtensionGrid>
            </>
          )}
        </ExtensionsSection>
      ) : null}

      {showsKind(kind, "plugins") ? (
        <ExtensionsSection
          id={searchableSetting("extensions-scient-plugins").id}
          title="Scient plugins"
        >
          {plugins.length === 0 ? (
            <MutedLine>{inventory === null ? "Loading…" : "None."}</MutedLine>
          ) : (
            <ExtensionGrid label="Scient plugins">
              {plugins.map((plugin) => (
                <PluginItem key={plugin.pluginId} plugin={plugin} />
              ))}
            </ExtensionGrid>
          )}
        </ExtensionsSection>
      ) : null}

      {kind === "skills" ? null : (
        <SettingsSearchTarget
          id={searchableSetting("extensions-provider-plugins").id}
          className="grid gap-10 outline-none"
        >
          {providerInventory.phase !== "ready" || groups.length === 0 ? (
            <ExtensionsSection title="From your agents">
              <MutedLine>{providerInventoryMessage(providerInventory)}</MutedLine>
              {providerInventory.errors.map((error) => (
                <MutedLine key={error}>{error}</MutedLine>
              ))}
            </ExtensionsSection>
          ) : null}
          {groups.map((group) => (
            <ProviderSection key={group.provider.instanceId} group={group} kind={kind} />
          ))}
        </SettingsSearchTarget>
      )}

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
