import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationProjectShell,
  ProviderInstanceId,
  ServerConfig,
  UnifiedSettings,
} from "@t3tools/contracts";
import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";

import { resolveComposerProviderSelection } from "../../components/ChatView.logic";
import { deriveEffectiveComposerModelState } from "../../composerDraftStore";
import { resolveNewThreadModelSelectionOverride } from "../../lib/chatThreadActions";
import { sortThreads, type ThreadSortInput } from "../../lib/threadSort";
import {
  NO_PROVIDER_MODEL_SELECTION,
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";

/**
 * Where an import goes and what continues it: the project (the one in view
 * by default) and the model a new chat there would open on.
 */

type ImportProject = Pick<OrchestrationProjectShell, "id"> & LegacyProjectSettingsFields;

/** The composer's remembered model choices, which every new draft starts from. */
export interface StickyModelSelection {
  readonly modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  readonly activeProvider: ProviderInstanceId | null;
}

/**
 * The model a new chat in `project` opens on, following the new-thread flow
 * step by step: the new draft takes the sticky selection, then the
 * new-thread override (the project's default, else the environment's, else
 * what the chat in view carries); the composer's own resolution then picks
 * the instance and model as it does for that draft. Null only when no
 * provider can run a chat here.
 */
export function newChatModelSelection(input: {
  readonly config: ServerConfig | undefined;
  readonly settings: UnifiedSettings;
  readonly project: ImportProject | null;
  /** What a new thread carries from the chat in view (`readCarriedModelSelection`). */
  readonly carrySelection: ModelSelection | null;
  readonly sticky: StickyModelSelection;
}): ModelSelection | null {
  const { config, settings, project, sticky } = input;
  if (config === undefined || project === null) return null;
  const projectDefault =
    resolveProjectSettings(settings, project.id, project).settings.defaultModelSelection ?? null;
  const override = resolveNewThreadModelSelectionOverride({
    projectDefaultSelection: projectDefault,
    carrySelection: input.carrySelection,
    // The import's thread is always new, never the draft in view.
    carrySourceDraftId: null,
    destinationDraftId: "",
  });
  // `applyStickyState`, then `setModelSelection` with the override.
  const draft = {
    modelSelectionByProvider:
      override === null
        ? sticky.modelSelectionByProvider
        : { ...sticky.modelSelectionByProvider, [override.instanceId]: override },
    activeProvider: override?.instanceId ?? sticky.activeProvider,
  };
  // A draft thread's own selection, as the chat view builds it.
  const threadModelSelection = projectDefault ?? NO_PROVIDER_MODEL_SELECTION;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(config.providers), settings),
  );
  const { selectedProviderEntry } = resolveComposerProviderSelection({
    entries,
    candidateInstanceIds: [
      draft.activeProvider,
      threadModelSelection.instanceId,
      projectDefault?.instanceId,
    ],
    lockedProvider: null,
    lockedInstanceId: null,
  });
  if (selectedProviderEntry === undefined) return null;
  const { selectedModel } = deriveEffectiveComposerModelState({
    draft,
    providers: config.providers,
    selectedProvider: selectedProviderEntry.driverKind,
    selectedInstanceId: selectedProviderEntry.instanceId,
    threadModelSelection,
    projectModelSelection: projectDefault,
    settings,
  });
  if (!selectedModel) return null;
  const drafted = draft.modelSelectionByProvider[selectedProviderEntry.instanceId];
  return drafted?.model === selectedModel
    ? drafted
    : { instanceId: selectedProviderEntry.instanceId, model: selectedModel };
}

/** A project, identified in the environment that holds it. */
export interface ImportProjectRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
}

/**
 * The project an import goes to unless the person picks another: the one in
 * view, else the one with the most recently active conversation, else the
 * first listed. Only projects in `available` qualify.
 */
export function defaultImportProject<
  P extends { readonly id: string; readonly environmentId: EnvironmentId },
>(input: {
  readonly available: ReadonlyArray<P>;
  readonly current: ImportProjectRef | null;
  readonly threads: ReadonlyArray<
    ThreadSortInput & {
      readonly id: string;
      readonly environmentId: EnvironmentId;
      readonly projectId: string | null;
      readonly archivedAt?: string | null;
    }
  >;
}): P | null {
  const find = (ref: ImportProjectRef | null) =>
    ref === null
      ? undefined
      : input.available.find(
          (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
        );
  const recent = sortThreads(
    input.threads.filter((thread) => thread.projectId !== null && !thread.archivedAt),
    "updated_at",
  )
    .map((thread) => find({ environmentId: thread.environmentId, projectId: thread.projectId! }))
    .find((project) => project !== undefined);
  return find(input.current) ?? recent ?? input.available[0] ?? null;
}
