import type { ServerProvider, ServerProviderModel } from "@t3tools/contracts";

import { preferredScientSubscriptionModels } from "./scientModel.ts";

const SUBSCRIPTION_ORDER = [
  "openai-codex",
  "anthropic",
  "antigravity-cli",
  "google-antigravity",
  "muse-code",
] as const;

function modelAccount(provider: ServerProvider, model: string) {
  const accounts = provider.connection?.accounts ?? [];
  const entry = accounts.find((account) => account.id === model.split("/", 1)[0]);
  const canonical = entry?.sameAccountAs
    ? accounts.find((account) => account.id === entry.sameAccountAs)
    : entry;
  return { entry, canonical: canonical ?? entry };
}

export function scientSubscriptionFamily(provider: ServerProvider, model: string) {
  if (provider.driver !== "scient") {
    switch (provider.driver) {
      case "codex":
        return "openai-codex";
      case "claudeAgent":
        return "anthropic";
      case "antigravity":
        return "antigravity";
      case "muse":
        return "muse-code";
      default:
        return undefined;
    }
  }
  const id = modelAccount(provider, model).canonical?.id;
  return id === "antigravity-cli" || id === "google-antigravity" ? "antigravity" : id;
}

function isScientSubscriptionModel(provider: ServerProvider, model: string): boolean {
  if (provider.driver !== "scient") return false;
  const { entry, canonical } = modelAccount(provider, model);
  return (
    entry?.kind === "account" &&
    entry.connected &&
    canonical !== undefined &&
    preferredScientSubscriptionModels(canonical.id).length > 0
  );
}

export function scientAgentAlternativeModel(
  provider: ServerProvider | undefined,
  model: string,
  isIneligible: (slug: string) => boolean,
  excludedFamily?: string,
): ServerProviderModel | undefined {
  if (provider?.driver !== "scient") return undefined;
  const current = excludedFamily ?? scientSubscriptionFamily(provider, model);
  for (const account of SUBSCRIPTION_ORDER) {
    for (const slug of preferredScientSubscriptionModels(account)) {
      if (
        scientSubscriptionFamily(provider, slug) === current ||
        !isScientSubscriptionModel(provider, slug) ||
        isIneligible(slug)
      ) {
        continue;
      }
      const candidate = provider.models.find((entry) => entry.slug === slug);
      if (candidate && !candidate.isCustom && !candidate.unavailableReason) return candidate;
    }
  }
  return undefined;
}
