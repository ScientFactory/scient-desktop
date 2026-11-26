import {
  type EnvironmentId,
  type ModelSelection,
  type ServerSettings,
  type ProjectId,
  resolveProjectProviderInstanceEnabled,
  type UsageLimitsReport,
  type ProviderInstanceId,
  type ProviderConsumeResetCreditInput,
  type ServerProviderSlashCommand,
  isProviderAvailable,
  PROVIDER_DISPLAY_NAMES,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
  type UsageLimitSourceSnapshot,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";
// SCIENT-FORK:START — Scient Agent's own accounts stand in for each other.
import {
  scientAgentAlternativeModel,
  scientSubscriptionFamily,
} from "./scientAgentModelFallback.ts";
import { resolveProviderModelPreferences } from "./scientModel.ts";
// SCIENT-FORK:END

import { isLocalLoopbackHost, isWildcardHost } from "./hostClassification.ts";

const MINUTE = 60_000;
const USAGE_READING_MAX_AGE_MS = 60 * MINUTE;
const SCIENT_USAGE_MAX_AGE_MS = 20 * MINUTE;
const USAGE_CACHE_LAG_MAX_MS = 15 * MINUTE;

const scopeToken = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/gu, "_");

function parseEpochMs(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveCanonicalModel(
  provider: Pick<ServerProvider, "models"> | undefined,
  model: string | null | undefined,
): string | null | undefined {
  if (!model || !provider) return model;
  const matched = provider.models.find(
    (candidate) => candidate.slug === model || candidate.aliases?.includes(model),
  );
  return matched?.slug ?? model;
}

function windowAppliesToModel(
  // SCIENT-FORK: usageLimits tells Antigravity's per-family Gemini quotas from one shared quota.
  provider: Pick<ServerProvider, "driver" | "models" | "usageLimits"> | undefined,
  window: ServerProviderUsageWindow,
  model: string | null | undefined,
): boolean {
  if (model === undefined || model === null) return true;
  const canonical = resolveCanonicalModel(provider, model) ?? model;
  if (window.modelIds !== undefined && !window.modelIds.includes(canonical)) {
    return false;
  }
  if (window.providerIds !== undefined) {
    const routeProvider = canonical.split("/")[0] ?? "";
    if (!window.providerIds.includes(routeProvider)) return false;
  }
  switch (provider?.driver) {
    case "claudeAgent":
      if (window.id.startsWith("seven_day_")) {
        return scopeToken(canonical).includes(window.id.slice("seven_day_".length));
      }
      return true;
    case "antigravity": {
      // SCIENT-FORK:START — a hub can prefix model ids, such as "ag/gemini-3.1-pro". Argon and
      // Carbon have their own quotas when the account reports them; older accounts report one
      // Gemini quota that covers every Gemini model.
      const base = canonical.slice(canonical.lastIndexOf("/") + 1);
      const family = base.match(/^(gemini|claude|gpt)-/)?.[1];
      const pool = window.id.match(/^(gemini|claude|gpt|3p)-/)?.[1];
      if (
        pool === "gemini" &&
        family === "gemini" &&
        provider?.usageLimits?.windows.some((entry) => /^gemini-(argon|carbon)-/.test(entry.id))
      ) {
        return antigravityQuotaFamily(window.id) === antigravityQuotaFamily(base);
      }
      // SCIENT-FORK:END
      return (
        pool === undefined ||
        family === undefined ||
        pool === family ||
        (pool === "3p" && (family === "claude" || family === "gpt"))
      );
    }
    case "opencode":
      return !window.id.startsWith("go_") || canonical.startsWith("opencode-go/");
    default:
      return true;
  }
}

function isWindowGating(
  provider: Pick<ServerProvider, "driver" | "usageLimits"> | undefined,
  window: ServerProviderUsageWindow,
): boolean {
  if (window.gating === false) return false;
  const windows = provider?.usageLimits?.windows ?? [];
  if (provider?.driver === "codex" && window.id === "individual") {
    // Seat-based plans spend credits only past their plan windows, so the credit cap blocks only plans without them.
    return !windows.some((entry) => entry.id === "primary" || entry.id === "secondary");
  }
  if (provider?.driver === "claudeAgent" && window.id === "monthly_spend") {
    return !windows.some((entry) => entry.id === "five_hour" || entry.id === "seven_day");
  }
  return true;
}

function isWindowFresh(
  limits: ServerProviderUsageLimits,
  window: ServerProviderUsageWindow,
  now: number,
  isScient: boolean,
): boolean {
  const checkedAt = parseEpochMs(limits.checkedAt);
  if (isScient && (window.fetchedAt === undefined || window.status === undefined)) return false;
  if (window.fetchedAt !== undefined) {
    const fetchedAt = parseEpochMs(window.fetchedAt);
    if (fetchedAt === null) return false;
    if (now - fetchedAt > (isScient ? SCIENT_USAGE_MAX_AGE_MS : USAGE_READING_MAX_AGE_MS)) {
      return false;
    }
    if (checkedAt !== null && checkedAt - fetchedAt > USAGE_CACHE_LAG_MAX_MS) return false;
    return true;
  }
  if (checkedAt === null) return false;
  return now - checkedAt <= USAGE_READING_MAX_AGE_MS;
}

function windowAvailability(
  window: ServerProviderUsageWindow,
): "available" | "blocked" | "unknown" {
  if (window.status !== undefined) {
    if (window.status === "exhausted") return "blocked";
    if (window.status === "ok" || window.status === "warning") return "available";
    return "unknown";
  }
  return (window.usedPercent ?? 0) >= 100 ? "blocked" : "available";
}

function normalizedFutureResetIso(window: ServerProviderUsageWindow, now: number): string | null {
  const resetsAt = parseEpochMs(window.resetsAt);
  return resetsAt !== null && resetsAt > now ? (window.resetsAt ?? null) : null;
}

function pickGoverningBlockedWindow(
  blocked: readonly ServerProviderUsageWindow[],
  now: number,
): { readonly window: ServerProviderUsageWindow; readonly resetsAt: string | null } {
  const withoutReset = blocked.find((window) => normalizedFutureResetIso(window, now) === null);
  if (withoutReset) return { window: withoutReset, resetsAt: null };
  let chosen = blocked[0]!;
  let chosenResetMs = parseEpochMs(normalizedFutureResetIso(chosen, now) ?? undefined);
  for (const candidate of blocked.slice(1)) {
    const candidateResetMs = parseEpochMs(normalizedFutureResetIso(candidate, now) ?? undefined);
    if (candidateResetMs !== null && (chosenResetMs === null || candidateResetMs > chosenResetMs)) {
      chosen = candidate;
      chosenResetMs = candidateResetMs;
    }
  }
  return { window: chosen, resetsAt: normalizedFutureResetIso(chosen, now) };
}

export type RouteQuotaEvaluation =
  | {
      readonly state: "blocked";
      readonly window: ServerProviderUsageWindow;
      readonly resetsAt: string | null;
    }
  | { readonly state: "available" }
  | { readonly state: "unknown" };

export function evaluateRouteQuota(
  provider: ServerProvider | undefined,
  now: number,
  model?: string,
): RouteQuotaEvaluation {
  const limits = provider?.usageLimits;
  if (!provider || !limits || limits.unavailable !== undefined) return { state: "unknown" };
  const canonical = resolveCanonicalModel(provider, model);
  const isScient = provider.driver === "scient";
  const routeProvider = canonical?.includes("/") ? canonical.split("/", 1)[0] : undefined;
  if (isScient && routeProvider === undefined) return { state: "unknown" };
  const hasUnknownSiblingAccount =
    routeProvider !== undefined && (limits.unknownProviderIds?.includes(routeProvider) ?? false);

  const byAccount = new Map<string, ServerProviderUsageWindow[]>();
  for (const window of limits.windows) {
    if (isScient && (!routeProvider || !window.providerIds?.includes(routeProvider))) continue;
    const key = window.accountId ?? "";
    const group = byAccount.get(key) ?? [];
    if (!byAccount.has(key)) byAccount.set(key, group);
    if (windowAppliesToModel(provider, window, canonical) && isWindowGating(provider, window)) {
      group.push(window);
    }
  }

  const blockedAccounts: Array<{
    readonly window: ServerProviderUsageWindow;
    readonly resetsAt: string | null;
  }> = [];
  let hasAvailableAccount = false;
  let hasUnknownAccount = false;

  for (const accountWindows of byAccount.values()) {
    const current = (window: ServerProviderUsageWindow) => {
      if (!isWindowFresh(limits, window, now, isScient)) return "unknown";
      const resetsAt = parseEpochMs(window.resetsAt);
      return resetsAt !== null && resetsAt <= now ? "unknown" : windowAvailability(window);
    };

    if (provider.driver === "cursor" && canonical) {
      const rails = /^(auto|default|grok|composer)/.test(canonical)
        ? ["apiPercentUsed", "autoPercentUsed"]
        : ["apiPercentUsed"];
      const readings = rails.map((id) => accountWindows.find((window) => window.id === id));
      const blocked = readings.filter(
        (window): window is ServerProviderUsageWindow =>
          window !== undefined && current(window) === "blocked",
      );
      if (blocked.length === rails.length) {
        blockedAccounts.push(pickGoverningBlockedWindow(blocked, now));
      } else if (readings.some((window) => window && current(window) === "available")) {
        hasAvailableAccount = true;
      } else {
        hasUnknownAccount = true;
      }
      continue;
    }

    const blocked = accountWindows.filter((window) => current(window) === "blocked");
    if (blocked.length > 0) {
      blockedAccounts.push(pickGoverningBlockedWindow(blocked, now));
    } else if (
      accountWindows.length > 0 &&
      accountWindows.every((window) => current(window) === "available")
    ) {
      hasAvailableAccount = true;
    } else {
      hasUnknownAccount = true;
    }
  }

  if (hasAvailableAccount) return { state: "available" };
  if (blockedAccounts.length > 0 && !hasUnknownAccount && !hasUnknownSiblingAccount) {
    // Across pooled accounts for one route, the soonest account reset unblocks the route.
    let soonest = blockedAccounts[0]!;
    let soonestMs = parseEpochMs(soonest.resetsAt ?? undefined);
    for (const candidate of blockedAccounts.slice(1)) {
      const candidateMs = parseEpochMs(candidate.resetsAt ?? undefined);
      if (candidateMs !== null && (soonestMs === null || candidateMs < soonestMs)) {
        soonest = candidate;
        soonestMs = candidateMs;
      }
    }
    return { state: "blocked", window: soonest.window, resetsAt: soonest.resetsAt };
  }
  return { state: "unknown" };
}

function fallbackLimitLabel(
  provider: Pick<ServerProvider, "driver" | "displayName">,
  window: Pick<ServerProviderUsageWindow, "label">,
): string {
  const windowLabel = window.label.trim();
  if (provider.driver === "scient") {
    return windowLabel.replace(/ \([^()]*@[^()]*\)(?= · )/u, "");
  }
  const providerName = provider.displayName?.trim() || String(provider.driver);
  if (!windowLabel) return providerName;
  if (windowLabel.toLowerCase().startsWith(providerName.toLowerCase())) return windowLabel;
  return `${providerName} · ${windowLabel}`;
}

export function exhaustedUsageWindow(
  provider: ServerProvider | undefined,
  now: number,
  model?: string,
) {
  const evaluation = evaluateRouteQuota(provider, now, model);
  return evaluation.state === "blocked" ? evaluation.window : undefined;
}

// SCIENT-FORK:START — subscription fallback shares picker visibility and preferred models.
export function resolveUsageLimitFallback(input: {
  readonly currentSelection: ModelSelection;
  readonly fallbackSelection: ModelSelection | null;
  readonly providers: readonly ServerProvider[];
  readonly now: number;
  readonly settings?: ServerSettings;
  readonly projectId?: ProjectId | null;
  readonly requireReplacementQuota?: boolean;
}): ModelSelection | undefined {
  const currentProvider = input.providers.find(
    (provider) => provider.instanceId === input.currentSelection.instanceId,
  );
  if (!currentProvider) return undefined;
  const currentFamily = scientSubscriptionFamily(currentProvider, input.currentSelection.model);
  const eligible = (
    provider: ServerProvider,
    selection: ModelSelection,
    options: { readonly includeDefaults?: boolean; readonly requireConfirmedQuota?: boolean } = {},
  ) => {
    const model = provider.models.find(
      (candidate) =>
        candidate.slug === selection.model || candidate.aliases?.includes(selection.model),
    );
    if (
      !provider.enabled ||
      !provider.installed ||
      provider.auth.status === "unauthenticated" ||
      provider.status === "error" ||
      !isProviderAvailable(provider) ||
      !model ||
      model.unavailableReason ||
      model.supportsTextGeneration === false ||
      (input.settings &&
        !resolveProjectProviderInstanceEnabled(
          input.settings,
          input.projectId ?? null,
          provider.instanceId,
        ))
    ) {
      return false;
    }
    const quota = evaluateRouteQuota(provider, input.now, model.slug);
    if (quota.state === "blocked") return false;
    if (options.requireConfirmedQuota && quota.state !== "available") return false;
    const preferences = input.settings?.providerModelPreferences?.[provider.instanceId];
    const hidden = options.includeDefaults
      ? resolveProviderModelPreferences(provider.driver, provider.models, preferences).hiddenModels
      : (preferences?.hiddenModels ?? []);
    return !hidden.includes(selection.model) && !hidden.includes(model.slug);
  };
  if (input.fallbackSelection) {
    const preferred = input.providers.find(
      (provider) => provider.instanceId === input.fallbackSelection?.instanceId,
    );
    const isCurrentRoute =
      preferred?.instanceId === currentProvider.instanceId &&
      resolveCanonicalModel(preferred, input.fallbackSelection.model) ===
        resolveCanonicalModel(currentProvider, input.currentSelection.model);
    if (
      preferred &&
      !isCurrentRoute &&
      eligible(preferred, input.fallbackSelection, {
        requireConfirmedQuota: input.requireReplacementQuota === true,
      })
    ) {
      return input.fallbackSelection;
    }
  }
  const agents = input.providers.filter((provider) => provider.driver === "scient");
  agents.sort(
    (a, b) =>
      Number(b.instanceId === input.currentSelection.instanceId) -
      Number(a.instanceId === input.currentSelection.instanceId),
  );
  const findAutomatic = (requireConfirmedQuota: boolean) => {
    for (const agent of agents) {
      const alternative = scientAgentAlternativeModel(
        agent,
        input.currentSelection.model,
        (slug) =>
          !eligible(
            agent,
            { instanceId: agent.instanceId, model: slug },
            { includeDefaults: true, requireConfirmedQuota },
          ),
        currentFamily,
      );
      if (alternative) return { instanceId: agent.instanceId, model: alternative.slug };
    }
    return undefined;
  };
  return findAutomatic(true) ?? (input.requireReplacementQuota ? undefined : findAutomatic(false));
}
// SCIENT-FORK:END

export function resolveNewThreadModelSelection(input: {
  readonly defaultSelection: ModelSelection | null;
  readonly explicitSelection?: ModelSelection | null;
  readonly fallbackSelection: ModelSelection | null;
  readonly providers: readonly ServerProvider[];
  readonly now: number;
  readonly settings?: ServerSettings;
  readonly projectId?: ProjectId | null;
}) {
  const selection = input.explicitSelection ?? input.defaultSelection;
  const unchanged = { selection, fallback: null };
  if (input.explicitSelection || !selection) return unchanged;
  const provider = input.providers.find((entry) => entry.instanceId === selection.instanceId);
  const evaluation = evaluateRouteQuota(provider, input.now, selection.model);
  if (!provider || evaluation.state !== "blocked") return unchanged;
  const fallback = resolveUsageLimitFallback({
    ...input,
    currentSelection: selection,
    requireReplacementQuota: true,
  });
  return fallback
    ? {
        selection: fallback,
        fallback: {
          provider,
          window: evaluation.window,
          limitLabel: fallbackLimitLabel(provider, evaluation.window),
          resetsAt: evaluation.resetsAt,
        },
      }
    : unchanged;
}

export const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings/Usage";
export const CHATGPT_USAGE_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";
/** A ChatGPT Business admin caps plan use in other apps; only the admin can raise it. */
export const CHATGPT_WORKSPACE_USAGE_LIMIT_CODE =
  "subscription_sharing_workplace_individual_usage_limit_exceeded";
/** OpenAI's partner guidelines fix this wording; the user sends it to their admin themselves. */
export const CHATGPT_WORKSPACE_ADMIN_REQUEST =
  "I've reached the limit for using my ChatGPT plan in Scient. Could you increase our workspace's usage limits so I can continue?\n\nGo to admin.openai.com → Workspace → Usage limits. Thank you!";

export function usesChatGptSharing(provider: ServerProvider | null | undefined): boolean {
  return provider?.auth.status === "authenticated" && provider.auth.subscriptionSharing === true;
}

export const CURSOR_USAGE_WINDOWS = [
  {
    id: "totalPercentUsed",
    label: "Overall",
    description: "All usage on your plan this billing cycle.",
  },
  {
    id: "autoPercentUsed",
    label: "Cursor Models",
    description: "Grok, Composer, and Auto use this allowance.",
  },
  {
    id: "apiPercentUsed",
    label: "Other Models",
    description: "Usage allowance for third-party models such as Claude, GPT, and Gemini.",
  },
] as const;

export function cursorUsageWindowDetails(id: string, pool: LimitPool) {
  const details = CURSOR_USAGE_WINDOWS.find((window) => window.id === id);
  return details &&
    ((pool.windows.length === 1 && id === "totalPercentUsed") || hasDuplicateCursorTotal(pool))
    ? { ...details, label: null, description: undefined }
    : details;
}

function cursorUsageWindowRank(id: string): number {
  const rank = CURSOR_USAGE_WINDOWS.findIndex((window) => window.id === id);
  return rank < 0 ? CURSOR_USAGE_WINDOWS.length : rank;
}

export function providersWithLimits(
  providers: readonly ServerProvider[],
): readonly ServerProvider[] {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      provider.usageLimits !== undefined,
  );
}

