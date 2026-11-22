import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type DiscoverCatalog,
  type EnvironmentId,
  type ExtensionsInventory,
  type ProjectId,
  type ServerProvider,
} from "@t3tools/contracts";
import { Link, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  type LucideIcon,
} from "lucide-react";
import { T, useGT, useMessages } from "gt-react";
import { createContext, type ReactNode, useContext, useEffect } from "react";

import {
  SettingsPageContainer,
  useSettingsSearchTarget,
} from "../../components/settings/settingsLayout";
import { useOptionalSettingsScope } from "../../components/settings/SettingsScopeContext";
import { Button } from "../../components/ui/button";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { useProjects } from "../../state/entities";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { useEnvironmentScope } from "../../state/session";
import { extensionsDiscoverCatalog, extensionsInventory } from "./extensionsState";
import {
  callbackOriginOf,
  EXTENSION_KIND_LABELS,
  EXTENSION_KINDS,
  type ExtensionKind,
} from "./extensionsView";
import type { ProviderInventoryView } from "./providerInventory";
import { useProviderInventory } from "./useProviderInventory";

export interface ExtensionsEnvironment {
  readonly environmentId: EnvironmentId;
  readonly canWrite: boolean;
  /** Origin of the server as this client reaches it; null while unknown. */
  readonly callbackOrigin: string | null;
  readonly inventory: ExtensionsInventory | null;
  readonly inventoryError: string | null;
  readonly catalog: DiscoverCatalog | null;
  readonly catalogError: string | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly providerInventory: ProviderInventoryView;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  /**
   * Whether `projects` is this environment's real project list. Before its
   * first snapshot arrives the list is empty, which proves nothing is deleted.
   */
  readonly projectsKnown: boolean;
}

const ExtensionsEnvironmentContext = createContext<ExtensionsEnvironment | null>(null);

/** Null outside ExtensionsPage, e.g. in the Accounts dialogs that reuse extension icons. */
export function useOptionalExtensionsEnvironment(): ExtensionsEnvironment | null {
  return useContext(ExtensionsEnvironmentContext);
}

export function useExtensionsEnvironment(): ExtensionsEnvironment {
  const value = useContext(ExtensionsEnvironmentContext);
  if (value === null) throw new Error("Read extensions inside ExtensionsPage.");
  return value;
}

function ExtensionsEnvironmentProvider({
  environmentId,
  loadProviderInventory,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly loadProviderInventory: boolean;
  readonly children: ReactNode;
}) {
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const allProjects = useProjects();
  const inventory = useEnvironmentQuery(extensionsInventory({ environmentId, input: {} }));
  const catalog = useEnvironmentQuery(extensionsDiscoverCatalog({ environmentId, input: {} }));
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const callbackOrigin = callbackOriginOf(useEnvironmentHttpBaseUrl(environmentId));
  const projects = allProjects.filter(
    (project) => project.environmentId === environmentId && project.isScratch !== true,
  );
  const projectsKnown = Option.isSome(shell.snapshot);
  const providerInventory = useProviderInventory({
    environmentId,
    roots: projects.map((project) => project.workspaceRoot),
    projectsKnown,
    providers,
    enabled: loadProviderInventory,
  });
  const value: ExtensionsEnvironment = {
    environmentId,
    canWrite,
    callbackOrigin,
    inventory: inventory.data,
    inventoryError: inventory.error,
    catalog: catalog.data,
    catalogError: catalog.error,
    providers,
    providerInventory,
    projects: projects.map((project) => ({ id: project.id, title: project.title })),
    projectsKnown,
  };
  return <ExtensionsEnvironmentContext value={value}>{children}</ExtensionsEnvironmentContext>;
}

/**
 * Settings ▸ Extensions for the one environment the settings scope chose (the
 * one its picker names), or the primary environment outside a scope. Every
 * page below it, and every change it sends, uses that environment; switching
 * environments remounts the page.
 */
