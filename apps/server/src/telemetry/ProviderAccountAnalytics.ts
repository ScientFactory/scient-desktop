import type { ServerProvider } from "@t3tools/contracts";

const MAX_OBSERVED_ACCOUNTS = 200;

export interface ProviderAccountEvent {
  readonly name: "install.account_observed";
  readonly properties: {
    readonly provider: string;
    readonly email?: string;
    readonly plan?: string;
    readonly accountType?: string;
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
      ) => {
        if (!email && !plan && !accountType) return;
        const key = [provider, email ?? "", plan ?? "", accountType ?? ""].join("\u0000");
        if (seen.has(key) || seen.size >= MAX_OBSERVED_ACCOUNTS) return;
        seen.add(key);
        events.push({
          name: "install.account_observed",
          properties: {
            provider,
            ...(email ? { email } : {}),
            ...(plan ? { plan } : {}),
            ...(accountType ? { accountType } : {}),
          },
        });
      };
      for (const provider of snapshot) {
        const { auth } = provider;
        if (auth.status === "authenticated") {
          add(
            provider.driver,
            auth.email?.trim().toLowerCase(),
            provider.driver === "codex" || provider.driver === "claudeAgent"
              ? auth.label?.trim()
              : undefined,
            auth.type,
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