export type LimitPresentations = ReadonlyMap<
  EnvironmentId,
  {
    readonly entry: { readonly target: { readonly label: string } };
    readonly serverConfig: {
      readonly providers: readonly ServerProvider[];
      readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
    } | null;
  }
>;

export function collectExternalUsageLinks(
  presentations: LimitPresentations,
  accountLabel = (provider: string, environment: string) => `${provider} on ${environment}`,
) {
  const links = new Map<
    string,
    {
      readonly label: string;
      readonly url: string;
      readonly message: string | undefined;
      readonly accounts: readonly string[];
    }
  >();
  for (const presentation of presentations.values()) {
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const external = provider.usageLimits?.externalUsage;
      if (external && provider.auth.status === "authenticated") {
        const account = accountLabel(
          provider.displayName ?? provider.instanceId,
          presentation.entry.target.label,
        );
        links.set(external.url, {
          ...external,
          message: provider.usageLimits?.unavailable?.message,
          accounts: [...new Set([...(links.get(external.url)?.accounts ?? []), account])],
        });
      }
    }
  }
  return [...links.values()];
}

function accountKey(
  driver: ServerProvider["driver"],
  email: string | undefined,
  limits?: ServerProviderUsageLimits,
): string | null {
  const normalizedEmail = email?.trim().toLowerCase();
  if (normalizedEmail) return `${driver}:${normalizedEmail}`;
  return limits?.credentialFingerprint
    ? `${driver}:credential:${limits.credentialFingerprint}`
    : null;
}

