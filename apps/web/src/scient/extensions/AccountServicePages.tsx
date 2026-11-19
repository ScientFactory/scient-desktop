import { ExternalLinkIcon, PlusIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { ACCOUNT_SERVICES, type AccountService, accountServicesFrom } from "./accountServices";
import { AboutCard, DetailLayout, DetailHeader, DetailSection } from "./ExtensionDetailPages";
import { ExtensionRow } from "./ExtensionRow";
import { ExtensionsPage, MutedLine, useExtensionsEnvironment } from "./ExtensionsPage";
import { ServiceAgents, useAccountService } from "./ServiceAgents";

export function AccountServiceItem({ service }: { readonly service: AccountService }) {
  const { audience, connect } = useAccountService(service);
  return (
    <ExtensionRow
      target={{ kind: "account", serviceId: service.id }}
      name={service.name}
      audience={audience}
      tagline={service.tagline || undefined}
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

function AccountServiceDetail({ service }: { readonly service: AccountService }) {
  const { routes, open } = useAccountService(service);
  const chatgptPage = routes.find((route) => route.family === "chatgpt")?.page;
  const claudePage = routes.find((route) => route.family === "claude")?.page;
  return (
    <DetailLayout
      back="installed"
      header={
        <DetailHeader name={service.name} tagline={service.tagline || undefined} actions={null} />
      }
      description={service.description}
    >
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
      {service.websiteUrl ? (
        <AboutCard rows={[["Website", service.websiteUrl.replace(/^https:\/\//, "")]]} />
      ) : null}
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
      {["ready", "partial", "error"].includes(providerInventory.phase)
        ? "Not found."
        : "Reading your agents…"}
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
