import { type ProjectId, ThreadId } from "@synara/contracts";
import { getRecommendedDefaultModelSelection } from "@synara/shared/model";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { startTransition, useCallback } from "react";
import { useAppSettings } from "../appSettings";
import { clearNewThreadLanding, markNewThreadLanding } from "../lib/newThreadLanding";
import {
  type ComposerThreadDraftState,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import {
  buildDraftThreadWorkspacePatch,
  createActiveDraftThreadSnapshot,
  createActiveThreadSnapshot,
  createFreshDraftThreadSeed,
  resolveTerminalThreadCreationState,
  resolveThreadBootstrapPlan,
  type NewThreadOptions,
} from "../lib/threadBootstrap";
import { promoteThreadCreate } from "../lib/threadCreatePromotion";
import {
  draftNavigationSlotKey,
  runDraftNavigationOnce,
  stageDraftNavigation,
} from "../lib/stagedDraftNavigation";
import { newCommandId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useFocusedChatContext } from "../focusedChatContext";
import { useStore } from "../store";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useTerminalStateStore } from "../terminalStateStore";

export interface NewThreadNavigationOptions {
  /**
   * Search params applied when the hook navigates to the created thread.
   * Lets callers keep view-level state (e.g. the editor workspace view)
   * across the route change; default navigation clears all search params.
   */
  search?: (previous: Record<string, unknown>) => Record<string, unknown>;
}

