import { AccountId, type EnvironmentId } from "@t3tools/contracts";

/** What `/settings/accounts` opens: one account's editor, the API keys, or one site's passwords. */
export interface AccountsLink {
  readonly account?: AccountId;
  readonly show?: "api-keys" | "passwords";
  /**
   * With `passwords`: the page whose logins Saved passwords shows, expanded, by its origin (port
   * included), matched as the key matches it. A bare host is an older link's.
   */
  readonly site?: string;
}

export function accountsSearch(raw: Record<string, unknown>): AccountsLink {
  return {
    ...(typeof raw.account === "string" && raw.account
      ? { account: AccountId.make(raw.account) }
      : {}),
    ...(raw.show === "api-keys" || raw.show === "passwords" ? { show: raw.show } : {}),
    ...(typeof raw.site === "string" && raw.site ? { site: raw.site.slice(0, 300) } : {}),
  };
}

/** Saved passwords on the computer that holds them, at the logins the key offers on `pageUrl`. */
export const savedPasswordsLink = (environmentId: EnvironmentId, pageUrl: string) => ({
  to: "/settings/accounts" as const,
  search: {
    machine: environmentId,
    show: "passwords" as const,
    site: URL.parse(pageUrl)?.origin ?? pageUrl,
  },
});

/** The link that opens one account's editor on the computer that holds it. */
export const accountEditorLink = (environmentId: EnvironmentId, accountId: AccountId) => ({
  to: "/settings/accounts" as const,
  search: { machine: environmentId, account: accountId },
});
