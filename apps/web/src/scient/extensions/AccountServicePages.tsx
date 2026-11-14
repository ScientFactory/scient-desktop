import { CheckIcon, ExternalLinkIcon, PlusIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ScientAgentAccounts } from "../providerConnection/ScientAgentAccounts";
import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";

import { Button } from "../../components/ui/button";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  ACCOUNT_SERVICES,
  type AccountService,
  accountServiceAudience,
  accountServiceRoutes,
  nextAccountServiceStep,
} from "./accountServices";
import {
  AboutCard,
  CardRow,
  DetailLayout,
  DetailHeader,
  DetailSection,
  PrimaryAction,
} from "./ExtensionDetailPages";
import { ExtensionRow } from "./ExtensionRow";
import { ExtensionsPage, MutedLine, useExtensionsEnvironment } from "./ExtensionsPage";
import { actOnProviderPlugin } from "./extensionsState";
import { openAuthorizationPage } from "./openAuthorizationPage";
import { useWindowFocusRefresh } from "./useWindowFocusRefresh";
import { WorksWithValue } from "./WorksWith";

/**
 * The service's place in every agent, from the agents' own inventories when Extensions has read
 * them, and the one step that connects it next. Returning from the provider's page re-reads the
 * agents that may now have it.
 */
function useAccountService(service: AccountService) {
  const { environmentId, canWrite, providers, providerInventory } = useExtensionsEnvironment();
  const act = useAtomCommand(actOnProviderPlugin, { reportFailure: true });
  const waiting = useRef(false);
  // Each agent counts once its own inventory arrives; a slow one never holds the others back.
  const finished = ["ready", "partial", "error"].includes(providerInventory.phase);
  const routes = accountServiceRoutes(
    service,
    providerInventory.providers.length > 0 ? providerInventory.providers : providers,
    (provider) => finished || provider.mcpServers !== undefined,
  );
  const step = nextAccountServiceStep(routes);
  useWindowFocusRefresh(() => {
    if (!waiting.current) return;
    waiting.current = false;
    for (const route of routes)
      void act({
        environmentId,
        input: { instanceId: route.instanceId, action: { type: "refresh-inventory" } },
      });
  });
  const open = (page: string) => {
    waiting.current = true;
    void openAuthorizationPage(async () => page);
  };
  return {
    routes,
    step,
    environmentId,
    /** The agents as last read, for an inline sign-in. */
    providers: providerInventory.providers.length > 0 ? providerInventory.providers : providers,
    /** A sign-in finishes in the browser; returning re-reads the agents. */
    expectReturn: () => {
      waiting.current = true;
    },
    audience: accountServiceAudience(routes),
    connect: step && canWrite ? () => open(step.page) : undefined,
    open,
  };
}

export function AccountServiceItem({ service }: { readonly service: AccountService }) {
  const { audience, connect } = useAccountService(service);
  return (
    <ExtensionRow
      target={{ kind: "account", serviceId: service.id }}
      name={service.name}
      audience={audience}
      tagline={service.tagline}
      trailing={
        connect ? (
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={`Connect ${service.name}`}
            onClick={connect}
          >
            <PlusIcon aria-hidden />
          </Button>
        ) : null
      }
    />
  );
}

/** The services in `category` whose name or description matches `query`. */
export function accountServicesFor(category: string | undefined, query = ""): AccountService[] {
  const needle = query.trim().toLowerCase();
  return ACCOUNT_SERVICES.filter(
    (service) =>
      (category === undefined || service.categories.some((entry) => entry === category)) &&
      (needle === "" ||
        [service.name, service.tagline, service.description].some((text) =>
          text.toLowerCase().includes(needle),
        )),
  );
}

/** Services an agent has through its account, or that `instanceId` has when one is chosen. */
export function connectedAccountServices(
  providers: Parameters<typeof accountServiceRoutes>[1],
  instanceId: string | null,
): AccountService[] {
  return ACCOUNT_SERVICES.filter((service) =>
    accountServiceRoutes(service, providers).some(
      (route) =>
        route.state === "connected" && (instanceId === null || route.instanceId === instanceId),
    ),
  );
}

const ROUTE_STATE_TEXT = {
  connected: "Connected",
  connect: "Not connected",
  "sign-in": "Sign-in needed",
  off: "Off in Codex",
  checking: "Checking…",
  update: "Update needed",
};

