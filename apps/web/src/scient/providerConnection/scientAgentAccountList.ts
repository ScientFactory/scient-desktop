import type {
  ProviderConnectionAccount,
  ProviderConnectionOperation,
  ServerProvider,
} from "@t3tools/contracts";

export interface ScientAgentAccountSections {
  /**
   * The user's own: usable now, or with a sign-in stored that is not usable
   * (an expired one), which can still be signed out of or renewed.
   */
  readonly yours: ReadonlyArray<ProviderConnectionAccount>;
  /** The rest: sign in through a browser or device flow. */
  readonly accounts: ReadonlyArray<ProviderConnectionAccount>;
  /** The rest: paste an API key. */
  readonly keys: ReadonlyArray<ProviderConnectionAccount>;
}

const isYours = (account: ProviderConnectionAccount) => account.connected || account.canDisconnect;

/**
 * The agent's sign-in list as the screen shows it. The agent decides what is
 * on the list and in what order; this only groups it and applies the search.
 */
export function scientAgentAccountSections(
  accounts: ReadonlyArray<ProviderConnectionAccount>,
  query: string,
): ScientAgentAccountSections {
  const needle = query.trim().toLowerCase();
  const matches = (account: ProviderConnectionAccount) =>
    needle.length === 0 ||
    account.name.toLowerCase().includes(needle) ||
    account.id.toLowerCase().includes(needle);
  const visible = accounts.filter(matches);
  return {
    yours: visible.filter(isYours),
    accounts: visible.filter((account) => !isYours(account) && account.kind === "account"),
    keys: visible.filter((account) => !isYours(account) && account.kind === "key"),
  };
}

/** What the user has typed, and the sign-in it was typed for. */
export interface ScientAgentAnswerDraft {
  readonly operationId: string;
  readonly value: string;
}

/**
 * The typed answer for the sign-in now running. Another client can cancel a
 * sign-in and start one for a different account on the same provider; what was
 * typed for the first must not be sent to the second.
 */
export function scientAgentAnswerFor(
  draft: ScientAgentAnswerDraft,
  active: ProviderConnectionOperation | null,
): string {
  return active !== null && draft.operationId === active.operationId ? draft.value : "";
}

/** The agent's sign-in list, once the agent is installed and has been checked. */
export function scientAgentAccounts(
  provider: ServerProvider,
): ReadonlyArray<ProviderConnectionAccount> | undefined {
  if (!provider.installed || provider.probePending === true) return undefined;
  return provider.connection?.accounts;
}

/**
 * The account sign-in this provider is in, or last ended. It is shown whether
 * or not the latest check could read the list: a sign-in in progress must stay
 * cancellable, and a failed one must still say why.
 */
export function scientAgentAccountOperation(
  provider: ServerProvider,
): ProviderConnectionOperation | null {
  return provider.connection?.accountOperation ?? null;
}
