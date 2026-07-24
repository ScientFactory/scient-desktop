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
  newThreadNavigationRequestKey,
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
      // Terminal-first threads need a real orchestration thread immediately so
      // the sidebar can render them as durable rows instead of draft-only routes.
      const createTerminalThread = async (
        threadId: ThreadId,
        creationState: ReturnType<typeof resolveTerminalThreadCreationState>,
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
      return runDraftNavigationOnce(
        draftNavigationSlotKey(projectId, entryPoint),
        newThreadNavigationRequestKey({
          hasCustomSearch: navigation?.search !== undefined,
          options,
        }),
        async (ownership) => {
          if (!ownership.isCurrent()) {
            return null;
          }
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
          const applyProviderOverride = (threadId: ThreadId) => {
            if (!options?.provider) {
              return;
            }
            const defaultModelSelection = getRecommendedDefaultModelSelection(options.provider);
            if (defaultModelSelection) {
              setModelSelection(threadId, defaultModelSelection);
            }
          };
          const currentPathMatch = /^\/([^/]+)$/.exec(router.state.location.pathname);
          const currentRouteThreadId = currentPathMatch?.[1]
            ? ThreadId.makeUnsafe(decodeURIComponent(currentPathMatch[1]))
            : null;
          const currentFocusedThreadId =
            focusedThreadId === routeThreadId ? currentRouteThreadId : focusedThreadId;
          const shouldForceFreshThread = options?.fresh === true;
          const storedDraftThreadCandidate = getDraftThreadByProjectId(projectId, entryPoint);
          const latestActiveDraftThreadCandidate: DraftThreadState | null = currentFocusedThreadId
            ? getDraftThread(currentFocusedThreadId)
            : null;
          const storedDraftThread =
            !shouldForceFreshThread &&
            !wantsTemporaryThread &&
            storedDraftThreadCandidate?.isTemporary !== true
              ? storedDraftThreadCandidate
              : null;
          const latestActiveDraftThread =
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
            routeThreadId: currentFocusedThreadId,
          });
          const currentAppState = useStore.getState();
          const activeThreadSnapshot = createActiveThreadSnapshot(
            currentFocusedThreadId
              ? currentAppState.threads.find((thread) => thread.id === currentFocusedThreadId)
              : null,
            projectId,
          );
          const activeDraftThreadSnapshot = createActiveDraftThreadSnapshot(
            latestActiveDraftThreadCandidate,
            projectId,
          );
          const projectDefaultModelSelection =
            currentAppState.projects.find((project) => project.id === projectId)
              ?.defaultModelSelection ?? null;
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

          if (bootstrapPlan.kind !== "fresh") {
            const preservedComposerDraft =
              useComposerDraftStore.getState().draftsByThreadId[bootstrapPlan.threadId] ?? null;
            if (
              bootstrapPlan.kind === "stored" &&
              currentFocusedThreadId !== bootstrapPlan.threadId
            ) {
              try {
                await navigate({
                  to: "/$threadId",
                  params: { threadId: bootstrapPlan.threadId },
                  ...(navigation?.search ? { search: navigation.search } : {}),
                });
              } catch (error) {
                if (!ownership.isCurrent()) {
                  return null;
                }
                throw error;
              }
              if (
                !ownership.isCurrent() ||
                router.state.location.pathname !== `/${bootstrapPlan.threadId}`
              ) {
                return null;
              }
            }
            if (!ownership.isCurrent()) {
              return null;
            }
            const draftContextPatch = buildDraftThreadWorkspacePatch({
              defaultEnvMode: settings.defaultThreadEnvMode,
              draftThread: bootstrapPlan.draftThread,
              entryPoint,
              options,
              reuseKind: bootstrapPlan.kind,
            });
            if (draftContextPatch) {
              setDraftThreadContext(bootstrapPlan.threadId, draftContextPatch);
            }
            applyProviderOverride(bootstrapPlan.threadId);
            setProjectDraftThreadId(projectId, bootstrapPlan.threadId, { entryPoint });
            restoreComposerDraft(bootstrapPlan.threadId, preservedComposerDraft);
            activateThreadEntryPoint(bootstrapPlan.threadId);
            if (entryPoint === "terminal" && ownership.isCurrent()) {
              await createTerminalThread(
                bootstrapPlan.threadId,
                resolveCreationState(
                  bootstrapPlan.threadId,
                  getDraftThread(bootstrapPlan.threadId),
                ),
              );
            }
            return bootstrapPlan.threadId;
          }

          try {
            await options?.prepareFreshCreate?.();
          } catch (error) {
            if (!ownership.isCurrent()) {
              return null;
            }
            throw error;
          }
          if (!ownership.isCurrent()) {
            return null;
          }
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
            isCurrent: ownership.isCurrent,
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
          if (entryPoint === "terminal" && ownership.isCurrent()) {
            await createTerminalThread(
              threadId,
              resolveCreationState(threadId, getDraftThread(threadId)),
            );
          }
          return threadId;
        },
      );
    },
    [
      clearTemporaryThread,
      clearTerminalState,
      navigate,
      openChatThreadPage,
      openTerminalThreadPage,
      focusedThreadId,
      markTemporaryThread,
      router,
      routeThreadId,
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