/** What a person can do for one agent: connect on the provider's page, or sign the agent in. */
function RouteAction({
  route,
  open,
  onSignIn,
}: {
  readonly route: ReturnType<typeof accountServiceRoutes>[number];
  readonly open: (page: string) => void;
  /** Signs the agent in where it is, when it can be; otherwise Settings → Providers. */
  readonly onSignIn?: (() => void) | undefined;
}) {
  if (route.state === "connect")
    return (
      <Button variant="ghost-primary" size="sm" onClick={() => open(route.page)}>
        {route.family === "chatgpt" ? "Connect in ChatGPT" : "Connect on claude.ai"}
      </Button>
    );
  if (route.state === "sign-in" && onSignIn)
    return (
      <Button variant="ghost-primary" size="sm" onClick={onSignIn}>
        {route.reason === "Not signed in" ? "Sign in with ChatGPT" : "Add ChatGPT"}
      </Button>
    );
  if (route.state === "sign-in")
    return (
      <Button variant="ghost-muted" size="sm" render={<Link to="/settings/providers" />}>
        Sign in
      </Button>
    );
  return (
    <span className="shrink-0 text-xs text-muted-foreground">{ROUTE_STATE_TEXT[route.state]}</span>
  );
}

function AccountServiceDetail({ service }: { readonly service: AccountService }) {
  const { routes, step, audience, connect, open, environmentId, providers, expectReturn } =
    useAccountService(service);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const chatgptPage = routes.find((route) => route.family === "chatgpt")?.page;
  const claudePage = routes.find((route) => route.family === "claude")?.page;
  return (
    <DetailLayout
      back="installed"
      header={
        <DetailHeader
          name={service.name}
          tagline={service.tagline}
          actions={
            step ? (
              <PrimaryAction
                icon={PlusIcon}
                disabled={connect === undefined}
                onClick={() => connect?.()}
              >
                {step.family === "chatgpt" ? "Connect in ChatGPT" : "Connect on claude.ai"}
              </PrimaryAction>
            ) : routes.some((route) => route.state === "connected") ? (
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <CheckIcon aria-hidden className="size-4" />
                Connected
              </span>
            ) : null
          }
        />
      }
      description={service.description}
    >
      <AboutCard
        rows={[
          ["Works with", <WorksWithValue key="works-with" audience={audience} />],
          ["Website", service.websiteUrl.replace(/^https:\/\//, "")],
        ]}
      />
      <DetailSection title="Your agents">
        {routes.length === 0 ? (
          <MutedLine>None of your agents reaches {service.name} through its account.</MutedLine>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-xl border bg-card">
            {routes.map((route) => {
              const provider = providers.find((entry) => entry.instanceId === route.instanceId);
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
                      <span className="block truncate text-xs text-muted-foreground">
                        {route.state === "connected"
                          ? route.family === "chatgpt"
                            ? "Through its ChatGPT account"
                            : "Through its Claude account"
                          : route.reason}
                      </span>
                    </span>
                    <RouteAction
                      route={route}
                      open={open}
                      onSignIn={
                        inline
                          ? () => {
                              expectReturn();
                              setSigningIn(
                                signingIn === route.instanceId ? null : route.instanceId,
                              );
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
        )}
        <div className="flex flex-wrap gap-2">
          {chatgptPage ? (
            <Button variant="ghost-muted" size="sm" onClick={() => open(chatgptPage)}>
              <ExternalLinkIcon aria-hidden />
              Manage in ChatGPT
            </Button>
          ) : null}
          {claudePage ? (
            <Button variant="ghost-muted" size="sm" onClick={() => open(claudePage)}>
              <ExternalLinkIcon aria-hidden />
              Manage on claude.ai
            </Button>
          ) : null}
        </div>
      </DetailSection>
    </DetailLayout>
  );
}

export function AccountServiceDetailPage({ serviceId }: { readonly serviceId: string }) {
  const service = ACCOUNT_SERVICES.find((candidate) => candidate.id === serviceId);
  return (
    <ExtensionsPage loadProviderInventory>
      {service ? <AccountServiceDetail service={service} /> : <MutedLine>Not found.</MutedLine>}
    </ExtensionsPage>
  );
}