interface AccountReport {
  readonly driver: ServerProvider["driver"];
  readonly email?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly usageLimits?: ServerProviderUsageLimits | undefined;
}

const nativeReport = (provider: ServerProvider): AccountReport => ({
  driver: provider.driver,
  email: provider.auth.email,
  workspaceId: provider.auth.workspaceId,
  usageLimits: provider.usageLimits,
});

// Include every enabled login, even unreadable workspaces.
function accountKeyResolver(reports: Iterable<AccountReport>) {
  const workspaces = new Map<string, Set<string>>();
  for (const report of reports) {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (key && report.workspaceId) {
      workspaces.set(key, (workspaces.get(key) ?? new Set()).add(report.workspaceId));
    }
  }
  return (report: AccountReport): string | null => {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (!key) return null;
    if (report.workspaceId) return `${key}:${report.workspaceId}`;
    const known = workspaces.get(key);
    if (!known) return key;
    return known.size === 1 ? `${key}:${[...known][0]}` : null;
  };
}

// SCIENT-FORK:START — thread details pool signed-in logins with hub accounts by the same identity
// as the Usage page, so a Google credential fingerprint matches as well as an e-mail.
/** The signed-in logins that read the same account as one of these hub accounts. */
export function providersReadingAccounts(
  providers: readonly ServerProvider[],
  accounts: readonly UsageLimitSourceAccount[],
  /** Every account the hub lists, readable or not, so a login's workspace resolves as in the pool. */
  knownAccounts: readonly UsageLimitSourceAccount[] = accounts,
): ServerProvider[] {
  const resolveKey = accountKeyResolver([
    ...providers.filter((provider) => provider.enabled).map(nativeReport),
    ...knownAccounts,
  ]);
  const keys = new Set(accounts.flatMap((account) => resolveKey(account) ?? []));
  return providers.filter((provider) => {
    const key = resolveKey(nativeReport(provider));
    return key !== null && keys.has(key);
  });
}
// SCIENT-FORK:END

