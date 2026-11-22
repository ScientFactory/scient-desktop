import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { ProviderStoreEntry, ServerProvider, ServerProviderPlugin } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { Link } from "@tanstack/react-router";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { PlusIcon } from "lucide-react";
import { useContext, useRef, useState, type ReactNode } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { Button } from "../../components/ui/button";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { ScientAgentAccounts } from "../providerConnection/ScientAgentAccounts";
import {
  type AccountService,
  type AccountServiceRoute,
  accountServiceAudience,
  accountServiceRoutes,
  isAccountRoute,
  NOT_SIGNED_IN_REASON,
  nextAccountServiceStep,
  type StorePluginRoute,
} from "./accountServices";
import { useProviderPluginActions } from "./extensionActions";
import { DetailSection } from "./ExtensionDetailPages";
import { ActionFeedback } from "./ExtensionItems";
import { MutedLine, useExtensionsEnvironment } from "./ExtensionsPage";
import {
  actOnProviderPlugin,
  extensionsProviderStoreEntry,
  extensionsProviderStorePage,
} from "./extensionsState";
import { areStoreTwins } from "./extensionsView";
import { needsAntigravityConnectionSignIn } from "./ProviderStorePages";
import { openAuthorizationPage } from "./openAuthorizationPage";
import { StoreInstall, storeProviders, useStoreInstall } from "./StoreInstall";
import { useWindowFocusRefresh } from "./useWindowFocusRefresh";

function CardRow({ children }: { readonly children: ReactNode }) {
  return <div className="flex min-h-14 items-center gap-3 px-4 py-3">{children}</div>;
}

/**
 * The service's place in every agent, from the agents' own inventories when Extensions has read
 * them, and the one step that connects it next. Returning from the provider's page, or adding a
 * plugin here, re-reads the agents that may now have it.
 */
export function useAccountService(service: AccountService) {
  const { environmentId, canWrite, providers, providerInventory } = useExtensionsEnvironment();
  const act = useAtomCommand(actOnProviderPlugin, { reportFailure: true });
  // While a sign-in may still finish in the browser, returning to Scient re-reads the agents: it
  // can take several visits, so the window stays open for a while rather than one return.
  const waiting = useRef<number | null>(null);
  // A provider page the browser would not open, offered as a link instead.
  const [blocked, setBlocked] = useState<string | null>(null);
  // Each agent counts once its own inventory arrives; a slow one never holds the others back.
  const finished = ["ready", "partial", "error"].includes(providerInventory.phase);
  const messages = useMessages();
  const routes = accountServiceRoutes(
    service,
    providerInventory.providers.length > 0 ? providerInventory.providers : providers,
    (provider) => finished || provider.mcpServers !== undefined,
    messages,
  );
  const step = nextAccountServiceStep(routes);
  // A Claude plugin added for one agent reaches the others that load Claude's plugins too.
  const reread = () => {
    for (const route of routes)
      void act({
        environmentId,
        input: { instanceId: route.instanceId, action: { type: "refresh-inventory" } },
      });
  };
  useWindowFocusRefresh(() => {
    if (waiting.current !== null) reread();
  });
  const expectReturn = () => {
    window.clearTimeout(waiting.current ?? undefined);
    waiting.current = window.setTimeout(() => {
      waiting.current = null;
    }, RETURN_WINDOW_MS);
  };
  const open = (page: string) => {
    expectReturn();
    setBlocked(null);
    void openAuthorizationPage(async () => page).then((opening) =>
      setBlocked(opening.outcome === "blocked" ? opening.url : null),
    );
  };
  return {
    routes,
    step,
    environmentId,
    /** The agents as last read, for an inline sign-in or install. */
    providers: providerInventory.providers.length > 0 ? providerInventory.providers : providers,
    /** A sign-in finishes in the browser; returning re-reads the agents. */
    expectReturn,
    blocked,
    reread,
    audience: accountServiceAudience(routes),
    /** Opens the next provider page; a store plugin step installs through `AddServicePlugin`. */
    connect: step && isAccountRoute(step) && canWrite ? () => open(step.page) : undefined,
    open,
  };
}

