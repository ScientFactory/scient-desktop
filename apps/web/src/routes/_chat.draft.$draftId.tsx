import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import ChatView from "../components/ChatView";
import {
  resolveDraftPromotionNavigationTarget,
  threadHasStarted,
} from "../components/ChatView.logic";
import {
  DraftId,
  markPromotedDraftThreadByRef,
  useBackgroundDraftSubmissionPending,
  useComposerDraftStore,
} from "../composerDraftStore";
import { SidebarInset } from "../components/ui/sidebar";
import { waitForDraftHeroTransition } from "../components/chat/draftHeroTransition";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  useAllEnvironmentShellsBootstrapped,
  useProject,
  useThread,
  useThreadRefs,
} from "../state/entities";

function DraftChatThreadRouteView() {
  const navigate = useNavigate();
  const { draftId: rawDraftId } = Route.useParams();
  const draftId = DraftId.make(rawDraftId);
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const projectRef =
    draftSession?.projectId == null
      ? null
      : scopeProjectRef(draftSession.environmentId, draftSession.projectId);
  const project = useProject(projectRef);
  const environmentShellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const projectRequired = draftSession?.projectId != null;
  const projectUnavailable = projectRequired && project === null;
  const threadRefs = useThreadRefs();
  const inferredThreadRef = draftSession
    ? (threadRefs.find(
        (ref) =>
          ref.environmentId === draftSession.environmentId &&
          ref.threadId === draftSession.threadId,
      ) ?? null)
    : null;
  const serverThreadRef = draftSession?.promotedTo ?? inferredThreadRef;
  const serverThread = useThread(serverThreadRef);
  const serverThreadStarted = threadHasStarted(serverThread);
  const backgroundSubmissionPending = useBackgroundDraftSubmissionPending(serverThreadRef);
  const canonicalThreadRef = resolveDraftPromotionNavigationTarget({
    serverThreadRef,
    serverThreadStarted,
    backgroundSubmissionPending,
  });

  useEffect(() => {
    if (!inferredThreadRef || draftSession?.promotedTo) {
      return;
    }
    markPromotedDraftThreadByRef(inferredThreadRef);
  }, [draftSession?.promotedTo, inferredThreadRef]);

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }

    let cancelled = false;
    void waitForDraftHeroTransition().then(() => {
      if (cancelled) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(canonicalThreadRef),
        replace: true,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [canonicalThreadRef, navigate]);

  useEffect(() => {
    if ((draftSession && !projectUnavailable) || canonicalThreadRef) {
      return;
    }
    if (projectUnavailable && !environmentShellsBootstrapped) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [
    canonicalThreadRef,
    draftSession,
    environmentShellsBootstrapped,
    navigate,
    projectUnavailable,
  ]);

  if (!draftSession || projectUnavailable) {
    return null;
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <ChatView
        draftId={draftId}
        environmentId={draftSession.environmentId}
        threadId={draftSession.threadId}
        routeKind="draft"
        forceExpandedMobileComposer
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/draft/$draftId")({
  component: DraftChatThreadRouteView,
});
