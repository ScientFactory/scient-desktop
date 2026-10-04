import {
  DEFAULT_MODEL_BY_PROVIDER,
  PREFERRED_DEFAULT_CODEX_MODELS,
  type ServerProviderModel,
  type CustomModelSetting,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { copySorted } from "./Array.ts";

const DEFAULT_PROVIDER_DRIVER_KIND = ProviderDriverKind.make("codex");

export const MODEL_TOKEN_LIMIT_MESSAGE = "Response stopped at a token limit.";

/** Choose the command for a model change against the thread's current provider instance. */
export function modelSelectionCommandType(
  currentInstanceId: ProviderInstanceId,
  selection: ModelSelection,
) {
  return currentInstanceId === selection.instanceId
    ? ("thread.model-selection.set" as const)
    : ("provider.switch" as const);
}

export interface SelectableModelOption {
  slug: string;
  name: string;
  aliases?: ReadonlyArray<string> | undefined;
  unavailableReason?: string | undefined;
}

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

export function createModelCapabilities(input: {
  optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
}): ModelCapabilities {
  return {
    optionDescriptors: input.optionDescriptors.map(cloneDescriptor),
  };
}

function getRawSelectionValueById(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | boolean | undefined {
  const selection = selections?.find((candidate) => candidate.id === id);
  return selection?.value;
}

function getProviderOptionSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | boolean | undefined {
  return getRawSelectionValueById(selections, id);
}

export function getProviderOptionStringSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | undefined {
  const value = getProviderOptionSelectionValue(selections, id);
  return typeof value === "string" ? value : undefined;
}

export function getProviderOptionBooleanSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): boolean | undefined {
  const value = getProviderOptionSelectionValue(selections, id);
  return typeof value === "boolean" ? value : undefined;
}

export function getModelSelectionStringOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string,
): string | undefined {
  return getProviderOptionStringSelectionValue(modelSelection?.options, id);
}

export function getModelSelectionBooleanOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string,
): boolean | undefined {
  return getProviderOptionBooleanSelectionValue(modelSelection?.options, id);
}

function canonicalModelSelectionOptions(
  modelSelection: ModelSelection,
): ReadonlyArray<readonly [id: string, value: string | boolean]> {
  return copySorted(
    (modelSelection.options ?? []).map(
      (selection): readonly [id: string, value: string | boolean] => [
        selection.id,
        selection.value,
      ],
    ),
    (
      [leftId, leftValue]: readonly [id: string, value: string | boolean],
      [rightId, rightValue]: readonly [id: string, value: string | boolean],
    ) => {
      const idOrder = leftId.localeCompare(rightId);
      return idOrder !== 0 ? idOrder : String(leftValue).localeCompare(String(rightValue));
    },
  );
}

/**
 * Compares the complete provider selection while treating option ordering and
 * an omitted empty option list as presentation details.
 */
export function modelSelectionsEqual(left: ModelSelection, right: ModelSelection): boolean {
  if (left.instanceId !== right.instanceId || left.model !== right.model) {
    return false;
  }
  const leftOptions = canonicalModelSelectionOptions(left);
  const rightOptions = canonicalModelSelectionOptions(right);
  return (
    leftOptions.length === rightOptions.length &&
    leftOptions.every(
      ([id, value], index) => id === rightOptions[index]?.[0] && value === rightOptions[index]?.[1],
    )
  );
}

function resolveDescriptorChoiceValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
  raw: string | null | undefined,
): string | undefined {
  const trimmed = trimOrNull(raw);
  // A concrete control resolves to a level; Off only when the provider offers it.
  if (
    descriptor.concreteReasoning &&
    (!trimmed ||
      ["none", "default", "inherited"].includes(trimmed) ||
      !descriptor.options.some((option) => option.id === trimmed))
  ) {
    return preferredReasoningLevel(
      descriptor.options.map((option) => option.id),
      descriptor.options.find((option) => option.isDefault)?.id,
    );
  }
  if (descriptor.strictSelection && trimmed) {
    return trimmed;
  }
  if (!trimmed) {
    return descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
  }
  if (descriptor.options.length === 0) {
    return trimmed;
  }
  if (
    descriptor.promptInjectedValues?.includes(trimmed) &&
    descriptor.options.some((option) => option.id === trimmed)
  ) {
    return descriptor.options.find((option) => option.isDefault)?.id;
  }
  if (descriptor.options.some((option) => option.id === trimmed)) {
    return trimmed;
  }
  return descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
}

function cloneDescriptor(descriptor: ProviderOptionDescriptor): ProviderOptionDescriptor {
  return descriptor.type === "select"
    ? {
        ...descriptor,
        options: [...descriptor.options],
        ...(descriptor.promptInjectedValues
          ? { promptInjectedValues: [...descriptor.promptInjectedValues] }
          : {}),
      }
    : { ...descriptor };
}

function cloneSelection(selection: ProviderOptionSelection): ProviderOptionSelection {
  return { ...selection };
}

