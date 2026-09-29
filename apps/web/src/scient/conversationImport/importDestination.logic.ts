import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationProjectShell,
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
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";

/**
 * Where an import goes and what continues it: the project (the one in view
 * by default) and the model a new chat there would open on.
 */

type ImportProject = Pick<OrchestrationProjectShell, "id"> & LegacyProjectSettingsFields;

/**
 * The model a new chat in `project` starts with. It follows the new-thread
 * flow: the project's default (else the environment's) becomes the new
 * draft's selection, and the composer's own resolution picks the instance
 * and model from it, falling back as a new chat would. Null only when no
 * provider can run a chat here.
 */
export function newChatModelSelection(input: {
  readonly config: ServerConfig | undefined;
  readonly settings: UnifiedSettings;
  readonly project: ImportProject | null;
}): ModelSelection | null {
  const { config, settings, project } = input;
  if (config === undefined || project === null) return null;
  const projectDefault =
    resolveProjectSettings(settings, project.id, project).settings.defaultModelSelection ?? null;
  const override = resolveNewThreadModelSelectionOverride({
    projectDefaultSelection: projectDefault,
    carrySelection: null,
    carrySourceDraftId: null,
    destinationDraftId: "",
  });
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(config.providers), settings),
  );
  const { selectedProviderEntry } = resolveComposerProviderSelection({
    entries,
    candidateInstanceIds: [override?.instanceId, projectDefault?.instanceId],
    lockedProvider: null,
    lockedInstanceId: null,
  });
  if (selectedProviderEntry === undefined) return null;
  const { selectedModel } = deriveEffectiveComposerModelState({
    draft:
      override === null
        ? null
        : {
            activeProvider: override.instanceId,
            modelSelectionByProvider: { [override.instanceId]: override },
          },
    providers: config.providers,
    selectedProvider: selectedProviderEntry.driverKind,
    selectedInstanceId: selectedProviderEntry.instanceId,
    threadModelSelection: null,
    projectModelSelection: projectDefault,
    settings,
  });
  if (!selectedModel) return null;
  return override?.instanceId === selectedProviderEntry.instanceId &&
    override.model === selectedModel
    ? override
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
