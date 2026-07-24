import { type AutomationDefinition, type AutomationRun } from "@synara/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { getProviderStartOptions, useAppSettings } from "~/appSettings";
import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "~/components/chat/chatHeaderControls";
import { CHAT_BACKGROUND_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { AutomationListRow } from "~/components/AutomationListRow";
import { Button } from "~/components/ui/button";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import {
  hasBlockingAutomationDraftWarnings,
  type AutomationDraftWarning,
  type AutomationDraftWarningId,
} from "~/lib/automationDraft";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import {
  type AutomationFormState,
  AutomationDialog,
  acknowledgedRiskIdsForFormWarnings,
  allVisibleTriageRuns,
  automationRowMeta,
  automationStatusDotClass,
  buildAutomationFormWarnings,
  createInputFromForm,
  formatRelativeTime,
  formFromDefinition,
  isFormSubmittable,
  providerOptionsForAutomationEdit,
  projectModelSelection,
  runResultSummary,
  RunStatusIndicator,
  updateInputFromForm,
  unresolvedTriageRuns,
  useAutomations,
} from "./-automations.shared";
import { resolveThreadPickerTitle } from "./-chatThreadRoute.logic";

export const Route = createFileRoute("/_chat/automations/")({
  component: AutomationsRouteView,
});

function AutomationsRouteView() {
  const navigate = useNavigate();
  const { settings } = useAppSettings();
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const projects = useStore((state) => state.projects);
  const threads = useStore((state) => state.threads);
  const [editingDefinition, setEditingDefinition] = useState<AutomationDefinition | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogWarnings, setDialogWarnings] = useState<readonly AutomationDraftWarning[]>([]);
  const [acknowledgedWarningIds, setAcknowledgedWarningIds] = useState<
    ReadonlySet<AutomationDraftWarningId>
  >(() => new Set());
  const [triageFilter, setTriageFilter] = useState<"unread" | "all">("unread");
  const [deleteErrors, setDeleteErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const fallbackProjectId = projects[0]?.id ?? "";
  const [form, setForm] = useState<AutomationFormState>(() =>
    formFromDefinition(null, fallbackProjectId, projectModelSelection(projects, fallbackProjectId)),
  );

  const {
    data,
    isLoading,
    isFetching,
    error: automationsError,
    refetch,
    createMutation,
    updateMutation,
    deleteMutation,
    runsByAutomationId,
  } = useAutomations((threadId) => void navigate({ to: "/$threadId", params: { threadId } }));
  const providerOptionsForDispatch = useMemo(() => getProviderStartOptions(settings), [settings]);

  const updateDialogForm = (nextForm: AutomationFormState) => {
    setForm(nextForm);
    setDialogWarnings(buildAutomationFormWarnings(nextForm));
  };

  const toggleWarning = (id: AutomationDraftWarningId, checked: boolean) => {
    setAcknowledgedWarningIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const openCreateDialog = () => {
    if (createMutation.isPending || updateMutation.isPending) return;
    createMutation.reset();
    updateMutation.reset();
    setEditingDefinition(null);
    const nextForm = formFromDefinition(
      null,
      fallbackProjectId,
      projectModelSelection(projects, fallbackProjectId),
    );
    setForm(nextForm);
    setDialogWarnings(buildAutomationFormWarnings(nextForm));
    setAcknowledgedWarningIds(new Set());
    setDialogOpen(true);
  };

  const submitForm = () => {
    if (createMutation.isPending || updateMutation.isPending) return;
    if (!isFormSubmittable(form)) return;
    if (hasBlockingAutomationDraftWarnings(dialogWarnings, acknowledgedWarningIds)) return;
    const acknowledgedRisks = acknowledgedRiskIdsForFormWarnings(
      dialogWarnings,
      acknowledgedWarningIds,
    );
    const closeOnSuccess = { onSuccess: () => setDialogOpen(false) };
    if (editingDefinition) {
      updateMutation.mutate(
        updateInputFromForm(
          editingDefinition,
          form,
          providerOptionsForAutomationEdit(editingDefinition, form, providerOptionsForDispatch),
          acknowledgedRisks,
        ),
        closeOnSuccess,
      );
      return;
    }
    createMutation.mutate(
      createInputFromForm(form, providerOptionsForDispatch, acknowledgedRisks),
      closeOnSuccess,
    );
  };

  const deleteDefinition = async (definition: AutomationDefinition) => {
    if (deleteMutation.isPending) return;
    const confirmed = await ensureNativeApi().dialogs.confirm(`Delete "${definition.name}"?`);
    if (!confirmed) return;
    setDeleteErrors((current) => {
      if (!current.has(definition.id)) return current;
      const next = new Map(current);
      next.delete(definition.id);
      return next;
    });
    deleteMutation.mutate(definition, {
      onError: (error) => {
        setDeleteErrors((current) =>
          new Map(current).set(
            definition.id,
            error instanceof Error ? error.message : "The automation could not be deleted.",
          ),
        );
      },
    });
  };

  const dialogMutation = editingDefinition ? updateMutation : createMutation;
  const dialogError = dialogMutation.isError
    ? dialogMutation.error instanceof Error
      ? dialogMutation.error.message
      : "The automation could not be saved."
    : null;
  const listError = automationsError instanceof Error ? automationsError.message : null;

  const active = data.definitions.filter((definition) => definition.enabled);
  const inactive = data.definitions.filter((definition) => !definition.enabled);
  const allTriageRuns = allVisibleTriageRuns(data.runs);
  const triageRuns = triageFilter === "unread" ? unresolvedTriageRuns(data.runs) : allTriageRuns;
  const unreadTriageCount = unresolvedTriageRuns(data.runs).length;

  const projectName = (definition: AutomationDefinition) =>
    projects.find((project) => project.id === definition.projectId)?.name ?? "Unknown project";

  const sourceSuffix = (definition: AutomationDefinition) => {
    if (!definition.sourceThreadId || definition.sourceThreadId === definition.targetThreadId) {
      return "";
    }
    const sourceThread = threads.find((candidate) => candidate.id === definition.sourceThreadId);
    return sourceThread ? ` · From ${resolveThreadPickerTitle(sourceThread.title)}` : "";
  };

  const subtitle = (definition: AutomationDefinition) => {
    const suffix = sourceSuffix(definition);
    if (definition.mode === "heartbeat") {
      const thread = threads.find((candidate) => candidate.id === definition.targetThreadId);
      const target = thread ? resolveThreadPickerTitle(thread.title) : projectName(definition);
      return `Heartbeat · ${target}${suffix}`;
    }
    return `${projectName(definition)}${suffix}`;
  };

  const renderRow = (definition: AutomationDefinition) => {
    const latestRun: AutomationRun | null = runsByAutomationId.get(definition.id)?.[0] ?? null;
    return (
      <AutomationListRow
        key={definition.id}
        onClick={() =>
          void navigate({
            to: "/automations/$automationId",
            params: { automationId: definition.id },
          })
        }
        leading={
          <span
            className={cn(
              "flex size-3.5 shrink-0 items-center justify-center",
              automationStatusDotClass(definition, latestRun),
            )}
          >
            <span className="block size-1.5 rounded-full bg-current" />
          </span>
        }
        title={definition.name}
        detail={subtitle(definition)}
        meta={automationRowMeta(definition, latestRun)}
        onDelete={() => void deleteDefinition(definition)}
        deleteDisabled={deleteMutation.isPending}
        error={
          deleteErrors.has(definition.id)
            ? `Could not delete: ${deleteErrors.get(definition.id)}`
            : undefined
        }
      />
    );
  };

  const renderSection = (title: string, defs: readonly AutomationDefinition[]) =>
    defs.length > 0 ? (
      <section className="flex flex-col gap-0.5">
        <h2 className="px-2 pb-1 text-sm font-medium text-foreground">{title}</h2>
        <div className="flex flex-col">{defs.map(renderRow)}</div>
      </section>
    ) : null;

  const renderTriageRow = (run: AutomationRun) => {
    const definition = data.definitions.find((entry) => entry.id === run.automationId);
    const summary = runResultSummary(run);
    const target = definition ? subtitle(definition) : "Saved run";
    return (
      <AutomationListRow
        key={run.id}
        // A run row opens its automation; the run's thread is opened from inside the
        // automation detail's "Previous runs" sidebar (orphan runs fall back to the thread).
        onClick={() =>
          definition
            ? void navigate({
                to: "/automations/$automationId",
                params: { automationId: definition.id },
              })
            : run.threadId
              ? void navigate({ to: "/$threadId", params: { threadId: run.threadId } })
              : undefined
        }
        leading={<RunStatusIndicator status={run.status} />}
        title={definition?.name ?? "Automation run"}
        detail={summary || target}
        meta={formatRelativeTime(run.finishedAt ?? run.startedAt ?? run.scheduledFor)}
        trailing={
          <CentralIcon
            name="chevron-right-small"
            className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          />
        }
      />
    );
  };

  const renderTriage = () =>
    allTriageRuns.length > 0 ? (
      <section className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between gap-3 px-2 pb-1">
          <h2 className="text-sm font-medium text-foreground">Needs review</h2>
          <div className="flex items-center gap-0.5 rounded-md bg-[var(--color-background-elevated-secondary)] p-0.5 text-xs">
            {(["unread", "all"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTriageFilter(value)}
                className={cn(
                  "rounded px-2 py-0.5 transition-colors",
                  triageFilter === value
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value === "unread" ? `Unread ${unreadTriageCount}` : `All ${allTriageRuns.length}`}
              </button>
            ))}
          </div>
        </div>
        {triageRuns.length === 0 ? (
          <div className="px-2 py-4 text-xs text-muted-foreground">No unread runs.</div>
        ) : (
          <div className="flex flex-col">{triageRuns.map(renderTriageRow)}</div>
        )}
      </section>
    ) : null;

  return (
    <RouteInsetSurface>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          CHAT_BACKGROUND_CLASS_NAME,
        )}
      >
        <header
          className={cn(
            CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
            CHAT_SURFACE_HEADER_PADDING_X_CLASS,
            "drag-region",
            desktopTopBarTrafficLightGutterClassName,
            desktopTopBarWindowControlsGutterClassName,
          )}
        >
          <div className={cn("flex items-center gap-2 sm:gap-3", CHAT_SURFACE_HEADER_HEIGHT_CLASS)}>
            <SidebarHeaderNavigationControls />
            <div className="min-w-0 flex-1" />
            <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh"
                title="Refresh"
                disabled={isFetching}
                onClick={() => void refetch()}
              >
                <CentralIcon
                  name="arrow-rotate-clockwise"
                  className={cn("size-4", isFetching && "animate-spin")}
                />
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={openCreateDialog}
                disabled={
                  projects.length === 0 || createMutation.isPending || updateMutation.isPending
                }
              >
                <CentralIcon name="plus-small" className="size-4" />
                New automation
              </Button>
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-12 pt-8">
            <h1 className="px-2 font-heading text-2xl font-semibold tracking-tight text-foreground">
              Automations
            </h1>
            {listError && data.definitions.length > 0 ? (
              <div
                role="alert"
                className="mx-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
              >
                Could not load automations: {listError}
              </div>
            ) : null}
            {isLoading ? (
              <div className="py-16 text-center text-sm text-muted-foreground">
                Loading automations...
              </div>
            ) : listError && data.definitions.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <p role="alert" className="max-w-md text-sm text-destructive">
                  Could not load automations: {listError}
                </p>
                <Button type="button" size="sm" variant="outline" onClick={() => void refetch()}>
                  Try again
                </Button>
              </div>
            ) : data.definitions.length === 0 ? (
              <div className="flex flex-col items-center gap-1 py-16 text-center">
                <p className="text-sm font-medium text-foreground">No automations yet</p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  Schedule a prompt to run on its own, or wake an existing thread on a loop.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {renderTriage()}
                {renderSection("Current", active)}
                {renderSection("Paused", inactive)}
              </div>
            )}
          </div>
        </main>
      </div>

      <AutomationDialog
        open={dialogOpen}
        editing={editingDefinition !== null}
        form={form}
        projects={projects}
        threads={threads}
        warnings={dialogWarnings}
        acknowledgedWarningIds={acknowledgedWarningIds}
        onToggleWarning={toggleWarning}
        onOpenChange={(open) => {
          if (dialogMutation.isPending) return;
          setDialogOpen(open);
          if (!open) dialogMutation.reset();
        }}
        onFormChange={(nextForm) => {
          if (dialogMutation.isPending) return;
          dialogMutation.reset();
          updateDialogForm(nextForm);
        }}
        onSubmit={submitForm}
        busy={createMutation.isPending || updateMutation.isPending}
        error={dialogError ? `Could not save automation: ${dialogError}` : null}
      />
    </RouteInsetSurface>
  );
}