const hubAccountName = (account: { readonly id: string }) => account.id.replace(/\.json$/i, "");

function limitAccountKeyResolver(presentations: LimitPresentations) {
  return accountKeyResolver(
    [...presentations.values()].flatMap((presentation) => [
      ...(presentation.serverConfig?.providers ?? [])
        .filter((provider) => provider.enabled)
        .map(nativeReport),
      ...(presentation.serverConfig?.usageLimitSources ?? []).flatMap((source) => source.accounts),
    ]),
  );
}

const nativeRowKey = (
  resolveKey: ReturnType<typeof accountKeyResolver>,
  environmentId: EnvironmentId,
  provider: ServerProvider,
) => resolveKey(nativeReport(provider)) ?? `${environmentId}:${provider.instanceId}`;

const hubRowKey = (
  resolveKey: ReturnType<typeof accountKeyResolver>,
  environmentId: EnvironmentId,
  source: UsageLimitSourceSnapshot,
  account: UsageLimitSourceAccount,
) =>
  resolveKey(account) ??
  `${hubIdentity(environmentId, source)}:${account.id}${account.workspaceId ? `:${account.workspaceId}` : ""}`;

// Source ids are environment-local, so only a remote endpoint names the same hub across environments.
function hubIdentity(environmentId: EnvironmentId, source: UsageLimitSourceSnapshot): string {
  // The server supplies canonical endpoints; native URL polyfills can misparse IPv6 hosts.
  const endpoint = source.endpoint;
  const host = endpoint?.match(/^https?:\/\/(\[[\da-f:.]+\]|[^:/?#@]+)(?::\d+)?(?:\/|$)/)?.[1];
  const local =
    !host ||
    isLocalLoopbackHost(host) ||
    isWildcardHost(host) ||
    // Each machine resolves these to itself too; shared host classification leaves them out.
    /\.localhost\.*$|^\[::ffff:(?:127\.|7f[\da-f]{2}:)/i.test(host);
  return endpoint && !local ? endpoint : `${environmentId}:${source.id}`;
}

export interface LimitAccount {
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  readonly displayName: string | null;
  readonly email: string | undefined;
  readonly plan: string | undefined;
  readonly accentColor: string | undefined;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly sourceLabel: string | null;
  readonly redeem: {
    readonly environmentId: EnvironmentId;
    readonly input: ProviderConsumeResetCreditInput;
  } | null;
  readonly limits: ServerProviderUsageLimits;
}

export function collectHttpQuotaSources(presentations: Parameters<typeof collectLimitAccounts>[0]) {
  return [...presentations].flatMap(([environmentId, presentation]) =>
    (presentation.serverConfig?.usageLimitSources ?? []).flatMap((source) =>
      source.kind === "http" && source.quotaAccounts?.length
        ? [
            {
              ...source,
              key: `${environmentId}:${source.id}`,
              label:
                presentations.size > 1
                  ? `${presentation.entry.target.label} · ${source.label}`
                  : source.label,
            },
          ]
        : [],
    ),
  );
}

export function collectLimitAccounts(presentations: LimitPresentations): readonly LimitAccount[] {
  const accounts = new Map<string, LimitAccount>();
  const creditSources = new Map<string, LimitAccount>();
  const hubRedeems = new Map<string, LimitAccount>();
  const planSources = new Map<string, LimitAccount>();
  const merge = (key: string, next: LimitAccount) => {
    // Prefer hub redemption to clear its routing cooldown too; displayed balance still follows the freshest read.
    const previousHub = hubRedeems.get(key);
    if (
      next.redeem &&
      "sourceId" in next.redeem.input &&
      (!previousHub || Date.parse(next.limits.checkedAt) > Date.parse(previousHub.limits.checkedAt))
    ) {
      hubRedeems.set(key, next);
    }
    const previousCredit = creditSources.get(key);
    if (
      next.limits.resetCredits &&
      (!previousCredit ||
        Date.parse(next.limits.checkedAt) > Date.parse(previousCredit.limits.checkedAt))
    ) {
      creditSources.set(key, next);
    }
    const previousPlan = planSources.get(key);
    if (
      next.plan &&
      (!previousPlan ||
        Date.parse(next.limits.checkedAt) > Date.parse(previousPlan.limits.checkedAt))
    ) {
      planSources.set(key, next);
    }
    const previous = accounts.get(key);
    if (!previous) {
      accounts.set(key, next);
      return;
    }
    const fresher = Date.parse(next.limits.checkedAt) > Date.parse(previous.limits.checkedAt);
    const environments = [
      ...previous.environments,
      ...next.environments.filter(
        (candidate) =>
          !previous.environments.some((seen) => seen.environmentId === candidate.environmentId),
      ),
    ];
    const winner = fresher ? next : previous;
    const creditSource = creditSources.get(key);
    // A hub e-mail names the account better than the driver's default instance name.
    const hubEmail = [previous, next].some(
      (account) => account.environments.length === 0 && account.email,
    );
    const displayName = previous.displayName ?? next.displayName;
    accounts.set(key, {
      ...previous,
      displayName:
        hubEmail &&
        displayName?.toLowerCase() === PROVIDER_DISPLAY_NAMES[previous.driver]?.toLowerCase()
          ? null
          : displayName,
      plan: planSources.get(key)?.plan ?? previous.plan ?? next.plan,
      accentColor: previous.accentColor ?? next.accentColor,
      environments,
      sourceLabel: environments.length > 0 ? null : (previous.sourceLabel ?? next.sourceLabel),
      redeem:
        hubRedeems.get(key)?.redeem ??
        (creditSource ? creditSource.redeem : (winner.redeem ?? previous.redeem ?? next.redeem)),
      limits: {
        ...winner.limits,
        ...(creditSource?.limits.resetCredits
          ? { resetCredits: creditSource.limits.resetCredits }
          : { resetCredits: undefined }),
      },
    });
  };
  const resolveKey = limitAccountKeyResolver(presentations);
  for (const [environmentId, presentation] of presentations) {
    const label = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (!provider.usageLimits || limitsNotice(provider.usageLimits) !== null) continue;
      merge(nativeRowKey(resolveKey, environmentId, provider), {
        key: `${environmentId}:${provider.instanceId}`,
        driver: provider.driver,
        displayName: provider.displayName?.trim() || null,
        email: provider.auth.email,
        plan: provider.auth.label,
        accentColor: provider.accentColor,
        environments: [{ environmentId, label }],
        sourceLabel: null,
        redeem: { environmentId, input: { instanceId: provider.instanceId } },
        limits: provider.usageLimits,
      });
    }
  }
  const labelEnvironment = presentations.size > 1;
  for (const [environmentId, presentation] of presentations) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      const sourceLabel = labelEnvironment
        ? `${presentation.entry.target.label} · ${source.label}`
        : source.label;
      for (const account of source.accounts) {
        if (limitsNotice(account.usageLimits) !== null) continue;
        const resolved = resolveKey(account);
        // A resolved account already has an identity; its public key must stay distinct from others'.
        const hub = resolved ? `${environmentId}:${source.id}` : hubIdentity(environmentId, source);
        const key = `${hub}:${account.id}${account.workspaceId ? `:${account.workspaceId}` : ""}`;
        merge(hubRowKey(resolveKey, environmentId, source, account), {
          key,
          driver: account.driver,
          displayName: account.email ? null : hubAccountName(account),
          email: account.email,
          plan: account.plan,
          accentColor: undefined,
          environments: [],
          sourceLabel,
          redeem: account.usageLimits.resetCredits?.nextCreditId
            ? {
                environmentId,
                input: {
                  sourceId: source.id,
                  accountId: account.id,
                  creditId: account.usageLimits.resetCredits.nextCreditId,
                },
              }
            : null,
          limits: account.usageLimits,
        });
      }
    }
  }
  return [...accounts.values()];
}

/** Hub accounts whose read failed and that no other report shows as a row, with their names. */
export function unshownFailedHubAccounts(
  presentations: LimitPresentations,
): ReadonlyMap<UsageLimitSourceAccount, string> {
  const resolveKey = limitAccountKeyResolver(presentations);
  const shownRows = new Set<string>();
  for (const [environmentId, presentation] of presentations) {
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (provider.usageLimits && limitsNotice(provider.usageLimits) === null) {
        shownRows.add(nativeRowKey(resolveKey, environmentId, provider));
      }
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      for (const account of source.accounts) {
        if (limitsNotice(account.usageLimits) === null) {
          shownRows.add(hubRowKey(resolveKey, environmentId, source, account));
        }
      }
    }
  }
  const failed = new Map<UsageLimitSourceAccount, string>();
  for (const [environmentId, presentation] of presentations) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      for (const account of source.accounts) {
        if (account.usageLimits.unavailable?.reason !== "probeFailed") continue;
        if (shownRows.has(hubRowKey(resolveKey, environmentId, source, account))) continue;
        failed.set(account, account.email ?? hubAccountName(account));
      }
    }
  }
  return failed;
}

