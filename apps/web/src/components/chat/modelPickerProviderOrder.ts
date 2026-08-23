import type { ProviderInstanceId } from "@t3tools/contracts";

export function prioritizeActiveProviderInstance<
  T extends { readonly instanceId: ProviderInstanceId },
>(entries: ReadonlyArray<T>, activeInstanceId: ProviderInstanceId): ReadonlyArray<T> {
  const activeIndex = entries.findIndex((entry) => entry.instanceId === activeInstanceId);
  if (activeIndex <= 0) return entries;
  return [
    entries[activeIndex]!,
    ...entries.slice(0, activeIndex),
    ...entries.slice(activeIndex + 1),
  ];
}
