import type { ServerProvider, ServerProviderModel } from "@t3tools/contracts";

/**
 * Another model Scient Agent can answer with when `model`'s account is out of quota: the first
 * listed model of another model account that is signed in through a sign-in (not a paid API key)
 * and has no exhausted window. A model's provider prefix names the account it uses.
 */
export function scientAgentAlternativeModel(
  provider: ServerProvider | undefined,
  model: string,
  isExhausted: (slug: string) => boolean,
): ServerProviderModel | undefined {
  if (provider?.driver !== "scient") return undefined;
  const accounts = provider.connection?.accounts ?? [];
  const accountOf = (slug: string) => {
    const prefix = slug.split("/", 1)[0];
    const entry = accounts.find((account) => account.id === prefix);
    return entry?.sameAccountAs === undefined
      ? entry
      : (accounts.find((account) => account.id === entry.sameAccountAs) ?? entry);
  };
  const current = accountOf(model);
  return provider.models.find((candidate) => {
    if (candidate.isCustom) return false;
    const account = accountOf(candidate.slug);
    return (
      account !== undefined &&
      account.id !== current?.id &&
      account.kind === "account" &&
      account.connected &&
      !isExhausted(candidate.slug)
    );
  });
}
