import type { ProviderInstanceId } from "@t3tools/contracts";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";

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

// SCIENT-FORK: keyboard traversal includes the same setup-capable instances as the rail.
export function adjacentModelPickerProvider(input: {
  entries: ReadonlyArray<ProviderInstanceEntry>;
  selectedInstanceId: ProviderInstanceId | "favorites";
  direction: 1 | -1;
  disabledInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
  selectableUnavailableInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
  setupAvailableInstanceIds?: ReadonlySet<ProviderInstanceId>;
}) {
  const providers: Array<ProviderInstanceId | "favorites"> = [
    "favorites",
    ...input.entries
      .filter(
        (entry) =>
          !input.disabledInstanceIds?.has(entry.instanceId) &&
          (isProviderInstancePickerReady(entry) ||
            input.selectableUnavailableInstanceIds?.has(entry.instanceId) ||
            input.setupAvailableInstanceIds?.has(entry.instanceId)),
      )
      .map((entry) => entry.instanceId),
  ];
  const index = providers.indexOf(input.selectedInstanceId);
  return providers[
    index < 0
      ? input.direction === 1
        ? 0
        : providers.length - 1
      : (index + input.direction + providers.length) % providers.length
  ]!;
}
