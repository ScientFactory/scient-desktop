// FILE: migration035FrozenModelSelectionCompatibility.ts
// Purpose: Frozen v0.5.13 snapshot of modelSelectionCompatibility used ONLY by
//   migration 035. It reproduces that migration's exact released behavior on old
//   persisted data, independent of the live model catalog.
// Layer: Persistence migration (frozen)
// Exports: normalizeLegacyModelSelection, normalizePersistedModelSelection
//
// WHY THIS EXISTS: the live modelSelectionCompatibility.ts derives
//   DROID_ONLY_MODEL_SLUGS from @synara/contracts' MODEL_OPTIONS_BY_PROVIDER,
//   which must remain free to evolve (adding Opus 5, etc.). A released migration
//   must instead depend on a fixed snapshot of the values it actually used at
//   release time. This file hardcodes the exact v0.5.13-derived DROID_ONLY set
//   so migration 035 is behaviorally pinned and no longer imports the catalog.
//
// DO NOT MODIFY: check-migration-lineage.ts freezes this file as released
//   migration-dependency content. Its behavior must stay byte-identical to the
//   v0.5.13 modelSelectionCompatibility. See migration035FrozenModelSelectionCompatibility.test.ts.

// v0.5.13-frozen value of DROID_ONLY_MODEL_SLUGS: the Factory-exclusive built-in
// slugs (droid provider slugs minus every non-droid provider slug) as computed
// from MODEL_OPTIONS_BY_PROVIDER at the v0.5.13 release. Kept as a literal so the
// migration no longer reaches into the live, evolving catalog.
const DROID_ONLY_MODEL_SLUGS = new Set([
  "claude-opus-4-8-fast",
  "claude-opus-4-7-fast",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
  "gpt-5.5-fast",
  "gpt-5.5-pro",
  "gpt-5.4-fast",
  "gpt-5.3-codex-fast",
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "glm-5.2",
  "glm-5.2-fast",
  "glm-5.1",
  "nemotron-3-ultra",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "deepseek-v4-pro",
  "minimax-m3",
  "minimax-m2.7",
]);

type ModelProviderKind =
  | "codex"
  | "claudeAgent"
  | "cursor"
  | "antigravity"
  | "grok"
  | "droid"
  | "kilo"
  | "opencode"
  | "pi";