export interface LimitPoolMember {
  readonly account: LimitAccount;
  readonly window: ServerProviderUsageWindow;
  readonly refillPercent: number;
}

export interface LimitPoolWindow {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly members: readonly LimitPoolMember[];
  readonly columns: ReadonlyArray<
    LimitPoolMember | { readonly account: LimitAccount; readonly window: null }
  >;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly pace: LimitPace | null;
  readonly resets: ReadonlyArray<{
    readonly member: LimitPoolMember;
    readonly at: number;
    readonly restoresPercent: number;
  }>;
}

export interface LimitPool {
  readonly driver: ServerProvider["driver"];
  readonly accounts: readonly LimitAccount[];
  readonly windows: readonly LimitPoolWindow[];
}

function hasDuplicateCursorTotal(pool: LimitPool): boolean {
  if (pool.windows.length !== 2) return false;
  const total = pool.windows.find((window) => window.id === "totalPercentUsed");
  const auto = pool.windows.find((window) => window.id === "autoPercentUsed");
  return (
    total !== undefined &&
    auto !== undefined &&
    total.members.length === auto.members.length &&
    total.members.every(({ account, window }) =>
      account.limits.windows.some(
        (candidate) =>
          candidate.id === auto.id &&
          candidate.kind === auto.kind &&
          candidate.usedPercent === window.usedPercent &&
          candidate.resetsAt === window.resetsAt,
      ),
    )
  );
}

export function displayLimitWindows(pool: LimitPool) {
  if (pool.driver === "antigravity") {
    return [...pool.windows].sort(
      (left, right) =>
        Number(!left.id.startsWith("gemini-")) - Number(!right.id.startsWith("gemini-")) ||
        left.id
          .replace(/-(5h|weekly|quota)$/, "")
          .localeCompare(right.id.replace(/-(5h|weekly|quota)$/, "")) ||
        WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind],
    );
  }
  if (pool.driver !== "cursor") return pool.windows;
  const hasAuto = pool.windows.some((window) => window.id === "autoPercentUsed");
  const hasApi = pool.windows.some((window) => window.id === "apiPercentUsed");
  const hideTotal = (hasAuto && hasApi) || hasDuplicateCursorTotal(pool);
  return pool.windows
    .filter((window) => !hideTotal || window.id !== "totalPercentUsed")
    .sort((left, right) => cursorUsageWindowRank(left.id) - cursorUsageWindowRank(right.id));
}

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function collectLimitPools(
  accounts: readonly LimitAccount[],
  now: number,
): readonly LimitPool[] {
  const byDriver = new Map<ServerProvider["driver"], LimitAccount[]>();
  for (const account of accounts) {
    const list = byDriver.get(account.driver);
    if (list) list.push(account);
    else byDriver.set(account.driver, [account]);
  }
  return [...byDriver].map(([driver, members]) => {
    const orderWindow = members
      .flatMap((account) => account.limits.windows)
      .sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind])[0];
    const orderReset = (account: LimitAccount) => {
      const window = account.limits.windows.find(
        (window) => orderWindow && poolKey(driver, window) === poolKey(driver, orderWindow),
      );
      return (
        (window ? resetMillis(poolMember(account, window, now).window) : null) ??
        Number.POSITIVE_INFINITY
      );
    };
    const sorted = [...members].sort(
      (left, right) =>
        orderReset(left) - orderReset(right) ||
        accountSortName(left).localeCompare(accountSortName(right)) ||
        left.key.localeCompare(right.key),
    );
    return { driver, accounts: sorted, windows: poolWindows(sorted, now) };
  });
}

