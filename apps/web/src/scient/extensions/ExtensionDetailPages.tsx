import type {
  ConnectorSummary,
  DiscoverEntry,
  ExtensionComponent,
  ProjectId,
  ScientPluginSummary,
  ServerProviderMcpServer,
  ServerProviderPlugin,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { CheckIcon, EllipsisIcon, type LucideIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Button, InlineButton } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { NativeSelect } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { useEnvironmentQuery } from "../../state/query";
import { AddConnectorDialog } from "./AddConnectorDialog";
import {
  type ConnectorActionsState,
  useAddEntry,
  useConnectorActions,
  usePluginActions,
  useProviderPluginActions,
  useProviderServerActions,
} from "./extensionActions";
import {
  ActionFeedback,
  ConnectorMenuItems,
  mcpServerSummary,
  PluginMenuItems,
} from "./ExtensionItems";
import { BackLink, ExtensionsPage, MutedLine, useExtensionsEnvironment } from "./ExtensionsPage";
import { ExtensionIcon } from "./ExtensionRow";
import { extensionsDiscoverPage } from "./extensionsState";
import {
  type ProviderExtensionGroup,
  catalogEntries,
  collectProviderExtensionGroups,
  connectorActions,
  connectorAuthLabel,
  connectorSourceLabel,
  CONNECTOR_STATUS_TEXT,
  entryName,
  entryTagline,
  isCatalogOnlyEntry,
  pluginGlyph,
  MCP_SERVER_STATUS_TEXT,
  TEST_OUTCOME_LABELS,
  workspaceLabel,
} from "./extensionsView";

type BackTo = "discover" | "installed";

function DetailBack({ to }: { readonly to: BackTo }) {
  return to === "discover" ? (
    <BackLink to="/settings/extensions">Discover</BackLink>
  ) : (
    <BackLink to="/settings/extensions/installed">Installed</BackLink>
  );
}

/** Large icon, name and tagline, then the primary action and a "⋯" menu. */
function DetailHeader({
  name,
  iconUrl,
  glyph,
  tagline,
  status,
  primary,
  menu,
}: {
  readonly name: string;
  readonly iconUrl?: string | undefined;
  readonly glyph?: LucideIcon | undefined;
  readonly tagline?: string | undefined;
  readonly status?: string | null | undefined;
  readonly primary: ReactNode;
  readonly menu?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center gap-4">
      <ExtensionIcon name={name} iconUrl={iconUrl} glyph={glyph} size="large" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="truncate text-xl font-semibold tracking-[-0.02em] text-foreground">
            {name}
          </h1>
          {status ? <span className="shrink-0 text-sm text-muted-foreground">{status}</span> : null}
        </div>
        {tagline ? <p className="text-sm text-muted-foreground">{tagline}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {primary}
        {menu}
      </div>
    </header>
  );
}

function DetailMenu({ name, children }: { readonly name: string; readonly children: ReactNode }) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-sm" variant="ghost-muted" aria-label={`More for ${name}`} />}
      >
        <EllipsisIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end">{children}</MenuPopup>
    </Menu>
  );
}

function Done({ children }: { readonly children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <CheckIcon aria-hidden className="size-4" />
      {children}
    </span>
  );
}

function DetailSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="grid gap-2" aria-label={title}>
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Facts({ rows }: { readonly rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ExternalLink({ href, children }: { readonly href: string; readonly children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-foreground underline underline-offset-2"
    >
      {children}
    </a>
  );
}

/**
 * Which agents of this environment can use a connected service: one summary
 * line, then only the agents with limits or no support, each with its reason.
 */
function WorksWithSection() {
  const { inventory } = useExtensionsEnvironment();
  const [showAll, setShowAll] = useState(false);
  const support = inventory?.providerSupport ?? [];
  const working = support.filter((entry) => entry.status !== "unsupported").length;
  // Agents with limits still work, so they count; they are listed with their limit.
  const exceptions = support.filter((entry) => entry.status !== "supported");
  const summary =
    working === support.length
      ? "Works with all your agents."
      : working === 0
        ? "Doesn't work with your agents."
        : `Works with ${working} of ${support.length} agents.`;
  const listed = showAll ? support : exceptions;
  return (
    <DetailSection title="Works with">
      {support.length === 0 ? (
        <MutedLine>No agents reported.</MutedLine>
      ) : (
        <>
          <p className="text-sm text-foreground">{summary}</p>
          {listed.length > 0 ? (
            <ul className="grid gap-1 text-sm" aria-label="Agents">
              {listed.map((entry) => (
                <li key={entry.providerInstanceId} data-support={entry.status}>
                  <span className="text-foreground">{entry.displayName}</span>
                  <span className="text-muted-foreground">
                    {" — "}
                    {entry.reason ??
                      (entry.status === "supported"
                        ? "Works"
                        : entry.status === "conditional"
                          ? "Works, with limits"
                          : "Not supported")}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {exceptions.length < support.length ? (
            <div className="text-sm">
              <InlineButton
                tone="muted"
                aria-expanded={showAll}
                onClick={() => setShowAll((current) => !current)}
              >
                {showAll ? "Show fewer" : `Show all ${support.length}`}
              </InlineButton>
            </div>
          ) : null}
        </>
      )}
    </DetailSection>
  );
}

function AboutSection({
  description,
  websiteUrl,
  repositoryUrl,
}: {
  readonly description: string | undefined;
  readonly websiteUrl?: string | undefined;
  readonly repositoryUrl?: string | undefined;
}) {
  if (!description && !websiteUrl && !repositoryUrl) return null;
  return (
    <DetailSection title="About">
      {description ? (
        <p className="max-w-prose whitespace-pre-line text-sm text-foreground/90">{description}</p>
      ) : null}
      {websiteUrl || repositoryUrl ? (
        <p className="flex gap-4 text-sm">
          {websiteUrl ? <ExternalLink href={websiteUrl}>Website</ExternalLink> : null}
          {repositoryUrl ? <ExternalLink href={repositoryUrl}>Source code</ExternalLink> : null}
        </p>
      ) : null}
    </DetailSection>
  );
}

/** All projects, or the projects picked here; each switch sends the whole new list. */
function AvailabilitySection({
  connector,
  name,
  locked,
  setAvailability,
}: {
  readonly connector: ConnectorSummary;
  readonly name: string;
  readonly locked: boolean;
  readonly setAvailability: ConnectorActionsState["setAvailability"];
}) {
  const { projects } = useExtensionsEnvironment();
  const availability = connector.availability;
  const selectedIds = availability.type === "projects" ? availability.projectIds : [];
  const toggle = (projectId: ProjectId, enabled: boolean) =>
    void setAvailability({
      type: "projects",
      projectIds: enabled
        ? [...selectedIds.filter((id) => id !== projectId), projectId]
        : selectedIds.filter((id) => id !== projectId),
    });
  return (
    <DetailSection title="Available in">
      <span className="w-48">
        <NativeSelect
          size="sm"
          aria-label={`Where ${name} is available`}
          value={availability.type}
          disabled={locked}
          onChange={(event) =>
            void setAvailability(
              event.target.value === "all-projects"
                ? { type: "all-projects" }
                : { type: "projects", projectIds: selectedIds },
            )
          }
        >
          <option value="all-projects">All projects</option>
          <option value="projects">Selected projects</option>
        </NativeSelect>
      </span>
      {availability.type === "projects" ? (
        <>
          {selectedIds.length === 0 ? <MutedLine>Not available in any project.</MutedLine> : null}
          {projects.length === 0 ? (
            <MutedLine>No projects yet.</MutedLine>
          ) : (
            <ul className="grid max-w-md gap-1.5" aria-label="Projects">
              {projects.map((project) => {
                const enabled = selectedIds.includes(project.id);
                return (
                  <li key={project.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate">{project.title}</span>
                    <Switch
                      size="sm"
                      checked={enabled}
                      disabled={locked}
                      aria-label={`${enabled ? "Turn off" : "Turn on"} in ${project.title}`}
                      onCheckedChange={(checked) => toggle(project.id, Boolean(checked))}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}
    </DetailSection>
  );
}

/** A connected service, optionally with the registry entry it came from. */
function ConnectorDetail({
  connector,
  entry,
  back,
}: {
  readonly connector: ConnectorSummary;
  readonly entry: DiscoverEntry | undefined;
  readonly back: BackTo;
}) {
  const actions = useConnectorActions(connector);
  const allowed = connectorActions(connector);
  const name = entry ? entryName(entry) : connector.displayName;
  // One pattern for every added connector: an On/Off switch, plus "Sign in"
  // while the service needs it. Status text says what is wrong, never "Off"
  // beside a contradicting "Connected".
  const primary = (
    <>
      {connector.status === "needs-auth" ? (
        <Button disabled={!actions.canSignIn} onClick={() => void actions.signIn()}>
          Sign in
        </Button>
      ) : null}
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Switch
          checked={connector.enabled}
          disabled={actions.locked}
          aria-label={`${connector.enabled ? "Turn off" : "Turn on"} ${name}`}
          onCheckedChange={(checked) => void actions.setEnabled(Boolean(checked))}
        />
        <span className="w-6">{connector.enabled ? "On" : "Off"}</span>
      </label>
    </>
  );
  return (
    <>
      <DetailBack to={back} />
      <DetailHeader
        name={name}
        iconUrl={entry?.iconUrl ?? connector.iconUrl}
        tagline={(entry ? entryTagline(entry) : undefined) ?? connector.description}
        status={connector.enabled ? CONNECTOR_STATUS_TEXT[connector.status] : null}
        primary={primary}
        menu={
          <DetailMenu name={name}>
            <ConnectorMenuItems connector={connector} actions={actions} toggle={false} />
          </DetailMenu>
        }
      />
      <div className="grid gap-1 empty:hidden">
        <ActionFeedback feedback={actions.feedback} waitingForSignIn={actions.waitingForSignIn} />
      </div>
      <AboutSection
        description={entry?.description ?? connector.description}
        websiteUrl={entry?.websiteUrl}
        repositoryUrl={entry?.repositoryUrl}
      />
      <WorksWithSection />
      <DetailSection title="Tools">
        <div>
          <Button
            size="xs"
            variant="outline"
            disabled={actions.locked || !allowed.canTest}
            onClick={() => void actions.test()}
          >
            {actions.busy === "test" ? "Testing…" : "Test"}
          </Button>
        </div>
        {!allowed.canTest ? <MutedLine>Sign in first to list its tools.</MutedLine> : null}
        {actions.testResult ? (
          <div className="grid gap-1 text-sm" role="status">
            <p className="text-muted-foreground">
              {TEST_OUTCOME_LABELS[actions.testResult.outcome]}
              {actions.testResult.serverName ? ` · ${actions.testResult.serverName}` : ""}
              {actions.testResult.serverVersion ? ` ${actions.testResult.serverVersion}` : ""}
              {actions.testResult.message ? ` · ${actions.testResult.message}` : ""}
            </p>
            {actions.testResult.tools.length > 0 ? (
              <ul className="grid gap-1" aria-label={`Tools of ${name}`}>
                {actions.testResult.tools.map((tool) => (
                  <li key={tool.name} className="flex min-w-0 gap-2">
                    <span className="shrink-0 font-mono text-xs">{tool.name}</span>
                    {tool.destructive ? (
                      <span className="shrink-0 text-xs text-destructive-foreground">
                        changes data
                      </span>
                    ) : tool.readOnly ? (
                      <span className="shrink-0 text-xs text-muted-foreground">read-only</span>
                    ) : null}
                    {tool.description ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {tool.description}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : actions.testResult.outcome === "ok" ? (
              <MutedLine>No tools reported.</MutedLine>
            ) : null}
          </div>
        ) : null}
      </DetailSection>
      <AvailabilitySection
        connector={connector}
        name={name}
        locked={actions.locked}
        setAvailability={actions.setAvailability}
      />
      <DetailSection title="Sign-in">
        <Facts rows={[["Method", connectorAuthLabel(connector.auth)]]} />
        {connector.status === "needs-credential" ? (
          <MutedLine>
            {connector.auth.type === "credential" && connector.auth.storage === "bound"
              ? "The secret this service used is no longer available."
              : "The stored key is gone. Remove this service and add it again."}
          </MutedLine>
        ) : null}
        {connector.lastError ? (
          <p className="text-sm text-destructive-foreground">{connector.lastError}</p>
        ) : null}
        {allowed.signIn ? (
          <div>
            <Button
              size="xs"
              variant="outline"
              disabled={!actions.canSignIn}
              onClick={() => void actions.signIn()}
            >
              {allowed.signIn === "sign-in" ? "Sign in" : "Reconnect"}
            </Button>
          </div>
        ) : null}
      </DetailSection>
      <DetailSection title="Advanced">
        <Facts
          rows={[
            [
              "URL",
              <span key="url" className="font-mono text-xs">
                {connector.url}
              </span>,
            ],
            [
              "Server name",
              <span key="server-name" className="font-mono text-xs">
                {connector.serverName}
              </span>,
            ],
            ["Source", connectorSourceLabel(connector.source)],
          ]}
        />
        <div>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={actions.locked}
            onClick={() => void actions.remove()}
          >
            Remove
          </Button>
        </div>
      </DetailSection>
    </>
  );
}

function ConnectorDetailContent({ connectorId }: { readonly connectorId: string }) {
  const { inventory, inventoryError, catalog } = useExtensionsEnvironment();
  const connector = inventory?.connectors.find((item) => item.connectorId === connectorId);
  if (!connector) {
    return (
      <>
        <DetailBack to="installed" />
        <MutedLine>
          {inventory === null ? (inventoryError ?? "Loading…") : "This service is not connected."}
        </MutedLine>
      </>
    );
  }
  const entry = catalogEntries(catalog).find((item) => item.installedConnectorId === connectorId);
  return <ConnectorDetail connector={connector} entry={entry} back="installed" />;
}

export function ConnectorDetailPage({ connectorId }: { readonly connectorId: string }) {
  return (
    <ExtensionsPage>
      <ConnectorDetailContent connectorId={connectorId} />
    </ExtensionsPage>
  );
}

/** A registry or curated server that is not added yet. */
function ServerDetail({ entry }: { readonly entry: DiscoverEntry }) {
  const { environmentId, callbackOrigin } = useExtensionsEnvironment();
  const actions = useAddEntry(entry);
  const [withOptions, setWithOptions] = useState(false);
  const name = entryName(entry);
  return (
    <>
      <DetailBack to="discover" />
      <DetailHeader
        name={name}
        iconUrl={entry.iconUrl}
        tagline={entryTagline(entry)}
        primary={
          <Button disabled={!actions.canAdd || actions.locked} onClick={() => void actions.add()}>
            {actions.busy === "add" ? "Adding…" : "Add"}
          </Button>
        }
        menu={
          actions.canAdd ? (
            <DetailMenu name={name}>
              <MenuItem disabled={actions.locked} onClick={() => setWithOptions(true)}>
                Add with options…
              </MenuItem>
            </DetailMenu>
          ) : null
        }
      />
      <div className="grid gap-1 empty:hidden">
        {!actions.canAdd ? (
          <MutedLine>
            {entry.unsupportedReason ??
              "Scient can't add this server: it has no remote endpoint to connect to."}
          </MutedLine>
        ) : null}
        <ActionFeedback feedback={actions.feedback} />
      </div>
      <AboutSection
        description={entry.description}
        websiteUrl={entry.websiteUrl}
        repositoryUrl={entry.repositoryUrl}
      />
      <WorksWithSection />
      <DetailSection title="Advanced">
        <Facts
          rows={[
            ...(isCatalogOnlyEntry(entry)
              ? [["Listed by", "Scient catalog"] as const]
              : [
                  [
                    "Registry name",
                    <span key="registry-name" className="font-mono text-xs">
                      {entry.name}
                    </span>,
                  ] as const,
                  ["Version", entry.version] as const,
                ]),
            ...entry.remotes.map(
              (remote, index) =>
                [
                  entry.remotes.length > 1 ? `Endpoint ${index + 1}` : "Endpoint",
                  <span key={remote.url} className="font-mono text-xs">
                    {remote.url} ({remote.type})
                  </span>,
                ] as const,
            ),
          ]}
        />
      </DetailSection>
      {withOptions ? (
        <AddConnectorDialog
          open
          onOpenChange={(open) => {
            if (!open) setWithOptions(false);
          }}
          environmentId={environmentId}
          entry={entry}
          callbackOrigin={callbackOrigin}
        />
      ) : null}
    </>
  );
}

/** Curated entries come with the catalog; others are looked up by name. */
function ServerDetailContent({ name }: { readonly name: string }) {
  const { environmentId, catalog, inventory } = useExtensionsEnvironment();
  const curated = catalogEntries(catalog).find((entry) => entry.name === name);
  const search = useEnvironmentQuery(
    curated || catalog === null
      ? null
      : extensionsDiscoverPage({ environmentId, input: { query: name } }),
  );
  const entry = curated ?? search.data?.entries.find((candidate) => candidate.name === name);
  if (!entry) {
    return (
      <>
        <DetailBack to="discover" />
        <MutedLine>
          {search.error ??
            (catalog === null || search.isPending ? "Loading…" : "This server was not found.")}
        </MutedLine>
      </>
    );
  }
  const connector =
    entry.installedConnectorId === undefined
      ? undefined
      : inventory?.connectors.find((item) => item.connectorId === entry.installedConnectorId);
  if (connector) return <ConnectorDetail connector={connector} entry={entry} back="discover" />;
  return <ServerDetail entry={entry} />;
}

export function ServerDetailPage({ name }: { readonly name: string }) {
  return (
    <ExtensionsPage>
      <ServerDetailContent name={name} />
    </ExtensionsPage>
  );
}

const COMPONENT_LABELS: Readonly<Record<ExtensionComponent["type"], string>> = {
  skill: "Skill",
  "mcp-tools": "Tools",
  connector: "Connected service",
  settings: "Settings",
  panel: "Panel",
};

function PluginDetail({ plugin }: { readonly plugin: ScientPluginSummary }) {
  const actions = usePluginActions(plugin);
  const navigate = useNavigate();
  const builtIn = plugin.origin === "built-in";
  const settingsPath = plugin.settingsPath;
  const hasMenu = plugin.canSetEnabled || plugin.canRemove;
  return (
    <>
      <DetailBack to={builtIn ? "discover" : "installed"} />
      <DetailHeader
        name={plugin.displayName}
        glyph={pluginGlyph(plugin)}
        tagline={plugin.description}
        status={!builtIn && !plugin.enabled ? "Off" : null}
        primary={
          builtIn && settingsPath?.startsWith("/settings/") ? (
            <Button variant="outline" onClick={() => void navigate({ to: settingsPath })}>
              Open settings
            </Button>
          ) : (
            <Done>{builtIn ? "Built in" : "Installed"}</Done>
          )
        }
        menu={
          hasMenu ? (
            <DetailMenu name={plugin.displayName}>
              <PluginMenuItems plugin={plugin} actions={actions} />
            </DetailMenu>
          ) : null
        }
      />
      <div className="grid gap-1 empty:hidden">
        <ActionFeedback feedback={actions.feedback} />
      </div>
      <DetailSection title="About">
        <Facts
          rows={[
            ["Publisher", plugin.publisher],
            ["Version", plugin.version],
          ]}
        />
      </DetailSection>
      {plugin.components.length > 0 ? (
        <DetailSection title="Includes">
          <ul className="grid gap-1.5 text-sm" aria-label="Includes">
            {plugin.components.map((component) => (
              <li key={`${component.type}:${component.name}`}>
                <span className="text-muted-foreground">{COMPONENT_LABELS[component.type]} · </span>
                {component.type === "skill" ? (
                  <Link
                    to="/settings/skills"
                    className="text-foreground underline underline-offset-2"
                  >
                    {component.name}
                  </Link>
                ) : (
                  <span className="text-foreground">{component.name}</span>
                )}
                {component.detail ? (
                  <span className="block text-xs text-muted-foreground">{component.detail}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </DetailSection>
      ) : null}
      {!builtIn ? (
        <DetailSection title="Advanced">
          <Facts
            rows={[
              ...(plugin.digest
                ? [
                    [
                      "SHA-256",
                      <span key="digest" className="font-mono text-xs">
                        {plugin.digest}
                      </span>,
                    ] as const,
                  ]
                : []),
              ...(plugin.installedAt ? [["Installed", plugin.installedAt] as const] : []),
            ]}
          />
          {plugin.canRemove ? (
            <div>
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={actions.locked}
                onClick={() => void actions.remove()}
              >
                Remove
              </Button>
            </div>
          ) : null}
        </DetailSection>
      ) : null}
    </>
  );
}

function PluginDetailContent({ pluginId }: { readonly pluginId: string }) {
  const { inventory, inventoryError } = useExtensionsEnvironment();
  const plugin = inventory?.plugins.find((item) => item.pluginId === pluginId);
  if (!plugin) {
    return (
      <>
        <DetailBack to="installed" />
        <MutedLine>
          {inventory === null ? (inventoryError ?? "Loading…") : "This plugin is not installed."}
        </MutedLine>
      </>
    );
  }
  return <PluginDetail plugin={plugin} />;
}

export function PluginDetailPage({ pluginId }: { readonly pluginId: string }) {
  return (
    <ExtensionsPage>
      <PluginDetailContent pluginId={pluginId} />
    </ExtensionsPage>
  );
}

function useProviderGroup(instanceId: string): ProviderExtensionGroup | undefined {
  const { providers } = useExtensionsEnvironment();
  return collectProviderExtensionGroups(providers, null).find(
    (group) => group.provider.instanceId === instanceId,
  );
}

function ProviderPluginDetailContent({
  instanceId,
  pluginId,
  workspace,
}: {
  readonly instanceId: string;
  readonly pluginId: string;
  readonly workspace: string | undefined;
}) {
  const group = useProviderGroup(instanceId);
  const found = group?.plugins.find(
    (entry) => entry.plugin.id === pluginId && entry.cwd === workspace,
  );
  if (!group || !found) {
    return (
      <>
        <DetailBack to="installed" />
        <MutedLine>This plugin is no longer reported.</MutedLine>
      </>
    );
  }
  return <ProviderPluginDetail group={group} plugin={found.plugin} workspace={workspace} />;
}

function ProviderPluginDetail({
  group,
  plugin,
  workspace,
}: {
  readonly group: ProviderExtensionGroup;
  readonly plugin: ServerProviderPlugin;
  readonly workspace: string | undefined;
}) {
  const actions = useProviderPluginActions(group.provider, group.label, plugin, workspace);
  const name = plugin.displayName ?? plugin.name;
  const uninstall =
    plugin.canUninstall === true ? (
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={actions.locked}
        onClick={() => void actions.uninstall()}
      >
        Uninstall
      </Button>
    ) : null;
  return (
    <>
      <DetailBack to="installed" />
      <DetailHeader
        name={name}
        tagline={plugin.description}
        status={plugin.enabled ? null : "Off"}
        primary={<Done>Installed</Done>}
        menu={
          plugin.canUninstall === true ? (
            <DetailMenu name={name}>
              <MenuItem
                variant="destructive"
                disabled={actions.locked}
                onClick={() => void actions.uninstall()}
              >
                Uninstall
              </MenuItem>
            </DetailMenu>
          ) : null
        }
      />
      <div className="grid gap-1 empty:hidden">
        <ActionFeedback feedback={actions.feedback} />
      </div>
      <DetailSection title={`Managed by ${group.label}`}>
        <Facts
          rows={[
            ...(plugin.version ? [["Version", plugin.version] as const] : []),
            ...(plugin.marketplace ? [["Marketplace", plugin.marketplace] as const] : []),
            ...(workspace ? [["Workspace", workspaceLabel(workspace)] as const] : []),
            ["State", plugin.enabled ? "On" : "Off"],
          ]}
        />
        <MutedLine>{group.label} installs and updates this plugin.</MutedLine>
        {uninstall ? <div>{uninstall}</div> : null}
      </DetailSection>
    </>
  );
}

export function ProviderPluginDetailPage(props: {
  readonly instanceId: string;
  readonly pluginId: string;
  readonly workspace: string | undefined;
}) {
  return (
    <ExtensionsPage>
      <ProviderPluginDetailContent {...props} />
    </ExtensionsPage>
  );
}

function ProviderServerDetailContent({
  instanceId,
  serverName,
}: {
  readonly instanceId: string;
  readonly serverName: string;
}) {
  const group = useProviderGroup(instanceId);
  const server = group?.mcpServers.find((candidate) => candidate.name === serverName);
  if (!group || !server) {
    return (
      <>
        <DetailBack to="installed" />
        <MutedLine>This MCP server is no longer reported.</MutedLine>
      </>
    );
  }
  return <ProviderServerDetail group={group} server={server} />;
}

function ProviderServerDetail({
  group,
  server,
}: {
  readonly group: ProviderExtensionGroup;
  readonly server: ServerProviderMcpServer;
}) {
  const actions = useProviderServerActions(group.provider, group.label, server);
  const canSignIn = server.canStartSignIn === true;
  return (
    <>
      <DetailBack to="installed" />
      <DetailHeader
        name={server.name}
        tagline={mcpServerSummary(server)}
        status={server.status === "connected" ? null : MCP_SERVER_STATUS_TEXT[server.status]}
        primary={
          server.status === "connected" ? (
            <Done>Connected</Done>
          ) : canSignIn ? (
            <Button disabled={actions.locked} onClick={() => void actions.signIn()}>
              Sign in
            </Button>
          ) : null
        }
      />
      <div className="grid gap-1 empty:hidden">
        <ActionFeedback feedback={actions.feedback} />
      </div>
      <DetailSection title={`Managed by ${group.label}`}>
        <Facts
          rows={[
            ["Status", MCP_SERVER_STATUS_TEXT[server.status] ?? "Connected"],
            ...(server.toolCount === undefined
              ? []
              : [["Tools", String(server.toolCount)] as const]),
            ...(server.scope ? [["Scope", server.scope] as const] : []),
            ...(server.pluginId ? [["From plugin", server.pluginId] as const] : []),
          ]}
        />
        {server.error ? (
          <p className="text-sm text-destructive-foreground">{server.error}</p>
        ) : null}
        <MutedLine>{group.label} configures and runs this server.</MutedLine>
        {canSignIn && server.status === "connected" ? (
          <div>
            <Button
              size="xs"
              variant="outline"
              disabled={actions.locked}
              onClick={() => void actions.signIn()}
            >
              Sign in again
            </Button>
          </div>
        ) : null}
      </DetailSection>
    </>
  );
}

export function ProviderServerDetailPage(props: {
  readonly instanceId: string;
  readonly serverName: string;
}) {
  return (
    <ExtensionsPage>
      <ProviderServerDetailContent {...props} />
    </ExtensionsPage>
  );
}
