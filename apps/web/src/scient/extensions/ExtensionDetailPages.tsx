import {
  type ConnectorProviderSupport,
  type ConnectorSummary,
  type ConnectorTestResult,
  type DiscoverCatalog,
  type DiscoverEntry,
  type ExtensionComponent,
  ExtensionsError,
  type ProjectId,
  type ScientPluginSummary,
  type ServerProviderMcpServer,
  type ServerProviderPlugin,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ChevronRightIcon,
  DownloadIcon,
  EllipsisIcon,
  LogInIcon,
  type LucideIcon,
  RefreshCwIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { Button } from "../../components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { ScrollArea } from "../../components/ui/scroll-area";
import { NativeSelect } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
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
import { ActionFeedback, mcpServerSummary } from "./ExtensionItems";
import {
  BackLink,
  ExtensionsPage,
  GHOST_LINK_CLASS,
  MutedLine,
  SECTION_HEADING_CLASS,
  useExtensionsEnvironment,
} from "./ExtensionsPage";
import { ExtensionIcon } from "./ExtensionRow";
import { extensionsDiscoverEntry } from "./extensionsState";
import {
  type ProviderExtensionGroup,
  type ToolGroups,
  catalogEntries,
  collectProviderExtensionGroups,
  connectorActions,
  connectorAuthLabel,
  connectorSourceLabel,
  entryName,
  entrySourceLabel,
  entryTagline,
  groupTools,
  isCatalogOnlyEntry,
  MCP_SERVER_STATUS_TEXT,
  pluginGlyph,
  TEST_OUTCOME_LABELS,
  urlHost,
  workspaceLabel,
} from "./extensionsView";

const isExtensionsError = Schema.is(ExtensionsError);

type BackTo = "discover" | "installed";

function DetailBack({ to }: { readonly to: BackTo }) {
  return to === "discover" ? (
    <BackLink to="/settings/extensions">Discover</BackLink>
  ) : (
    <BackLink to="/settings/extensions/installed">Installed</BackLink>
  );
}

/**
 * Every detail page: a header with the item's actions, an optional longer
 * description and feedback, then its cards.
 */
function DetailLayout({
  back,
  header,
  description,
  feedback,
  children,
}: {
  readonly back: BackTo;
  readonly header: ReactNode;
  readonly description?: string | undefined;
  readonly feedback?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <>
      <DetailBack to={back} />
      <article className="grid gap-6">
        <div className="grid gap-4">
          {header}
          {description ? (
            <p className="max-w-prose whitespace-pre-line text-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
          {feedback ? <div className="grid gap-1 empty:hidden">{feedback}</div> : null}
        </div>
        <div className="grid gap-8">{children}</div>
      </article>
    </>
  );
}

/** 64px icon, name and tagline; the item's buttons on the right. */
function DetailHeader({
  name,
  iconUrl,
  glyph,
  tagline,
  actions,
}: {
  readonly name: string;
  readonly iconUrl?: string | undefined;
  readonly glyph?: LucideIcon | undefined;
  readonly tagline?: string | undefined;
  readonly actions: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center gap-4">
      <ExtensionIcon name={name} iconUrl={iconUrl} glyph={glyph} size="large" />
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-2xl font-medium tracking-[-0.02em] text-foreground">{name}</h1>
        {tagline ? <p className="text-sm text-muted-foreground">{tagline}</p> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
    </header>
  );
}

/** A longer description only when it says more than the tagline. */
function extraDescription(description: string | undefined, tagline: string | undefined) {
  const text = description?.trim();
  return text && text !== tagline?.trim() ? text : undefined;
}

/**
 * The item's main action, drawn like the provider "Install" button in
 * Settings → Providers: a borderless primary-colour button with a leading icon.
 */
function PrimaryAction({
  icon: Icon,
  disabled,
  onClick,
  children,
}: {
  readonly icon: LucideIcon;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <Button
      size="sm"
      type="button"
      variant="ghost-primary"
      data-primary-action=""
      disabled={disabled}
      onClick={onClick}
    >
      <Icon aria-hidden />
      {children}
    </Button>
  );
}

function MoreMenu({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="icon-sm" variant="ghost-muted" aria-label={label} />}>
        <EllipsisIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end">{children}</MenuPopup>
    </Menu>
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
    <section className="grid gap-3" aria-label={title}>
      <h2 className={SECTION_HEADING_CLASS}>{title}</h2>
      {children}
    </section>
  );
}

const CARD_CLASS = "divide-y divide-border overflow-hidden rounded-xl border bg-card";

function CardRow({ children }: { readonly children: ReactNode }) {
  return <div className="flex min-h-14 items-center gap-3 px-4 py-3">{children}</div>;
}

/** A row inside a card that belongs to the row above it. */
function NestedRow({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 py-2 pr-4 pl-8 text-sm">
      {children}
    </div>
  );
}

type Fact = readonly [label: string, value: ReactNode];

function fact(label: string, value: ReactNode | null | undefined): Fact | null {
  return value === null || value === undefined || value === "" ? null : [label, value];
}

/** Key/value rows in a card; rows without data are left out. */
function AboutCard({ rows }: { readonly rows: ReadonlyArray<Fact | null> }) {
  const shown = rows.filter((row) => row !== null);
  if (shown.length === 0) return null;
  return (
    <DetailSection title="About">
      <dl className={cn(CARD_CLASS, "text-sm")}>
        {shown.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[35%_minmax(0,1fr)] gap-4 px-4 py-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </DetailSection>
  );
}

function ExternalLink({ href }: { readonly href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(GHOST_LINK_CLASS, "text-foreground")}
    >
      {urlHost(href) ?? href}
    </a>
  );
}

function Mono({ children }: { readonly children: string }) {
  return <span className="font-mono text-xs leading-5">{children}</span>;
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function formatDate(iso: string | undefined): string | undefined {
  return iso === undefined ? undefined : DATE_FORMAT.format(new Date(iso));
}

/** Curated categories by their section titles; "featured" is a shelf, not a category. */
function categoryLabel(entry: DiscoverEntry | undefined, catalog: DiscoverCatalog | null) {
  const categories = entry?.categories.filter((category) => category !== "featured") ?? [];
  if (categories.length === 0) return undefined;
  return categories
    .map(
      (category) =>
        catalog?.sections.find((section) => section.category === category)?.title ??
        category.charAt(0).toUpperCase() + category.slice(1),
    )
    .join(", ");
}

/** "All agents", "4 agents": agents with limits can use the service, so they count. */
function worksWithCount(support: ReadonlyArray<ConnectorProviderSupport>): string {
  const usable = support.filter((entry) => entry.status !== "unsupported").length;
  if (usable === support.length) return "All agents";
  if (usable === 0) return "None of your agents";
  return `${usable} ${usable === 1 ? "agent" : "agents"}`;
}

/** An agent's logo with its name below; an amber dot marks one that works with limits. */
function AgentTileContent({
  entry,
  iconUrl,
}: {
  readonly entry: ConnectorProviderSupport;
  readonly iconUrl: string | undefined;
}) {
  return (
    <>
      <ProviderInstanceIcon
        driverKind={entry.driver}
        displayName={entry.displayName}
        acpRegistryIconUrl={iconUrl}
        iconClassName="size-7"
        indicatorBackground="var(--popover)"
        {...(entry.status === "conditional" ? { statusDotClassName: "bg-warning" } : {})}
      />
      <span className="line-clamp-2 w-full text-xs leading-tight text-muted-foreground">
        {entry.displayName}
      </span>
    </>
  );
}

const AGENT_TILE_CLASS = "flex w-[4.5rem] flex-col items-center gap-1.5 py-1 text-center";

/** How long the pointer rests on "Works with" before its card opens. */
const WORKS_WITH_OPEN_DELAY_MS = 200;

/**
 * A limited agent's tile tells why on hover, keyboard focus, or a tap. The
 * tooltip opens from inside the card, so the card stays open with it.
 *
 * A press pins the reason open and the next press unpins it. Hover or focus
 * only shows it, so a tap that lands just after focus (or a hover) opened it
 * pins it rather than closing it again.
 */
function LimitedAgentTile({
  entry,
  iconUrl,
}: {
  readonly entry: ConnectorProviderSupport;
  readonly iconUrl: string | undefined;
}) {
  const [shown, setShown] = useState<"closed" | "shown" | "pinned">("closed");
  const reason = entry.reason ?? "Works with limits";
  return (
    <Tooltip
      open={shown !== "closed"}
      onOpenChange={(next, details) => {
        // Presses are handled below; everything else shows or hides it.
        if (details.reason === "trigger-press") return;
        if (!next) setShown("closed");
        else setShown((current) => (current === "pinned" ? "pinned" : "shown"));
      }}
    >
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${entry.displayName}: ${reason}`}
            onClick={() => setShown((current) => (current === "pinned" ? "closed" : "pinned"))}
            className={cn(
              AGENT_TILE_CLASS,
              "cursor-default rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            )}
          />
        }
      >
        <AgentTileContent entry={entry} iconUrl={iconUrl} />
      </TooltipTrigger>
      <TooltipPopup side="top">{reason}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * How many agents can use this service. Hovering it, or pressing it (click,
 * tap, Enter), opens a card of their logos above it, scrolling sideways when
 * they don't fit. Opened from the keyboard, focus moves into the card so Tab
 * reaches a limited agent's reason. Agents that can't use it are left out of
 * the card; the count already says so.
 */
function WorksWithValue() {
  const { inventory, providers } = useExtensionsEnvironment();
  const support = inventory?.providerSupport ?? [];
  if (support.length === 0) {
    return <span className="text-muted-foreground">No agents reported</span>;
  }
  const usable = support.filter((entry) => entry.status !== "unsupported");
  const count = worksWithCount(support);
  if (usable.length === 0) return <span>{count}</span>;
  const iconUrlOf = (entry: ConnectorProviderSupport) =>
    providers.find((provider) => provider.instanceId === entry.providerInstanceId)?.iconUrl;
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={WORKS_WITH_OPEN_DELAY_MS}
        closeDelay={120}
        render={
          <button
            type="button"
            aria-label={`Works with: ${count}`}
            className={cn(GHOST_LINK_CLASS, "text-foreground")}
          />
        }
      >
        {count}
      </PopoverTrigger>
      {/* Above the count, left edges aligned; below only when there is no room
          above, and shifted sideways only as far as the viewport needs. */}
      <PopoverPopup
        side="top"
        align="start"
        sideOffset={8}
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        padding="comfortable"
        aria-label="Agents"
        initialFocus={(openType) => openType === "keyboard"}
        className="w-max"
      >
        {/* The width limit sits on the content, independent of the positioner's
            measurements, so the card is measured, and placed, at that width.
            A wide 4rem fade marks whichever edge still has more agents, so the
            row reads as scrollable. */}
        <ScrollArea
          scrollFade
          hideScrollbars
          className="h-auto max-w-[min(396px,calc(100vw-3rem))] [&>[data-slot=scroll-area-viewport]]:[--fade-size:4rem]"
        >
          <ul className="flex w-max gap-1">
            {usable.map((entry) => (
              <li
                key={entry.providerInstanceId}
                data-support={entry.status}
                className={entry.status === "conditional" ? undefined : AGENT_TILE_CLASS}
              >
                {entry.status === "conditional" ? (
                  <LimitedAgentTile entry={entry} iconUrl={iconUrlOf(entry)} />
                ) : (
                  <AgentTileContent entry={entry} iconUrl={iconUrlOf(entry)} />
                )}
              </li>
            ))}
          </ul>
        </ScrollArea>
      </PopoverPopup>
    </Popover>
  );
}

interface DetailRow {
  readonly key: string;
  readonly name: ReactNode;
  readonly detail?: ReactNode;
}

interface DetailGroup {
  readonly label: string;
  readonly rows: ReadonlyArray<DetailRow>;
}

function DetailGroupRow({ group }: { readonly group: DetailGroup }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-foreground/[0.035]">
        <span className="font-medium text-foreground">{group.label}</span>
        <span className="flex items-center gap-1.5 text-muted-foreground tabular-nums">
          {group.rows.length}
          <ChevronRightIcon
            aria-hidden
            className="size-4 transition-transform group-data-[panel-open]:rotate-90"
          />
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ul aria-label={group.label} className="divide-y divide-border border-t">
          {group.rows.map((row) => (
            <li
              key={row.key}
              className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4 px-4 py-2.5 text-sm"
            >
              <span className="min-w-0 break-words text-foreground">{row.name}</span>
              <span className="min-w-0 break-words text-muted-foreground">{row.detail}</span>
            </li>
          ))}
        </ul>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** Collapsible groups in one card; empty groups are left out. */
function GroupsCard({
  label,
  groups,
}: {
  readonly label: string;
  readonly groups: ReadonlyArray<DetailGroup>;
}) {
  return (
    <div role="group" aria-label={label} className={CARD_CLASS}>
      {groups
        .filter((group) => group.rows.length > 0)
        .map((group) => (
          <DetailGroupRow key={group.label} group={group} />
        ))}
    </div>
  );
}

function MutedCard({ children }: { readonly children: string }) {
  return (
    <div className={CARD_CLASS}>
      <p className="px-4 py-3 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function toolRows(tools: ToolGroups["read"]): ReadonlyArray<DetailRow> {
  return tools.map((tool) => ({
    key: tool.name,
    name: <span className="font-mono text-xs leading-5">{tool.name}</span>,
    detail: tool.description?.trim() || tool.title,
  }));
}

const TOOLS_AFTER_SIGN_IN = "Tools appear after you add and sign in.";

/**
 * A connector's tools, grouped from its last test. Nothing runs on its own:
 * "See tools" runs one test, then the groups show.
 */
function ToolsSection({
  canTest,
  locked,
  testing,
  testResult,
  onTest,
}: {
  readonly canTest: boolean;
  readonly locked: boolean;
  readonly testing: boolean;
  readonly testResult: ConnectorTestResult | null;
  readonly onTest: () => void;
}) {
  if (!canTest || testResult?.outcome === "ok") {
    const grouped = testResult?.outcome === "ok" ? groupTools(testResult.tools) : null;
    return (
      <DetailSection title="Tools">
        {grouped === null ? (
          <MutedCard>{TOOLS_AFTER_SIGN_IN}</MutedCard>
        ) : testResult?.tools.length === 0 ? (
          <MutedCard>No tools reported.</MutedCard>
        ) : (
          <GroupsCard
            label="Tool groups"
            groups={[
              { label: "Write", rows: toolRows(grouped.write) },
              { label: "Read", rows: toolRows(grouped.read) },
              { label: "Other", rows: toolRows(grouped.other) },
            ]}
          />
        )}
      </DetailSection>
    );
  }
  return (
    <DetailSection title="Tools">
      <div className={CARD_CLASS}>
        <button
          type="button"
          disabled={locked}
          onClick={onTest}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm transition-colors not-disabled:hover:bg-foreground/[0.035] disabled:cursor-default"
        >
          <span className="font-medium text-foreground">
            {testing ? "Listing tools…" : testResult ? "Try again" : "See tools"}
          </span>
          <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />
        </button>
        {testResult ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {TEST_OUTCOME_LABELS[testResult.outcome]}
            {testResult.message ? ` · ${testResult.message}` : ""}
          </p>
        ) : null}
      </div>
    </DetailSection>
  );
}

function connectionState(connector: ConnectorSummary): string {
  if (connector.status === "needs-auth") return "Needs sign-in";
  if (connector.status === "needs-credential") return "Key missing";
  return connector.auth.type === "none" ? "No sign-in needed" : "Signed in";
}

function connectionDetail(connector: ConnectorSummary, busy: string | null): string {
  if (busy === "sign-in") return "Opening sign-in…";
  if (connector.status === "needs-credential") {
    return connector.auth.type === "credential" && connector.auth.storage === "bound"
      ? "The secret this service used is no longer available."
      : "The stored key is gone. Remove this service and add it again.";
  }
  return connector.auth.type === "none"
    ? (urlHost(connector.url) ?? connector.url)
    : connectorAuthLabel(connector.auth);
}

/**
 * "Available in" with the projects it names. A saved project deleted since
 * shows as "Deleted project". Every change leaves deleted projects out: the
 * server refuses a list that names one, and dropping it only narrows where
 * the service is available.
 */
function AvailabilityRows({
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
  const { projects, projectsKnown } = useExtensionsEnvironment();
  const availability = connector.availability;
  const selectedIds = availability.type === "projects" ? availability.projectIds : [];
  const existing = new Set(projects.map((project) => project.id));
  // Until the project list arrives, an id missing from it proves nothing.
  const deletedIds = projectsKnown ? selectedIds.filter((id) => !existing.has(id)) : [];
  const liveIds = selectedIds.filter((id) => !deletedIds.includes(id));
  const sendProjects = (projectIds: ReadonlyArray<ProjectId>) =>
    void setAvailability({ type: "projects", projectIds });
  const toggle = (projectId: ProjectId, enabled: boolean) => {
    const others = liveIds.filter((id) => id !== projectId);
    sendProjects(enabled ? [...others, projectId] : others);
  };
  return (
    <div role="group" aria-label="Available in" className="divide-y divide-border">
      <CardRow>
        <span className="min-w-0 flex-1 text-sm text-foreground">Available in</span>
        <span className="w-44">
          <NativeSelect
            size="sm"
            aria-label={`Where ${name} is available`}
            value={availability.type}
            disabled={locked}
            onChange={(event) =>
              event.target.value === "all-projects"
                ? void setAvailability({ type: "all-projects" })
                : sendProjects(liveIds)
            }
          >
            <option value="all-projects">All projects</option>
            <option value="projects">Selected projects</option>
          </NativeSelect>
        </span>
      </CardRow>
      {availability.type === "projects" ? (
        <>
          {liveIds.length === 0 ? (
            <NestedRow>
              <span className="text-muted-foreground">Not available in any project.</span>
            </NestedRow>
          ) : null}
          {!projectsKnown ? (
            <NestedRow>
              <span className="text-muted-foreground">Loading projects…</span>
            </NestedRow>
          ) : projects.length === 0 && deletedIds.length === 0 ? (
            <NestedRow>
              <span className="text-muted-foreground">No projects yet.</span>
            </NestedRow>
          ) : null}
          {projectsKnown
            ? projects.map((project) => {
                const enabled = liveIds.includes(project.id);
                return (
                  <NestedRow key={project.id}>
                    <span className="min-w-0 truncate text-foreground">{project.title}</span>
                    <Switch
                      size="sm"
                      checked={enabled}
                      disabled={locked}
                      aria-label={`${enabled ? "Turn off" : "Turn on"} in ${project.title}`}
                      onCheckedChange={(checked) => toggle(project.id, Boolean(checked))}
                    />
                  </NestedRow>
                );
              })
            : null}
          {deletedIds.map((projectId) => (
            <NestedRow key={projectId}>
              <span className="min-w-0 truncate text-muted-foreground">Deleted project</span>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={locked}
                aria-label={`Remove deleted project ${projectId}`}
                onClick={() => sendProjects(liveIds)}
              >
                Remove
              </Button>
            </NestedRow>
          ))}
        </>
      ) : null}
    </div>
  );
}

/** A connected service, optionally with the catalog or registry entry it came from. */
function ConnectorDetail({
  connector,
  entry,
  back,
}: {
  readonly connector: ConnectorSummary;
  readonly entry: DiscoverEntry | undefined;
  readonly back: BackTo;
}) {
  const { inventory, catalog } = useExtensionsEnvironment();
  const actions = useConnectorActions(connector);
  const allowed = connectorActions(connector);
  const name = entry ? entryName(entry) : connector.displayName;
  const iconUrl = entry?.iconUrl ?? connector.iconUrl;
  const tagline = (entry ? entryTagline(entry) : undefined) ?? connector.description;
  const source = connector.source;
  const pluginId = source.type === "plugin" ? source.pluginId : null;
  const pluginName = inventory?.plugins.find((plugin) => plugin.pluginId === pluginId)?.displayName;
  const curated = entry !== undefined && (isCatalogOnlyEntry(entry) || entry.categories.length > 0);
  return (
    <DetailLayout
      back={back}
      header={
        <DetailHeader
          name={name}
          iconUrl={iconUrl}
          tagline={tagline}
          actions={
            <Button
              variant="destructive-outline"
              disabled={actions.locked}
              onClick={() => void actions.remove()}
            >
              Remove
            </Button>
          }
        />
      }
      description={extraDescription(entry?.description ?? connector.description, tagline)}
    >
      <DetailSection title="Connection">
        <div className={CARD_CLASS}>
          <CardRow>
            <ExtensionIcon name={name} iconUrl={iconUrl} size="avatar" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{connectionState(connector)}</p>
              <p className="truncate text-xs text-muted-foreground">
                {connectionDetail(connector, actions.busy)}
              </p>
            </div>
            {allowed.signIn ? (
              <PrimaryAction
                icon={allowed.signIn === "sign-in" ? LogInIcon : RefreshCwIcon}
                disabled={!actions.canSignIn}
                onClick={() => void actions.signIn()}
              >
                {actions.busy === "sign-in"
                  ? "Opening…"
                  : allowed.signIn === "sign-in"
                    ? "Sign in"
                    : "Reconnect"}
              </PrimaryAction>
            ) : null}
            <MoreMenu label={`More for ${name} connection`}>
              <MenuItem
                disabled={actions.locked || !allowed.canTest}
                onClick={() => void actions.test()}
              >
                Test
              </MenuItem>
            </MoreMenu>
          </CardRow>
          <CardRow>
            <span className="min-w-0 flex-1 text-sm text-foreground">Use with agents</span>
            <Switch
              checked={connector.enabled}
              disabled={actions.locked}
              aria-label={`${connector.enabled ? "Turn off" : "Turn on"} ${name}`}
              onCheckedChange={(checked) => void actions.setEnabled(Boolean(checked))}
            />
          </CardRow>
          <AvailabilityRows
            connector={connector}
            name={name}
            locked={actions.locked}
            setAvailability={actions.setAvailability}
          />
        </div>
        {connector.lastError ? (
          <p className="text-sm text-destructive-foreground">{connector.lastError}</p>
        ) : null}
        <div className="grid gap-1 empty:hidden">
          <ActionFeedback feedback={actions.feedback} waitingForSignIn={actions.waitingForSignIn} />
        </div>
      </DetailSection>
      <ToolsSection
        canTest={allowed.canTest}
        locked={actions.locked}
        testing={actions.busy === "test"}
        testResult={actions.testResult}
        onTest={() => void actions.test()}
      />
      <AboutCard
        rows={[
          fact("Added on", formatDate(connector.createdAt)),
          fact("Category", categoryLabel(entry, catalog)),
          fact("Website", entry?.websiteUrl ? <ExternalLink href={entry.websiteUrl} /> : null),
          fact(
            "Repository",
            entry?.repositoryUrl ? <ExternalLink href={entry.repositoryUrl} /> : null,
          ),
          ["Works with", <WorksWithValue key="works-with" />],
          ["Sign-in used", connectorAuthLabel(connector.auth)],
          ["URL", <Mono key="url">{connector.url}</Mono>],
          ["Server name", <Mono key="server-name">{connector.serverName}</Mono>],
          ["Source", connectorSourceLabel(source, curated, pluginName)],
        ]}
      />
    </DetailLayout>
  );
}

/**
 * The connector, with the entry it came from when one is known: curated
 * entries carry its id, registry connectors are looked up by registry name.
 */
function ConnectorDetailContent({ connectorId }: { readonly connectorId: string }) {
  const { environmentId, inventory, inventoryError, catalog } = useExtensionsEnvironment();
  const connector = inventory?.connectors.find((item) => item.connectorId === connectorId);
  const fromCatalog = catalogEntries(catalog).find(
    (item) => item.installedConnectorId === connectorId,
  );
  const registryName =
    fromCatalog === undefined && connector?.source.type === "registry"
      ? connector.source.name
      : null;
  const registryEntry = useEnvironmentQuery(
    registryName === null
      ? null
      : extensionsDiscoverEntry({ environmentId, input: { name: registryName } }),
  );
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
  const entry = fromCatalog ?? registryEntry.data ?? undefined;
  // Keyed by id: a different connector is a different page, with nothing carried over.
  return (
    <ConnectorDetail
      key={connector.connectorId}
      connector={connector}
      entry={entry}
      back="installed"
    />
  );
}

export function ConnectorDetailPage({ connectorId }: { readonly connectorId: string }) {
  return (
    <ExtensionsPage>
      <ConnectorDetailContent connectorId={connectorId} />
    </ExtensionsPage>
  );
}

/** A catalog or registry server that is not added yet. */
function ServerDetail({
  entry,
  onAddWithOptions,
}: {
  readonly entry: DiscoverEntry;
  readonly onAddWithOptions: () => void;
}) {
  const { catalog } = useExtensionsEnvironment();
  const actions = useAddEntry(entry);
  const name = entryName(entry);
  const tagline = entryTagline(entry);
  const catalogOnly = isCatalogOnlyEntry(entry);
  return (
    <DetailLayout
      back="discover"
      header={
        <DetailHeader
          name={name}
          iconUrl={entry.iconUrl}
          tagline={tagline}
          actions={
            <>
              <PrimaryAction
                icon={DownloadIcon}
                disabled={!actions.canAdd || actions.locked}
                onClick={() => void actions.add()}
              >
                {actions.busy === "add" ? "Adding…" : "Add"}
              </PrimaryAction>
              {actions.canAdd ? (
                <MoreMenu label={`More for ${name}`}>
                  <MenuItem disabled={actions.locked} onClick={onAddWithOptions}>
                    Add with options…
                  </MenuItem>
                </MoreMenu>
              ) : null}
            </>
          }
        />
      }
      description={extraDescription(entry.description, tagline)}
      feedback={
        <>
          {!actions.canAdd ? (
            <MutedLine>
              {entry.unsupportedReason ??
                "Scient can't add this server: it has no remote endpoint to connect to."}
            </MutedLine>
          ) : null}
          <ActionFeedback feedback={actions.feedback} />
        </>
      }
    >
      <DetailSection title="Tools">
        <MutedCard>{TOOLS_AFTER_SIGN_IN}</MutedCard>
      </DetailSection>
      <AboutCard
        rows={[
          fact("Category", categoryLabel(entry, catalog)),
          fact("Website", entry.websiteUrl ? <ExternalLink href={entry.websiteUrl} /> : null),
          fact(
            "Repository",
            entry.repositoryUrl ? <ExternalLink href={entry.repositoryUrl} /> : null,
          ),
          ["Works with", <WorksWithValue key="works-with" />],
          fact(
            "URL",
            entry.remotes.length > 0 ? (
              <span className="grid gap-1">
                {entry.remotes.map((remote) => (
                  <Mono key={remote.url}>{remote.url}</Mono>
                ))}
              </span>
            ) : null,
          ),
          catalogOnly ? null : ["Registry name", <Mono key="registry-name">{entry.name}</Mono>],
          catalogOnly ? null : ["Version", entry.version],
          ["Source", entrySourceLabel(entry)],
        ]}
      />
    </DetailLayout>
  );
}

/**
 * Any catalog or registry server by its exact name, looked up on the server
 * so entries no preview lists still open. Once added it is its connector.
 * "Add with options" stays open across that switch, for its sign-in step.
 */
function ServerDetailContent({ name }: { readonly name: string }) {
  const { environmentId, callbackOrigin, inventory } = useExtensionsEnvironment();
  const [withOptions, setWithOptions] = useState(false);
  const lookup = useEnvironmentQuery(extensionsDiscoverEntry({ environmentId, input: { name } }));
  const entry = lookup.data;
  if (entry === null) {
    const notFound = isExtensionsError(lookup.failure) && lookup.failure.reason === "not-found";
    return (
      <>
        <DetailBack to="discover" />
        <MutedLine>
          {notFound ? "This server was not found." : (lookup.error ?? "Loading…")}
        </MutedLine>
      </>
    );
  }
  const connector =
    entry.installedConnectorId === undefined
      ? undefined
      : inventory?.connectors.find((item) => item.connectorId === entry.installedConnectorId);
  return (
    <>
      {connector ? (
        <ConnectorDetail
          key={connector.connectorId}
          connector={connector}
          entry={entry}
          back="discover"
        />
      ) : (
        <ServerDetail entry={entry} onAddWithOptions={() => setWithOptions(true)} />
      )}
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

export function ServerDetailPage({ name }: { readonly name: string }) {
  return (
    <ExtensionsPage>
      <ServerDetailContent name={name} />
    </ExtensionsPage>
  );
}

type ComponentGroupLabel = "Skills" | "Connected services" | "Tools" | "Other";

const COMPONENT_KINDS: Readonly<
  Record<ExtensionComponent["type"], { readonly group: ComponentGroupLabel; readonly kind: string }>
> = {
  skill: { group: "Skills", kind: "Skill" },
  connector: { group: "Connected services", kind: "Connected service" },
  "mcp-tools": { group: "Tools", kind: "Tools" },
  settings: { group: "Other", kind: "Settings" },
  panel: { group: "Other", kind: "Panel" },
};

const COMPONENT_GROUP_ORDER: ReadonlyArray<ComponentGroupLabel> = [
  "Skills",
  "Connected services",
  "Tools",
  "Other",
];

function componentGroups(
  components: ReadonlyArray<ExtensionComponent>,
): ReadonlyArray<DetailGroup> {
  return COMPONENT_GROUP_ORDER.map((label) => ({
    label,
    rows: components
      .filter((component) => COMPONENT_KINDS[component.type].group === label)
      .map((component) => ({
        key: `${component.type}:${component.name}`,
        name:
          component.type === "skill" ? (
            <Link to="/settings/skills" className={cn(GHOST_LINK_CLASS, "text-foreground")}>
              {component.name}
            </Link>
          ) : component.type === "mcp-tools" ? (
            <span className="font-mono text-xs leading-5">{component.name}</span>
          ) : (
            component.name
          ),
        detail:
          component.detail ??
          (label === "Other" ? COMPONENT_KINDS[component.type].kind : undefined),
      })),
  }));
}

function PluginDetail({ plugin }: { readonly plugin: ScientPluginSummary }) {
  const actions = usePluginActions(plugin);
  const builtIn = plugin.origin === "built-in";
  const glyph = pluginGlyph(plugin);
  const settingsPath = plugin.settingsPath?.startsWith("/settings/") ? plugin.settingsPath : null;
  return (
    <DetailLayout
      back={builtIn ? "discover" : "installed"}
      header={
        <DetailHeader
          name={plugin.displayName}
          glyph={glyph}
          tagline={plugin.description}
          actions={
            <>
              {plugin.canSetEnabled ? (
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Switch
                    checked={plugin.enabled}
                    disabled={actions.locked}
                    aria-label={`${plugin.enabled ? "Turn off" : "Turn on"} ${plugin.displayName}`}
                    onCheckedChange={(checked) => void actions.setEnabled(Boolean(checked))}
                  />
                  <span className="w-6">{plugin.enabled ? "On" : "Off"}</span>
                </label>
              ) : null}
              {plugin.canRemove ? (
                <Button
                  variant="destructive-outline"
                  disabled={actions.locked}
                  onClick={() => void actions.remove()}
                >
                  Uninstall
                </Button>
              ) : null}
            </>
          }
        />
      }
      feedback={<ActionFeedback feedback={actions.feedback} />}
    >
      {plugin.components.length > 0 ? (
        <DetailSection title="Includes">
          <GroupsCard label="Parts" groups={componentGroups(plugin.components)} />
        </DetailSection>
      ) : null}
      <AboutCard
        rows={[
          ["Developer", plugin.publisher],
          ["Version", plugin.version],
          fact("Installed on", formatDate(plugin.installedAt)),
          fact(
            "Settings",
            settingsPath ? (
              <Link to={settingsPath} className={cn(GHOST_LINK_CLASS, "text-foreground")}>
                Open settings
              </Link>
            ) : null,
          ),
          ["Source", builtIn ? "Built into Scient" : "Plugin bundle"],
          fact("SHA-256", plugin.digest ? <Mono>{plugin.digest}</Mono> : null),
        ]}
      />
    </DetailLayout>
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

function ManagedBy({ label }: { readonly label: string }) {
  return <span className="text-sm text-muted-foreground">Managed by {label}</span>;
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
  const servers = group.mcpServers.filter((server) => server.pluginId === plugin.id);
  return (
    <DetailLayout
      back="installed"
      header={
        <DetailHeader
          name={name}
          tagline={plugin.description}
          actions={
            plugin.canUninstall === true ? (
              <Button
                variant="destructive-outline"
                disabled={actions.locked}
                onClick={() => void actions.uninstall()}
              >
                Uninstall
              </Button>
            ) : (
              <ManagedBy label={group.label} />
            )
          }
        />
      }
      feedback={<ActionFeedback feedback={actions.feedback} />}
    >
      {servers.length > 0 ? (
        <DetailSection title="Includes">
          <GroupsCard
            label="Parts"
            groups={[
              {
                label: "MCP servers",
                rows: servers.map((server) => ({
                  key: server.name,
                  name: server.name,
                  detail: mcpServerSummary(server),
                })),
              },
            ]}
          />
        </DetailSection>
      ) : null}
      <AboutCard
        rows={[
          ["Managed by", group.label],
          fact("Version", plugin.version),
          fact("Marketplace", plugin.marketplace),
          fact("Workspace", workspace ? workspaceLabel(workspace) : null),
          ["State", plugin.enabled ? "On" : "Off"],
        ]}
      />
    </DetailLayout>
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
  const status =
    server.status === "connected"
      ? "Connected"
      : (MCP_SERVER_STATUS_TEXT[server.status] ?? "Unknown");
  return (
    <DetailLayout
      back="installed"
      header={
        <DetailHeader
          name={server.name}
          tagline={mcpServerSummary(server)}
          actions={
            <>
              {canSignIn ? (
                <PrimaryAction
                  icon={server.status === "connected" ? RefreshCwIcon : LogInIcon}
                  disabled={actions.locked}
                  onClick={() => void actions.signIn()}
                >
                  {server.status === "connected" ? "Sign in again" : "Sign in"}
                </PrimaryAction>
              ) : null}
              <ManagedBy label={group.label} />
            </>
          }
        />
      }
      feedback={
        <>
          {server.error ? (
            <p className="text-sm text-destructive-foreground">{server.error}</p>
          ) : null}
          <ActionFeedback feedback={actions.feedback} />
        </>
      }
    >
      <AboutCard
        rows={[
          ["Managed by", group.label],
          ["Status", status],
          fact("Tools", server.toolCount === undefined ? null : String(server.toolCount)),
          fact("Scope", server.scope),
          fact("From plugin", server.pluginId),
        ]}
      />
    </DetailLayout>
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