function accountSortName(account: LimitAccount): string {
  return (account.displayName ?? account.email ?? account.key).toLowerCase();
}

const CODEX_PLAN_CAPACITY: Record<string, number> = {
  "ChatGPT Plus Subscription": 1,
  "ChatGPT Pro 100 Subscription": 5,
  "ChatGPT Pro 200 Subscription": 20,
};
// Claude's published plan multipliers describe the session allowance only.
const CLAUDE_SESSION_CAPACITY: Record<string, number> = { Pro: 1, Max: 5, Ultra: 20 };

function planCapacity(account: LimitAccount, kind: ServerProviderUsageWindow["kind"]) {
  if (!account.plan) return undefined;
  if (account.driver === "codex" && (kind === "session" || kind === "weekly")) {
    return CODEX_PLAN_CAPACITY[account.plan];
  }
  if (account.driver === "claudeAgent" && kind === "session") {
    return CLAUDE_SESSION_CAPACITY[account.plan];
  }
  return undefined;
}

// Codex ids name slots, so pool by kind; other drivers' ids identify distinct allowances.
function poolKey(driver: ServerProvider["driver"], window: ServerProviderUsageWindow): string {
  return driver === "codex" ? window.kind : `${window.kind}:${window.id}`;
}

function poolMember(account: LimitAccount, reported: ServerProviderUsageWindow, now: number) {
  const spentWeekly =
    reported.kind === "session"
      ? account.limits.windows.find(
          (window) =>
            window.usedPercent >= 100 &&
            (account.driver === "claudeAgent"
              ? window.id === "seven_day"
              : account.driver === "codex" && window.kind === "weekly"),
        )
      : undefined;
  if (!spentWeekly) return { account, window: reported, refillPercent: reported.usedPercent };

  const weeklyReset = resetMillis(spentWeekly);
  const sessionReset = resetMillis(reported);
  const cutoff = Math.max(now, Date.parse(account.limits.checkedAt));
  let resetsAt: string | undefined;
  let refillPercent = 0;
  // A stale or missing clock cannot tell us when blocked quota becomes usable.
  if (
    weeklyReset !== null &&
    sessionReset !== null &&
    weeklyReset > cutoff &&
    sessionReset > cutoff
  ) {
    if (sessionReset <= weeklyReset) {
      resetsAt = spentWeekly.resetsAt;
      refillPercent = 100;
    } else if (reported.usedPercent >= 100) {
      resetsAt = reported.resetsAt;
      refillPercent = 100;
    } else {
      resetsAt = spentWeekly.resetsAt;
      refillPercent = 100 - Math.max(0, Math.min(100, reported.usedPercent));
    }
  }
  return {
    account,
    // Suppression is not session spending, so it has no session pace clock.
    window: { ...reported, usedPercent: 100, resetsAt, windowDurationMins: undefined },
    refillPercent,
  };
}

/** Neumaier compensated summation. */
function compensatedSum(values: readonly number[]): number {
  let sum = 0;
  let correction = 0;
  for (const value of values) {
    const next = sum + value;
    correction += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
    sum = next;
  }
  return sum + correction;
}

function poolWindows(accounts: readonly LimitAccount[], now: number): readonly LimitPoolWindow[] {
  const byKey = new Map<string, LimitPoolMember[]>();
  for (const account of accounts) {
    for (const reported of account.limits.windows) {
      const member = poolMember(account, reported, now);
      const { window } = member;
      const pooled = poolKey(account.driver, window);
      const key = byKey.get(pooled)?.some((member) => member.account === account)
        ? `${window.kind}:${window.id}`
        : pooled;
      const list = byKey.get(key);
      if (list) list.push(member);
      else byKey.set(key, [member]);
    }
  }
  const pools = [...byKey].map(([key, members]): LimitPoolWindow => {
    const memberByAccount = new Map(members.map((member) => [member.account.key, member]));
    const first = members[0]!.window;
    const id = members[0]!.account.driver === "codex" ? key : first.id;
    // One unknown plan makes the pool incomparable by plan, so every member then counts once.
    const capacities = members.map((m) => planCapacity(m.account, first.kind));
    const weights = capacities.every((capacity) => capacity !== undefined)
      ? capacities
      : members.map(() => 1);
    const weightOf = new Map(members.map((m, index) => [m, weights[index]!]));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    // Sum in value order so reset order cannot change the rounded result.
    const usedPercent =
      compensatedSum(
        members.map((m) => m.window.usedPercent * weightOf.get(m)!).sort((a, b) => a - b),
      ) / totalWeight;
    // Judge pace only for windows with reset clocks; others add spend without elapsed time.
    const timed = members.flatMap((m) => {
      const share = elapsedShare(m.window, now);
      return share === null
        ? []
        : [{ used: m.window.usedPercent, elapsed: share, weight: weightOf.get(m)! }];
    });
    const timedWeight = timed.reduce((sum, t) => sum + t.weight, 0);
    const timedUsed = timed.reduce((sum, t) => sum + t.used * t.weight, 0) / timedWeight;
    const meanElapsed =
      timed.length > 0
        ? timed.reduce((sum, t) => sum + t.elapsed * t.weight, 0) / timedWeight
        : null;
    const resets = members
      .flatMap((member) => {
        const at = resetMillis(member.window);
        return at === null
          ? []
          : [
              {
                member,
                at,
                restoresPercent: Math.round(
                  (member.refillPercent * weightOf.get(member)!) / totalWeight,
                ),
              },
            ];
      })
      .sort((left, right) => left.at - right.at);
    return {
      id,
      kind: first.kind,
      label: first.label,
      members,
      columns: accounts.map(
        (account) => memberByAccount.get(account.key) ?? { account, window: null },
      ),
      usedPercent: Math.round(usedPercent),
      remainingPercent: Math.round(100 - usedPercent),
      pace: meanElapsed === null ? null : paceOfShares(timedUsed, meanElapsed),
      resets,
    };
  });
  return pools.sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind]);
}

