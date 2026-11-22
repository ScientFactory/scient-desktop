import { T, useGT, useMessages } from "gt-react";
import { ExternalLinkIcon, PlusIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { m, type MessageResolver } from "../../i18n/messages";
import {
  ACCOUNT_SERVICES,
  type AccountService,
  accountServicesFrom,
  accountServiceTagline,
  isAccountRoute,
} from "./accountServices";
import { AboutCard, DetailLayout, DetailHeader, DetailSection } from "./ExtensionDetailPages";
import { ExtensionRow } from "./ExtensionRow";
import { ExtensionsPage, MutedLine, useExtensionsEnvironment } from "./ExtensionsPage";
import { AddServicePlugin, ServiceAgents, useAccountService } from "./ServiceAgents";

export function AccountServiceItem({ service }: { readonly service: AccountService }) {
  const gt = useGT();
  const messages = useMessages();
  const { audience, connect, step, providers, reread } = useAccountService(service);
  const stepProvider =
    step && !isAccountRoute(step)
      ? providers.find((provider) => provider.instanceId === step.instanceId)
      : undefined;
  return (
    <ExtensionRow
      target={{ kind: "account", serviceId: service.id }}
      name={service.name}
      audience={audience}
      tagline={accountServiceTagline(service, messages) || undefined}
      trailing={
        step && !isAccountRoute(step) && stepProvider ? (
          <AddServicePlugin
            service={service}
            route={step}
            provider={stepProvider}
            refresh={reread}
          />
        ) : connect ? (
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={gt("Connect {name}", { name: service.name })}
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
export function accountServicesFor(
  category: string | undefined,
  query = "",
  resolve: MessageResolver = m,
): AccountService[] {
  const needle = query.trim().toLowerCase();
  return ACCOUNT_SERVICES.filter(
    (service) =>
      (category === undefined || service.categories.some((entry) => entry === category)) &&
      (needle === "" ||
        [service.name, accountServiceTagline(service, resolve), resolve(service.description)].some(
          (text) => text.toLowerCase().includes(needle),
        )),
  );
}

function AccountServiceDetail({ service }: { readonly service: AccountService }) {
  const gt = useGT();
  const messages = useMessages();
  const { routes, open } = useAccountService(service);
  const accountRoutes = routes.filter(isAccountRoute);
  const chatgptPage = accountRoutes.find((route) => route.family === "chatgpt")?.page;
  const claudePage = accountRoutes.find((route) => route.family === "claude")?.page;
  return (
    <DetailLayout
      back="installed"
      header={
        <DetailHeader
          name={service.name}
          tagline={accountServiceTagline(service, messages) || undefined}
          actions={null}
        />
      }
      description={messages(service.description)}
    >
      <DetailSection title={gt("Your agents")}>
        <ServiceAgents service={service} />
        <div className="flex flex-wrap gap-2">
          {chatgptPage ? (
            <Button variant="ghost-muted" size="sm" onClick={() => open(chatgptPage)}>
              <ExternalLinkIcon aria-hidden />
              <T>Manage in ChatGPT</T>
            </Button>
          ) : null}
          {claudePage ? (
            <Button variant="ghost-muted" size="sm" onClick={() => open(claudePage)}>
              <ExternalLinkIcon aria-hidden />
              <T>Manage on claude.ai</T>
            </Button>
          ) : null}
        </div>
      </DetailSection>
      {service.websiteUrl ? (
        <AboutCard rows={[[gt("Website"), service.websiteUrl.replace(/^https:\/\//, "")]]} />
      ) : null}
    </DetailLayout>
  );
}

/** Gmail and the like by their own id, any other ChatGPT app once the agents report it. */
function AccountServiceDetailContent({ serviceId }: { readonly serviceId: string }) {
  const gt = useGT();
  const { providerInventory, providers } = useExtensionsEnvironment();
  const service = accountServicesFrom(
    providerInventory.providers.length > 0 ? providerInventory.providers : providers,
  ).find((candidate) => candidate.id === serviceId);
  if (service) return <AccountServiceDetail service={service} />;
  return (
    <MutedLine>
      {["ready", "partial", "error"].includes(providerInventory.phase)
        ? gt("Not found.")
        : gt("Reading your agents…")}
    </MutedLine>
  );
}

export function AccountServiceDetailPage({ serviceId }: { readonly serviceId: string }) {
  return (
    <ExtensionsPage loadProviderInventory>
      <AccountServiceDetailContent serviceId={serviceId} />
    </ExtensionsPage>
  );
}