export function ExtensionsPage({
  children,
  loadProviderInventory = false,
}: {
  readonly children: ReactNode;
  readonly loadProviderInventory?: boolean;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const scope = useOptionalSettingsScope();
  const environmentId =
    scope === null ? primaryEnvironmentId : (scope.environment?.environmentId ?? null);
  return (
    <SettingsPageContainer>
      {environmentId === null ? (
        <p className="text-sm text-muted-foreground">
          <T>Connect an execution environment to manage extensions.</T>
        </p>
      ) : (
        <ExtensionsEnvironmentProvider
          key={environmentId}
          environmentId={environmentId}
          loadProviderInventory={loadProviderInventory}
        >
          <div className="@container/extensions grid gap-10">{children}</div>
        </ExtensionsEnvironmentProvider>
      )}
    </SettingsPageContainer>
  );
}

type ExtensionsTab = "discover" | "installed";

const TAB_PATHS = {
  discover: "/settings/extensions",
  installed: "/settings/extensions/installed",
} as const;

/**
 * "Discover | Installed" on the left, a page-specific control on the right,
 * and below them which kind to show. Switching tab keeps the kind.
 */
export function ExtensionsTopBar({
  tab,
  kind,
  children,
}: {
  readonly tab: ExtensionsTab;
  readonly kind: ExtensionKind | undefined;
  readonly children?: ReactNode;
}) {
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  const show = (nextTab: ExtensionsTab, nextKind: ExtensionKind | undefined) =>
    void navigate({
      to: TAB_PATHS[nextTab],
      search: (current) => {
        const { kind: _previous, ...rest } = current as { kind?: ExtensionKind };
        return nextKind === undefined ? rest : { ...rest, kind: nextKind };
      },
    });
  return (
    <div className="grid gap-4">
      {/* Fixed heights: the bar stays put whichever tab, kind or control is showing. */}
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          aria-label={gt("Extensions")}
          variant="segmented"
          value={[tab]}
          onValueChange={(next) => {
            const nextTab = next[0];
            if ((nextTab === "discover" || nextTab === "installed") && nextTab !== tab) {
              show(nextTab, kind);
            }
          }}
        >
          <Toggle value="discover">
            <T>Discover</T>
          </Toggle>
          <Toggle value="installed">
            <T>Installed</T>
          </Toggle>
        </ToggleGroup>
        {children}
      </div>
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          aria-label={gt("Show", { $context: "which kind of extension to list" })}
          variant="pill"
          size="sm"
          className="-ms-3"
          value={[kind ?? "plugins"]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === undefined || value === (kind ?? "plugins")) return;
            show(tab, value === "skills" ? "skills" : undefined);
          }}
        >
          {EXTENSION_KINDS.map((item) => (
            <Toggle key={item} value={item}>
              {messages(EXTENSION_KIND_LABELS[item])}
            </Toggle>
          ))}
        </ToggleGroup>
        {/* MCP servers are plugins' business; the Skills tab has none to browse. */}
        {kind === "skills" ? null : (
          <Link
            to="/settings/extensions/all"
            className={`${SECTION_TITLE_LINK_CLASS} text-sm text-muted-foreground hover:text-foreground`}
          >
            <T>Browse all MCP servers</T>
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 transition-transform group-hover:translate-x-0.5"
            />
          </Link>
        )}
      </div>
    </div>
  );
}

