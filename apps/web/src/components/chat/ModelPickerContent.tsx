import { getDroidModelSection } from "@t3tools/client-runtime/droid-model-presentation";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderInstanceId,
  type EnvironmentId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { formatProviderUpdateRequiredNotice } from "@t3tools/client-runtime/providerUpdateRequiredModels";
import { useNavigate } from "@tanstack/react-router";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  memo,
  useContext,
  useState,
  useEffect,
  useEffectEvent,
  type RefObject,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";

import { ModelPickerOverlayContext } from "../../scient/providerConnection/ModelPickerOverlayContext";
import { ModelPickerNewChatFooter } from "./ModelPickerNewChatFooter";
import { ModelListDisclosureContent } from "./ModelListDisclosureContent";
import { ModelListRow } from "./ModelListRow";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
import {
  adjacentModelPickerProvider,
  prioritizeActiveProviderInstance,
} from "./modelPickerProviderOrder";
import { getProviderStatusMessage, hasProviderSetup } from "./ProviderStatusBanner";
import {
  modelPickerLegacySectionKey,
  modelPickerModelKey,
  parseModelPickerLegacySectionKey,
  parseModelPickerModelKey,
} from "./modelPickerKeys";
import { rankModelPickerSearch } from "./modelPickerSearch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxListVirtualized,
} from "../ui/combobox";
import { ModelEsque } from "./providerIconUtils";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import {
  useEnvironmentModelPreferences,
  useToggleEnvironmentModelFavorite,
} from "~/hooks/useSettings";
import { announce } from "~/lib/announce";
import {
  hasModelSourceSections,
  modelSourceSectionKey,
  modelSourceSectionLabel,
  parseModelSourceSectionKey,
} from "~/scient/modelPicker/modelSourceSections";
import {
  useModelSourceSectionState,
  deriveScientModelPickerGroups,
} from "~/scient/modelPicker/useScientModelPickerGroups";
import { cn } from "~/lib/utils";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { TooltipProvider } from "../ui/tooltip";
import { InlineButton } from "../ui/button";
import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { providerModelKey, sortProviderModelItems } from "../../modelOrdering";
import { isActiveProviderConnectionOperation } from "~/scient/providerConnection/providerConnectionPresentation";

export type ModelPickerItem = {
  isDefault?: boolean | undefined;
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  badge?: "new";
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  instanceDisplayName: string;
  instanceAccentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  continuationGroupKey?: string | undefined;
  isLegacy?: boolean | undefined;
  /** Provider-reported compact cost label (e.g. `"0.5×"`); absent when unknown. */
  providerCostLabel?: string | undefined;
  isUnavailable?: boolean | undefined;
};

export function resolveModelPickerSelectedModel(input: {
  driverKind: ProviderDriverKind | undefined;
  model: string;
  options: ReadonlyArray<ModelEsque>;
}) {
  if (input.driverKind === "antigravity" && input.model === ANTIGRAVITY_DEFAULT_MODEL) {
    const availableModels = input.options.filter(
      (option) => option.slug !== ANTIGRAVITY_DEFAULT_MODEL && !option.isUnavailable,
    );
    return (
      availableModels.find((option) => option.aliases?.includes(ANTIGRAVITY_DEFAULT_MODEL)) ??
      availableModels.find((option) => option.isDefault)
    );
  }
  return input.options.find((option) => option.slug === input.model);
}

function shouldIncludeModelPickerOption(input: {
  readonly entry: ProviderInstanceEntry;
  readonly option: ModelEsque;
  readonly activeInstanceId: ProviderInstanceId;
  readonly activeModel: string;
}): boolean {
  if (input.entry.driverKind === "antigravity" && input.option.slug === ANTIGRAVITY_DEFAULT_MODEL) {
    return false;
  }
  if (isProviderInstancePickerReady(input.entry)) return true;
  return (
    input.entry.enabled &&
    (input.entry.driverKind === "opencode" || input.entry.driverKind === "antigravity") &&
    input.entry.instanceId === input.activeInstanceId &&
    input.option.slug === input.activeModel &&
    input.option.isUnavailable === true
  );
}

function shouldOfferModelPickerSetup(
  entry: ProviderInstanceEntry,
  options: ReadonlyArray<ModelEsque>,
  setupAvailable = hasProviderSetup(entry.snapshot),
): boolean {
  return (
    entry.enabled &&
    entry.status !== "disabled" &&
    setupAvailable &&
    (entry.snapshot.probePending === true ||
      !isProviderInstancePickerReady(entry) ||
      !entry.installed ||
      entry.snapshot.auth.status === "unauthenticated" ||
      isActiveProviderConnectionOperation(entry.snapshot.connection?.operation) ||
      isActiveProviderConnectionOperation(entry.snapshot.connection?.accountOperation) ||
      (!entry.models.some((model) => !model.unavailableReason) &&
        !options.some((option) => !option.isUnavailable)))
  );
}

const EMPTY_MODEL_JUMP_LABELS = new Map<string, string>();
const MODEL_LIST_ESTIMATED_ITEM_SIZE = 52;

