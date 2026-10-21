import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type DiscoverCatalog,
  type EnvironmentId,
  type ExtensionsInventory,
  type ProjectId,
  type ServerProvider,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { ChevronLeftIcon, ChevronRightIcon, type LucideIcon } from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";

import {
  SettingsPageContainer,
  useSettingsSearchTarget,
} from "../../components/settings/settingsLayout";
import { useOptionalSettingsScope } from "../../components/settings/SettingsScopeContext";
import { Button, InlineButton } from "../../components/ui/button";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { useProjects } from "../../state/entities";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { useEnvironmentScope } from "../../state/session";
import { extensionsDiscoverCatalog, extensionsInventory } from "./extensionsState";
import { callbackOriginOf } from "./extensionsView";

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
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  /**
   * Whether `projects` is this environment's real project list. Before its
   * first snapshot arrives the list is empty, which proves nothing is deleted.
   */
  readonly projectsKnown: boolean;
}

const ExtensionsEnvironmentContext = createContext<ExtensionsEnvironment | null>(null);

export function useExtensionsEnvironment(): ExtensionsEnvironment {
  const value = useContext(ExtensionsEnvironmentContext);
  if (value === null) throw new Error("Read extensions inside ExtensionsPage.");
  return value;
}

function ExtensionsEnvironmentProvider({
  environmentId,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly children: ReactNode;
}) {
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const allProjects = useProjects();
  const inventory = useEnvironmentQuery(extensionsInventory({ environmentId, input: {} }));
  const catalog = useEnvironmentQuery(extensionsDiscoverCatalog({ environmentId, input: {} }));
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const callbackOrigin = callbackOriginOf(useEnvironmentHttpBaseUrl(environmentId));
  const value: ExtensionsEnvironment = {
    environmentId,
    canWrite,
    callbackOrigin,
    inventory: inventory.data,
    inventoryError: inventory.error,
    catalog: catalog.data,
    catalogError: catalog.error,
    providers,
    projects: allProjects
      .filter((project) => project.environmentId === environmentId && project.isScratch !== true)
      .map((project) => ({ id: project.id, title: project.title })),
    projectsKnown: Option.isSome(shell.snapshot),
  };
  return <ExtensionsEnvironmentContext value={value}>{children}</ExtensionsEnvironmentContext>;
}

/**
 * Settings ▸ Extensions for the one environment the settings scope chose (the
 * one its picker names), or the primary environment outside a scope. Every
 * page below it, and every change it sends, uses that environment; switching
 * environments remounts the page.
 */
export function ExtensionsPage({ children }: { readonly children: ReactNode }) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const scope = useOptionalSettingsScope();
  const environmentId =
    scope === null ? primaryEnvironmentId : (scope.environment?.environmentId ?? null);
  return (
    <SettingsPageContainer>
      {environmentId === null ? (
        <p className="text-sm text-muted-foreground">
          Connect an execution environment to manage extensions.
        </p>
      ) : (
        <ExtensionsEnvironmentProvider key={environmentId} environmentId={environmentId}>
          <div className="grid gap-10">{children}</div>
        </ExtensionsEnvironmentProvider>
      )}
    </SettingsPageContainer>
  );
}

type ExtensionsTab = "discover" | "installed";

/** "Discover | Installed" on the left, a page-specific control on the right. */
export function ExtensionsTopBar({
  tab,
  children,
}: {
  readonly tab: ExtensionsTab;
  readonly children?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <ToggleGroup
        aria-label="Extensions"
        variant="segmented"
        value={[tab]}
        onValueChange={(next) => {
          if (next[0] === "discover" && tab !== "discover") {
            void navigate({ to: "/settings/extensions" });
          } else if (next[0] === "installed" && tab !== "installed") {
            void navigate({ to: "/settings/extensions/installed" });
          }
        }}
      >
        <Toggle value="discover">Discover</Toggle>
        <Toggle value="installed">Installed</Toggle>
      </ToggleGroup>
      {children}
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

/** Classes for a section title that opens the full list. */
export const SECTION_TITLE_LINK_CLASS =
  "group inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

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
    <Button size="xs" variant="ghost-muted" disabled={disabled} onClick={onClick}>
      <Icon aria-hidden />
      {children}
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

export function BackLink({
  to,
  children,
}: {
  readonly to: "/settings/extensions" | "/settings/extensions/installed";
  readonly children: string;
}) {
  return (
    <div className="text-sm">
      <InlineButton tone="muted" render={<Link to={to} />}>
        <ChevronLeftIcon aria-hidden className="size-4" />
        {children}
      </InlineButton>
    </div>
  );
}

export function MutedLine({ children }: { readonly children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
