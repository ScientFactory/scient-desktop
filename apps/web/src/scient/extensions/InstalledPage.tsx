import type { ProviderInstanceId } from "@t3tools/contracts";
import { FolderOpenIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useRef, useState } from "react";

import { SettingsSearchTarget } from "../../components/settings/settingsLayout";
import { searchableSetting } from "../../components/settings/settingsSearch";
import { useAtomCommand } from "../../state/use-atom-command";
import { actOnProviderPlugin } from "./extensionsState";
import { openAuthorizationPage } from "./openAuthorizationPage";
import { Button } from "../../components/ui/button";
import { NativeSelect } from "../../components/ui/select";
import { AddConnectorDialog } from "./AddConnectorDialog";
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
import { InstallBundleDialog } from "./InstallBundleDialog";
import { providerInventoryMessage } from "./providerInventory";
import { useWindowFocusRefresh } from "./useWindowFocusRefresh";
import { AgentSkills } from "../skills/AgentSkills";
import { ProjectSkills } from "../skills/ProjectSkills";
import { ScientSkillsLibrary } from "../skills/ScientSkillsLibrary";

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
  const { environmentId, canWrite } = useExtensionsEnvironment();
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
    ...(showsKind(kind, "connectors") ? group.mcpServers : []).map((server) => (
      <ProviderServerItem
        key={`server:${server.name}`}
        provider={group.provider}
        label={group.label}
        server={server}
      />
    )),
  ];
  const title = `From ${group.label}`;
  if (kind !== undefined && rows.length === 0) return null;
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
      {group.provider.driver === "claudeAgent" && group.provider.accountAppsAvailable === true ? (
        <div>
          <Button
            variant="ghost-muted"
            size="sm"
            onClick={() => {
              waitingForConnection.current = true;
              void openAuthorizationPage(async () => "https://claude.ai/settings/connectors");
            }}
          >
            Add more on claude.ai
          </Button>
        </div>
      ) : null}
    </ExtensionsSection>
  );
}

function Installed({ kind }: { readonly kind: ExtensionKind | undefined }) {
  const {
    environmentId,
    callbackOrigin,
    inventory,
    inventoryError,
    catalog,
    providers,
    providerInventory,
    canWrite,
  } = useExtensionsEnvironment();
  const [worksWith, setWorksWith] = useState<ProviderInstanceId | null>(null);
  const [dialog, setDialog] = useState<"add" | "install" | null>(null);
  const options = worksWithOptions(inventory?.providerSupport ?? [], providers);
  const selected = options.find((option) => option.instanceId === worksWith) ?? null;
  const groups = collectProviderExtensionGroups(
    providerInventory.providers,
    selected?.instanceId ?? null,
  );
  const curated = catalogEntries(catalog);
  const plugins = [
    ...(inventory?.plugins.filter((plugin) => plugin.origin === "bundle") ?? []),
    ...(inventory?.plugins.filter((plugin) => plugin.origin === "built-in") ?? []),
  ];

  return (
    <>
      <ExtensionsTopBar tab="installed" kind={kind}>
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

      {showsKind(kind, "connectors") ? (
        <ExtensionsSection
          id={searchableSetting("extensions-connected-services").id}
          title="Connected services"
          action={
            <SectionAction icon={PlusIcon} disabled={!canWrite} onClick={() => setDialog("add")}>
              Add by URL
            </SectionAction>
          }
        >
          {inventory === null ? (
            <MutedLine>{inventoryError ? "Unavailable." : "Loading…"}</MutedLine>
          ) : !connectorsReach(selected) ? (
            <MutedLine>
              {selected?.support?.reason ??
                `${selected?.label ?? "This agent"} does not support remote MCP servers.`}
            </MutedLine>
          ) : inventory.connectors.length === 0 ? (
            <MutedLine>None yet. Add one from Discover or by URL.</MutedLine>
          ) : (
            <>
              {selected?.support?.status === "conditional" && selected.support.reason ? (
                <MutedLine>{selected.support.reason}</MutedLine>
              ) : null}
              <ExtensionGrid label="Connected services">
                {inventory.connectors.map((connector) => (
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
          action={
            <SectionAction
              icon={FolderOpenIcon}
              disabled={!canWrite}
              onClick={() => setDialog("install")}
            >
              Install from folder
            </SectionAction>
          }
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
          <ExtensionsSection title="Scient skills">
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

      {dialog === "add" ? (
        <AddConnectorDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          environmentId={environmentId}
          entry={null}
          callbackOrigin={callbackOrigin}
        />
      ) : null}
      {dialog === "install" ? (
        <InstallBundleDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
        />
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