function withDescriptorCurrentValue(
  descriptor: ProviderOptionDescriptor,
  rawCurrentValue: string | boolean | undefined,
): ProviderOptionDescriptor {
  if (descriptor.type === "boolean") {
    if (typeof rawCurrentValue === "boolean") {
      return {
        ...descriptor,
        currentValue: rawCurrentValue,
      };
    }
    return descriptor;
  }
  const currentValue =
    typeof rawCurrentValue === "string"
      ? resolveDescriptorChoiceValue(descriptor, rawCurrentValue)
      : resolveDescriptorChoiceValue(descriptor, descriptor.currentValue);
  if (!currentValue) {
    const { currentValue: _unusedCurrentValue, ...rest } = descriptor;
    return rest;
  }
  return {
    ...descriptor,
    currentValue,
  };
}

export function getProviderOptionDescriptors(input: {
  caps: ModelCapabilities;
  selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  const { caps, selections } = input;
  const baseDescriptors = (caps.optionDescriptors ?? []).map(cloneDescriptor);

  return baseDescriptors.map((descriptor) =>
    withDescriptorCurrentValue(
      descriptor,
      getRawSelectionValueById(selections, descriptor.id) ?? descriptor.currentValue,
    ),
  );
}

export function getProviderOptionCurrentValue(
  descriptor: ProviderOptionDescriptor | null | undefined,
): string | boolean | undefined {
  if (!descriptor) {
    return undefined;
  }
  if (descriptor.type === "boolean") {
    return descriptor.currentValue;
  }
  if (descriptor.currentValue) {
    return descriptor.currentValue;
  }
  return descriptor.options.find((option) => option.isDefault)?.id;
}

export function getProviderOptionCurrentLabel(
  descriptor: ProviderOptionDescriptor | null | undefined,
): string | undefined {
  if (!descriptor) {
    return undefined;
  }
  if (descriptor.type === "boolean") {
    return typeof descriptor.currentValue === "boolean"
      ? descriptor.currentValue
        ? "On"
        : "Off"
      : undefined;
  }
  const currentValue = getProviderOptionCurrentValue(descriptor);
  if (typeof currentValue !== "string") {
    return descriptor.strictSelection ? (descriptor.emptySelectionLabel ?? "Default") : undefined;
  }
  return (
    descriptor.options.find((option) => option.id === currentValue)?.label ??
    (descriptor.strictSelection ? `${currentValue} unavailable` : undefined)
  );
}

export function buildProviderOptionSelectionsFromDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined,
): Array<ProviderOptionSelection> | undefined {
  if (!descriptors || descriptors.length === 0) {
    return undefined;
  }

  const nextSelections: Array<ProviderOptionSelection> = [];

  for (const descriptor of descriptors) {
    const value = getProviderOptionCurrentValue(descriptor);
    if (typeof value === "string" || typeof value === "boolean") {
      nextSelections.push({ id: descriptor.id, value });
    }
  }

  return nextSelections.length > 0 ? nextSelections : undefined;
}

