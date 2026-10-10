// Composer side of committed voice dictation: registers the mounted composer
// as its draft's delivery endpoint and builds the origin a stop click captures.
// Kept apart from delivery so the voice controls, which the citation comment
// editor also mounts, do not import the thread-queue modules.

import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { useLayoutEffect, useMemo, useRef } from "react";

import {
  composerTargetKey,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "../../composerDraftStore.ts";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../../threadRoutes.ts";
import { useQueueEditSessions } from "../threadQueue/editSession.ts";
import { registerVoiceDraftEndpoint, type VoiceDraftOrigin } from "./voiceDraftDelivery.ts";

/**
 * Extracted queue drafts and open queue edits prepare the send asynchronously
 * (journal intake, edit flush) before the send path reads the composer.
 */
export function hasAsyncSendPreparation(target: ComposerThreadTarget): boolean {
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  return (
    Boolean(draft?.extractedIntent) ||
    useQueueEditSessions.getState().sessions[composerTargetKey(target)] !== undefined
  );
}

/**
 * Registers the composer as its draft's voice endpoint and returns the origin
 * that a stop click captures. The endpoint reads the latest render through a
 * ref, so its identity stays fixed for the composer's whole mount.
 */
export function useScientVoiceDraftOrigin(input: {
  readonly target: ComposerThreadTarget;
  readonly environmentId: EnvironmentId;
  readonly title: string | null;
  readonly acceptsDraftText: boolean;
  readonly insert: (text: string) => boolean;
  /** The composer's own send guards: provider, send-disabled, busy, scope. */
  readonly sendReady: () => boolean;
  readonly submit: () => void;
}): VoiceDraftOrigin {
  const navigate = useNavigate();
  const latestRef = useRef(input);
  latestRef.current = input;
  const key = composerTargetKey(input.target);
  const target = input.target;
  const environmentId = input.environmentId;
  const title = input.title;

  // Layout timing: a job finishing right after a remount finds the endpoint.
  useLayoutEffect(
    () =>
      registerVoiceDraftEndpoint(key, {
        acceptsDraftText: () => latestRef.current.acceptsDraftText,
        environmentId: () => latestRef.current.environmentId,
        insert: (text) => latestRef.current.insert(text),
        canSubmit: () =>
          latestRef.current.sendReady() && !hasAsyncSendPreparation(latestRef.current.target),
        submit: () => latestRef.current.submit(),
      }),
    [key],
  );

  return useMemo(
    () => ({
      key,
      target,
      environmentId,
      title,
      open: () => {
        if (typeof target === "string") {
          void navigate({ to: "/draft/$draftId", params: buildDraftThreadRouteParams(target) });
        } else {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(target),
          });
        }
      },
    }),
    [environmentId, key, navigate, target, title],
  );
}
