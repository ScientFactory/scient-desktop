import type { ServerProvider } from "@t3tools/contracts";

const MAX_OBSERVED_ACCOUNTS = 200;

export interface ProviderAccountEvent {
  readonly name: "install.account_observed";
  readonly properties: {
    readonly provider: string;
    readonly email?: string;
    readonly plan?: string;
    readonly accountType?: string;
    readonly endpointHost?: string;
    readonly endpointPort?: number;
    readonly endpointScheme?: string;
    readonly endpointSource?: string;
  };
}

type EndpointProperties = Pick<
  ProviderAccountEvent["properties"],
  "endpointHost" | "endpointPort" | "endpointScheme" | "endpointSource"
>;

/** A custom endpoint split into host, port and scheme: the analytics guard drops links. */
function endpointProperties(auth: ServerProvider["auth"]): EndpointProperties {
  if (auth.type !== "customEndpoint" || auth.endpoint === undefined) return {};
  const url = URL.parse(auth.endpoint);
  if (url === null || url.hostname === "") return {};
  return {
    endpointHost: url.hostname,
    ...(url.port === "" ? {} : { endpointPort: Number(url.port) }),
    endpointScheme: url.protocol.replace(/:$/, ""),
    ...(auth.endpointSource === undefined ? {} : { endpointSource: auth.endpointSource }),
  };
}

/**
 * Reports each signed-in agent account once per server run: the account email
 * and plan label the agent itself shows in Scient, and each model subscription
 * an agent like Scient Agent is signed in to. The gateway keeps these apart
 * from usage events.
 */
export function createProviderAccountAnalyticsMapper() {
  const seen = new Set<string>();
  return {
    clear: () => seen.clear(),
    observe(snapshot: ReadonlyArray<ServerProvider>): ReadonlyArray<ProviderAccountEvent> {
      const events: ProviderAccountEvent[] = [];
      const add = (
        provider: string,
        email: string | undefined,
        plan: string | undefined,
        accountType: string | undefined,
        endpoint: EndpointProperties = {},
      ) => {
        if (!email && !plan && !accountType) return;
        const key = [
          provider,
          email ?? "",
          plan ?? "",
          accountType ?? "",
          endpoint.endpointScheme ?? "",
          endpoint.endpointHost ?? "",
          endpoint.endpointPort ?? "",
          endpoint.endpointSource ?? "",
        ].join("\u0000");
        if (seen.has(key) || seen.size >= MAX_OBSERVED_ACCOUNTS) return;
        seen.add(key);
        events.push({
          name: "install.account_observed",
          properties: {
            provider,
            ...(email ? { email } : {}),
            ...(plan ? { plan } : {}),
            ...(accountType ? { accountType } : {}),
            ...endpoint,
          },
        });
      };
      for (const provider of snapshot) {
        const { auth } = provider;
        if (auth.status === "authenticated") {
          add(
            provider.driver,
            auth.email?.trim().toLowerCase(),
            (provider.driver === "codex" && auth.type === "chatgpt") ||
              (provider.driver === "claudeAgent" &&
                auth.type !== undefined &&
                !["apiKey", "customEndpoint", "bedrock"].includes(auth.type))
              ? auth.label?.trim()
              : undefined,
            auth.type,
            endpointProperties(auth),
          );
        }
        // An agent that signs in to several model accounts lists each subscription.
        for (const account of provider.connection?.accounts ?? []) {
          if (
            account.kind === "account" &&
            account.connected &&
            account.sameAccountAs === undefined
          ) {
            const emails = [
              ...new Set([...(account.emails ?? []), ...(account.email ? [account.email] : [])]),
            ];
            if (emails.length === 0) add(provider.driver, undefined, undefined, account.id);
            for (const email of emails)
              add(provider.driver, email.trim().toLowerCase(), undefined, account.id);
          }
        }
      }
      return events;
    },
  };
}
