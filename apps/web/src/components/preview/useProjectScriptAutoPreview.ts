import type { ProjectScript, PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useCallback, useEffect, useRef, useState } from "react";

import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { useDiscoveredPortsState } from "~/portDiscoveryState";
import { toastManager } from "~/components/ui/toast";

import {
  captureProjectScriptPreviewWaitBaseline,
  isCurrentProjectScriptPreviewLaunch,
  isProjectScriptPreviewServerReady,
  openProjectScriptPreview,
  planProjectScriptAutoPreview,
  resolveProjectScriptPreviewRequest,
  shouldCancelProjectScriptPreviewWait,
  type ProjectScriptPreviewWaitBaseline,
  type ProjectScriptPreviewRequest,
} from "./projectScriptAutoPreview";

export const PROJECT_SCRIPT_PREVIEW_START_TIMEOUT_MS = 60_000;

interface PendingProjectScriptPreview {
  readonly id: number;
  readonly threadRef: ScopedThreadRef;
  readonly request: ProjectScriptPreviewRequest;
  readonly baseline: ProjectScriptPreviewWaitBaseline;
}

/**
 * Completes the ProjectScript auto-preview contract without navigating a
 * localhost tab before its server is browser-ready. Waiting is renderer-local
 * and bounded; durable tabs and navigation remain owned by PreviewManager.
 */
export function useProjectScriptAutoPreview<E>(input: {
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeTabId: string | null;
  readonly sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  readonly openPreview: OpenPreviewMutation<E>;
}): (script: ProjectScript, launchThreadRef: ScopedThreadRef) => Promise<void> {
  const [pending, setPending] = useState<PendingProjectScriptPreview | null>(null);
  const pendingRef = useRef<PendingProjectScriptPreview | null>(null);
  const nextRequestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const activeThreadRefRef = useRef(input.activeThreadRef);
  activeThreadRefRef.current = input.activeThreadRef;
  const discovered = useDiscoveredPortsState(
    pending?.threadRef.environmentId ?? null,
    pending ? [pending.request.requestedUrl] : undefined,
  );
  const activePendingSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, pending?.threadRef),
  );

  const clearPending = useCallback((expectedId?: number): boolean => {
    const current = pendingRef.current;
    if (current === null || (expectedId !== undefined && current.id !== expectedId)) return false;
    pendingRef.current = null;
    setPending(null);
    return true;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingRef.current = null;
    };
  }, []);

  const openRequest = useCallback(
    async (threadRef: ScopedThreadRef, request: ProjectScriptPreviewRequest): Promise<void> => {
      const result = await openProjectScriptPreview({
        threadRef,
        request,
        openPreview: input.openPreview,
      });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Unable to open preview",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
    [input.openPreview],
  );

  useEffect(() => {
    if (pending === null) return;
    if (
      input.activeThreadRef === null ||
      scopedThreadKey(input.activeThreadRef) !== scopedThreadKey(pending.threadRef)
    ) {
      clearPending(pending.id);
    }
  }, [clearPending, input.activeThreadRef, pending]);

  const activePendingPreviewTabId =
    activePendingSurface?.kind === "preview" ? activePendingSurface.resourceId : undefined;
  useEffect(() => {
    if (
      pending === null ||
      !shouldCancelProjectScriptPreviewWait({
        baseline: pending.baseline,
        sessions: input.sessions,
        activePreviewTabId: activePendingPreviewTabId,
      })
    ) {
      return;
    }
    // User intent is represented by the panel/surface selection, tab set, and
    // visible navigation—not unrelated Browser runtime timestamps.
    clearPending(pending.id);
  }, [activePendingPreviewTabId, clearPending, input.sessions, pending]);

  useEffect(() => {
    if (
      pending === null ||
      !isProjectScriptPreviewServerReady(pending.request, discovered.servers)
    ) {
      return;
    }
    if (!clearPending(pending.id)) return;
    void openRequest(pending.threadRef, pending.request);
  }, [clearPending, discovered.servers, openRequest, pending]);

  useEffect(() => {
    if (pending === null) return;
    const timeout = window.setTimeout(() => {
      if (!clearPending(pending.id)) return;
      toastManager.add({
        type: "info",
        title: "Preview is still starting",
        description: "It will appear under Local previews when the server is ready.",
      });
    }, PROJECT_SCRIPT_PREVIEW_START_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [clearPending, pending]);

  return useCallback(
    async (script: ProjectScript, launchThreadRef: ScopedThreadRef): Promise<void> => {
      if (
        !mountedRef.current ||
        !isCurrentProjectScriptPreviewLaunch(activeThreadRefRef.current, launchThreadRef)
      ) {
        return;
      }
      const threadRef = launchThreadRef;
      let plan;
      try {
        plan = planProjectScriptAutoPreview({
          script,
          previewSupported: isPreviewSupportedInRuntime(),
          sessions: input.sessions,
          resolveRequest: () => resolveProjectScriptPreviewRequest(threadRef, script.previewUrl!),
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Unable to open preview",
          description: error instanceof Error ? error.message : "The preview URL is invalid.",
        });
        return;
      }

      if (plan.kind === "ignore") return;
      if (plan.kind === "focus") {
        clearPending();
        useRightPanelStore.getState().openBrowser(threadRef, plan.tabId);
        return;
      }
      if (plan.kind === "open") {
        clearPending();
        await openRequest(threadRef, plan.request);
        return;
      }

      nextRequestIdRef.current += 1;
      const baseline = captureProjectScriptPreviewWaitBaseline(input.sessions, input.activeTabId);
      const nextPending: PendingProjectScriptPreview = {
        id: nextRequestIdRef.current,
        threadRef,
        request: plan.request,
        baseline,
      };
      pendingRef.current = nextPending;
      setPending(nextPending);
      useRightPanelStore.getState().openBrowser(threadRef, baseline.visibleTabId);
    },
    [clearPending, input.activeTabId, input.sessions, openRequest],
  );
}
