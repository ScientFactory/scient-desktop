import type { SelectProviderOptionDescriptor, ServerProviderModel } from "@t3tools/contracts";

/** A presentation-only control: its values are native model IDs, never model options. */
export const ANTIGRAVITY_REASONING_CONTROL = "scient:antigravity-model";

export interface AntigravityModelGroup {
  readonly name: string;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly label: string }>;
}

/**
 * Only group verified Gemini effort variants from the live, instance-owned catalog.
 * Unknown naming, custom entries and agents exposing real options stay native.
 * Neither the catalog nor persisted selections are rewritten.
 */
export function getAntigravityModelGroups(
  driver: string,
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<AntigravityModelGroup> {
  if (driver !== "antigravity") return [];
  const candidates = new Map<
    string,
    Array<{ model: ServerProviderModel; name: string; level: string }>
  >();
  for (const model of models) {
    const id = /^(gemini-[a-z0-9.-]+)-(low|medium|high)$/.exec(model.slug);
    const name = /^(Gemini .+) \((Low|Medium|High)\)$/.exec(model.name);
    if (!id || !name || name[2]?.toLowerCase() !== id[2]) continue;
    const key = id[1]!;
    const entries = candidates.get(key) ?? [];
    entries.push({ model, name: name[1]!, level: id[2]! });
    candidates.set(key, entries);
  }
  const result: AntigravityModelGroup[] = [];
  for (const [base, entries] of candidates) {
    const first = entries[0]!;
    if (
      entries.length < 2 ||
      models.some((model) => model.slug === base) ||
      new Set(entries.map(({ level }) => level)).size !== entries.length ||
      entries.some(
        ({ model, name }) =>
          model.isCustom ||
          (model.capabilities?.optionDescriptors?.length ?? 0) > 0 ||
          name !== first.name ||
          Boolean(model.isLegacy) !== Boolean(first.model.isLegacy),
      )
    )
      continue;
    const order = ["low", "medium", "high"];
    result.push({
      name: first.name,
      models: entries
        .toSorted((a, b) => order.indexOf(a.level) - order.indexOf(b.level))
        .map(({ model, level }) => ({
          slug: model.slug,
          label: level[0]!.toUpperCase() + level.slice(1),
        })),
    });
  }
  return result;
}

export function getAntigravityReasoningControl(
  groups: ReadonlyArray<AntigravityModelGroup>,
  selectedModel: string | null | undefined,
): SelectProviderOptionDescriptor | null {
  const group = groups.find((candidate) =>
    candidate.models.some(({ slug }) => slug === selectedModel),
  );
  if (!group || !selectedModel) return null;
  return {
    id: ANTIGRAVITY_REASONING_CONTROL,
    label: "Reasoning",
    type: "select",
    currentValue: selectedModel,
    options: group.models.map(({ slug, label }) => ({ id: slug, label })),
  };
}

/** Collapse display rows only, after visibility filters; every row retains a real ID. */
export function groupAntigravityModelRows<
  T extends {
    slug: string;
    name: string;
    shortName?: string | undefined;
    isDefault?: boolean | undefined;
    isUnavailable?: boolean | undefined;
  },
>(
  rows: ReadonlyArray<T>,
  groups: ReadonlyArray<AntigravityModelGroup>,
  selectedModel?: string | null,
): Array<T & { shortName?: string | undefined }> {
  const bySlug = new Map(
    groups.flatMap((group) => group.models.map(({ slug }) => [slug, group] as const)),
  );
  const emitted = new Set<AntigravityModelGroup>();
  return rows.flatMap((row) => {
    const group = !row.isUnavailable ? bySlug.get(row.slug) : undefined;
    if (!group) return [row];
    if (emitted.has(group)) return [];
    emitted.add(group);
    const members = rows.filter(
      (candidate) => !candidate.isUnavailable && bySlug.get(candidate.slug) === group,
    );
    const representative =
      members.find(({ slug }) => slug === selectedModel) ??
      members.find(({ isDefault }) => isDefault) ??
      members[0]!;
    // A single search/visibility result should keep its exact, informative label.
    if (members.length === 1) return [representative];
    return [{ ...representative, name: group.name, shortName: group.name }];
  });
}
