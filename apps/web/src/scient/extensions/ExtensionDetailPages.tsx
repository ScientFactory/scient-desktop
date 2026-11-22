import ChatMarkdown from "../../components/ChatMarkdown";
import { ConnectorToolsList } from "./ConnectorToolsList";
import { PluginContents } from "./PluginContents";
import {
  AccountId,
  type ConnectorSummary,
  type ConnectorTestResult,
  type DiscoverCatalog,
  type DiscoverEntry,
  type ExtensionComponent,
  ExtensionsError,
  type ProjectId,
  type ProviderInstanceId,
  type ScientPluginSummary,
  type ServerProviderMcpServer,
  type ServerProviderPlugin,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ChevronRightIcon,
  PlusIcon,
  EllipsisIcon,
  LogInIcon,
  type LucideIcon,
  RefreshCwIcon,
} from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { type ReactNode, useState } from "react";

import { toastManager } from "../../components/ui/toast";
import { m, type MessageResolver } from "../../i18n/messages";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { LocalSetupDialog } from "./LocalSetupFields";

import { WorksWithValue } from "./WorksWith";
import { AddForAgents, useConnectorAgents } from "./AgentPicker";
import { Button } from "../../components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { NativeSelect } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
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
import {
  ActionFeedback,
  connectorProblem,
  LocalConnectorMenuItems,
  mcpServerSummary,
} from "./ExtensionItems";
import {
  fixConnectorPrompt,
  makeFromEntryPrompt,
  useConnectorAgentChat,
} from "./connectorAgentChat";
import { ErrorNote } from "./ExtensionsFeedback";
import { siteHost } from "./LocalSetupFields";
import { useSignIn } from "../accounts/useSignIn";
import {
  BackToList,
  ExtensionsPage,
  GHOST_LINK_CLASS,
  MutedLine,
  SECTION_HEADING_CLASS,
  useBackToList,
  useExtensionsEnvironment,
} from "./ExtensionsPage";
import { ExtensionIcon, type ExtensionTarget } from "./ExtensionRow";
import { extensionsDiscoverEntry } from "./extensionsState";
import {
  type ProviderExtensionGroup,
  providerExtensionAudience,
  collectProviderExtensionGroups,
  connectorActions,
  connectorAuthLabel,
  connectorFacts,
  connectorSourceLabel,
  entryName,
  entryNeedsSetup,
  entryFacts,
  providerServerConnectLabel,
  providerServerDisplayName,
  entrySourceLabel,
  entryTagline,
  isCatalogOnlyEntry,
  MCP_SERVER_STATUS_TEXT,
  pluginGlyph,
  TEST_OUTCOME_LABELS,
  urlHost,
  workspaceLabel,
  connectorAudience,
} from "./extensionsView";
import { useInstalledEntries } from "./installedEntries";
import { providerInventoryMessage } from "./providerInventoryCopy";

const isExtensionsError = Schema.is(ExtensionsError);

type BackTo = "discover" | "installed";

/** Back to the list the page was opened from; `to` is used when it was opened directly. */
function DetailBack({ to }: { readonly to: BackTo }) {
  const gt = useGT();
  return to === "discover" ? (
    <BackToList fallback="/settings/extensions" fallbackLabel={gt("Discover")} />
  ) : (
    <BackToList fallback="/settings/extensions/installed" fallbackLabel={gt("Installed")} />
  );
}

/**
 * Every detail page: a header with the item's actions, an optional longer
 * description and feedback, then its cards.
 */