/** The Discover row's +: adds the service's store plugin in place, as the store's own Add does. */
export function AddServicePlugin({
  service,
  route,
  provider,
  refresh,
}: {
  readonly service: AccountService;
  readonly route: StorePluginRoute;
  readonly provider: ServerProvider;
  readonly refresh: () => void;
}) {
  const gt = useGT();
  const { allowed, lock, install } = useStoreInstall(provider, route.entry, refresh);
  return (
    <Button
      size="icon-sm"
      variant="ghost-muted"
      aria-label={gt("Connect {name}", { name: service.name })}
      disabled={!allowed || lock.locked}
      onClick={install}
    >
      <PlusIcon aria-hidden />
    </Button>
  );
}

/** One agent's Add for a store plugin, named for the agent that keeps it. */
function StoreRouteAction({
  route,
  provider,
  refresh,
}: {
  readonly route: StorePluginRoute;
  readonly provider: ServerProvider;
  readonly refresh: () => void;
}) {
  const gt = useGT();
  const { target, allowed, lock, install } = useStoreInstall(provider, route.entry, refresh);
  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <Button
        variant="ghost-primary"
        size="sm"
        disabled={!allowed || lock.locked}
        onClick={install}
      >
        {lock.busy
          ? gt("Adding…")
          : target.driver === "codex"
            ? gt("Add to Codex")
            : target.driver === "claudeAgent"
              ? gt("Add to Claude Code")
              : gt("Add to Scient Agent")}
      </Button>
      <ActionFeedback feedback={lock.feedback} />
    </span>
  );
}

/** How long after opening a provider's page returning to Scient re-reads the agents. */
const RETURN_WINDOW_MS = 10 * 60_000;

const ROUTE_STATE_TEXT = {
  connected: msg("Connected"),
  connect: msg("Not connected"),
  "sign-in": msg("Sign-in needed"),
  off: msg("Off in Codex"),
  checking: msg("Checking…"),
  update: msg("Update needed"),
  add: msg("Not added"),
  added: msg("Added"),
};

/**
 * What a person can do for one agent: connect on the provider's page, sign the agent in, or add
 * the service's plugin to it.
 */
function RouteAction({
  route,
  provider,
  open,
  reread,
  onSignIn,
}: {
  readonly route: AccountServiceRoute;
  readonly provider: ServerProvider | undefined;
  readonly open: (page: string) => void;
  readonly reread: () => void;
  /** Signs the agent in where it is, when it can be; otherwise Settings → Providers. */
  readonly onSignIn?: (() => void) | undefined;
}) {
  const gt = useGT();
  const messages = useMessages();
  if (route.state === "connect")
    return (
      <Button variant="ghost-primary" size="sm" onClick={() => open(route.page)}>
        {route.family === "chatgpt" ? gt("Connect in ChatGPT") : gt("Connect on claude.ai")}
      </Button>
    );
  if (route.state === "add" && provider)
    return <StoreRouteAction route={route} provider={provider} refresh={reread} />;
  if (route.state === "sign-in" && onSignIn)
    return (
      <Button variant="ghost-primary" size="sm" onClick={onSignIn}>
        {route.reason === messages(NOT_SIGNED_IN_REASON)
          ? gt("Sign in with ChatGPT")
          : gt("Add ChatGPT")}
      </Button>
    );
  if (route.state === "sign-in")
    return (
      <Button variant="ghost-muted" size="sm" render={<Link to="/settings/providers" />}>
        <T>Sign in</T>
      </Button>
    );
  return (
    <span className="shrink-0 text-xs text-muted-foreground">
      {route.state === "off" && !isAccountRoute(route)
        ? gt("Turned off")
        : messages(ROUTE_STATE_TEXT[route.state])}
    </span>
  );
}

function TurnOnInAntigravity({
  provider,
  plugin,
  label,
}: {
  readonly provider: ServerProvider;
  readonly plugin: ServerProviderPlugin;
  readonly label: string;
}) {
  const gt = useGT();
  const actions = useProviderPluginActions(provider, label, plugin, undefined);
  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <span className="text-xs text-muted-foreground">
        <T>Off in Antigravity</T>
      </span>
      <Button
        variant="ghost-primary"
        size="sm"
        disabled={actions.locked}
        onClick={() => void actions.setEnabled(true)}
      >
        {actions.busy ? gt("Turning on…") : gt("Turn on")}
      </Button>
      <ActionFeedback feedback={actions.feedback} />
    </span>
  );
}

