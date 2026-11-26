import {
  EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  antigravityWindowLimitsModel,
  collectLimitAccounts,
  collectLimitPools,
  collectProviderUsageLimits,
  displayLimitWindows,
  hubRoutes,
  instanceHubs,
  type LimitPoolWindow,
  // SCIENT-FORK: shared account identity for the hub pool.
  providersReadingAccounts,
} from "@t3tools/shared/usageLimits";
import { limitsNotice } from "@t3tools/shared/usageLimitsCopy";

export type ThreadDetailsLimits =
  | { readonly kind: "instance"; readonly limits: ServerProviderUsageLimits }
  | { readonly kind: "pool"; readonly windows: readonly LimitPoolWindow[] };

// collectLimitAccounts keys its input by environment; the card reads one, so any id serves.
const CARD_ENVIRONMENT = EnvironmentId.make("thread-details");

export function resolveThreadDetailsLimits(
  providerInstanceId: ProviderInstanceId | null,
  model: string | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): ThreadDetailsLimits | null {
  const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
  if (!provider) return null;
  const report = collectProviderUsageLimits(provider.instanceId, providers, sources, now, model);
  // Only this instance's data: the report keeps one instance per login, and any other entry may be
  // a different login or workspace, so fall back to the instance's own snapshot.
  const own =
    report?.accounts.find((entry) => entry.instanceId === provider.instanceId)?.limits ??
    provider.usageLimits;
  if (!own) return null;
  const hubs = instanceHubs(provider, sources);
  if (limitsNotice(own) === null || hubs.length === 0) return { kind: "instance", limits: own };
  // An instance sent to a hub reads no limits of its own; its hub pools the accounts it spends.
  return hubPool(provider.driver, model, providers, hubs, now) ?? { kind: "instance", limits: own };
}

export function resolveThreadHttpQuotas(
  providerInstanceId: ProviderInstanceId | null,
  sources: UsageLimitSourceSnapshots,
) {
  if (providerInstanceId === null) return [];
  return sources.flatMap((source) =>
    source.kind === "http"
      ? (source.quotaAccounts ?? []).flatMap((account) =>
          account.providerInstanceId === providerInstanceId
            ? account.windows.map((window) => ({
                key: JSON.stringify([source.id, account.id, window.id]),
                accountLabel: account.label,
                window,
              }))
            : [],
        )
      : [],
  );
}

export function nextPoolReset(window: LimitPoolWindow, now: number) {
  const pooled = window.members.length > 1;
  return (
    window.resets.find((reset) => reset.at > now && (!pooled || reset.restoresPercent > 0)) ?? null
  );
}

function hubPool(
  driver: ServerProvider["driver"],
  model: string | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): ThreadDetailsLimits | null {
  const routes = hubRoutes(sources, driver, model);
  const routed = sources.map((source) => ({
    ...source,
    accounts: source.accounts.filter(routes).map((account) =>
      account.driver === "antigravity"
        ? {
            ...account,
            usageLimits: {
              ...account.usageLimits,
              windows: account.usageLimits.windows.filter((window) =>
                antigravityWindowLimitsModel(window, model),
              ),
            },
          }
        : account,
    ),
  }));
  const readable = routed
    .flatMap((source) => source.accounts)
    .filter((account) => limitsNotice(account.usageLimits) === null);
  if (readable.length === 0) return null;
  // A signed-in login joins the pool only as a fresher reading of an account the hub routes to.
  // SCIENT-FORK:START — matched like the Usage page, so Antigravity's credential fingerprint counts
  // too. A local reading keeps only the quotas this model spends, like the hub's, and joins only
  // when one is left.
  const signedIn = providersReadingAccounts(
    providers,
    readable,
    routed.flatMap((source) => source.accounts),
  ).flatMap((provider) => {
    if (provider.driver !== "antigravity" || !provider.usageLimits) return [provider];
    // An older account's local reading meters Claude and GPT apart ("claude-quota", "gpt-weekly").
    const base = model?.slice(model.lastIndexOf("/") + 1);
    const windows = provider.usageLimits.windows.filter((window) => {
      const vendor = window.id.match(/^(claude|gpt)-(quota|weekly)$/)?.[1];
      return vendor !== undefined && base !== undefined && /^(claude|gpt)/.test(base)
        ? base.startsWith(vendor)
        : antigravityWindowLimitsModel(window, model);
    });
    return windows.length === 0
      ? []
      : [{ ...provider, usageLimits: { ...provider.usageLimits, windows } }];
  });
  // SCIENT-FORK:END
  const presentations = new Map([
    [
      CARD_ENVIRONMENT,
      {
        entry: { target: { label: "" } },
        serverConfig: { providers: signedIn, usageLimitSources: routed },
      },
    ],
  ]);
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  return pools.length > 0 ? { kind: "pool", windows: pools.flatMap(displayLimitWindows) } : null;
}

export function poolSources(window: LimitPoolWindow) {
  const hubs = window.members.flatMap(({ account }) =>
    account.environments.length === 0 && account.sourceLabel ? [account.sourceLabel] : [],
  );
  const signedIn = window.members.some(({ account }) => account.environments.length > 0);
  return { hubs: [...new Set(hubs)], signedIn };
}
