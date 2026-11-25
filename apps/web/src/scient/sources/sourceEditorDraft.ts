import type { ScientSourceMetadataUpdateRequest } from "@t3tools/contracts";

type Metadata = ScientSourceMetadataUpdateRequest["metadata"];

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/**
 * A draft moved onto a newer record: each field the person changed from `base` keeps their value,
 * and every other field takes the newer record's.
 */
export function rebaseSourceDraft(base: Metadata, draft: Metadata, latest: Metadata): Metadata {
  const keys = new Set([...Object.keys(base), ...Object.keys(draft), ...Object.keys(latest)]);
  const rebased: Record<string, unknown> = {};
  for (const key of keys) {
    const field = key as keyof Metadata;
    const value = same(draft[field], base[field]) ? latest[field] : draft[field];
    if (value !== undefined) rebased[key] = value;
  }
  return rebased as unknown as Metadata;
}

/** The fields of `draft` that differ from `base`. */
export function changedDraftFields(base: Metadata, draft: Metadata): ReadonlySet<keyof Metadata> {
  const keys = new Set([...Object.keys(base), ...Object.keys(draft)]) as Set<keyof Metadata>;
  return new Set([...keys].filter((key) => !same(draft[key], base[key])));
}