/**
 * An Antigravity agent's row for a service its marketplace has as a plugin. Shown only once the
 * store answers and can add plugins; being added claims nothing about the plugin's own sign-in.
 */
function AntigravityServiceRow({
  route,
  provider,
}: {
  readonly route: StorePluginRoute;
  readonly provider: ServerProvider;
}) {
  const gt = useGT();
  const { environmentId } = useExtensionsEnvironment();
  const registry = useContext(RegistryContext);
  const atom = extensionsProviderStoreEntry({
    environmentId,
    input: { instanceId: route.instanceId, entryId: route.entry.id },
  });
  const entry = useEnvironmentQuery(atom);
  // The store also knows copies installed before agy recorded origins, by their manifest; those
  // keep their own id, so find them by name and act on that copy.
  const plugin =
    provider.plugins?.find((item) => item.id === route.entry.id) ??
    (entry.data?.installed
      ? provider.plugins?.find((item) => item.name === entry.data?.name)
      : undefined);
  if (entry.error || entry.data?.storeUnavailable) return null;
  const state =
    entry.data === null || entry.data.installationStateKnown === false
      ? "checking"
      : route.state === "add" && plugin !== undefined
        ? plugin.enabled
          ? "added"
          : "off"
        : route.state;
  return (
    <CardRow>
      <ProviderInstanceIcon
        driverKind={route.driver}
        displayName={route.label}
        acpRegistryIconUrl={provider.iconUrl}
        iconClassName="size-6"
        indicatorBackground="var(--card)"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{route.label}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {state === "added"
            ? entry.data && needsAntigravityConnectionSignIn(entry.data)
              ? gt("Added · its connection signs in only in Antigravity’s own plugin manager")
              : gt("Added · signs in the first time a chat uses it")
            : state === "add" && entry.data?.disabledReason
              ? entry.data.disabledReason
              : gt("Through its Antigravity Marketplace plugin")}
        </span>
      </span>
      {state === "checking" ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          <T>Checking…</T>
        </span>
      ) : state === "off" ? (
        plugin?.canSetEnabled ? (
          <TurnOnInAntigravity provider={provider} plugin={plugin} label={route.label} />
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">
            <T>Off in Antigravity</T>
          </span>
        )
      ) : state === "added" ? null : entry.data?.disabledReason ? (
        // The line above says why it can't be added; offer where to act, never a dead button.
        <Button
          variant="ghost-muted"
          size="sm"
          render={<Link to="/settings/extensions/installed" />}
        >
          <T>Open Installed</T>
        </Button>
      ) : (
        <span className="flex shrink-0 flex-col items-end gap-1">
          <StoreInstall
            provider={provider}
            entry={entry.data!}
            refresh={() => registry.refresh(atom)}
          />
        </span>
      )}
    </CardRow>
  );
}

