import {
  getAntigravityModelGroups,
  groupAntigravityModelRows,
} from "@t3tools/client-runtime/antigravity-model-presentation";
import { groupDroidModelRows } from "@t3tools/client-runtime/droid-model-presentation";
import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";

import type { ModelPickerItem } from "~/components/chat/ModelPickerContent";
import { modelPickerModelKey } from "~/components/chat/modelPickerKeys";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { providerModelKey } from "~/modelOrdering";
import type { ProviderInstanceEntry } from "~/providerInstances";

import {
  buildModelSourceSectionRows,
  COLLAPSED_MODEL_SOURCES_STORAGE_KEY,
  CollapsedModelSources,
  groupModelsBySource,
  hasModelSourceSections,
  modelSourceSection,
  modelSourceSectionKey,
  modelSourceSectionsApply,
  NO_COLLAPSED_MODEL_SOURCES,
} from "./modelSourceSections";

/**
 * Which model source sections the user collapsed (remembered) and which ones
 * open with the picker because they hold the selected model.
 */
export function useModelSourceSectionState(input: {
  readonly activeInstanceId: ProviderInstanceId;
  readonly activeModelSlug: string;
  readonly activeDriverKind: ProviderDriverKind | undefined;
}) {
  const { activeInstanceId, activeModelSlug, activeDriverKind } = input;
  const [collapsedModelSources, setCollapsedModelSources] = useLocalStorage(
    COLLAPSED_MODEL_SOURCES_STORAGE_KEY,
    NO_COLLAPSED_MODEL_SOURCES,
    CollapsedModelSources,
  );
  // The section holding the selected model opens with the picker.
  const [revealedModelSources, setRevealedModelSources] = useState(
    () =>
      new Set<string>(
        activeModelSlug && hasModelSourceSections(activeDriverKind)
          ? [modelSourceSectionKey(activeInstanceId, modelSourceSection(activeModelSlug))]
          : [],
      ),
  );
  return {
    collapsedModelSources,
    setCollapsedModelSources,
    revealedModelSources,
    setRevealedModelSources,
  };
}

/**
 * Scient's grouping of the picker's model list: Antigravity variants fold
 * into one row per family, Droid splits into its own sections, and Oh My Pi
 * and Pi models split by source into collapsible sections.
 */
export function useScientModelPickerGroups(input: {
  readonly ungroupedFilteredModels: ReadonlyArray<ModelPickerItem>;
  readonly selectedInstanceId: ProviderInstanceId | "favorites";
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly entryByInstanceId: ReadonlyMap<ProviderInstanceId, ProviderInstanceEntry>;
  readonly activeInstanceId: ProviderInstanceId;
  readonly activeModelSlug: string;
  readonly isSearching: boolean;
  readonly sourceSectionState: ReturnType<typeof useModelSourceSectionState>;
}) {
  const {
    ungroupedFilteredModels,
    selectedInstanceId,
    instanceEntries,
    entryByInstanceId,
    activeInstanceId,
    activeModelSlug,
    isSearching,
  } = input;
  const {
    collapsedModelSources,
    setCollapsedModelSources,
    revealedModelSources,
    setRevealedModelSources,
  } = input.sourceSectionState;
  const filteredModels = useMemo(() => {
    // Favorites remain exact model/effort shortcuts, including pre-existing bookmarks.
    if (
      selectedInstanceId === "favorites" ||
      !ungroupedFilteredModels.some((model) => model.driverKind === "antigravity")
    )
      return ungroupedFilteredModels;
    const visible = new Map<string, ModelPickerItem>();
    for (const entry of instanceEntries) {
      const rows = ungroupedFilteredModels.filter((model) => model.instanceId === entry.instanceId);
      const groups = getAntigravityModelGroups(entry.driverKind, entry.models);
      for (const row of groupAntigravityModelRows(
        rows,
        groups,
        entry.instanceId === activeInstanceId ? activeModelSlug : null,
      )) {
        visible.set(providerModelKey(row.instanceId, row.slug), row);
      }
    }
    return ungroupedFilteredModels.flatMap((row) => {
      const shown = visible.get(providerModelKey(row.instanceId, row.slug));
      return shown ? [shown] : [];
    });
  }, [
    ungroupedFilteredModels,
    selectedInstanceId,
    instanceEntries,
    activeInstanceId,
    activeModelSlug,
  ]);

  const droidGroups = useMemo(() => {
    if (
      isSearching ||
      selectedInstanceId === "favorites" ||
      instanceEntries.find((entry) => entry.instanceId === selectedInstanceId)?.driverKind !==
        "droid"
    )
      return null;
    return groupDroidModelRows(filteredModels);
  }, [isSearching, selectedInstanceId, instanceEntries, filteredModels]);

  const sourceSectionRows = useMemo(() => {
    const showsFavorites = selectedInstanceId === "favorites";
    if (
      showsFavorites ||
      !modelSourceSectionsApply({
        isSearching,
        showsFavorites,
        driverKind: entryByInstanceId.get(selectedInstanceId)?.driverKind,
      })
    )
      return null;
    const groups = groupModelsBySource(filteredModels);
    return groups
      ? buildModelSourceSectionRows({
          instanceId: selectedInstanceId,
          groups,
          collapsed: new Set(collapsedModelSources),
          revealed: revealedModelSources,
          modelKey: (model) => modelPickerModelKey(model.instanceId, model.slug),
        })
      : null;
  }, [
    collapsedModelSources,
    entryByInstanceId,
    filteredModels,
    isSearching,
    revealedModelSources,
    selectedInstanceId,
  ]);

  const toggleModelSourceSection = useCallback(
    (key: string) => {
      const expanded = sourceSectionRows?.sections.get(key)?.expanded ?? true;
      setRevealedModelSources((revealed) => {
        const next = new Set(revealed);
        next.delete(key);
        return next;
      });
      setCollapsedModelSources((collapsed) =>
        expanded
          ? [...collapsed.filter((entry) => entry !== key), key]
          : collapsed.filter((entry) => entry !== key),
      );
    },
    // setRevealedModelSources is a stable state setter, listed because it now
    // arrives as a parameter.
    [setCollapsedModelSources, setRevealedModelSources, sourceSectionRows],
  );

  return { filteredModels, droidGroups, sourceSectionRows, toggleModelSourceSection };
}