export function useHandleNewThread() {
  const projects = useStore((store) => store.projects);
  const { settings } = useAppSettings();
  const navigate = useNavigate();
  const router = useRouter();
  const { activeDraftThread, activeProjectId, activeThread, focusedThreadId, routeThreadId } =
    useFocusedChatContext();
  const openChatThreadPage = useTerminalStateStore((store) => store.openChatThreadPage);
  const openTerminalThreadPage = useTerminalStateStore((store) => store.openTerminalThreadPage);
  const clearTerminalState = useTerminalStateStore((store) => store.clearTerminalState);
  const markTemporaryThread = useTemporaryThreadStore((store) => store.markTemporaryThread);
  const clearTemporaryThread = useTemporaryThreadStore((store) => store.clearTemporaryThread);

  const handleNewThread = useCallback(
    (
      projectId: ProjectId,
      options?: NewThreadOptions,
      navigation?: NewThreadNavigationOptions,
    ): Promise<ThreadId | null> => {
      const entryPoint = options?.entryPoint ?? "chat";
      const wantsTemporaryThread = options?.temporary === true;
      const applyProviderOverride = (threadId: ThreadId) => {
        if (!options?.provider) {
          return;
        }
        const defaultModelSelection = getRecommendedDefaultModelSelection(options.provider);
        if (!defaultModelSelection) {
          return;
        }
        setModelSelection(threadId, defaultModelSelection);
      };
      const restoreComposerDraft = (
        threadId: ThreadId,
        draftState: ComposerThreadDraftState | null,
      ) => {
        if (!draftState) {
          return;
        }
        useComposerDraftStore.setState((state) => {
          if (state.draftsByThreadId[threadId] === draftState) {
            return state;
          }
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: draftState,
            },
          };
        });
      };
      const activateThreadEntryPoint = (threadId: ThreadId) => {
        if (entryPoint === "terminal") {
          openTerminalThreadPage(threadId, { terminalOnly: true });
          return;
        }
        openChatThreadPage(threadId);
      };
      const {
        getDraftThread,
        getDraftThreadByProjectId,
        applyStickyState,
        clearDraftThread,
        registerDraftThread,
        setDraftThreadContext,
        setProjectDraftThreadId,
        setModelSelection,
      } = useComposerDraftStore.getState();
      const shouldForceFreshThread = options?.fresh === true;

      const storedDraftThreadCandidate = getDraftThreadByProjectId(projectId, entryPoint);
      const latestActiveDraftThreadCandidate: DraftThreadState | null = focusedThreadId
        ? getDraftThread(focusedThreadId)
        : null;
      const storedDraftThread =
        !shouldForceFreshThread &&
        !wantsTemporaryThread &&
        storedDraftThreadCandidate?.isTemporary !== true
          ? storedDraftThreadCandidate
          : null;
      const latestActiveDraftThread: DraftThreadState | null =
        !shouldForceFreshThread &&
        !wantsTemporaryThread &&
        latestActiveDraftThreadCandidate?.isTemporary !== true
          ? latestActiveDraftThreadCandidate
          : null;
      const bootstrapPlan = resolveThreadBootstrapPlan({
        storedDraftThread,
        latestActiveDraftThread,
        entryPoint,
        projectId,
        routeThreadId: focusedThreadId,
      });
      // Read from the store at call time so post-sync sidebar flows can use the latest project defaults.
      const projectDefaultModelSelection =
        useStore.getState().projects.find((project) => project.id === projectId)
          ?.defaultModelSelection ?? null;
      const activeThreadSnapshot = createActiveThreadSnapshot(activeThread, projectId);
      const activeDraftThreadSnapshot = createActiveDraftThreadSnapshot(
        activeDraftThread,
        projectId,
      );
      const resolveCreationState = (
        targetThreadId: ThreadId,
        draftThread: DraftThreadState | null,
      ) =>
        resolveTerminalThreadCreationState({
          activeDraftThread: activeDraftThreadSnapshot,
          activeThread: activeThreadSnapshot,
          defaultEnvMode: settings.defaultThreadEnvMode,
          defaultProvider: options?.provider ?? settings.defaultProvider,
          draftComposerState:
            useComposerDraftStore.getState().draftsByThreadId[targetThreadId] ?? null,
          draftThread,
          projectDefaultModelSelection,
          projectId,
        });
      // Terminal-first threads need a real orchestration thread immediately so
      // the sidebar can render them as durable rows instead of draft-only routes.
      const createTerminalThread = async (
        threadId: ThreadId,
        creationState: ReturnType<typeof resolveCreationState>,
      ): Promise<void> => {
        const api = readNativeApi();
        if (!api) {
          return;
        }
        await promoteThreadCreate(
          {
            type: "thread.create",
            commandId: newCommandId(),
            threadId,
            projectId,
            title: "New terminal",
            modelSelection: creationState.modelSelection,
            runtimeMode: creationState.runtimeMode,
            interactionMode: creationState.interactionMode,
            envMode: creationState.envMode,
            branch: creationState.branch,
            worktreePath: creationState.worktreePath,
            lastKnownPr: creationState.lastKnownPr,
            createdAt: new Date().toISOString(),
          },
          api,
        );
      };
      if (bootstrapPlan.kind === "stored") {
        return (async (): Promise<ThreadId> => {
          if (wantsTemporaryThread) {
            markTemporaryThread(bootstrapPlan.threadId);
          }
          const preservedComposerDraft =
            useComposerDraftStore.getState().draftsByThreadId[bootstrapPlan.threadId] ?? null;
          let resolvedStoredDraftThread: DraftThreadState | null = bootstrapPlan.draftThread;
          const draftContextPatch = buildDraftThreadWorkspacePatch({
            defaultEnvMode: settings.defaultThreadEnvMode,
            draftThread: bootstrapPlan.draftThread,
            entryPoint,
            options,
            reuseKind: "stored",
          });
          if (draftContextPatch) {
            setDraftThreadContext(bootstrapPlan.threadId, draftContextPatch);
            resolvedStoredDraftThread = getDraftThread(bootstrapPlan.threadId);
          }
          applyProviderOverride(bootstrapPlan.threadId);
          setProjectDraftThreadId(projectId, bootstrapPlan.threadId, { entryPoint });
          restoreComposerDraft(bootstrapPlan.threadId, preservedComposerDraft);
          activateThreadEntryPoint(bootstrapPlan.threadId);
          if (focusedThreadId === bootstrapPlan.threadId) {
            if (entryPoint === "terminal") {
              await createTerminalThread(
                bootstrapPlan.threadId,
                resolveCreationState(bootstrapPlan.threadId, resolvedStoredDraftThread),
              );
            }
            return bootstrapPlan.threadId;
          }
          await navigate({
            to: "/$threadId",
            params: { threadId: bootstrapPlan.threadId },
            ...(navigation?.search ? { search: navigation.search } : {}),
          });
          restoreComposerDraft(bootstrapPlan.threadId, preservedComposerDraft);
          if (entryPoint === "terminal") {
            await createTerminalThread(
              bootstrapPlan.threadId,
              resolveCreationState(bootstrapPlan.threadId, resolvedStoredDraftThread),
            );
          }
          return bootstrapPlan.threadId;
        })();
      }

      if (bootstrapPlan.kind === "route") {
        return (async (): Promise<ThreadId> => {
          if (wantsTemporaryThread) {
            markTemporaryThread(bootstrapPlan.threadId);
          }
          const preservedComposerDraft =
            useComposerDraftStore.getState().draftsByThreadId[bootstrapPlan.threadId] ?? null;
          let resolvedActiveDraftThread: DraftThreadState | null = bootstrapPlan.draftThread;
          const draftContextPatch = buildDraftThreadWorkspacePatch({
            defaultEnvMode: settings.defaultThreadEnvMode,
            draftThread: bootstrapPlan.draftThread,
            entryPoint,
            options,
            reuseKind: "route",
          });
          if (draftContextPatch) {
            setDraftThreadContext(bootstrapPlan.threadId, draftContextPatch);
            resolvedActiveDraftThread = getDraftThread(bootstrapPlan.threadId);
          }
          applyProviderOverride(bootstrapPlan.threadId);
          setProjectDraftThreadId(projectId, bootstrapPlan.threadId, { entryPoint });
          restoreComposerDraft(bootstrapPlan.threadId, preservedComposerDraft);
          activateThreadEntryPoint(bootstrapPlan.threadId);
          if (entryPoint === "terminal") {
            await createTerminalThread(
              bootstrapPlan.threadId,
              resolveCreationState(bootstrapPlan.threadId, resolvedActiveDraftThread),
            );
          }
          return bootstrapPlan.threadId;
        })();
      }

      return runDraftNavigationOnce(draftNavigationSlotKey(projectId, entryPoint), async () => {
        const threadId = newThreadId();
        if (wantsTemporaryThread) {
          markTemporaryThread(threadId);
        }
        const createdAt = new Date().toISOString();
        const draftSeed = createFreshDraftThreadSeed({
          createdAt,
          defaultEnvMode: settings.defaultThreadEnvMode,
          entryPoint,
          options,
        });
        const committed = await stageDraftNavigation({
          // Keep the previous routed draft alive while the destination loads. Replacing the
          // project's primary slot earlier makes the route guard redirect the old URL to Home.
          stage: () => {
            registerDraftThread(threadId, { projectId, ...draftSeed });
            markNewThreadLanding(threadId);
            activateThreadEntryPoint(threadId);
            applyStickyState(threadId);
            applyProviderOverride(threadId);
          },
          // Mark the draft-landing navigation as a transition so the new route
          // subtree renders interruptibly and the browser can paint the composer
          // skeleton immediately instead of freezing on the synchronous commit.
          navigate: () =>
            new Promise<void>((resolve, reject) => {
              startTransition(() => {
                navigate({
                  to: "/$threadId",
                  params: { threadId },
                  ...(navigation?.search ? { search: navigation.search } : {}),
                }).then(resolve, reject);
              });
            }),
          // TanStack resolves an older navigate() promise when a newer navigation supersedes it.
          // Verify the committed route before deleting the previous project draft.
          isDestinationActive: () => router.state.location.pathname === `/${threadId}`,
          finalize: () => setProjectDraftThreadId(projectId, threadId, draftSeed),
          rollback: () => {
            clearNewThreadLanding(threadId);
            clearDraftThread(threadId);
            clearTerminalState(threadId);
            if (wantsTemporaryThread) {
              clearTemporaryThread(threadId);
            }
          },
        });
        if (!committed) {
          return null;
        }
        if (entryPoint === "terminal") {
          await createTerminalThread(
            threadId,
            resolveCreationState(threadId, getDraftThread(threadId)),
          );
        }
        return threadId;
      });
    },
    [
      activeDraftThread,
      activeThread,
      clearTemporaryThread,
      clearTerminalState,
      navigate,
      openChatThreadPage,
      openTerminalThreadPage,
      focusedThreadId,
      markTemporaryThread,
      router,
      settings.defaultProvider,
      settings.defaultThreadEnvMode,
    ],
  );

  return {
    activeDraftThread,
    activeProjectId,
    activeThread,
    activeContextThreadId: focusedThreadId,
    handleNewThread,
    projects,
    routeThreadId,
  };
}