/** Each agent's place for a service, with its action, as on Gmail's page and plugin pages. */
export function ServiceAgents({ service }: { readonly service: AccountService }) {
  const gt = useGT();
  const { routes, open, environmentId, providers, expectReturn, reread, blocked } =
    useAccountService(service);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  if (routes.length === 0)
    return (
      <MutedLine>
        <T>
          None of your agents can reach <Var>{service.name}</Var>.
        </T>
      </MutedLine>
    );
  // The line under an agent's name, when it says more than the action beside it does.
  const note = (route: AccountServiceRoute) =>
    route.state === "connected" || route.state === "added"
      ? route.family === "chatgpt"
        ? gt("Through its ChatGPT account")
        : route.family === "claude"
          ? gt("Through its Claude account")
          : route.family === "claude-store"
            ? gt("Through a Claude Code plugin")
            : gt("Through a Codex plugin")
      : route.state === "add" && route.driver === "scient"
        ? // Scient Agent loads another agent's plugins, so one Add serves both rows.
          route.family === "claude-store"
          ? gt("Uses Claude Code’s plugins, so one Add serves both")
          : gt("Uses Codex’s plugins, so one Add serves both")
        : route.state === "add" || (route.state === "connect" && route.family === "chatgpt")
          ? undefined
          : route.reason;
  return (
    <div className="grid min-w-0 gap-2">
      {blocked ? (
        <MutedLine>
          <T>
            Your browser didn’t open the page.{" "}
            <a href={blocked} target="_blank" rel="noreferrer" className="underline">
              Open it here
            </a>
            .
          </T>
        </MutedLine>
      ) : null}
      <div className="min-w-0 divide-y divide-border overflow-hidden rounded-xl border bg-card">
        {routes.map((route) => {
          const provider = providers.find((entry) => entry.instanceId === route.instanceId);
          if (route.family === "antigravity-store")
            return provider ? (
              <AntigravityServiceRow key={route.instanceId} route={route} provider={provider} />
            ) : null;
          // Scient Agent signs in to ChatGPT right here; the agent runs the sign-in.
          const inline = route.driver === "scient" && provider?.connection?.accounts;
          return (
            <div key={route.instanceId}>
              <CardRow>
                <ProviderInstanceIcon
                  driverKind={route.driver}
                  displayName={route.label}
                  acpRegistryIconUrl={provider?.iconUrl}
                  iconClassName="size-6"
                  indicatorBackground="var(--card)"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{route.label}</span>
                  {note(route) ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {note(route)}
                    </span>
                  ) : null}
                </span>
                <RouteAction
                  route={route}
                  provider={provider}
                  open={open}
                  reread={reread}
                  onSignIn={
                    inline
                      ? () => {
                          expectReturn();
                          setSigningIn(signingIn === route.instanceId ? null : route.instanceId);
                        }
                      : undefined
                  }
                />
              </CardRow>
              {signingIn === route.instanceId && provider && route.state === "sign-in" ? (
                <div className="px-4 pb-4">
                  <ScientAgentAccounts
                    environmentId={environmentId}
                    provider={provider}
                    only={(account) =>
                      account.id === "openai-codex" || account.sameAccountAs === "openai-codex"
                    }
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div>
        <Button size="xs" variant="ghost-muted" onClick={reread}>
          <T>Check again</T>
        </Button>
      </div>
    </div>
  );
}

const STORE_KINDS = ["shared", "codex", "antigravity"] as const;

/**
 * A store plugin's page lists every agent, when other agents' stores have the same service: each
 * agent's row adds its own store's copy, as a service page does.
 */
export function StoreEntryAgents({ entry }: { readonly entry: ProviderStoreEntry }) {
  const gt = useGT();
  const { environmentId, providers } = useExtensionsEnvironment();
  // Every agent reading another store, searched for this entry's name: instances can read
  // different homes, so one may list a copy another does not.
  const others = STORE_KINDS.filter((kind) => kind !== entry.kind).flatMap((kind) =>
    storeProviders(providers, kind).map((reader) => ({ kind, reader })),
  );
  const matches = useAtomValue(
    Atom.make((get) =>
      others.flatMap(({ kind, reader }) => {
        const result = get(
          extensionsProviderStorePage({
            environmentId,
            input: {
              instanceId: reader.instanceId,
              query: entry.displayName,
              preview: false,
              // The store's largest page: an exact twin ranks among a name search's first.
              limit: 50,
            },
          }),
        );
        const twin = (Option.getOrNull(AsyncResult.value(result))?.entries ?? []).find(
          (candidate) => areStoreTwins(candidate, entry),
        );
        return twin ? [[kind, twin.id] as const] : [];
      }),
    ),
  );
  // One copy per store; the first reader that lists it names it.
  const found = matches.filter(
    ([kind], index) => matches.findIndex(([other]) => other === kind) === index,
  );
  if (found.length === 0) return null;
  const ids: Partial<Record<ProviderStoreEntry["kind"], string>> = Object.fromEntries([
    [entry.kind, entry.id],
    ...found,
  ]);
  const service: AccountService = {
    id: `store:${entry.kind}:${entry.id}`,
    name: entry.displayName,
    tagline: entry.tagline ?? "",
    description: entry.description,
    categories: [],
    stores: {
      ...(ids.shared ? { claude: ids.shared } : {}),
      ...(ids.codex ? { codex: ids.codex } : {}),
      ...(ids.antigravity ? { antigravity: ids.antigravity } : {}),
    },
  };
  return (
    <DetailSection title={gt("Your agents")}>
      <ServiceAgents service={service} />
    </DetailSection>
  );
}
