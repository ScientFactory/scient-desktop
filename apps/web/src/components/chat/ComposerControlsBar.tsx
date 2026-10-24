import type { ChatComposerProps } from "./ChatComposer";
import type { PromptUltrathink } from "@t3tools/client-runtime/model-traits";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { type AppModelOption } from "../../modelSelection";
import { CircleAlertIcon } from "lucide-react";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerControl, ComposerControlSeparator } from "./ComposerControl";
import {
  ComposerFooterModeControls,
  ComposerModelPicker,
  type RuntimeModeOption,
} from "./ComposerFooterControls";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import {
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderState";
import type { useComposerProviderModel } from "./useComposerProviderModel";
import type { ComponentProps } from "react";

/**
 * The composer footer controls: model picker, traits, mode controls and the overflow menu for
 * blocks that do not fit. Rendered in the expanded footer or the resting controls host.
 */
export function ComposerControlsBar(props: {
  voiceBusy: boolean;
  modelPickerOverrides: Pick<
    ComponentProps<typeof ComposerModelPicker>,
    | "isProviderSetupAvailable"
    | "renderProviderSetup"
    | "renderProviderFooter"
    | "onContinueInNewChat"
    | "continueInNewChatDisabled"
    | "statusLabel"
    | "triggerAriaLabel"
  >;
  supportedRuntimeModes: ComponentProps<typeof ComposerFooterModeControls>["supportedRuntimeModes"];
  environmentId: EnvironmentId;
  routeKind: ChatComposerProps["routeKind"];
  routeThreadRef: ChatComposerProps["routeThreadRef"];
  draftId: ChatComposerProps["draftId"];
  selectedProvider: ProviderDriverKind;
  selectedInstanceId: ProviderInstanceId;
  selectedModel: string;
  selectedProviderModels: ServerProvider["models"];
  composerModelOptions: ReturnType<typeof useComposerProviderModel>["composerModelOptions"];
  reportedModelSelection: ChatComposerProps["reportedModelSelection"];
  promptUltrathink: PromptUltrathink;
  onPromptEdit: (edit: (prompt: string) => string) => void;
  planModeEnabled: boolean;
  planModeUiEnabled: boolean;
  interactionMode: ProviderInteractionMode;
  compatibleRuntimeMode: RuntimeMode;
  compatibleRuntimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  toggleInteractionMode: () => void;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  composerControlsCollapsed: boolean;
  composerControlsHidden: boolean;
  restingHiddenBlockCount: number;
  iconOnlyBlockCount: number;
  showInlineRestingControls: boolean;
  showLeadingSeparator: boolean;
  showProviderUnavailable: boolean;
  providerSetupInstanceId: ProviderInstanceId | undefined;
  onOpenProviderSetup: ChatComposerProps["onOpenProviderSetup"];
  providerCatalogPending: boolean;
  isSendBusy: boolean;
  multipleModelsEnabled: boolean;
  multipleModelSelections: ChatComposerProps["multipleModelSelections"];
  onMultipleModelSelectionsChange: ChatComposerProps["onMultipleModelSelectionsChange"];
  selectedModelSelection: ModelSelection;
  onProviderModelSelect: ChatComposerProps["onProviderModelSelect"];
  activeThreadModelSelection: ChatComposerProps["activeThreadModelSelection"];
  selectedModelForPickerWithCustomFallback: string;
  lockedProvider: ChatComposerProps["lockedProvider"];
  lockedContinuationGroupKey: string | null;
  providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings: ChatComposerProps["keybindings"];
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  terminalOpen: boolean;
  modelPickerOpen: boolean;
  onModelPickerOpenChange: (open: boolean) => void;
  modelPickerIconClassName: string | undefined;
  getModelDisabledReason: ChatComposerProps["getModelDisabledReason"];
}) {
  const {
    environmentId,
    routeKind,
    routeThreadRef,
    draftId,
    selectedProvider,
    selectedInstanceId,
    selectedModel,
    selectedProviderModels,
    composerModelOptions,
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
    planModeEnabled,
    planModeUiEnabled,
    interactionMode,
    compatibleRuntimeMode,
    compatibleRuntimeModeOptions,
    toggleInteractionMode,
    handleRuntimeModeChange,
    composerControlsCollapsed,
    composerControlsHidden,
    restingHiddenBlockCount,
    iconOnlyBlockCount,
    showInlineRestingControls,
    showLeadingSeparator,
    showProviderUnavailable,
    providerSetupInstanceId,
    onOpenProviderSetup,
    providerCatalogPending,
    isSendBusy,
    multipleModelsEnabled,
    multipleModelSelections,
    onMultipleModelSelectionsChange,
    selectedModelSelection,
    onProviderModelSelect,
    activeThreadModelSelection,
    selectedModelForPickerWithCustomFallback,
    lockedProvider,
    lockedContinuationGroupKey,
    providerInstanceEntries,
    keybindings,
    modelOptionsByInstance,
    terminalOpen,
    modelPickerOpen,
    onModelPickerOpenChange,
    modelPickerIconClassName,
    getModelDisabledReason,
  } = props;
  // SCIENT-FORK:START — native trait variants share the model picker's visibility policy.
  const traitModels =
    selectedProvider === "antigravity"
      ? selectedProviderModels.filter((model) =>
          (modelOptionsByInstance.get(selectedInstanceId) ?? []).some(
            (option) => option.slug === model.slug,
          ),
        )
      : selectedProviderModels;
  // SCIENT-FORK:END
  const providerTraitsMenuContent = renderProviderTraitsMenuContent({
    onNativeModelChange: (model) => onProviderModelSelect(selectedInstanceId, model),
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: traitModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
    planModeEnabled,
  });
  const providerTraitsPickerInput = {
    onNativeModelChange: (model: string) => onProviderModelSelect(selectedInstanceId, model),
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: traitModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
    planModeEnabled,
    isComposerOwned: true,
  } satisfies Parameters<typeof renderProviderTraitsPicker>[0];
  const providerTraitsPicker = renderProviderTraitsPicker(providerTraitsPickerInput);
  const restingProviderTraitsPicker = renderProviderTraitsPicker({
    ...providerTraitsPickerInput,
    size: composerControlsCollapsed ? "xs" : "sm",
    hidden: composerControlsHidden || restingHiddenBlockCount > 1,
  });
  const restingBlockDefs = [
    ...(providerTraitsPicker
      ? [
          {
            id: "traits",
            content: (
              <>
                <ComposerControlSeparator size={composerControlsCollapsed ? "xs" : "sm"} />
                {restingProviderTraitsPicker}
              </>
            ),
          },
        ]
      : []),
    {
      id: "mode",
      content: (
        <ComposerFooterModeControls
          supportedRuntimeModes={props.supportedRuntimeModes}
          showInteractionModeToggle={planModeUiEnabled}
          interactionMode={interactionMode}
          runtimeMode={compatibleRuntimeMode}
          runtimeModeOptions={compatibleRuntimeModeOptions}
          size={composerControlsCollapsed ? "xs" : "sm"}
          hidden={composerControlsHidden || restingHiddenBlockCount > 0}
          onToggleInteractionMode={toggleInteractionMode}
          onRuntimeModeChange={handleRuntimeModeChange}
        />
      ),
    },
  ];
  const hiddenRestingBlockIds = restingBlockDefs
    .slice(restingBlockDefs.length - restingHiddenBlockCount)
    .map((def) => def.id);
  // Its own element, so typing (which rebuilds the controls around it) leaves it cached.
  const composerModelPicker = (
    <ComposerModelPicker
      environmentId={environmentId}
      compact={false}
      iconOnly={props.voiceBusy}
      isComposerOwned
      disabled={props.voiceBusy || providerCatalogPending || isSendBusy}
      multipleModelsEnabled={multipleModelsEnabled}
      multipleModelSelections={multipleModelSelections}
      onMultipleModelSelectionsChange={onMultipleModelSelectionsChange}
      selectedModelSelection={selectedModelSelection}
      onProviderModelSelect={onProviderModelSelect}
      activeInstanceId={
        providerCatalogPending
          ? (activeThreadModelSelection?.instanceId ?? selectedInstanceId)
          : selectedInstanceId
      }
      model={
        providerCatalogPending
          ? (activeThreadModelSelection?.model ?? selectedModelForPickerWithCustomFallback)
          : selectedModelForPickerWithCustomFallback
      }
      lockedProvider={lockedProvider}
      lockedContinuationGroupKey={lockedContinuationGroupKey}
      instanceEntries={providerInstanceEntries}
      keybindings={keybindings}
      modelOptionsByInstance={modelOptionsByInstance}
      size={composerControlsCollapsed ? "xs" : "sm"}
      triggerClassName={
        props.voiceBusy
          ? "-ms-2.5"
          : composerControlsCollapsed
            ? cn(
                "min-w-13 shrink text-xs!",
                !showInlineRestingControls &&
                  "@max-[640px]/composer-surface:[&_[data-chat-provider-model-picker-label]]:w-0 @max-[640px]/composer-surface:[&_[data-chat-provider-model-picker-label]]:flex-none",
              )
            : "-ms-2.5 min-w-13"
      }
      terminalOpen={terminalOpen}
      open={modelPickerOpen}
      instanceIndicatorBackground={
        composerControlsCollapsed
          ? "color-mix(in srgb, var(--chat-composer-glass-surface) var(--glass-opacity), transparent)"
          : "var(--contrast-input)"
      }
      {...(modelPickerIconClassName || composerControlsCollapsed
        ? {
            activeProviderIconClassName: cn(
              modelPickerIconClassName,
              composerControlsCollapsed &&
                "fill-muted-foreground/70! text-muted-foreground/70! [&_path]:fill-muted-foreground/70! [&_rect]:fill-muted-foreground/70! [&_[data-icon-detail]]:fill-transparent! [&[data-provider-package-icon]]:opacity-70 [&[data-provider-package-icon]_path:not([data-icon-detail])]:fill-muted-foreground!",
            ),
          }
        : {})}
      onOpenChange={onModelPickerOpenChange}
      getModelDisabledReason={getModelDisabledReason}
      onOpenProviderSetup={onOpenProviderSetup}
      {...props.modelPickerOverrides}
    />
  );
  return showProviderUnavailable ? (
    <ComposerControl
      type="button"
      disabled={!providerSetupInstanceId}
      onClick={() => {
        if (providerSetupInstanceId) {
          onOpenProviderSetup(providerSetupInstanceId);
        }
      }}
      data-chat-provider-unavailable="true"
      className="shrink-0"
    >
      <CircleAlertIcon className="size-4" />
      {providerSetupInstanceId ? "Open provider settings" : "No provider available"}
    </ComposerControl>
  ) : (
    <>
      {showLeadingSeparator ? (
        <ComposerControlSeparator
          size="xs"
          className="@max-[400px]/composer-surface:hidden"
          data-resting-controls-separator="true"
        />
      ) : null}
      {composerModelPicker}

      <>
        {restingBlockDefs.map((def, index) => {
          const hidden =
            props.voiceBusy || index >= restingBlockDefs.length - restingHiddenBlockCount;
          return (
            <div
              key={def.id}
              data-resting-block={def.id}
              data-composer-block-icon-only={
                index >= restingBlockDefs.length - iconOnlyBlockCount ? "true" : "false"
              }
              aria-hidden={hidden || undefined}
              inert={hidden || undefined}
              className={cn(
                "flex w-max min-w-max shrink-0 items-center gap-1",
                hidden && "pointer-events-none invisible absolute",
                index >= restingBlockDefs.length - iconOnlyBlockCount &&
                  "[&_[data-composer-control-label]]:pointer-events-none [&_[data-composer-control-label]]:invisible [&_[data-composer-control-label]]:absolute [&_[data-composer-control-label]]:w-max [&_[data-composer-control-label]]:max-w-none [&_[data-composer-control-compact-icon]]:[visibility:inherit] [&_[data-composer-control-compact-icon]]:relative",
              )}
            >
              {def.content}
            </div>
          );
        })}
        <div
          data-resting-controls-overflow
          aria-hidden={props.voiceBusy || hiddenRestingBlockIds.length === 0 || undefined}
          inert={props.voiceBusy || hiddenRestingBlockIds.length === 0 || undefined}
          className={cn(
            "min-w-0 shrink-0",
            (props.voiceBusy || hiddenRestingBlockIds.length === 0) &&
              "pointer-events-none invisible absolute",
          )}
        >
          <CompactComposerControlsMenu
            interactionMode={interactionMode}
            runtimeMode={compatibleRuntimeMode}
            runtimeModeOptions={compatibleRuntimeModeOptions}
            size={composerControlsCollapsed ? "xs" : "sm"}
            hidden={composerControlsHidden || hiddenRestingBlockIds.length === 0}
            showInteractionModeToggle={planModeUiEnabled && hiddenRestingBlockIds.includes("mode")}
            traitsMenuContent={
              hiddenRestingBlockIds.includes("traits") ? providerTraitsMenuContent : undefined
            }
            onToggleInteractionMode={toggleInteractionMode}
            onRuntimeModeChange={handleRuntimeModeChange}
          />
        </div>
      </>
    </>
  );
}