function ModelListSeparator() {
  return <div className="h-0.5" />;
}

function modelJumpLabelsByKey(
  modelKeys: ReadonlyArray<string>,
  keybindings: ResolvedKeybindingsConfig,
  terminalOpen: boolean,
): ReadonlyMap<string, string> {
  const shortcutLabelOptions = {
    platform: navigator.platform,
    context: { terminalFocus: false, terminalOpen, modelPickerOpen: true },
  };
  const mapping = new Map<string, string>();
  for (const [index, modelKey] of modelKeys.entries()) {
    const command = modelPickerJumpCommandForIndex(index);
    const label = command && shortcutLabelForCommand(keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(modelKey, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_MODEL_JUMP_LABELS;
}

function ModelPickerProviderNotices({
  setupEntries,
  updateRequiredNotices,
  onRequestClose,
  onOpenProviderSetup,
}: {
  setupEntries: ReadonlyArray<ProviderInstanceEntry>;
  updateRequiredNotices: ReadonlyArray<{ instanceId: ProviderInstanceId; notice: string }>;
  onRequestClose: (() => void) | undefined;
  onOpenProviderSetup: ((instanceId: ProviderInstanceId) => void) | undefined;
}) {
  const navigate = useNavigate();
  return (
    <>
      {setupEntries.length > 0 ? (
        <div className="max-h-44 shrink-0 overflow-y-auto border-t border-border/70 p-2">
          {setupEntries.map((entry) => (
            <div key={entry.instanceId} className="px-1 py-1.5 text-xs leading-snug">
              <p className="line-clamp-3 text-muted-foreground">
                {getProviderStatusMessage(entry.snapshot)}
              </p>
              <InlineButton
                className="mt-1"
                onClick={() => {
                  onRequestClose?.();
                  onOpenProviderSetup?.(entry.instanceId);
                }}
              >
                {setupEntries.length > 1 ? `Set up ${entry.displayName}` : "Open provider setup"}
              </InlineButton>
            </div>
          ))}
        </div>
      ) : null}
      {updateRequiredNotices.map(({ instanceId, notice }) => (
        <p
          key={instanceId}
          className="shrink-0 border-t border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground"
        >
          {notice}{" "}
          <InlineButton
            onClick={() => {
              onRequestClose?.();
              void navigate({ to: "/settings/providers" });
            }}
          >
            Provider settings
          </InlineButton>
        </p>
      ))}
    </>
  );
}

function ModelPickerList({
  listRef,
  itemKeys,
  extraData,
  renderItem,
}: {
  listRef: RefObject<LegendListRef | null>;
  itemKeys: ReadonlyArray<string>;
  extraData: unknown;
  renderItem: (props: { item: string; index: number }) => ReactNode;
}) {
  const [showTopScrollFade, setShowTopScrollFade] = useState(false);
  const [showBottomScrollFade, setShowBottomScrollFade] = useState(false);
  const [contentSize, setContentSize] = useState(
    () => itemKeys.length * MODEL_LIST_ESTIMATED_ITEM_SIZE,
  );
  useLayoutEffect(() => listRef.current?.getState().listen("totalSize", setContentSize), [listRef]);
  const updateScrollFades = () => {
    const scrollElement = listRef.current?.getScrollableNode();
    if (!(scrollElement instanceof HTMLElement)) {
      return;
    }
    const maxScrollOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    setShowTopScrollFade(scrollElement.scrollTop > 1);
    setShowBottomScrollFade(maxScrollOffset - scrollElement.scrollTop > 1);
  };

  // Disabled-reason closures rebuild identical key arrays; compare contents.
  const itemListKey = JSON.stringify(itemKeys);

  const [fadesResetFor, setFadesResetFor] = useState(itemListKey);
  if (fadesResetFor !== itemListKey) {
    setFadesResetFor(itemListKey);
    setShowTopScrollFade(false);
    setShowBottomScrollFade(itemKeys.length > 5);
  }
  const measureScrollFades = useEffectEvent(updateScrollFades);
  useLayoutEffect(() => {
    let nestedFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      measureScrollFades();
      nestedFrame = window.requestAnimationFrame(() => measureScrollFades());
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(nestedFrame);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new list re-measures its scroll fades once it has laid out.
  }, [itemListKey]);

  return (
    <div
      className="relative min-h-0 overflow-hidden pr-px"
      style={{
        height: itemKeys.length === 0 ? 0 : `calc(${contentSize}px + var(--spacing) * 5)`,
      }}
      // SCIENT-FORK: the model list region the provider setup replaces.
      data-model-picker-models="true"
    >
      <ComboboxListVirtualized>
        <LegendList<string>
          ref={listRef}
          data={itemKeys}
          extraData={extraData}
          keyExtractor={(modelKey) => modelKey}
          renderItem={renderItem}
          estimatedItemSize={MODEL_LIST_ESTIMATED_ITEM_SIZE}
          drawDistance={480}
          recycleItems
          contentContainerClassName="pl-2 pr-px"
          ItemSeparatorComponent={ModelListSeparator}
          onLayout={updateScrollFades}
          onScroll={updateScrollFades}
          className={cn(
            "scrollbar-gutter-stable h-full overflow-x-hidden overscroll-y-contain py-1.5 [&::-webkit-scrollbar-track]:my-2",
            getVirtualizedScrollFadeClassName({
              top: showTopScrollFade,
              bottom: showBottomScrollFade,
            }),
          )}
        />
      </ComboboxListVirtualized>
    </div>
  );
}

// Capture gives picker shortcuts priority over the composer.
function WindowKeyDownListener({ onKeyDown }: { onKeyDown: (event: KeyboardEvent) => void }) {
  const handleKeyDown = useEffectEvent(onKeyDown);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleKeyDown(event);
    window.addEventListener("keydown", listener, true);
    return () => {
      window.removeEventListener("keydown", listener, true);
    };
  }, []);
  return null;
}

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  environmentId: EnvironmentId | null;
  activeInstanceId: ProviderInstanceId;
  model: string;
  selectedModels?: ReadonlyArray<{ instanceId: ProviderInstanceId; model: string }>;
  onToggleModel?: (instanceId: ProviderInstanceId, model: string) => void;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  terminalOpen: boolean;
  onRequestClose?: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  /** Keep a not-ready provider selectable when Scient can render its setup flow inline. */
  isProviderSetupAvailable?: (entry: ProviderInstanceEntry) => boolean;
  renderProviderSetup?: (entry: ProviderInstanceEntry) => ReactNode;
  /** Optional context row beneath the selected provider's model list. */
  renderProviderFooter?: (entry: ProviderInstanceEntry) => ReactNode;
  onContinueInNewChat?: () => void;
  continueInNewChatDisabled?: boolean;
}) {
  const {
    keybindings: providedKeybindings,
    modelOptionsByInstance,
    instanceEntries,
    getModelDisabledReason,
    onInstanceModelChange,
    onToggleModel,
  } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modelListRef = useRef<LegendListRef | null>(null);
  const pickerContentRef = useRef<HTMLDivElement>(null);
  const highlightedModelKeyRef = useRef<string | null>(null);
  const { favorites } = useEnvironmentModelPreferences(props.environmentId);
  const activeEntry = props.instanceEntries.find(
    (entry) => entry.instanceId === props.activeInstanceId,
  );
  const activeModel = resolveModelPickerSelectedModel({
    driverKind: activeEntry?.driverKind,
    model: props.model,
    options: modelOptionsByInstance.get(props.activeInstanceId) ?? [],
  });
  const activeModelSlug =
    activeModel?.slug ?? (props.model === ANTIGRAVITY_DEFAULT_MODEL ? "" : props.model);
  const activeModelKey = activeModelSlug
    ? modelPickerModelKey(props.activeInstanceId, activeModelSlug)
    : null;
  const selectedModelKeys = (() =>
    props.selectedModels?.map((selection) => {
      const entry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
      const model = resolveModelPickerSelectedModel({
        driverKind: entry?.driverKind,
        model: selection.model,
        options: modelOptionsByInstance.get(selection.instanceId) ?? [],
      });
      return modelPickerModelKey(selection.instanceId, model?.slug ?? selection.model);
    }))();
  const selectedModelKeySet = (() =>
    new Set(selectedModelKeys ?? (activeModelKey ? [activeModelKey] : [])))();
  const activeInstanceHasSelectableUnavailableModel =
    activeEntry !== undefined &&
    (modelOptionsByInstance.get(props.activeInstanceId) ?? []).some((option) =>
      shouldIncludeModelPickerOption({
        entry: activeEntry,
        option,
        activeInstanceId: props.activeInstanceId,
        activeModel: activeModelSlug,
      }),
    ) &&
    !isProviderInstancePickerReady(activeEntry);
  const activeInstanceNeedsSetup =
    (props.onOpenProviderSetup !== undefined || props.renderProviderSetup !== undefined) &&
    activeEntry !== undefined &&
    shouldOfferModelPickerSetup(
      activeEntry,
      modelOptionsByInstance.get(props.activeInstanceId) ?? [],
      props.isProviderSetupAvailable?.(activeEntry) ?? hasProviderSetup(activeEntry.snapshot),
    );
  const [selectedInstanceId, setSelectedInstanceId] = useState<ProviderInstanceId | "favorites">(
    () => {
      if (
        props.lockedProvider !== null ||
        activeInstanceHasSelectableUnavailableModel ||
        activeInstanceNeedsSetup
      ) {
        return props.activeInstanceId;
      }
      return favorites.length > 0 ? "favorites" : props.activeInstanceId;
    },
  );
  const favoritesSet = new Set(favorites.map((fav) => providerModelKey(fav.provider, fav.model)));
  const [expandedLegacyInstances, setExpandedLegacyInstances] = useState(
    () =>
      new Set<ProviderInstanceId>(
        modelOptionsByInstance
          .get(props.activeInstanceId)
          ?.some(
            (model) =>
              model.slug === activeModelSlug &&
              (activeEntry?.driverKind === "droid"
                ? getDroidModelSection(model) === "more"
                : model.isLegacy),
          ) && !favoritesSet.has(providerModelKey(props.activeInstanceId, activeModelSlug))
          ? [props.activeInstanceId]
          : [],
      ),
  );
  // SCIENT-FORK:START — model source sections remember what the user collapsed
  const sourceSectionState = useModelSourceSectionState({
    activeInstanceId: props.activeInstanceId,
    activeModelSlug,
    activeDriverKind: activeEntry?.driverKind,
  });
  // SCIENT-FORK:END
  const serverKeybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keybindings = providedKeybindings ?? serverKeybindings;
  const toggleFavorite = useToggleEnvironmentModelFavorite(props.environmentId);

  const focusSearchInput = () => {
    searchInputRef.current?.focus({ preventScroll: true });
  };

  const handleSelectInstance = (instanceId: ProviderInstanceId | "favorites") => {
    setSearchQuery("");
    setSelectedInstanceId(instanceId);
    window.requestAnimationFrame(() => {
      focusSearchInput();
    });
  };

  useLayoutEffect(() => {
    focusSearchInput();
    const frame = window.requestAnimationFrame(() => {
      focusSearchInput();
    });
    const timeout = window.setTimeout(() => {
      focusSearchInput();
    }, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [focusSearchInput]);

  const entryByInstanceId = (() =>
    new Map(instanceEntries.map((entry) => [entry.instanceId, entry])))();
  const matchesLockedProvider = (
    entry: Pick<ProviderInstanceEntry, "driverKind" | "continuationGroupKey">,
  ): boolean => {
    if (props.lockedProvider === null) return true;
    if (entry.driverKind !== props.lockedProvider) return false;
    if (!props.lockedContinuationGroupKey) return true;
    return entry.continuationGroupKey === props.lockedContinuationGroupKey;
  };

  const selectableUnavailableInstanceIds = (() => {
    const instanceIds = new Set<ProviderInstanceId>();
    if (activeInstanceHasSelectableUnavailableModel) {
      instanceIds.add(props.activeInstanceId);
    }
    if (props.onOpenProviderSetup) {
      for (const entry of instanceEntries) {
        if (
          shouldOfferModelPickerSetup(entry, modelOptionsByInstance.get(entry.instanceId) ?? [])
        ) {
          instanceIds.add(entry.instanceId);
        }
      }
    }
    return instanceIds.size > 0 ? instanceIds : undefined;
  })();

  const flatModels = (() => {
    const out: ModelPickerItem[] = [];
    for (const [instanceId, models] of modelOptionsByInstance) {
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        continue;
      }
      for (const model of models) {
        if (
          !shouldIncludeModelPickerOption({
            entry,
            option: model,
            activeInstanceId: props.activeInstanceId,
            activeModel: activeModelSlug,
          })
        ) {
          continue;
        }
        out.push({
          slug: model.slug,
          name: model.name,
          ...(model.isDefault ? { isDefault: true } : {}),
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          ...(model.badge ? { badge: model.badge } : {}),
          ...(model.isLegacy ? { isLegacy: true } : {}),
          ...(model.providerCostLabel ? { providerCostLabel: model.providerCostLabel } : {}),
          ...(model.isUnavailable ? { isUnavailable: true } : {}),
          instanceId,
          driverKind: entry.driverKind,
          instanceDisplayName: entry.displayName,
          ...(entry.accentColor ? { instanceAccentColor: entry.accentColor } : {}),
          ...(entry.acpRegistryAgentId ? { acpRegistryAgentId: entry.acpRegistryAgentId } : {}),
          ...(entry.acpRegistryIconUrl ? { acpRegistryIconUrl: entry.acpRegistryIconUrl } : {}),
          ...(entry.continuationGroupKey
            ? { continuationGroupKey: entry.continuationGroupKey }
            : {}),
        });
      }
    }
    return out;
  })();

  const isLocked = props.lockedProvider !== null;
  const isSearching = searchQuery.trim().length > 0;
  const lockedDisabledInstanceIds = (() => {
    if (!isLocked) {
      return undefined;
    }
    const disabled = new Set<ProviderInstanceId>();
    for (const entry of instanceEntries) {
      if (!matchesLockedProvider(entry)) {
        disabled.add(entry.instanceId);
      }
    }
    return disabled;
  })();
  const sidebarInstanceEntries = (() => {
    const enabledEntries = instanceEntries.filter(isProviderInstancePickerVisible);
    if (!isLocked) {
      return prioritizeActiveProviderInstance(enabledEntries, props.activeInstanceId);
    }
    const available: ProviderInstanceEntry[] = [];
    const disabled: ProviderInstanceEntry[] = [];
    for (const entry of enabledEntries) {
      if (matchesLockedProvider(entry)) {
        available.push(entry);
      } else {
        disabled.push(entry);
      }
    }
    return [...available, ...disabled];
  })();
  const setupAvailableInstanceIds = (() => {
    if (!props.isProviderSetupAvailable || !props.renderProviderSetup || isLocked) {
      return undefined;
    }
    const instanceIds = new Set<ProviderInstanceId>();
    for (const entry of sidebarInstanceEntries) {
      if (
        shouldOfferModelPickerSetup(
          entry,
          modelOptionsByInstance.get(entry.instanceId) ?? [],
          props.isProviderSetupAvailable(entry),
        )
      ) {
        instanceIds.add(entry.instanceId);
      }
    }
    return instanceIds.size > 0 ? instanceIds : undefined;
  })();
  const overlay = useContext(ModelPickerOverlayContext);
  const selectedSetupEntry =
    selectedInstanceId !== "favorites" &&
    (setupAvailableInstanceIds?.has(selectedInstanceId) ||
      overlay?.instanceId === selectedInstanceId)
      ? entryByInstanceId.get(selectedInstanceId)
      : undefined;
  const isShowingSetup = selectedSetupEntry !== undefined;
  const selectedFooterEntry =
    !isSearching && selectedInstanceId !== "favorites"
      ? entryByInstanceId.get(selectedInstanceId)
      : undefined;
  const isSearchingModels = isSearching && !selectedSetupEntry;
  const showSidebar = !isSearchingModels && sidebarInstanceEntries.length > 0;
  const instanceOrder = (() => instanceEntries.map((entry) => entry.instanceId))();

  const ungroupedFilteredModels = (() => {
    let result = flatModels;

    if (searchQuery.trim()) {
      const candidates =
        props.lockedProvider !== null ? result.filter((m) => matchesLockedProvider(m)) : result;
      return rankModelPickerSearch(candidates, searchQuery, (model) => ({
        name: model.name,
        ...(model.shortName ? { shortName: model.shortName } : {}),
        ...(model.subProvider ? { subProvider: model.subProvider } : {}),
        driverKind: model.driverKind,
        providerDisplayName: model.instanceDisplayName,
        isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
      }));
    }

    if (props.lockedProvider !== null) {
      result = result.filter((m) => matchesLockedProvider(m));
      if (selectedInstanceId === "favorites") {
        result = result.filter((m) => favoritesSet.has(providerModelKey(m.instanceId, m.slug)));
      } else {
        result = result.filter((m) => m.instanceId === selectedInstanceId);
      }
    } else if (selectedInstanceId === "favorites") {
      result = result.filter((m) => favoritesSet.has(providerModelKey(m.instanceId, m.slug)));
    } else {
      result = result.filter((m) => m.instanceId === selectedInstanceId);
    }

    return sortProviderModelItems(result, {
      favoriteModelKeys: favoritesSet,
      groupFavorites: selectedInstanceId !== "favorites",
      instanceOrder: selectedInstanceId === "favorites" ? instanceOrder : [],
    });
  })();

  // SCIENT-FORK:START — Antigravity families, Droid sections and model source sections
  const { filteredModels, droidGroups, sourceSectionRows, toggleModelSourceSection } =
    deriveScientModelPickerGroups({
      ungroupedFilteredModels,
      selectedInstanceId,
      instanceEntries,
      entryByInstanceId,
      activeInstanceId: props.activeInstanceId,
      activeModelSlug,
      isSearching,
      sourceSectionState,
    });
  // SCIENT-FORK:END

  const legacySection = (() => {
    if (isSearching || selectedInstanceId === "favorites" || sourceSectionRows) {
      return null;
    }
    const currentModels: ModelPickerItem[] = [];
    const legacyModels: ModelPickerItem[] = [];
    for (const model of filteredModels) {
      const isLegacy =
        // SCIENT-FORK:START — Droid’s More section uses provider metadata, not legacy status.
        (droidGroups ? getDroidModelSection(model) === "more" : model.isLegacy) &&
        // SCIENT-FORK:END
        !favoritesSet.has(providerModelKey(model.instanceId, model.slug));
      (isLegacy ? legacyModels : currentModels).push(model);
    }
    if (legacyModels.length === 0) {
      return null;
    }
    return {
      key: modelPickerLegacySectionKey(selectedInstanceId),
      currentModels,
      legacyModels,
      isExpanded: expandedLegacyInstances.has(selectedInstanceId),
    };
  })();

  const visibleModels = (() => {
    if (sourceSectionRows) return sourceSectionRows.visibleModels;
    if (!legacySection) {
      return droidGroups ? [...droidGroups.models, ...droidGroups.custom] : filteredModels;
    }
    return [
      ...legacySection.currentModels,
      ...(legacySection.isExpanded ? legacySection.legacyModels : []),
    ];
  })();

  const selectedEntry =
    selectedInstanceId === "favorites" ? undefined : entryByInstanceId.get(selectedInstanceId);
  const providerSetupEntries =
    !isSearching && props.onOpenProviderSetup
      ? instanceEntries.filter(
          (entry) =>
            matchesLockedProvider(entry) &&
            shouldOfferModelPickerSetup(
              entry,
              modelOptionsByInstance.get(entry.instanceId) ?? [],
            ) &&
            (selectedEntry
              ? entry.instanceId === selectedEntry.instanceId
              : filteredModels.length === 0),
        )
      : [];

  const updateRequiredNotices = (
    isSearching
      ? instanceEntries.filter(matchesLockedProvider)
      : selectedEntry
        ? [selectedEntry]
        : []
  ).flatMap((entry) => {
    const notice = formatProviderUpdateRequiredNotice(entry.snapshot, searchQuery);
    return notice ? [{ instanceId: entry.instanceId, notice }] : [];
  });

  const toggleLegacySection = (instanceId: ProviderInstanceId) => {
    setExpandedLegacyInstances((expanded) => {
      const next = new Set(expanded);
      if (next.has(instanceId)) {
        next.delete(instanceId);
      } else {
        next.add(instanceId);
      }
      return next;
    });
  };

  const handleContinueInNewChat = () => {
    if (props.continueInNewChatDisabled) return;
    props.onRequestClose?.();
    props.onContinueInNewChat?.();
  };

  const handleModelSelect = (
    modelSlug: string,
    instanceId: ProviderInstanceId,
    additive = false,
  ): string | null => {
    if (getModelDisabledReason?.(instanceId, modelSlug)) {
      return null;
    }
    const options = modelOptionsByInstance.get(instanceId);
    if (!options) {
      return null;
    }
    const entry = entryByInstanceId.get(instanceId);
    if (!entry) {
      return null;
    }
    const resolvedModel = resolveSelectableModel(entry.driverKind, modelSlug, options);
    if (!resolvedModel) return null;
    if (additive && onToggleModel) {
      onToggleModel(instanceId, resolvedModel);
    } else {
      onInstanceModelChange(instanceId, resolvedModel);
    }
    return resolvedModel;
  };

  const modelJumpCommandByKey = (() => {
    const mapping = new Map<
      string,
      NonNullable<ReturnType<typeof modelPickerJumpCommandForIndex>>
    >();
    let selectableModelIndex = 0;
    for (const model of visibleModels) {
      if (getModelDisabledReason?.(model.instanceId, model.slug)) {
        continue;
      }
      const jumpCommand = modelPickerJumpCommandForIndex(selectableModelIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(modelPickerModelKey(model.instanceId, model.slug), jumpCommand);
      selectableModelIndex += 1;
    }
    return mapping;
  })();
  const modelJumpModelKeys = (() => [...modelJumpCommandByKey.keys()])();
  const allItemKeys = ((): string[] => [
    ...flatModels.map((model) => modelPickerModelKey(model.instanceId, model.slug)),
    ...new Set(
      flatModels
        .filter((model) =>
          model.driverKind === "droid" ? getDroidModelSection(model) === "more" : model.isLegacy,
        )
        .map((model) => modelPickerLegacySectionKey(model.instanceId)),
    ),
    ...new Set(
      flatModels.flatMap((model) =>
        hasModelSourceSections(model.driverKind)
          ? [
              modelSourceSectionKey(model.instanceId, "accounts"),
              modelSourceSectionKey(model.instanceId, "custom"),
            ]
          : [],
      ),
    ),
  ])();
  const filteredItemKeys = ((): string[] => {
    if (sourceSectionRows) return [...sourceSectionRows.itemKeys];
    const modelKeys = visibleModels.map((model) =>
      modelPickerModelKey(model.instanceId, model.slug),
    );
    if (!legacySection) {
      return modelKeys;
    }
    modelKeys.splice(legacySection.currentModels.length, 0, legacySection.key);
    return modelKeys;
  })();
  const filteredModelByKey = ((): ReadonlyMap<string, ModelPickerItem> =>
    new Map(
      visibleModels.map(
        (model) => [modelPickerModelKey(model.instanceId, model.slug), model] as const,
      ),
    ))();
  const [searchHeight, setSearchHeight] = useState(0);
  const modelJumpShortcutContext = (() =>
    ({
      terminalFocus: false,
      terminalOpen: props.terminalOpen,
      modelPickerOpen: true,
    }) as const)();
  const modelJumpLabelByKey = modelJumpLabelsByKey(
    modelJumpModelKeys,
    keybindings,
    props.terminalOpen,
  );
  const modelListExtraData = (() => ({
    favoritesSet,
    modelJumpLabelByKey,
    activeModelKey,
    selectedModelKeySet,
    sourceSections: sourceSectionRows?.sections,
  }))();

  const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
    if (overlay?.instanceId || event.defaultPrevented || event.repeat || isCommandPaletteOpen()) {
      return;
    }

    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: modelJumpShortcutContext,
    });
    if (command === "modelPicker.previousProvider" || command === "modelPicker.nextProvider") {
      event.preventDefault();
      event.stopPropagation();
      const next = adjacentModelPickerProvider({
        entries: sidebarInstanceEntries,
        selectedInstanceId,
        direction: command === "modelPicker.nextProvider" ? 1 : -1,
        disabledInstanceIds: lockedDisabledInstanceIds,
        selectableUnavailableInstanceIds,
        ...(setupAvailableInstanceIds ? { setupAvailableInstanceIds } : {}),
      });
      setSearchQuery("");
      handleSelectInstance(next);
      announce(
        next === "favorites" ? "Favorites" : (entryByInstanceId.get(next)?.displayName ?? next),
        "model-picker",
      );
      return;
    }
    if (isShowingSetup) return;
    const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
    if (jumpIndex === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const targetModelKey = modelJumpModelKeys[jumpIndex];
    if (!targetModelKey) {
      return;
    }
    const model = parseModelPickerModelKey(targetModelKey);
    if (!model) {
      return;
    }
    const selectedSlug = handleModelSelect(model.slug, model.instanceId);
    if (selectedSlug === null) return;
    const name = flatModels.find(
      (item) => item.slug === selectedSlug && item.instanceId === model.instanceId,
    )?.name;
    announce(`Model: ${name ?? selectedSlug}`, "model-picker");
  };

  return (
    <TooltipProvider delay={0}>
      <WindowKeyDownListener onKeyDown={onWindowKeyDown} />
      <div
        ref={pickerContentRef}
        className="relative flex max-h-[min(21.625rem,var(--available-height,85vh))] w-screen max-w-90 flex-row overflow-hidden"
        style={isSearchingModels ? { height: searchHeight } : undefined}
        data-model-picker-content="true"
      >
        {showSidebar && (
          <ModelPickerSidebar
            selectedInstanceId={selectedInstanceId}
            onSelectInstance={handleSelectInstance}
            onFocusSearch={focusSearchInput}
            instanceEntries={sidebarInstanceEntries}
            showFavorites
            {...(setupAvailableInstanceIds ? { setupAvailableInstanceIds } : {})}
            {...(selectableUnavailableInstanceIds ? { selectableUnavailableInstanceIds } : {})}
            {...(lockedDisabledInstanceIds
              ? {
                  disabledInstanceIds: lockedDisabledInstanceIds,
                  getDisabledInstanceTooltip: (entry: ProviderInstanceEntry) =>
                    `${entry.displayName} is unavailable in this conversation. Fork to continue with ${entry.displayName}.`,
                }
              : {})}
          />
        )}

        <Combobox<string, boolean>
          inline
          items={isShowingSetup ? [] : allItemKeys}
          filteredItems={isShowingSetup ? [] : filteredItemKeys}
          filter={null}
          autoHighlight
          open
          virtualized
          multiple={onToggleModel !== undefined}
          value={onToggleModel ? [...selectedModelKeySet] : activeModelKey}
          onItemHighlighted={(modelKey, eventDetails) => {
            highlightedModelKeyRef.current = typeof modelKey === "string" ? modelKey : null;
            if (eventDetails.reason === "keyboard" && eventDetails.index >= 0) {
              void modelListRef.current?.scrollIndexIntoView?.({
                index: eventDetails.index,
                animated: false,
              });
            }
          }}
          onValueChange={(value, details) => {
            const modelKey = Array.isArray(value)
              ? (value.find((key) => !selectedModelKeySet.has(key)) ??
                [...selectedModelKeySet].find((key) => !value.includes(key)))
              : value;
            if (typeof modelKey !== "string") {
              return;
            }
            const legacyInstanceId = parseModelPickerLegacySectionKey(modelKey);
            if (legacyInstanceId) {
              toggleLegacySection(legacyInstanceId);
              return;
            }
            if (parseModelSourceSectionKey(modelKey)) {
              toggleModelSourceSection(modelKey);
              return;
            }
            const model = parseModelPickerModelKey(modelKey);
            if (model) {
              handleModelSelect(
                model.slug,
                model.instanceId,
                "shiftKey" in details.event && details.event.shiftKey === true,
              );
            }
          }}
        >
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40",
              showSidebar && "border-l border-border/70",
            )}
          >
            {/* The shared search field owns its visual treatment; setup remains scoped to the
                explicitly selected provider, without showing a redundant search field. */}
            {!selectedSetupEntry ? (
              <ComboboxSearchInput
                ref={searchInputRef}
                placeholder="Search models..."
                value={searchQuery}
                onChange={(e) => {
                  if (!isSearching) setSearchHeight(pickerContentRef.current?.offsetHeight ?? 0);
                  setSearchQuery(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (
                    showSidebar &&
                    !e.altKey &&
                    !e.ctrlKey &&
                    !e.metaKey &&
                    ((e.key === "ArrowLeft" && !e.shiftKey && searchQuery.length === 0) ||
                      (e.key === "Tab" && e.shiftKey))
                  ) {
                    const sidebar = e.currentTarget
                      .closest("[data-model-picker-content]")
                      ?.querySelector("[data-model-picker-sidebar]");
                    const button =
                      sidebar?.querySelector<HTMLButtonElement>(
                        'button[aria-pressed="true"]:not(:disabled)',
                      ) ?? sidebar?.querySelector<HTMLButtonElement>("button:not(:disabled)");
                    if (button) {
                      e.preventDefault();
                      e.stopPropagation();
                      button.focus();
                      return;
                    }
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    props.onRequestClose?.();
                    return;
                  }
                  if (e.key === "Enter" && highlightedModelKeyRef.current) {
                    (
                      e as typeof e & { preventBaseUIHandler?: () => void }
                    ).preventBaseUIHandler?.();
                    e.preventDefault();
                    e.stopPropagation();
                    const legacyInstanceId = parseModelPickerLegacySectionKey(
                      highlightedModelKeyRef.current,
                    );
                    if (legacyInstanceId) {
                      toggleLegacySection(legacyInstanceId);
                      return;
                    }
                    if (parseModelSourceSectionKey(highlightedModelKeyRef.current)) {
                      toggleModelSourceSection(highlightedModelKeyRef.current);
                      return;
                    }
                    const model = parseModelPickerModelKey(highlightedModelKeyRef.current);
                    if (model) {
                      handleModelSelect(model.slug, model.instanceId, e.shiftKey);
                    }
                    return;
                  }
                  e.stopPropagation();
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
              />
            ) : null}

            {/* Scient: setup has intrinsic height independent of the model catalog. */}
            {selectedSetupEntry && props.renderProviderSetup ? (
              <div
                className="min-h-0 flex-auto overflow-y-auto overscroll-y-contain bg-muted/40"
                data-model-picker-setup="true"
              >
                {props.renderProviderSetup(selectedSetupEntry)}
              </div>
            ) : (
              <ModelPickerList
                listRef={modelListRef}
                itemKeys={filteredItemKeys}
                extraData={modelListExtraData}
                renderItem={({ item: modelKey, index }) => {
                  if (legacySection?.key === modelKey) {
                    return (
                      <ComboboxItem
                        hideIndicator
                        index={index}
                        value={modelKey}
                        aria-expanded={legacySection.isExpanded}
                        className="group w-full cursor-pointer"
                      >
                        <ModelListDisclosureContent
                          label={droidGroups ? "More models" : "Legacy models"}
                          count={legacySection.legacyModels.length}
                          expanded={legacySection.isExpanded}
                        />
                      </ComboboxItem>
                    );
                  }
                  const sourceSection = sourceSectionRows?.sections.get(modelKey);
                  if (sourceSection) {
                    return (
                      <ComboboxItem
                        hideIndicator
                        index={index}
                        value={modelKey}
                        aria-expanded={sourceSection.expanded}
                        className="group w-full cursor-pointer"
                      >
                        <ModelListDisclosureContent
                          label={modelSourceSectionLabel(
                            sourceSection.section,
                            selectedEntry?.displayName ?? "provider",
                          )}
                          count={sourceSection.count}
                          expanded={sourceSection.expanded}
                        />
                      </ComboboxItem>
                    );
                  }
                  const model = filteredModelByKey.get(modelKey);
                  if (!model) {
                    return null;
                  }
                  const disabledReason =
                    getModelDisabledReason?.(model.instanceId, model.slug) ?? null;
                  return (
                    <div>
                      {droidGroups?.custom[0] === model ? (
                        <div className="px-2 pt-3 pb-1 text-[11px] text-muted-foreground">
                          Custom models
                        </div>
                      ) : null}
                      <ModelListRow
                        key={modelKey}
                        index={index}
                        slug={model.slug}
                        providerCostLabel={model.providerCostLabel}
                        name={model.name}
                        shortName={model.shortName}
                        subProvider={model.subProvider}
                        instanceId={model.instanceId}
                        driverKind={model.driverKind}
                        providerDisplayName={model.instanceDisplayName}
                        providerAccentColor={model.instanceAccentColor}
                        acpRegistryAgentId={model.acpRegistryAgentId}
                        acpRegistryIconUrl={model.acpRegistryIconUrl}
                        isFavorite={favoritesSet.has(
                          providerModelKey(model.instanceId, model.slug),
                        )}
                        isSelected={
                          selectedModelKeys !== undefined
                            ? selectedModelKeySet.has(modelKey)
                            : modelKey === activeModelKey
                        }
                        showSelection={selectedModelKeys !== undefined}
                        showProvider
                        preferShortName={!isLocked}
                        useTriggerLabel={false}
                        showNewBadge={model.badge === "new"}
                        unavailable={model.isUnavailable === true}
                        jumpLabel={modelJumpLabelByKey.get(modelKey) ?? null}
                        disabledReason={disabledReason}
                        onToggleFavorite={toggleFavorite}
                      />
                    </div>
                  );
                }}
              />
            )}
            <ComboboxEmpty
              size="compact"
              className={cn("empty:h-0", selectedSetupEntry && "hidden")}
            >
              No models found
            </ComboboxEmpty>
            {selectedFooterEntry && props.renderProviderFooter
              ? props.renderProviderFooter(selectedFooterEntry)
              : null}
            {props.onContinueInNewChat ? (
              <ModelPickerNewChatFooter
                disabled={props.continueInNewChatDisabled ?? false}
                onFork={handleContinueInNewChat}
              />
            ) : null}
            <ModelPickerProviderNotices
              setupEntries={selectedSetupEntry ? [] : providerSetupEntries}
              updateRequiredNotices={updateRequiredNotices}
              onRequestClose={props.onRequestClose}
              onOpenProviderSetup={props.onOpenProviderSetup}
            />
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
});