function limitsNotice(limits: ServerProviderUsageLimits): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? "This account has no subscription limits.";
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? "Could not read limits.";
  }
  return limits.windows.length === 0 ? "No limits reported." : null;
}

export function remainingPercent(window: ServerProviderUsageWindow): number {
  return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
}

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

export function elapsedShare(window: ServerProviderUsageWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowDurationMins === undefined) return null;
  const length = window.windowDurationMins * MINUTE;
  if (length <= 0) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

// Bars show quota remaining, so even pace tracks time remaining.
export function paceRemainingPercent(
  window: ServerProviderUsageWindow,
  now: number,
): number | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : Math.round((1 - elapsed) * 100);
}

export type LimitPace = "ahead" | "on" | "under";

export function paceOf(window: ServerProviderUsageWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : paceOfShares(window.usedPercent, elapsed);
}

function paceOfShares(usedPercent: number, elapsed: number): LimitPace {
  const gap = usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

/** One redeemable reset as clients offer it; `input` already names the chosen credit. */
export interface ResetCreditChoice {
  readonly key: string;
  readonly summary: string;
  readonly actionLabel: string;
  readonly confirmDescription: string;
  readonly availableCount: number;
  readonly input: ProviderConsumeResetCreditInput;
}

export type ResetCountdown =
  | { readonly kind: "now" }
  | { readonly kind: "momentarily" }
  | { readonly kind: "in"; readonly ms: number };

export function resetCountdown(
  window: ServerProviderUsageWindow,
  now: number,
): ResetCountdown | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  if (resetsAt <= now) return { kind: "now" };
  if (resetsAt - now < MINUTE) return { kind: "momentarily" };
  return { kind: "in", ms: resetsAt - now };
}

export const USAGE_LIMITS_COMMAND = {
  name: "usage-limits",
  description: "Show this provider's usage limits",
} satisfies ServerProviderSlashCommand;

export function isUsageLimitsCommand(prompt: string): boolean {
  return prompt.trim().toLowerCase() === "/usage-limits";
}

export function hasProviderUsageLimits(
  driver: ServerProvider["driver"],
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): boolean {
  return (
    providersWithLimits(providers).some((provider) => provider.driver === driver) ||
    sources.some(
      (source) =>
        source.accounts.some((account) => account.driver === driver) ||
        (source.error !== undefined && source.accounts.length === 0),
    )
  );
}

export function sameUsageLimitCommandCoverage(
  previous: UsageLimitSourceSnapshots,
  next: UsageLimitSourceSnapshots,
): boolean {
  const coverage = (sources: UsageLimitSourceSnapshots) =>
    new Set(
      sources.flatMap((source) =>
        source.error !== undefined && source.accounts.length === 0
          ? ["*"]
          : source.accounts.map((account) => String(account.driver)),
      ),
    );
  const before = coverage(previous);
  const after = coverage(next);
  return before.size === after.size && [...before].every((driver) => after.has(driver));
}

/** Advertise on workspace catalogs too, which replace the global command list. */
export function withUsageLimitsCommands(
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): ServerProvider[] {
  const supportedDrivers = new Set([
    ...providersWithLimits(providers).map((provider) => provider.driver),
    ...sources.flatMap((source) => source.accounts.map((account) => account.driver)),
  ]);
  const unreadableSource = sources.some(
    (source) => source.error !== undefined && source.accounts.length === 0,
  );
  return providers.map((provider) => {
    if (!unreadableSource && !supportedDrivers.has(provider.driver)) return provider;
    const commands = (items: readonly ServerProviderSlashCommand[]) => [
      ...items.filter((command) => command.name !== USAGE_LIMITS_COMMAND.name),
      USAGE_LIMITS_COMMAND,
    ];
    return {
      ...provider,
      slashCommands: commands(provider.slashCommands),
      ...(provider.workspaceSnapshots
        ? {
            workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
              ...snapshot,
              slashCommands: commands(snapshot.slashCommands),
            })),
          }
        : {}),
    };
  });
}

/** The hubs an instance sends its requests through: those whose address is its endpoint. */
export function instanceHubs(
  provider: ServerProvider,
  sources: UsageLimitSourceSnapshots,
): UsageLimitSourceSnapshots {
  const endpoint = provider.auth.endpoint;
  return endpoint === undefined ? [] : sources.filter((source) => source.origin === endpoint);
}

// Antigravity meters Gemini Argon, Gemini Carbon, other Gemini, and Claude/GPT models apart.
function antigravityQuotaFamily(id: string) {
  if (!id.startsWith("gemini")) return "shared";
  return id.includes("argon") ? "argon" : id.includes("carbon") ? "carbon" : "gemini";
}

/** Each Antigravity quota blocks only the models it meters. */
export function antigravityWindowLimitsModel(
  window: Pick<ServerProviderUsageWindow, "id">,
  model: string | null,
): boolean {
  // A hub can prefix model ids, such as "ag/gemini-3.1-pro".
  const base = model?.slice(model.lastIndexOf("/") + 1);
  // An alias such as "fast" may route to either quota, so both hold it back.
  if (base === undefined || !/^(gemini|claude|gpt)/.test(base)) return true;
  return antigravityQuotaFamily(window.id) === antigravityQuotaFamily(base);
}

/** The hub accounts that serve a model: those that list it, else every account of the driver. */
export function hubRoutes(
  sources: UsageLimitSourceSnapshots,
  driver: ServerProvider["driver"],
  model: string | null,
): (account: UsageLimitSourceAccount) => boolean {
  // Claude Code's 1M-context suffix is not part of the model id a hub routes.
  const full = model?.replace(/\[1m\]$/i, "");
  // The hub routes a thinking suffix such as "gpt-5.2(high)" by its base model when one lists it.
  const base = full?.replace(/\([^)]*\)$/, "");
  const lists = (id: string | undefined) =>
    sources.some((source) => source.accounts.some((account) => account.models?.includes(id ?? "")));
  const slug = lists(base) ? base : full;
  const listed = (account: UsageLimitSourceAccount) =>
    slug !== undefined && account.models?.includes(slug) === true;
  const serving = new Set(
    sources.flatMap((source) => source.accounts.filter(listed).map((account) => account.driver)),
  );
  // Model ids such as "opus" are aliases no hub lists, so no listing falls back to the driver.
  if (serving.size === 0)
    return (account) => account.driver === driver && account.models?.length !== 0;
  // An account whose model list was unreadable may serve the model too.
  return (account) =>
    account.models ? listed(account) : serving.has(account.driver) || account.driver === driver;
}

