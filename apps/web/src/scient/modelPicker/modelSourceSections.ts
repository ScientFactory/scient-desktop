import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Oh My Pi and Pi list the user's own sign-ins and API keys together with the
 * Scient custom models registered into them. The model picker shows the two
 * as separate sections that the user can collapse.
 */
const SOURCE_SECTION_DRIVERS: ReadonlySet<string> = new Set(["omp", "pi"]);

/**
 * Scient registers each model connection under the provider id
 * `scient_<connection id>` (`customModelProviderId` on the server), and a model
 * slug starts with its provider id. The prefix is presentation only: it never
 * changes which models are offered.
 */
const SCIENT_CUSTOM_PROVIDER_PREFIX = "scient_";

export type ModelSourceSection = "accounts" | "custom";

const SECTIONS: ReadonlyArray<ModelSourceSection> = ["accounts", "custom"];

export function hasModelSourceSections(driverKind: string | undefined): boolean {
  return driverKind !== undefined && SOURCE_SECTION_DRIVERS.has(driverKind);
}

/**
 * Sections apply to one selected Oh My Pi or Pi instance. Search and Favorites
 * list plain matches, including models in collapsed sections.
 */
export function modelSourceSectionsApply(input: {
  readonly isSearching: boolean;
  readonly showsFavorites: boolean;
  readonly driverKind: string | undefined;
}): boolean {
  return !input.isSearching && !input.showsFavorites && hasModelSourceSections(input.driverKind);
}

export function modelSourceSection(slug: string): ModelSourceSection {
  return slug.startsWith(SCIENT_CUSTOM_PROVIDER_PREFIX) ? "custom" : "accounts";
}

/**
 * Splits one instance's models into the two sections, keeping each provider's
 * models together in the order the provider first appears. Returns null when
 * one section would be empty: a single group needs no headers.
 */
export function groupModelsBySource<
  T extends { readonly slug: string; readonly subProvider?: string | undefined },
>(rows: ReadonlyArray<T>): Readonly<Record<ModelSourceSection, ReadonlyArray<T>>> | null {
  const accounts = new Map<string, T[]>();
  const custom: T[] = [];
  for (const row of rows) {
    if (modelSourceSection(row.slug) === "custom") {
      custom.push(row);
      continue;
    }
    const provider = row.subProvider ?? "";
    const group = accounts.get(provider);
    if (group) group.push(row);
    else accounts.set(provider, [row]);
  }
  if (accounts.size === 0 || custom.length === 0) return null;
  return { accounts: [...accounts.values()].flat(), custom };
}

const SECTION_KEY_PREFIX = "model-source:";

export function modelSourceSectionKey(
  instanceId: ProviderInstanceId,
  section: ModelSourceSection,
): string {
  return `${SECTION_KEY_PREFIX}${section}:${instanceId}`;
}

export function parseModelSourceSectionKey(
  key: string,
): { readonly instanceId: ProviderInstanceId; readonly section: ModelSourceSection } | null {
  if (!key.startsWith(SECTION_KEY_PREFIX)) return null;
  const rest = key.slice(SECTION_KEY_PREFIX.length);
  const separator = rest.indexOf(":");
  const section = SECTIONS.find((candidate) => candidate === rest.slice(0, separator));
  const instanceId = rest.slice(separator + 1);
  return section && separator > 0 && instanceId
    ? { instanceId: instanceId as ProviderInstanceId, section }
    : null;
}

export function modelSourceSectionLabel(
  section: ModelSourceSection,
  providerDisplayName: string,
): string {
  return section === "custom" ? "Scient custom models" : `Your ${providerDisplayName} accounts`;
}

/** Collapsed sections, as section keys, remembered on this device. */
export const COLLAPSED_MODEL_SOURCES_STORAGE_KEY = "scient:model-picker:collapsed-sources:v1";
export const CollapsedModelSources = Schema.Array(Schema.String);
/** Stable default, so the stored value keeps its identity between renders. */
export const NO_COLLAPSED_MODEL_SOURCES: ReadonlyArray<string> = [];

export interface ModelSourceSectionRows<T> {
  /** The header keys and the keys of the models they show, in list order. */
  readonly itemKeys: ReadonlyArray<string>;
  /** The models the list shows, for selection and jump shortcuts. */
  readonly visibleModels: ReadonlyArray<T>;
  readonly sections: ReadonlyMap<
    string,
    {
      readonly section: ModelSourceSection;
      readonly count: number;
      readonly expanded: boolean;
    }
  >;
}

/**
 * Lays out one instance's sections. A section is expanded unless the user
 * collapsed it; `revealed` keeps the section holding the selected model open
 * when the picker opens, until the user collapses it again.
 */
export function buildModelSourceSectionRows<T>(input: {
  readonly instanceId: ProviderInstanceId;
  readonly groups: Readonly<Record<ModelSourceSection, ReadonlyArray<T>>>;
  readonly collapsed: ReadonlySet<string>;
  readonly revealed: ReadonlySet<string>;
  readonly modelKey: (model: T) => string;
}): ModelSourceSectionRows<T> {
  const itemKeys: string[] = [];
  const visibleModels: T[] = [];
  const sections = new Map<
    string,
    { section: ModelSourceSection; count: number; expanded: boolean }
  >();
  for (const section of SECTIONS) {
    const key = modelSourceSectionKey(input.instanceId, section);
    const models = input.groups[section];
    const expanded = !input.collapsed.has(key) || input.revealed.has(key);
    sections.set(key, { section, count: models.length, expanded });
    itemKeys.push(key);
    if (!expanded) continue;
    for (const model of models) {
      itemKeys.push(input.modelKey(model));
      visibleModels.push(model);
    }
  }
  return { itemKeys, visibleModels, sections };
}