/** A plain section: a heading, an optional action, then its content. An `id` makes it a settings-search target. */
export function ExtensionsSection({
  id,
  title,
  action,
  children,
}: {
  readonly id?: string;
  readonly title: ReactNode;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  const targetRef = useSettingsSearchTarget<HTMLElement>(id);
  return (
    <section
      id={id}
      ref={targetRef}
      tabIndex={id ? -1 : undefined}
      className="grid gap-3 outline-none"
      aria-label={typeof title === "string" ? title : undefined}
    >
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-3">
        <h2 className={SECTION_HEADING_CLASS}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A section heading: "Popular ›". */
export const SECTION_HEADING_CLASS = "text-lg font-medium tracking-[-0.015em] text-foreground";

/**
 * A link or trigger drawn like a ghost button: no underline, the shared grey
 * hover background, ghost-button padding and radius. The negative margin keeps
 * its text on the content edge.
 */
export const GHOST_LINK_CLASS =
  "-mx-2 -my-0.5 inline-flex items-center gap-1 rounded-[var(--control-radius)] px-2 py-0.5 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** Classes for a section title that opens the full list. */
export const SECTION_TITLE_LINK_CLASS = `group ${GHOST_LINK_CLASS}`;

/** A small muted action beside a section heading: "+ Add by URL". */
export function SectionAction({
  icon: Icon,
  disabled = false,
  onClick,
  children,
}: {
  readonly icon: LucideIcon;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <Button
      size="xs"
      variant="ghost-muted"
      // The hover background reaches past the text, which stays on the content edge.
      className="-me-2"
      disabled={disabled}
      onClick={onClick}
    >
      <Icon aria-hidden />
      {children}
    </Button>
  );
}

/**
 * "Show all 8 ⌄" / "Show less ⌃" beside a section heading. Collapsing keeps the
 * heading in view so the reader doesn't lose their place.
 */
export function SectionShowAllToggle({
  total,
  expanded,
  onExpandedChange,
}: {
  readonly total: number;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
}) {
  const gt = useGT();
  const Icon = expanded ? ChevronUpIcon : ChevronDownIcon;
  return (
    <Button
      size="xs"
      variant="ghost-muted"
      className="-me-2"
      aria-expanded={expanded}
      onClick={(event) => {
        if (expanded) {
          event.currentTarget
            .closest("section")
            ?.querySelector("h2")
            ?.scrollIntoView({ block: "nearest" });
        }
        onExpandedChange(!expanded);
      }}
    >
      {expanded ? gt("Show less") : gt("Show all {total}", { total })}
      <Icon aria-hidden />
    </Button>
  );
}

export function SectionTitleChevron() {
  return (
    <ChevronRightIcon
      aria-hidden
      className="size-4.5 text-muted-foreground/70 transition-transform group-hover:translate-x-0.5"
    />
  );
}

/**
 * The list an item's page was opened from (Discover, a category, a store,
 * Installed), with its search and filters, so the page's back link returns
 * there. Remembered for this window only.
 */
let lastListPage: { readonly href: string; readonly label: string } | null = null;
const ITEM_PATH_PREFIX = "/settings/extensions/item/";

/** Forgets the remembered list, as a new window starts; tests start each case this way. */
export function forgetListPage() {
  lastListPage = null;
}

/** Called by every list page so the item pages opened from it can go back to it. */
export function useRememberListPage(label: string) {
  const href = useLocation({ select: (location) => location.href });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the list in a module store item pages read later
  useEffect(() => {
    // A list page still mounted while the router moves on sees the next page's address.
    if (!href.startsWith(ITEM_PATH_PREFIX)) lastListPage = { href, label };
  }, [href, label]);
}

/** Goes to the list an item's page was opened from, or to Installed when it was opened directly. */
export function useBackToList(): () => void {
  const router = useRouter();
  return () => router.history.push(lastListPage?.href ?? "/settings/extensions/installed");
}

/**
 * An item page's back link: to the list it was opened from, or to `fallback`
 * when it was opened directly.
 */
export function BackToList({
  fallback,
  fallbackLabel,
}: {
  readonly fallback: "/settings/extensions" | "/settings/extensions/installed";
  readonly fallbackLabel: string;
}) {
  const router = useRouter();
  const remembered = lastListPage;
  if (remembered === null) return <BackLink to={fallback}>{fallbackLabel}</BackLink>;
  return (
    <div>
      <Button
        size="sm"
        variant="ghost-muted"
        className="-ms-2.5"
        onClick={() => router.history.push(remembered.href)}
      >
        <ChevronLeftIcon aria-hidden />
        {remembered.label}
      </Button>
    </div>
  );
}

export function BackLink({
  to,
  children,
}: {
  readonly to: "/settings/extensions" | "/settings/extensions/installed";
  readonly children: string;
}) {
  return (
    <div>
      <Button size="sm" variant="ghost-muted" className="-ms-2.5" render={<Link to={to} />}>
        <ChevronLeftIcon aria-hidden />
        {children}
      </Button>
    </div>
  );
}

export function MutedLine({ children }: { readonly children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
