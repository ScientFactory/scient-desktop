import { CheckIcon, ExternalLinkIcon, PlusIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import {
  ACCOUNT_SERVICES,
  type AccountService,
  accountServicesFrom,
  accountServiceRoutes,
} from "./accountServices";
import {
  AboutCard,
  DetailLayout,
  DetailHeader,
  DetailSection,
  PrimaryAction,
} from "./ExtensionDetailPages";
import { ExtensionRow } from "./ExtensionRow";
import { ExtensionsPage, MutedLine, useExtensionsEnvironment } from "./ExtensionsPage";
import { WorksWithValue } from "./WorksWith";
import { ServiceAgents, useAccountService } from "./ServiceAgents";

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

function AccountServiceDetail({ service }: { readonly service: AccountService }) {
  const { routes, step, audience, connect, open } = useAccountService(service);
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
          service.websiteUrl ? ["Website", service.websiteUrl.replace(/^https:\/\//, "")] : null,
        ]}
      />
      <DetailSection title="Your agents">
        <ServiceAgents service={service} />
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

/** Gmail and the like by their own id, any other ChatGPT app once the agents report it. */
function AccountServiceDetailContent({ serviceId }: { readonly serviceId: string }) {
  const { providerInventory, providers } = useExtensionsEnvironment();
  const service = accountServicesFrom(
    providerInventory.providers.length > 0 ? providerInventory.providers : providers,
  ).find((candidate) => candidate.id === serviceId);
  if (service) return <AccountServiceDetail service={service} />;
  return (
    <MutedLine>
      {providerInventory.phase === "ready" ? "Not found." : "Reading your agents…"}
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
