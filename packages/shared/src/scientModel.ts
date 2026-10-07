/**
 * Scient model defaults: native agent account ordering and curated picker
 * visibility, the product reasoning default, and automatic model selection.
 */
import {
  DEFAULT_MODEL_BY_PROVIDER,
  PREFERRED_DEFAULT_CODEX_MODELS,
  type ModelCapabilities,
  type ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";

import { codexModelFamily, type SelectableModelOption } from "./model.ts";

const VISIBLE_AGENT_SUBSCRIPTION_MODELS = new Set([
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-opus-5-5",
  "anthropic/claude-fable-5-5",
  "openai-codex/gpt-6-astra",
  "openai-codex/gpt-6-luna",
  "openai-codex/gpt-6.1-sol",
  "google-antigravity/gemini-3.8-flash",
  "google-antigravity/gemini-3.1-pro",
  "google-antigravity/claude-opus-4-6",
]);

const AGENT_ACCOUNT_GROUP_ORDER = new Map([
  ["anthropic", 0],
  ["openai", 1],
  ["openai-codex", 1],
  ["google", 2],
  ["google-antigravity", 2],
  ["google-gemini-cli", 2],
  ["google-vertex", 2],
]);

/** Default native agent account groups; preserve catalog order within each group. */
export function sortAgentModelsByAccount<T extends { readonly slug: string }>(
  driver: string,
  models: ReadonlyArray<T>,
): T[] {
  if (driver !== "pi" && driver !== "omp" && driver !== "scient") return [...models];
  const rank = (model: T) => AGENT_ACCOUNT_GROUP_ORDER.get(model.slug.split("/")[0] ?? "") ?? 3;
  return [...models].sort((a, b) => rank(a) - rank(b));
}

/** Curated picker defaults for native agent catalogs, independent of account access. */
export function getDefaultHiddenAgentModels(
  driver: string,
  models: ReadonlyArray<{ readonly slug: string; readonly isCustom?: boolean }>,
): string[] {
  if (driver !== "pi" && driver !== "omp" && driver !== "scient") return [];
  return models
    .filter(
      (model) =>
        !model.isCustom &&
        ["anthropic/", "openai-codex/", "google-antigravity/"].some((prefix) =>
          model.slug.startsWith(prefix),
        ) &&
        !VISIBLE_AGENT_SUBSCRIPTION_MODELS.has(model.slug),
    )
    .map((model) => model.slug);
}

/** Saved visibility wins; use the default account order until the user reorders models. */
export function resolveProviderModelPreferences(
  driver: string,
  models: ReadonlyArray<{ readonly slug: string; readonly isCustom?: boolean }>,
  preferences:
    | { readonly hiddenModels: ReadonlyArray<string>; readonly modelOrder: ReadonlyArray<string> }
    | undefined,
) {
  if (driver !== "pi" && driver !== "omp" && driver !== "scient") {
    return preferences ?? { hiddenModels: [], modelOrder: [] };
  }
  if (preferences?.modelOrder.length) return preferences;
  return {
    hiddenModels: preferences?.hiddenModels ?? getDefaultHiddenAgentModels(driver, models),
    modelOrder: sortAgentModelsByAccount(driver, models).map((model) => model.slug),
  };
}

/** A product default for the next request, never a claim about an already-running session. */
export function preferredReasoningLevel(
  levels: ReadonlyArray<string>,
  preferred?: string,
  userPreference?: string,
): string | undefined {
  const available = levels.filter(
    (level) => !["off", "none", "default", "inherited"].includes(level),
  );
  return (
    (userPreference && available.includes(userPreference) ? userPreference : undefined) ??
    (preferred && available.includes(preferred) ? preferred : undefined) ??
    ["medium", "high", "low", "xhigh", "max", "minimal"].find((level) =>
      available.includes(level),
    ) ??
    available[0]
  );
}

const PREFERRED_ACCOUNT_MODELS: Readonly<Record<string, ReadonlyArray<string>>> = {
  anthropic: ["claude-opus-5-5"],
  "openai-codex": ["gpt-6.1-sol"],
  cursor: ["grok-4.7-high", "cursor-grok-4.7-high", "grok-4.7", "cursor-grok-4.7"],
  "google-antigravity": ["gemini-3.8-flash-high", "gemini-3.8-flash"],
};

function preferredAccountModel<T extends SelectableModelOption>(
  driver: ProviderDriverKind,
  models: ReadonlyArray<T>,
): T | undefined {
  // Preserve account order; choose within the first account, without jumping
  // to another account when its preferred model is absent.
  const accounts =
    driver === "scient"
      ? [models[0]?.slug.split("/")[0] ?? ""]
      : driver === "cursor"
        ? ["cursor"]
        : driver === "antigravity"
          ? ["google-antigravity"]
          : [];
  for (const account of accounts) {
    for (const id of PREFERRED_ACCOUNT_MODELS[account] ?? []) {
      const slug = driver === "scient" ? `${account}/${id}` : id;
      const match = models.find(
        (model) => model.slug.split("[")[0] === slug || model.aliases?.includes(slug),
      );
      if (match) return match;
    }
  }
  return undefined;
}

/** Resolve only implicit selections; explicit and persisted picks never pass through here. */
export function resolveAutomaticModel(
  driver: ProviderDriverKind,
  models: ReadonlyArray<
    SelectableModelOption & {
      isDefault?: boolean | undefined;
      isCustom?: boolean | undefined;
      isLegacy?: boolean | undefined;
      capabilities?: ModelCapabilities | null | undefined;
    }
  >,
): string | undefined {
  const available = models.filter((model) => !model.isLegacy && !model.unavailableReason);
  const builtIns = available.filter((model) => !model.isCustom);
  const preferences =
    driver === "codex"
      ? PREFERRED_DEFAULT_CODEX_MODELS
      : driver === "claudeAgent"
        ? ["claude-opus-5-5", "claude-fable-5-1"]
        : [];
  const preferred =
    preferredAccountModel(driver, builtIns) ??
    preferences.flatMap((slug) =>
      builtIns.filter((model) =>
        driver === "codex"
          ? codexModelFamily(model.slug) === slug
          : model.slug === slug || model.aliases?.includes(slug),
      ),
    )[0];
  const reported = available.find((model) => model.isDefault);
  const fallback = DEFAULT_MODEL_BY_PROVIDER[driver];
  const selected =
    preferred ??
    reported ??
    builtIns.find((model) => model.slug === fallback || model.aliases?.includes(fallback ?? "")) ??
    builtIns[0] ??
    available[0];
  if (driver === "antigravity" && selected && !selected.isCustom && selected.capabilities) {
    const variant = /^(gemini-[a-z0-9.-]+)-(low|medium|high)$/.exec(selected.slug);
    const name = /^(Gemini .+) \((Low|Medium|High)\)$/.exec(selected.name);
    if (variant && name && name[2]?.toLowerCase() === variant[2]) {
      const high = builtIns.find(
        (model) =>
          model.slug === `${variant[1]}-high` &&
          model.name === `${name[1]} (High)` &&
          Boolean(model.capabilities) &&
          (model.capabilities?.optionDescriptors?.length ?? 0) === 0,
      );
      if (high && (selected.capabilities?.optionDescriptors?.length ?? 0) === 0) return high.slug;
    }
  }
  // Antigravity has no static dispatchable model ID.
  return selected?.slug ?? (models.length === 0 && driver !== "antigravity" ? fallback : undefined);
}

/** Publish the same automatic choice to every client without altering catalog order or IDs. */
export function applyAutomaticModelDefaults(
  driver: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const selected = resolveAutomaticModel(
    driver,
    driver === "scient" ? sortAgentModelsByAccount(driver, models) : models,
  );
  return models.map((model) => {
    // Built-in capability defaults affect new selections, not saved selection options.
    const capabilities =
      !model.isCustom &&
      (driver === "codex" ||
        driver === "claudeAgent" ||
        preferredAccountModel(driver, [model]) !== undefined) &&
      model.capabilities
        ? {
            ...model.capabilities,
            optionDescriptors: (model.capabilities.optionDescriptors ?? []).map((descriptor) => {
              if (
                descriptor.type !== "select" ||
                !["reasoningEffort", "effort", "thinkingLevel", "reasoning"].includes(
                  descriptor.id,
                ) ||
                !descriptor.options.some((option) => option.id === "high")
              )
                return descriptor;
              return {
                ...descriptor,
                concreteReasoning: true,
                currentValue: "high",
                options: descriptor.options.map((option) => ({
                  ...option,
                  isDefault: option.id === "high",
                })),
              };
            }),
          }
        : model.capabilities;
    const resolved = capabilities === model.capabilities ? model : { ...model, capabilities };
    if (model.slug === selected) return { ...resolved, isDefault: true };
    if (!model.isDefault) return resolved;
    const { isDefault: _default, ...rest } = resolved;
    return rest;
  });
}