export function DetailLayout({
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
  const { environmentId } = useExtensionsEnvironment();
  return (
    <>
      <DetailBack to={back} />
      <article className="grid min-w-0 grid-cols-1 gap-6">
        <div className="grid min-w-0 grid-cols-1 gap-4">
          {header}
          {description ? (
            <ChatMarkdown
              text={description}
              cwd={undefined}
              environmentId={environmentId}
              className="text-sm text-muted-foreground"
            />
          ) : null}
          {feedback ? <div className="grid gap-1 empty:hidden">{feedback}</div> : null}
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-8">{children}</div>
      </article>
    </>
  );
}

/** 64px icon, name and tagline; the item's buttons on the right. */
export function DetailHeader({
  name,
  iconUrl,
  providerPlugin,
  glyph,
  tagline,
  developer,
  actions,
}: {
  readonly name: string;
  readonly iconUrl?: string | undefined;
  readonly providerPlugin?: Extract<ExtensionTarget, { kind: "provider-plugin" }> | undefined;
  readonly glyph?: LucideIcon | undefined;
  readonly tagline?: string | undefined;
  readonly developer?: string | undefined;
  readonly actions: ReactNode;
}) {
  const gt = useGT();
  return (
    <header className="flex flex-wrap items-center gap-4">
      <ExtensionIcon
        name={name}
        iconUrl={iconUrl}
        glyph={glyph}
        size="large"
        providerPlugin={providerPlugin}
      />
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-2xl font-medium tracking-[-0.02em] text-foreground">{name}</h1>
        {developer || tagline ? (
          <p className="text-sm text-muted-foreground">
            {[developer ? gt("By {developer}", { developer }) : undefined, tagline]
              .filter(Boolean)
              .join(" • ")}
          </p>
        ) : null}
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
export function PrimaryAction({
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

export function DetailSection({
  title,
  count,
  status,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly status?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section
      className="grid min-w-0 grid-cols-1 gap-3"
      aria-label={count === undefined ? title : `${title} ${count}`}
    >
      <h2 className={cn(SECTION_HEADING_CLASS, count !== undefined && "border-b pb-3")}>
        {title}
        {count !== undefined ? (
          <>
            {" "}
            <span className="font-normal text-muted-foreground">{count}</span>
          </>
        ) : null}
        {status ? (
          <span role="status" className="ml-3 font-normal text-muted-foreground">
            {status}
          </span>
        ) : null}
      </h2>
      {children}
    </section>
  );
}

const CARD_CLASS = "divide-y divide-border overflow-hidden rounded-xl border bg-card";

export function CardRow({ children }: { readonly children: ReactNode }) {
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
export function AboutCard({ rows }: { readonly rows: ReadonlyArray<Fact | null> }) {
  const gt = useGT();
  const shown = rows.filter((row) => row !== null);
  if (shown.length === 0) return null;
  return (
    <DetailSection title={gt("About")}>
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

/** Curated categories by their section titles; "most-used" is a shelf, not a category. */
function categoryLabel(entry: DiscoverEntry | undefined, catalog: DiscoverCatalog | null) {
  const categories = entry?.categories.filter((category) => category !== "most-used") ?? [];
  if (categories.length === 0) return undefined;
  return categories
    .map(
      (category) =>
        catalog?.sections.find((section) => section.category === category)?.title ??
        category.charAt(0).toUpperCase() + category.slice(1),
    )
    .join(", ");
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
export function GroupsCard({
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

const TOOLS_AFTER_SIGN_IN = msg("Tools appear after you add and sign in.");

/**
 * "See tools" runs one test before displaying the connector's tools.
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
  const gt = useGT();
  const messages = useMessages();
  const { environmentId } = useExtensionsEnvironment();
  if (testResult?.outcome === "ok") {
    return <ConnectorToolsList tools={testResult.tools} environmentId={environmentId} />;
  }
  if (!canTest) {
    return (
      <DetailSection title={gt("Tools")}>
        <MutedCard>{messages(TOOLS_AFTER_SIGN_IN)}</MutedCard>
      </DetailSection>
    );
  }
  return (
    <DetailSection title={gt("Tools")}>
      <div className={CARD_CLASS}>
        <button
          type="button"
          disabled={locked}
          onClick={onTest}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm transition-colors not-disabled:hover:bg-foreground/[0.035] disabled:cursor-default"
        >
          <span className="font-medium text-foreground">
            {testing ? gt("Listing tools…") : testResult ? gt("Try again") : gt("See tools")}
          </span>
          <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />
        </button>
        {testResult ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {testResult.message
              ? gt("{outcome} · {message}", {
                  outcome: messages(TEST_OUTCOME_LABELS[testResult.outcome]),
                  message: testResult.message,
                })
              : messages(TEST_OUTCOME_LABELS[testResult.outcome])}
          </p>
        ) : null}
      </div>
    </DetailSection>
  );
}

function connectionState(connector: ConnectorSummary, resolve: MessageResolver = m): string {
  if (connector.status === "needs-auth") return resolve(msg("Needs sign-in"));
  if (connector.status === "needs-credential") {
    return resolve(
      connector.auth.type === "source-control" ? msg("Account missing") : msg("Key missing"),
    );
  }
  if (connector.local !== undefined) return resolve(msg("Runs on this computer"));
  return resolve(connector.auth.type === "none" ? msg("No account needed") : msg("Signed in"));
}

function connectionDetail(
  connector: ConnectorSummary,
  busy: string | null,
  resolve: MessageResolver = m,
): string {
  if (busy === "sign-in") return resolve(msg("Opening sign-in…"));
  if (connector.status === "needs-credential") {
    if (connector.auth.type === "source-control") {
      return resolve(
        msg("Source Control no longer has {account}. Sign in to GitHub again.", {
          account: connector.auth.account,
        }),
      );
    }
    return resolve(
      connector.auth.type === "credential" && connector.auth.storage === "bound"
        ? msg("The secret this service used is no longer available.")
        : msg("The stored key is gone. Remove this service and add it again."),
    );
  }
  if (connector.local !== undefined) {
    const { running, missing, problem } = connector.local;
    if (problem !== undefined) return problem;
    if (missing.length > 0) return resolve(msg("Needs {items}", { items: missing.join(", ") }));
    return running === 0
      ? resolve(msg("Starts when an agent uses it"))
      : resolve(
          msg(
            "{count, plural, one {{count} copy running, one per chat} other {{count} copies running, one per chat}}",
            { count: running },
          ),
        );
  }
  return connector.auth.type === "none"
    ? (urlHost(connector.url) ?? connector.url)
    : connectorAuthLabel(connector.auth, resolve);
}

/**
 * "Projects" with the projects it names. A saved project deleted since
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
  const gt = useGT();
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
    <div role="group" aria-label={gt("Projects")} className="divide-y divide-border">
      <CardRow>
        <span className="min-w-0 flex-1 text-sm text-foreground">
          <T>Projects</T>
        </span>
        <span className="w-44">
          <NativeSelect
            size="sm"
            aria-label={gt("Where {name} is available", { name })}
            value={availability.type}
            disabled={locked}
            onChange={(event) =>
              event.target.value === "all-projects"
                ? void setAvailability({ type: "all-projects" })
                : sendProjects(liveIds)
            }
          >
            <option value="all-projects">{gt("All projects")}</option>
            <option value="projects">{gt("Selected projects")}</option>
          </NativeSelect>
        </span>
      </CardRow>
      {availability.type === "projects" ? (
        <>
          {liveIds.length === 0 ? (
            <NestedRow>
              <span className="text-muted-foreground">
                <T>Not available in any project.</T>
              </span>
            </NestedRow>
          ) : null}
          {!projectsKnown ? (
            <NestedRow>
              <span className="text-muted-foreground">
                <T>Loading projects…</T>
              </span>
            </NestedRow>
          ) : projects.length === 0 && deletedIds.length === 0 ? (
            <NestedRow>
              <span className="text-muted-foreground">
                <T>No projects yet.</T>
              </span>
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
                      aria-label={
                        enabled
                          ? gt("Turn off in {project}", { project: project.title })
                          : gt("Turn on in {project}", { project: project.title })
                      }
                      onCheckedChange={(checked) => toggle(project.id, Boolean(checked))}
                    />
                  </NestedRow>
                );
              })
            : null}
          {deletedIds.map((projectId) => (
            <NestedRow key={projectId}>
              <span className="min-w-0 truncate text-muted-foreground">
                <T>Deleted project</T>
              </span>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={locked}
                aria-label={gt("Remove deleted project {id}", { id: projectId })}
                onClick={() => sendProjects(liveIds)}
              >
                <T>Remove</T>
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
  const gt = useGT();
  const messages = useMessages();
  const { inventory, catalog, environmentId, canWrite } = useExtensionsEnvironment();
  const actions = useConnectorActions(connector);
  const backToList = useBackToList();
  const allowed = connectorActions(connector);
  const [editing, setEditing] = useState(false);
  const startChat = useConnectorAgentChat(environmentId);
  const signInPerson = useSignIn(environmentId);
  const problem = connectorProblem(connector);
  const local = connector.local;
  const signIn = local?.signIn;
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const revealFolder = async (folder: string) => {
    const result = await openInEditor({
      environmentId,
      input: { cwd: folder, editor: "file-manager", reveal: true },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: gt("Unable to show the folder"),
        description: folder,
      });
    }
  };
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
              onClick={() =>
                // Its own page has nothing left to show; a catalog entry's page shows the entry again.
                void actions.remove().then((removed) => {
                  if (removed && back === "installed") backToList();
                })
              }
            >
              <T>Remove</T>
            </Button>
          }
        />
      }
      description={extraDescription(entry?.description ?? connector.description, tagline)}
    >
      <DetailSection title={gt("Connection")}>
        <div className={CARD_CLASS}>
          <CardRow>
            <ExtensionIcon name={name} iconUrl={iconUrl} size="avatar" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">
                {connectionState(connector, messages)}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {connectionDetail(connector, actions.busy, messages)}
              </p>
            </div>
            {allowed.signIn ? (
              <PrimaryAction
                icon={LogInIcon}
                disabled={!actions.canSignIn}
                onClick={() => void actions.signIn()}
              >
                {actions.busy === "sign-in" ? gt("Opening…") : gt("Sign in")}
              </PrimaryAction>
            ) : null}
            <MoreMenu label={gt("More for {name} connection", { name })}>
              {connector.status === "connected" && connector.auth.type === "oauth" ? (
                <MenuItem disabled={!actions.canSignIn} onClick={() => void actions.signIn()}>
                  <T>Sign in again</T>
                </MenuItem>
              ) : null}
              <MenuItem
                disabled={actions.locked || !allowed.canTest}
                onClick={() => void actions.test()}
              >
                {gt("Test", { $context: "verb, tests a connector" })}
              </MenuItem>
              {connector.local !== undefined ? (
                <>
                  <MenuItem disabled={actions.locked} onClick={() => void actions.restart()}>
                    <T>Restart</T>
                  </MenuItem>
                  <MenuItem onClick={() => void revealFolder(connector.local!.directory)}>
                    <T>Show in folder</T>
                  </MenuItem>
                  <LocalConnectorMenuItems connector={connector} actions={actions} />
                </>
              ) : null}
            </MoreMenu>
          </CardRow>
          {local !== undefined && (local.changedBy !== undefined || local.forkedFrom) ? (
            <CardRow>
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                {[
                  local.forkedFrom ? gt("Your copy of {name}", { name: local.forkedFrom }) : null,
                  local.changedBy === "agent"
                    ? gt("Changed by an agent on {date}", {
                        date: formatDate(connector.updatedAt) ?? "",
                      })
                    : gt("Changed by you on {date}", {
                        date: formatDate(connector.updatedAt) ?? "",
                      }),
                ]
                  .filter(Boolean)
                  .join(". ")}
              </span>
              {local.canUndo ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actions.locked}
                  onClick={() => void actions.undo()}
                >
                  <T>Undo last change</T>
                </Button>
              ) : null}
            </CardRow>
          ) : null}
          <CardRow>
            <span className="min-w-0 flex-1 text-sm text-foreground">
              <T>Use with agents</T>
            </span>
            <Switch
              checked={connector.enabled}
              disabled={actions.locked}
              aria-label={
                connector.enabled ? gt("Turn off {name}", { name }) : gt("Turn on {name}", { name })
              }
              onCheckedChange={(checked) => void actions.setEnabled(Boolean(checked))}
            />
          </CardRow>
          <AgentRows
            connector={connector}
            name={name}
            locked={actions.locked}
            setAgents={actions.setAgents}
          />
          <AvailabilityRows
            connector={connector}
            name={name}
            locked={actions.locked}
            setAvailability={actions.setAvailability}
          />
        </div>
        {problem !== undefined ? (
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <ErrorNote message={problem} />
            </div>
            {local !== undefined && startChat !== undefined ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void startChat(
                    fixConnectorPrompt(connector.displayName, connector.serverName, problem),
                    "fix",
                  )
                }
              >
                <T>Fix with an agent</T>
              </Button>
            ) : null}
          </div>
        ) : null}
        {local !== undefined && (local.setup.length > 0 || signIn !== undefined) ? (
          <div className={CARD_CLASS}>
            {signIn !== undefined ? (
              <CardRow>
                <span className="min-w-0 flex-1 text-sm text-foreground">
                  <T>
                    Sign-in to <Var>{siteHost(signIn.site)}</Var>
                  </T>
                </span>
                <span className="truncate text-sm text-muted-foreground">
                  {signIn.state === "missing"
                    ? gt("Missing")
                    : signIn.state === "needs-user"
                      ? gt("Needs sign-in")
                      : signIn.account}
                </span>
                {signIn.state === "needs-user" && signIn.accountId !== undefined ? (
                  <Button
                    size="sm"
                    disabled={!canWrite || actions.locked}
                    // The next time its session ends, the connector takes the one the person made.
                    onClick={() => void signInPerson(AccountId.make(signIn.accountId!))}
                  >
                    <T>Sign in</T>
                  </Button>
                ) : null}
              </CardRow>
            ) : null}
            {local.setup.map(({ field, value, account }) => (
              <CardRow key={field.key}>
                <span className="min-w-0 flex-1 text-sm text-foreground">{field.title}</span>
                <span className="truncate text-sm text-muted-foreground">
                  {field.sensitive
                    ? (account ?? (field.required ? gt("Missing") : gt("Not set")))
                    : value === undefined
                      ? field.required
                        ? gt("Missing")
                        : gt("Not set")
                      : Array.isArray(value)
                        ? value.join(", ")
                        : String(value)}
                </span>
              </CardRow>
            ))}
            <CardRow>
              <span className="min-w-0 flex-1" />
              <Button
                size="sm"
                variant="outline"
                disabled={!canWrite}
                onClick={() => setEditing(true)}
              >
                <T>Edit setup</T>
              </Button>
            </CardRow>
          </div>
        ) : null}
        {editing && connector.local !== undefined ? (
          <LocalSetupDialog
            connector={{ ...connector, local: connector.local }}
            environmentId={environmentId}
            onClose={() => setEditing(false)}
          />
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
          fact(gt("Added on"), formatDate(connector.createdAt)),
          ...connectorFacts(entry, connector, messages),
          fact(gt("Category"), categoryLabel(entry, catalog)),
          fact(gt("Website"), entry?.websiteUrl ? <ExternalLink href={entry.websiteUrl} /> : null),
          fact(
            gt("Repository"),
            entry?.repositoryUrl ? <ExternalLink href={entry.repositoryUrl} /> : null,
          ),
          [
            gt("Works with"),
            <WorksWithValue key="works-with" audience={connectorAudience(connector)} />,
          ],
          ...(connector.local === undefined
            ? ([
                // Connection already says when there is no sign-in.
                connector.auth.type === "none"
                  ? null
                  : [gt("Sign-in used"), connectorAuthLabel(connector.auth, messages)],
                ["URL", <Mono key="url">{connector.url}</Mono>],
              ] satisfies ReadonlyArray<Fact | null>)
            : [
                fact(gt("Version"), connector.local.version),
                fact(gt("Author"), connector.local.author),
                fact(
                  gt("Runs", { $context: "the command a connector runs" }),
                  connector.local.commandLine === undefined ? null : (
                    <Mono key="runs">{connector.local.commandLine}</Mono>
                  ),
                ),
                [
                  gt("Folder"),
                  <Mono key="folder">{connector.local.directory}</Mono>,
                ] satisfies Fact,
              ]),
          [gt("Server name"), <Mono key="server-name">{connector.serverName}</Mono>],
          [gt("Source"), connectorSourceLabel(source, curated, pluginName, messages)],
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
  const gt = useGT();
  const { environmentId, inventory, inventoryError } = useExtensionsEnvironment();
  const connector = inventory?.connectors.find((item) => item.connectorId === connectorId);
  const fromCatalog = useInstalledEntries().find(
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
          {inventory === null
            ? (inventoryError ?? gt("Loading…"))
            : gt("This service is not connected.")}
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
  /** Opens the add form, for the chosen agents (absent: every agent). */
  readonly onAddWithOptions: (agents?: ReadonlyArray<ProviderInstanceId>) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { catalog, providers, environmentId } = useExtensionsEnvironment();
  const codex = providers.find((provider) => provider.driver === "codex" && provider.enabled);
  const antigravity = providers.find(
    (provider) => provider.driver === "antigravity" && provider.enabled,
  );
  const actions = useAddEntry(entry);
  const startChat = useConnectorAgentChat(environmentId);
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
              <AddForAgents
                name={name}
                disabled={!actions.canAdd || actions.locked}
                onAdd={(agents) =>
                  entryNeedsSetup(entry) ? onAddWithOptions(agents) : void actions.add(agents)
                }
                trigger={
                  <Button size="sm" type="button" variant="ghost-primary" data-primary-action="">
                    <PlusIcon aria-hidden />
                    {actions.busy === "add"
                      ? gt("Adding…")
                      : gt("Add", { $context: "verb, adds an extension" })}
                  </Button>
                }
              />
              {actions.canAdd && entry.localBundle === undefined ? (
                <MoreMenu label={gt("More for {name}", { name })}>
                  <MenuItem disabled={actions.locked} onClick={() => onAddWithOptions()}>
                    <T>Add with options…</T>
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
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">
                <MutedLine>
                  {entry.unsupportedReason ??
                    gt("Scient can't add this server: it has no remote endpoint to connect to.")}
                </MutedLine>
              </div>
              {startChat !== undefined && !catalogOnly ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void startChat(
                      makeFromEntryPrompt({
                        title: name,
                        registryName: entry.name,
                        repositoryUrl: entry.repositoryUrl,
                        reason: entry.unsupportedReason,
                      }),
                      "make",
                    )
                  }
                >
                  <T>Make with an agent</T>
                </Button>
              ) : null}
            </div>
          ) : null}
          {entry.accountRequired === false ? (
            <MutedLine>
              <T>No account needed</T>
            </MutedLine>
          ) : null}
          <ActionFeedback feedback={actions.feedback} />
        </>
      }
    >
      <DetailSection title={gt("Tools")}>
        <MutedCard>
          {entry.accountRequired === false
            ? gt("Tools appear after you add it.")
            : messages(TOOLS_AFTER_SIGN_IN)}
        </MutedCard>
      </DetailSection>
      <AboutCard
        rows={[
          ...entryFacts(entry, messages),
          fact(gt("Category"), categoryLabel(entry, catalog)),
          fact(gt("Website"), entry.websiteUrl ? <ExternalLink href={entry.websiteUrl} /> : null),
          fact(
            gt("Repository"),
            entry.repositoryUrl ? <ExternalLink href={entry.repositoryUrl} /> : null,
          ),
          [gt("Works with"), <WorksWithValue key="works-with" />],
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
          catalogOnly ? null : [gt("Registry name"), <Mono key="registry-name">{entry.name}</Mono>],
          catalogOnly ? null : [gt("Version"), entry.version],
          [gt("Source"), entrySourceLabel(entry, messages)],
          fact(
            gt("Also available"),
            (entry.agentStores?.codex && codex) ||
              (entry.agentStores?.antigravity && antigravity) ? (
              <span className="grid gap-1">
                {entry.agentStores?.codex && codex ? (
                  <Link
                    to="/settings/extensions/item/store/$instanceId/$entryId"
                    params={{ instanceId: codex.instanceId, entryId: entry.agentStores.codex }}
                    className={cn(GHOST_LINK_CLASS, "text-foreground")}
                  >
                    <T>
                      Also in <Var>{codex.displayName ?? "Codex"}</Var>’s store
                    </T>
                  </Link>
                ) : null}
                {entry.agentStores?.antigravity && antigravity ? (
                  <Link
                    to="/settings/extensions/item/store/$instanceId/$entryId"
                    params={{
                      instanceId: antigravity.instanceId,
                      entryId: entry.agentStores.antigravity,
                    }}
                    className={cn(GHOST_LINK_CLASS, "text-foreground")}
                  >
                    <T>Also in the Antigravity Marketplace</T>
                  </Link>
                ) : null}
              </span>
            ) : null,
          ),
        ]}
      />
    </DetailLayout>
  );
}

/**
 * Which agents get a connector: all of them, or the ones chosen here. An agent added later gets
 * it only while "All agents" is set. The last chosen agent stays on; "Use with agents" turns the
 * connector off for everyone.
 */
function AgentRows({
  connector,
  name,
  locked,
  setAgents,
}: {
  readonly connector: ConnectorSummary;
  readonly name: string;
  readonly locked: boolean;
  readonly setAgents: ConnectorActionsState["setAgents"];
}) {
  const gt = useGT();
  const agents = useConnectorAgents();
  if (agents.length <= 1 && connector.agents === undefined) return null;
  const chosen = connector.agents ?? [];
  const toggle = (instanceId: ProviderInstanceId, on: boolean) => {
    const others = chosen.filter((id) => id !== instanceId);
    void setAgents(on ? [...others, instanceId] : others);
  };
  return (
    <div role="group" aria-label={gt("Agents")} className="divide-y divide-border">
      <CardRow>
        <span className="min-w-0 flex-1 text-sm text-foreground">
          <T>Agents</T>
        </span>
        <span className="w-44">
          <NativeSelect
            size="sm"
            aria-label={gt("Which agents get {name}", { name })}
            value={connector.agents === undefined ? "all" : "chosen"}
            disabled={locked}
            onChange={(event) =>
              void setAgents(
                event.target.value === "all" ? null : agents.map((agent) => agent.instanceId),
              )
            }
          >
            <option value="all">{gt("All agents")}</option>
            <option value="chosen">{gt("Selected agents")}</option>
          </NativeSelect>
        </span>
      </CardRow>
      {connector.agents !== undefined
        ? agents.map((agent) => {
            const on = chosen.includes(agent.instanceId);
            return (
              <NestedRow key={agent.instanceId}>
                <span className="min-w-0 truncate text-foreground">{agent.label}</span>
                <Switch
                  size="sm"
                  checked={on}
                  disabled={locked || (on && chosen.length === 1)}
                  aria-label={
                    on
                      ? gt("Turn off for {agent}", { agent: agent.label })
                      : gt("Turn on for {agent}", { agent: agent.label })
                  }
                  onCheckedChange={(checked) => toggle(agent.instanceId, Boolean(checked))}
                />
              </NestedRow>
            );
          })
        : null}
    </div>
  );
}

/**
 * Any catalog or registry server by its exact name, looked up on the server
 * so entries no preview lists still open. Once added it is its connector.
 * "Add with options" stays open across that switch, for its sign-in step.
 */
function ServerDetailContent({ name }: { readonly name: string }) {
  const gt = useGT();
  const { environmentId, callbackOrigin, inventory } = useExtensionsEnvironment();
  // The add form, with the agents chosen for it (none chosen: every agent).
  const [withOptions, setWithOptions] = useState<{
    readonly agents?: ReadonlyArray<ProviderInstanceId>;
  } | null>(null);
  const lookup = useEnvironmentQuery(extensionsDiscoverEntry({ environmentId, input: { name } }));
  const entry = lookup.data;
  if (entry === null) {
    const notFound = isExtensionsError(lookup.failure) && lookup.failure.reason === "not-found";
    return (
      <>
        <DetailBack to="discover" />
        <MutedLine>
          {notFound ? gt("This server was not found.") : (lookup.error ?? gt("Loading…"))}
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
        <ServerDetail
          entry={entry}
          onAddWithOptions={(agents) => setWithOptions(agents === undefined ? {} : { agents })}
        />
      )}
      {withOptions ? (
        <AddConnectorDialog
          open
          onOpenChange={(open) => {
            if (!open) setWithOptions(null);
          }}
          environmentId={environmentId}
          entry={entry}
          callbackOrigin={callbackOrigin}
          agents={withOptions.agents}
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

type ComponentGroupLabel = "Connected services" | "Tools" | "Other";
/** A plugin's parts other than its skills, which have their own section. */
type PluginPart = ExtensionComponent & {
  readonly type: Exclude<ExtensionComponent["type"], "skill">;
};

/** `kind` is a `msg()` string. */
const COMPONENT_KINDS: Readonly<
  Record<PluginPart["type"], { readonly group: ComponentGroupLabel; readonly kind: string }>
> = {
  connector: { group: "Connected services", kind: msg("Connected service") },
  "mcp-tools": { group: "Tools", kind: msg("Tools") },
  settings: { group: "Other", kind: msg("Settings") },
  panel: { group: "Other", kind: msg("Panel") },
};

const COMPONENT_GROUP_LABELS: Readonly<Record<ComponentGroupLabel, string>> = {
  "Connected services": msg("Connected services"),
  Tools: msg("Tools"),
  Other: msg("Other", { $context: "other plugin parts" }),
};

const COMPONENT_GROUP_ORDER: ReadonlyArray<ComponentGroupLabel> = [
  "Connected services",
  "Tools",
  "Other",
];

function componentGroups(
  components: ReadonlyArray<PluginPart>,
  resolve: MessageResolver,
): ReadonlyArray<DetailGroup> {
  return COMPONENT_GROUP_ORDER.map((label) => ({
    label: resolve(COMPONENT_GROUP_LABELS[label]),
    rows: components
      .filter((component) => COMPONENT_KINDS[component.type].group === label)
      .map((component) => ({
        key: `${component.type}:${component.name}`,
        name:
          component.type === "mcp-tools" ? (
            <span className="font-mono text-xs leading-5">{component.name}</span>
          ) : (
            component.name
          ),
        detail:
          component.detail ??
          (label === "Other" ? resolve(COMPONENT_KINDS[component.type].kind) : undefined),
      })),
  }));
}

function PluginDetail({ plugin }: { readonly plugin: ScientPluginSummary }) {
  const gt = useGT();
  const messages = useMessages();
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
          developer={plugin.publisher}
          actions={
            <>
              {plugin.canSetEnabled ? (
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Switch
                    checked={plugin.enabled}
                    disabled={actions.locked}
                    aria-label={
                      plugin.enabled
                        ? gt("Turn off {name}", { name: plugin.displayName })
                        : gt("Turn on {name}", { name: plugin.displayName })
                    }
                    onCheckedChange={(checked) => void actions.setEnabled(Boolean(checked))}
                  />
                  <span className="w-6">
                    {plugin.enabled
                      ? gt("On", { $context: "switch state" })
                      : gt("Off", { $context: "switch state" })}
                  </span>
                </label>
              ) : null}
              {plugin.canRemove ? (
                <Button
                  variant="destructive-outline"
                  disabled={actions.locked}
                  onClick={() => void actions.remove()}
                >
                  <T>Remove</T>
                </Button>
              ) : null}
            </>
          }
        />
      }
      description={plugin.description}
      feedback={<ActionFeedback feedback={actions.feedback} />}
    >
      <PluginContents
        key={plugin.pluginId}
        pluginName={plugin.displayName}
        input={{ pluginId: plugin.pluginId }}
      />
      {plugin.components.some((component) => component.type !== "skill") ? (
        <DetailSection title={gt("Includes")}>
          <GroupsCard
            label={gt("Parts")}
            groups={componentGroups(
              plugin.components.filter(
                (component): component is PluginPart => component.type !== "skill",
              ),
              messages,
            )}
          />
        </DetailSection>
      ) : null}
      <AboutCard
        rows={[
          // A built-in's header and Source already say whose it is.
          builtIn ? null : [gt("Developer"), plugin.publisher],
          builtIn ? null : [gt("Version"), plugin.version],
          fact(gt("Installed on"), formatDate(plugin.installedAt)),
          fact(
            gt("Settings"),
            settingsPath ? (
              <Link to={settingsPath} className={cn(GHOST_LINK_CLASS, "text-foreground")}>
                <T>Open settings</T>
              </Link>
            ) : null,
          ),
          [gt("Works with"), <WorksWithValue key="works-with" />],
          [gt("Source"), builtIn ? gt("Built into Scient") : gt("Plugin bundle")],
          fact("SHA-256", plugin.digest ? <Mono>{plugin.digest}</Mono> : null),
        ]}
      />
    </DetailLayout>
  );
}

function PluginDetailContent({ pluginId }: { readonly pluginId: string }) {
  const gt = useGT();
  const { inventory, inventoryError } = useExtensionsEnvironment();
  const plugin = inventory?.plugins.find((item) => item.pluginId === pluginId);
  if (!plugin) {
    return (
      <>
        <DetailBack to="installed" />
        <MutedLine>
          {inventory === null
            ? (inventoryError ?? gt("Loading…"))
            : gt("This plugin is not installed.")}
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
  const { providerInventory } = useExtensionsEnvironment();
  return collectProviderExtensionGroups(providerInventory.providers, null).find(
    (group) => group.provider.instanceId === instanceId,
  );
}

function ManagedBy({ label }: { readonly label: string }) {
  return (
    <span className="text-sm text-muted-foreground">
      <T>
        Managed by <Var>{label}</Var>
      </T>
    </span>
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
  const gt = useGT();
  const messages = useMessages();
  const group = useProviderGroup(instanceId);
  const { providerInventory } = useExtensionsEnvironment();
  const found = group?.plugins.find(
    (entry) => entry.plugin.id === pluginId && entry.cwd === workspace,
  );
  if (!group || !found) {
    return (
      <>
        <DetailBack to="installed" />
        <MutedLine>
          {providerInventory.phase === "ready"
            ? gt("This plugin is no longer reported.")
            : providerInventoryMessage(providerInventory, messages)}
        </MutedLine>
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
  const gt = useGT();
  const actions = useProviderPluginActions(group.provider, group.label, plugin, workspace);
  const name = plugin.displayName ?? plugin.name;
  return (
    <DetailLayout
      back="installed"
      header={
        <DetailHeader
          name={name}
          providerPlugin={{
            kind: "provider-plugin",
            instanceId: group.provider.instanceId,
            pluginId: plugin.id,
            workspace,
          }}
          actions={
            <>
              {plugin.canSetEnabled ? (
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Switch
                    checked={plugin.enabled}
                    disabled={actions.locked}
                    aria-label={gt("Use {name}", { name })}
                    onCheckedChange={(enabled) => void actions.setEnabled(enabled)}
                  />
                  <T>Use plugin</T>
                </label>
              ) : null}
              {plugin.canUninstall === true ? (
                <Button
                  variant="destructive-outline"
                  disabled={actions.locked}
                  onClick={() => void actions.uninstall()}
                >
                  {gt("Remove from {agent}", { agent: group.label })}
                </Button>
              ) : (
                <MutedLine>
                  {group.provider.driver === "claudeAgent"
                    ? gt("Remove this plugin in Claude Code using its original install scope.")
                    : gt("Remove this plugin in {agent}’s plugin manager.", { agent: group.label })}
                </MutedLine>
              )}
            </>
          }
        />
      }
      description={plugin.description}
      feedback={<ActionFeedback feedback={actions.feedback} />}
    >
      <PluginContents
        key={JSON.stringify([group.provider.instanceId, plugin.id, workspace])}
        provider={group.provider}
        pluginName={name}
        input={{
          instanceId: group.provider.instanceId,
          pluginId: plugin.id,
          ...(workspace ? { cwd: workspace } : {}),
        }}
      />
      <AboutCard
        rows={[
          [
            gt("Works with"),
            <WorksWithValue
              key="works-with"
              audience={providerExtensionAudience(group.provider, plugin)}
            />,
          ],
          // Claude records a commit hash where others give a version; a hash tells a person nothing.
          fact(
            gt("Version"),
            /^[0-9a-f]{7,40}$/.test(plugin.version ?? "") ? null : plugin.version,
          ),
          fact(gt("Marketplace"), plugin.marketplace),
          fact(gt("Source"), plugin.sourceLabel),
          fact(gt("Workspace"), workspace ? workspaceLabel(workspace) : null),
          [
            gt("State"),
            plugin.enabled
              ? gt("On", { $context: "switch state" })
              : gt("Off", { $context: "switch state" }),
          ],
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
    <ExtensionsPage loadProviderInventory>
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
  const gt = useGT();
  const messages = useMessages();
  const group = useProviderGroup(instanceId);
  const { providerInventory } = useExtensionsEnvironment();
  const server = group?.mcpServers.find((candidate) => candidate.name === serverName);
  if (!group || !server) {
    return (
      <>
        <DetailBack to="installed" />
        <MutedLine>
          {providerInventory.phase === "ready"
            ? gt("This MCP server is no longer reported.")
            : providerInventoryMessage(providerInventory, messages)}
        </MutedLine>
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
  const gt = useGT();
  const messages = useMessages();
  const actions = useProviderServerActions(group.provider, group.label, server);
  const canSignIn = server.canStartSignIn === true || Boolean(server.connectUrl);
  const statusText = MCP_SERVER_STATUS_TEXT[server.status];
  const status =
    server.status === "connected"
      ? gt("Connected")
      : statusText === null
        ? gt("Unknown", { $context: "connector status" })
        : messages(statusText);
  return (
    <DetailLayout
      back="installed"
      header={
        <DetailHeader
          name={providerServerDisplayName(server)}
          tagline={mcpServerSummary(server, messages)}
          actions={
            <>
              {canSignIn ? (
                <PrimaryAction
                  icon={server.status === "connected" ? RefreshCwIcon : LogInIcon}
                  disabled={actions.locked}
                  onClick={() => void actions.signIn()}
                >
                  {providerServerConnectLabel(server, messages) ??
                    (server.status === "connected" ? gt("Sign in again") : gt("Sign in"))}
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
          [
            gt("Works with"),
            <WorksWithValue
              key="works-with"
              audience={providerExtensionAudience(group.provider, server)}
            />,
          ],
          [gt("Status"), status],
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
    <ExtensionsPage loadProviderInventory>
      <ProviderServerDetailContent {...props} />
    </ExtensionsPage>
  );
}
