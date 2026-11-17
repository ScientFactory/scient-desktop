// Composer side of committed voice dictation: registers the mounted composer
// as its draft's delivery endpoint and builds the origin a stop click captures.
// Kept apart from delivery so the voice controls, which the citation comment
// editor also mounts, do not import the thread-queue modules.

import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { useLayoutEffect, useRef } from "react";

import { composerTargetKey, type ComposerThreadTarget } from "../../composerDraftStore.ts";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../../threadRoutes.ts";
import { registerVoiceDraftEndpoint, type VoiceDraftOrigin } from "./voiceDraftDelivery.ts";

/**
 * Registers the composer as its draft's voice endpoint and returns the origin
 * that a stop click captures. The endpoint reads the latest render through a
 * ref, so its identity stays fixed for the composer's whole mount.
 */
export function useScientVoiceDraftOrigin(input: {
  readonly target: ComposerThreadTarget;
  /** Where Open goes: the thread that holds a queued-message edit, otherwise `target`. */
  readonly openTarget: ComposerThreadTarget;
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps latestRef holding the latest endpoint input
  useLayoutEffect(() => {
    latestRef.current = input;
  });
  const key = composerTargetKey(input.target);
  const target = input.target;
  const openTarget = input.openTarget;
  const environmentId = input.environmentId;
  const title = input.title;

  // Layout timing: a job finishing right after a remount finds the endpoint.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this composer's voice draft endpoint in the registry until unmount
  useLayoutEffect(
    () =>
      registerVoiceDraftEndpoint(key, {
        acceptsDraftText: () => latestRef.current.acceptsDraftText,
        environmentId: () => latestRef.current.environmentId,
        insert: (text) => latestRef.current.insert(text),
        canSubmit: () => latestRef.current.sendReady(),
        submit: () => latestRef.current.submit(),
      }),
    [key],
  );

  return {
    key,
    target,
    environmentId,
    title,
    open: () => {
      if (typeof openTarget === "string") {
        void navigate({ to: "/draft/$draftId", params: buildDraftThreadRouteParams(openTarget) });
      } else {
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(openTarget),
        });
      }
    },
  };
}
