import type {
  ProviderConnectionAccount,
  ProviderConnectionOperation,
  ProviderConnectionSubmitAuthorizationCodeInput,
  ProviderInstanceId,
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
 * on the list and in what order; this groups it, applies the search, and
 * shows an account once: an entry that signs in to another entry's account
 * (`sameAccountAs`) is left out while that account is one of the user's.
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
  const yoursIds = new Set(accounts.filter(isYours).map((account) => account.id));
  const shownElsewhere = (account: ProviderConnectionAccount) =>
    account.sameAccountAs !== undefined && yoursIds.has(account.sameAccountAs);
  const visible = accounts.filter((account) => !shownElsewhere(account) && matches(account));
  return {
    yours: visible.filter(isYours),
    accounts: visible.filter((account) => !isYours(account) && account.kind === "account"),
    keys: visible.filter((account) => !isYours(account) && account.kind === "key"),
  };
}

/** What the user has typed, and the sign-in and question it was typed for. */
export interface ScientAgentAnswerDraft {
  readonly operationId: string;
  readonly questionId: string | undefined;
  readonly value: string;
}

/**
 * The typed answer for the question now asked. Another client can cancel a
 * sign-in and start one for a different account on the same provider, or
 * answer a question so the agent asks the next; what was typed for one must
 * not be sent to another.
 */
export function scientAgentAnswerFor(
  draft: ScientAgentAnswerDraft,
  active: ProviderConnectionOperation | null,
): string {
  return active !== null &&
    draft.operationId === active.operationId &&
    draft.questionId === active.questionId
    ? draft.value
    : "";
}

/**
 * The submission of an answer to the question `current` shows. It names that
 * question, so an answer the agent has moved past is refused, not taken as the
 * answer to the next one.
 */
export function scientAgentAnswerInput(
  instanceId: ProviderInstanceId,
  current: ProviderConnectionOperation,
  answer: string,
): ProviderConnectionSubmitAuthorizationCodeInput {
  return {
    instanceId,
    operationId: current.operationId,
    authorizationCode: answer,
    ...(current.questionId ? { questionId: current.questionId } : {}),
  };
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