export function buildExplicitProviderOptionSelectionsFromDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): Array<ProviderOptionSelection> | undefined {
  const explicitIds = new Set((selections ?? []).map((selection) => selection.id));
  for (const descriptor of descriptors ?? []) {
    if (descriptor.type === "select" && descriptor.concreteReasoning)
      explicitIds.add(descriptor.id);
  }
  const normalized = buildProviderOptionSelectionsFromDescriptors(descriptors)?.filter(
    (selection) => explicitIds.has(selection.id),
  );
  return normalized && normalized.length > 0 ? normalized : undefined;
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

export function isClaudeUltrathinkPrompt(text: string | null | undefined): boolean {
  return typeof text === "string" && /\bultrathink\b/i.test(text);
}

/** Compare Codex model families without changing provider-owned dispatch identifiers. */
export function codexModelFamily(slug: string): string {
  return slug.startsWith("openai.gpt-") ? slug.slice("openai.".length) : slug;
}

export function formatCodexModelName(name: string): string {
  return name.replace(/^gpt/i, "GPT").replace(/-([a-z])/g, (_, c: string) => "-" + c.toUpperCase());
}

export function formatModelSlugName(slug: string): string {
  const separator = slug.lastIndexOf("/") + 1;
  const prefix = slug.slice(0, separator);
  const name = slug.slice(separator);
  if (/^gpt-\d/i.test(name)) return prefix + formatCodexModelName(name);
  if (!/^(claude-(opus|sonnet|haiku|fable)|gemini|grok|composer)-\d/i.test(name)) return slug;
  return (
    prefix +
    name
      .replace(/^(claude-[a-z]+-\d+)-(\d{1,2})(?=-|\[|$)/i, "$1.$2")
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderDriverKind = DEFAULT_PROVIDER_DRIVER_KIND,
): string | null {
  const trimmed = normalizeCustomModelSlug(model);
  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] ?? {};
  const aliased = Object.prototype.hasOwnProperty.call(aliases, trimmed)
    ? aliases[trimmed]
    : undefined;
  return typeof aliased === "string" ? aliased : trimmed;
}

/** Custom model identifiers are provider-owned, so only trim them; never expand aliases. */
export function normalizeCustomModelSlug(model: string | null | undefined): string | null {
  if (typeof model !== "string") {
    return null;
  }

  return model.trim() || null;
}

/** A custom model setting with its optional fields resolved. */
export interface CustomModelDefinition {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities | null;
}

const decodeCustomModelCapabilities = Schema.decodeUnknownOption(ModelCapabilities);

/**
 * Read a `customModels` setting into resolved definitions. Accepts the typed
 * union as well as the opaque `providerInstances[id].config` blob clients see,
 * so it tolerates bare slugs, malformed rows, and unparseable capabilities
 * (dropped rather than failing the whole list). Slugs are trimmed and
 * deduplicated, first occurrence wins; `name` falls back to the slug.
 */
export function readCustomModelEntries(value: unknown): CustomModelDefinition[] {
  if (!Array.isArray(value)) return [];
  const entries: CustomModelDefinition[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const record =
      typeof raw === "string"
        ? { slug: raw }
        : raw !== null && typeof raw === "object"
          ? (raw as { slug?: unknown; name?: unknown; capabilities?: unknown })
          : null;
    if (!record) continue;
    const slug = normalizeCustomModelSlug(typeof record.slug === "string" ? record.slug : null);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const name =
      (typeof record.name === "string" ? normalizeCustomModelSlug(record.name) : null) ?? slug;
    const capabilities =
      record.capabilities === undefined || record.capabilities === null
        ? null
        : Option.getOrNull(decodeCustomModelCapabilities(record.capabilities));
    entries.push({
      slug,
      name,
      capabilities: capabilities
        ? createModelCapabilities({ optionDescriptors: capabilities.optionDescriptors ?? [] })
        : null,
    });
  }
  return entries;
}

/**
 * Write a definition back to the compact stored shape: a bare slug when it
 * carries nothing custom, otherwise an entry with only the set fields.
 */
export function toCustomModelSetting(entry: CustomModelDefinition): CustomModelSetting {
  const descriptors = entry.capabilities?.optionDescriptors ?? [];
  const name = entry.name !== entry.slug ? entry.name : undefined;
  if (!name && descriptors.length === 0) return entry.slug;
  return {
    slug: entry.slug,
    ...(name ? { name } : {}),
    ...(descriptors.length > 0
      ? { capabilities: createModelCapabilities({ optionDescriptors: descriptors }) }
      : {}),
  };
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

export function resolveSelectableModel(
  provider: ProviderDriverKind,
  value: string | null | undefined,
  options: ReadonlyArray<SelectableModelOption>,
): string | null {
  options = options.filter((option) => !option.unavailableReason);
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = options.find((option) => option.slug === trimmed);
  if (direct) {
    return direct.slug;
  }

  const byName = options.find((option) => option.name.toLowerCase() === trimmed.toLowerCase());
  if (byName) {
    return byName.slug;
  }

  const byAlias = options.find((option) =>
    option.aliases?.some((alias) => alias.toLowerCase() === trimmed.toLowerCase()),
  );
  if (byAlias) {
    return byAlias.slug;
  }

  const normalized = normalizeModelSlug(trimmed, provider);
  if (!normalized) {
    return null;
  }

  const resolved = options.find((option) => option.slug === normalized);
  return resolved ? resolved.slug : null;
}

/** Trim a string, returning null for empty/missing values. */
function trimOrNull<T extends string>(value: T | null | undefined): T | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim() as T;
  return trimmed || null;
}

function cloneSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
): Array<ProviderOptionSelection> {
  return selections.map(cloneSelection);
}

export function createModelSelection(
  instanceId: ProviderInstanceId,
  model: string,
  options?: ReadonlyArray<ProviderOptionSelection> | null,
): ModelSelection {
  const selections = options ? cloneSelections(options) : [];
  const base: ModelSelection = {
    instanceId,
    model,
  };
  return selections.length > 0 ? { ...base, options: selections } : base;
}

/**
 * Returns the effort value if it is a prompt-injected value according to
 * any select descriptor in the given capabilities, or null otherwise.
 *
 * Unlike a single `find`, this checks every descriptor so that the
 * correct descriptor's `promptInjectedValues` list is consulted even when
 * multiple select descriptors exist.
 */
export function resolvePromptInjectedEffort(
  caps: ModelCapabilities,
  rawEffort: string | null | undefined,
): string | null {
  const trimmed = trimOrNull(rawEffort);
  if (!trimmed) return null;
  const descriptors = getProviderOptionDescriptors({ caps });
  for (const descriptor of descriptors) {
    if (descriptor.type === "select" && descriptor.promptInjectedValues?.includes(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

export function applyClaudePromptEffortPrefix(
  text: string,
  effort: string | null | undefined,
): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  // Prefixing a slash command turns it into plain prose, so Claude never
  // runs it. Command names come from arbitrary file names ("/deploy.prod",
  // "/plugin:skill"), so accept any first token without a second slash;
  // absolute paths like "/home/theo/app.ts" keep the prefix.
  if (effort !== "ultrathink" || /^\/[^\s/]+(?:\s|$)/u.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("Ultrathink:")) {
    return trimmed;
  }
  return `Ultrathink:\n${trimmed}`;
}