export function collectProviderUsageLimits(
  instanceId: ProviderInstanceId,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
  model: string | null = null,
): UsageLimitsReport | null {
  const selected = providers.find((provider) => provider.instanceId === instanceId);
  if (!selected) return null;
  // Only an instance sent to a hub is known to reach the accounts that hub routes its model to.
  const hubs = instanceHubs(selected, sources);
  const routes =
    hubs.length > 0
      ? hubRoutes(hubs, selected.driver, model)
      : (account: UsageLimitSourceAccount) => account.driver === selected.driver;
  const shownHubs = hubs.length > 0 ? hubs : sources;
  const drivers = new Set(
    shownHubs.flatMap((source) => source.accounts.filter(routes).map((account) => account.driver)),
  );
  if (drivers.size === 0) drivers.add(selected.driver);
  if (![...drivers].some((driver) => hasProviderUsageLimits(driver, providers, sources))) {
    return null;
  }
  const resolveKey = accountKeyResolver([
    ...providers.filter((provider) => provider.enabled).map(nativeReport),
    ...sources.flatMap((source) => source.accounts),
  ]);
  // Behind a hub, a local login counts only when it is one of the accounts the hub routes to.
  const routedKeys =
    hubs.length > 0
      ? new Set(hubs.flatMap((source) => source.accounts.filter(routes).map(resolveKey)))
      : null;
  type NativeSnapshot = { provider: ServerProvider; limits: ServerProviderUsageLimits };
  const nativeByAccount = new Map<
    string,
    { usage: NativeSnapshot; credits: NativeSnapshot | null }
  >();
  for (const provider of providersWithLimits(providers)) {
    if (!drivers.has(provider.driver) || !provider.usageLimits) continue;
    if (selected.driver === "scient" && provider.instanceId !== selected.instanceId) continue;
    const accountKey = resolveKey(nativeReport(provider));
    if (routedKeys && (accountKey === null || !routedKeys.has(accountKey))) continue;
    const snapshot = { provider, limits: provider.usageLimits };
    const key = accountKey ?? `instance:${provider.instanceId}`;
    const previous = nativeByAccount.get(key);
    const previousUsable = previous ? limitsNotice(previous.usage.limits) === null : false;
    const usable = limitsNotice(snapshot.limits) === null;
    const providerWins =
      !previous ||
      (usable && !previousUsable) ||
      (usable === previousUsable &&
        Date.parse(snapshot.limits.checkedAt) > Date.parse(previous.usage.limits.checkedAt));
    const previousCredit = previous?.credits;
    const credits =
      snapshot.limits.resetCredits &&
      (!previousCredit ||
        Date.parse(snapshot.limits.checkedAt) > Date.parse(previousCredit.limits.checkedAt))
        ? snapshot
        : (previousCredit ?? null);
    nativeByAccount.set(key, {
      usage: providerWins ? snapshot : previous.usage,
      credits,
    });
  }
  const native = [...nativeByAccount.values()];
  const nativeAccountKeys = new Set(
    native.flatMap(({ usage: { provider, limits } }) => {
      const key = resolveKey(nativeReport(provider));
      return key && limits.windows.length && !limits.unavailable ? [key] : [];
    }),
  );
  const accounts: Array<UsageLimitsReport["accounts"][number]> = [];
  const notices: string[] = [];
  for (const {
    usage: { provider, limits },
    credits,
  } of native) {
    const key = resolveKey(nativeReport(provider));
    // Only a hub this instance reaches may redeem a credit for its thread.
    const hubCredits = shownHubs
      .flatMap((source) => source.accounts.map((account) => ({ source, account })))
      .filter(
        ({ account }) =>
          key !== null &&
          resolveKey(account) === key &&
          account.usageLimits.resetCredits &&
          !limitsNotice(account.usageLimits),
      )
      .sort(
        (a, b) =>
          Date.parse(b.account.usageLimits.checkedAt) - Date.parse(a.account.usageLimits.checkedAt),
      )[0];
    const hubCreditId = hubCredits?.account.usageLimits.resetCredits?.nextCreditId;
    const showHubCredits =
      hubCredits &&
      (!credits ||
        Date.parse(hubCredits.account.usageLimits.checkedAt) >
          Date.parse(credits.limits.checkedAt));
    const shownCredits = showHubCredits
      ? hubCredits.account.usageLimits.resetCredits
      : credits?.limits.resetCredits;
    const scopedLimits =
      provider.driver === "scient"
        ? {
            ...limits,
            windows: limits.windows.filter(
              (window) =>
                model !== null &&
                window.status !== undefined &&
                window.providerIds !== undefined &&
                windowAppliesToModel(provider, window, model),
            ),
          }
        : limits;
    accounts.push({
      id: provider.instanceId,
      driver: provider.driver,
      label: `${provider.displayName?.trim() || String(provider.driver)} [${provider.instanceId}]`,
      ...(provider.auth.label ? { plan: provider.auth.label } : {}),
      instanceId: provider.instanceId,
      resetCreditInput:
        hubCreditId && hubCredits
          ? {
              sourceId: hubCredits.source.id,
              accountId: hubCredits.account.id,
              creditId: hubCreditId,
            }
          : { instanceId: credits?.provider.instanceId ?? provider.instanceId },
      ...(provider.displayName ? { displayName: provider.displayName } : {}),
      ...(provider.accentColor ? { accentColor: provider.accentColor } : {}),
      ...(provider.auth.email ? { email: provider.auth.email } : {}),
      limits: shownCredits ? { ...scopedLimits, resetCredits: shownCredits } : scopedLimits,
    });
  }
  for (const source of shownHubs) {
    const matching = source.accounts.filter(routes);
    for (const account of matching) {
      const key = resolveKey(account);
      if (key && nativeAccountKeys.has(key)) continue;
      accounts.push({
        id: `${source.id}:${account.id}`,
        driver: account.driver,
        label: `${source.label} · ${hubAccountName(account)}`,
        sourceLabel: "CLI Proxy",
        ...(account.usageLimits.resetCredits?.nextCreditId
          ? {
              resetCreditInput: {
                sourceId: source.id,
                accountId: account.id,
                creditId: account.usageLimits.resetCredits.nextCreditId,
              },
            }
          : {}),
        ...(account.plan ? { plan: account.plan } : {}),
        ...(account.email ? { email: account.email } : {}),
        limits: account.usageLimits,
      });
    }
    if (source.error && (matching.length > 0 || source.accounts.length === 0)) {
      notices.push(`${source.label}: ${source.error}`);
    }
  }
  return { createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)), accounts, notices };
}