const LEGACY_GEMINI_MODEL_LABELS: Readonly<Record<string, string>> = {
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
  "gemini-3-flash-preview": "Gemini 3.5 Flash",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Imported instance ids may be runtime names rather than Synara provider literals.
function inferProviderFromLabel(label: string): ModelProviderKind | undefined {
  const lowerLabel = label.toLowerCase();
  if (/(^|[^a-z0-9])pi([^a-z0-9]|$)/u.test(lowerLabel)) {
    return "pi";
  }
  if (lowerLabel.includes("opencode")) {
    return "opencode";
  }
  if (lowerLabel.includes("kilo")) {
    return "kilo";
  }
  if (lowerLabel.includes("cursor")) {
    return "cursor";
  }
  if (lowerLabel.includes("antigravity")) {
    return "antigravity";
  }
  if (lowerLabel.includes("claude") || lowerLabel.includes("anthropic")) {
    return "claudeAgent";
  }
  if (lowerLabel.includes("gemini") || lowerLabel.includes("google")) {
    return "antigravity";
  }
  if (lowerLabel.includes("grok") || lowerLabel.includes("xai") || lowerLabel.includes("x.ai")) {
    return "grok";
  }
  if (lowerLabel.includes("droid") || lowerLabel.includes("factory")) {
    return "droid";
  }
  if (lowerLabel.includes("codex")) {
    return "codex";
  }
  return undefined;
}

function inferLegacyModelProvider(provider: unknown, model: string): ModelProviderKind {
  if (
    provider === "codex" ||
    provider === "claudeAgent" ||
    provider === "cursor" ||
    provider === "antigravity" ||
    provider === "grok" ||
    provider === "droid" ||
    provider === "kilo" ||
    provider === "opencode" ||
    provider === "pi"
  ) {
    return provider;
  }
  if (provider === "gemini") {
    return "antigravity";
  }
  if (typeof provider === "string") {
    const providerFromLabel = inferProviderFromLabel(provider);
    if (providerFromLabel !== undefined) {
      return providerFromLabel;
    }
  }
  const lowerModel = model.toLowerCase();
  // Shared Claude/Gemini/OpenAI slugs remain ambiguous without an instance label;
  // only Factory-exclusive built-ins are safe to attribute to Droid.
  if (DROID_ONLY_MODEL_SLUGS.has(lowerModel)) {
    return "droid";
  }
  if (lowerModel.includes("claude")) {
    return "claudeAgent";
  }
  if (lowerModel.includes("gemini")) {
    return "antigravity";
  }
  if (lowerModel.includes("grok")) {
    return "grok";
  }
  return "codex";
}

function readLegacyProviderOptions(options: unknown, provider: ModelProviderKind): unknown {
  if (!isRecord(options)) {
    return options;
  }
  const providerScopedOptions = options[provider];
  return providerScopedOptions === undefined ? options : providerScopedOptions;
}

function normalizeModelOptions(input: unknown): unknown {
  if (!Array.isArray(input)) {
    return input;
  }

  const entries: Array<readonly [string, unknown]> = [];
  for (const option of input) {
    if (!isRecord(option)) {
      return input;
    }
    const id = readTrimmedString(option, "id");
    if (id === undefined) {
      return input;
    }
    entries.push([id, option.value]);
  }
  return Object.fromEntries(entries);
}

function splitLegacyAntigravityModelLabel(model: string): {
  model: string;
  reasoningEffort?: string;
} {
  const match = model.trim().match(/^(.*?)\s+\(([^()]+)\)$/u);
  if (!match?.[1] || !match[2]) {
    return { model };
  }
  const reasoningEffort = match[2].trim().toLowerCase();
  if (!new Set(["low", "medium", "high", "thinking"]).has(reasoningEffort)) {
    return { model };
  }
  return {
    model: match[1].trim(),
    reasoningEffort,
  };
}

function migrateLegacyGeminiModel(model: string): string {
  const trimmed = model.trim();
  return LEGACY_GEMINI_MODEL_LABELS[trimmed.toLowerCase()] ?? trimmed;
}

export function normalizeLegacyModelSelection(input: {
  readonly provider: unknown;
  readonly model: string;
  readonly options: unknown;
}): Record<string, unknown> {
  const provider = inferLegacyModelProvider(input.provider, input.model);
  const migratedGeminiSelection = input.provider === "gemini";
  const normalizedOptions = migratedGeminiSelection
    ? undefined
    : normalizeModelOptions(readLegacyProviderOptions(input.options, provider));
  const antigravityModel =
    provider === "antigravity"
      ? splitLegacyAntigravityModelLabel(
          migratedGeminiSelection ? migrateLegacyGeminiModel(input.model) : input.model,
        )
      : null;
  const options =
    antigravityModel?.reasoningEffort &&
    (normalizedOptions === undefined || isRecord(normalizedOptions))
      ? {
          ...(isRecord(normalizedOptions) ? normalizedOptions : {}),
          reasoningEffort: antigravityModel.reasoningEffort,
        }
      : normalizedOptions;
  return {
    provider,
    model: antigravityModel?.model ?? input.model,
    ...(options === undefined ? {} : { options }),
  };
}

export function normalizePersistedModelSelection(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }

  const model = readTrimmedString(input, "model");
  if (model === undefined) {
    return input;
  }

  // Newer Synara writes provider-less selections as { instanceId, model } and
  // option rows as [{ id, value }]; Synara stores canonical provider/options objects.
  return normalizeLegacyModelSelection({
    provider: input.provider ?? input.instanceId,
    model,
    options: input.options,
  });
}
