// Delivery of committed composer dictation to the draft it was started from.
//
// The origin is fixed at the stop click. Delivery never reads the route or the
// visible composer to choose a destination: it looks up the endpoint that the
// origin's own composer registered, and otherwise writes to the origin's draft
// in the store. Foreground Send happens only through that registered endpoint,
// re-checked in the frame that submits.

import { useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useMemo, useRef } from "react";

import {
  composerTargetKey,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "../../composerDraftStore.ts";
import { stackedThreadToast, toastManager } from "../../components/ui/toast.tsx";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../../threadRoutes.ts";
import { useQueueEditSessions } from "../threadQueue/editSession.ts";
import { buildVoiceDraftReplacement } from "./voiceComposerInsert.ts";

export interface VoiceDraftOrigin {
  /** `composerTargetKey` of the target: environment-scoped for server threads. */
  readonly key: string;
  readonly target: ComposerThreadTarget;
  readonly title: string | null;
  readonly open: () => void;
}

/** What a mounted composer offers for its own ordinary draft. */
export interface VoiceDraftEndpoint {
  /** False while a question or approval occupies the composer. */
  readonly acceptsDraftText: () => boolean;
  /** Appends to the ordinary draft through the editor; false when it declined. */
  readonly insert: (text: string) => boolean;
  /**
   * True only when `submit` would send now and read this composer before any
   * await: the send path reads the shared composer after its first await, so a
   * navigation during that wait could otherwise send another thread's input.
   */
  readonly canSubmit: () => boolean;
  readonly submit: () => void;
}

export type VoiceDraftNotice =
  | { readonly kind: "added" | "not-sent"; readonly origin: VoiceDraftOrigin }
  | { readonly kind: "unavailable"; readonly text: string }
  | { readonly kind: "failed"; readonly origin: VoiceDraftOrigin; readonly message: string };

const endpoints = new Map<string, VoiceDraftEndpoint>();

export function registerVoiceDraftEndpoint(key: string, endpoint: VoiceDraftEndpoint): () => void {
  endpoints.set(key, endpoint);
  return () => {
    if (endpoints.get(key) === endpoint) endpoints.delete(key);
  };
}

function hasVoiceDraftEndpoint(key: string): boolean {
  return endpoints.has(key);
}

/** Appends to the origin's stored draft; false when that draft no longer exists. */
export function appendVoiceTranscriptToStoredDraft(
  target: ComposerThreadTarget,
  text: string,
): boolean {
  const store = useComposerDraftStore.getState();
  // A closed new-thread draft has no session; writing would leave an orphan no
  // route can show. Server threads keep their own draft key.
  if (typeof target === "string" && store.getDraftSession(target) === null) return false;
  const current = store.getComposerDraft(target)?.prompt ?? "";
  store.setPrompt(target, buildVoiceDraftReplacement(current, text).replacement);
  return true;
}

export interface VoiceDraftDeliveryDependencies {
  readonly scheduleFrame: (callback: () => void) => void;
  readonly appendToStoredDraft: (target: ComposerThreadTarget, text: string) => boolean;
  readonly notify: (notice: VoiceDraftNotice) => void;
}

function quotedTitle(origin: VoiceDraftOrigin): string {
  return origin.title ? `“${origin.title}”` : "its draft";
}

function showVoiceDraftNotice(notice: VoiceDraftNotice): void {
  if (notice.kind === "unavailable") {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Transcript not saved",
        description: "Its draft was closed.",
        actionProps: {
          children: "Copy transcript",
          onClick: () => void navigator.clipboard?.writeText(notice.text),
        },
      }),
    );
    return;
  }
  const open = { children: "Open", onClick: notice.origin.open };
  toastManager.add(
    stackedThreadToast(
      notice.kind === "failed"
        ? {
            type: "error",
            title: "Voice transcription failed",
            description: notice.message,
            actionProps: open,
          }
        : notice.kind === "not-sent"
          ? {
              type: "info",
              title: `Transcript saved to ${quotedTitle(notice.origin)}`,
              description: "Message not sent.",
              actionProps: open,
            }
          : {
              type: "info",
              title: `Transcript added to ${quotedTitle(notice.origin)}`,
              actionProps: open,
            },
    ),
  );
}

const defaultDependencies: VoiceDraftDeliveryDependencies = {
  scheduleFrame: (callback) => {
    requestAnimationFrame(callback);
  },
  appendToStoredDraft: appendVoiceTranscriptToStoredDraft,
  notify: showVoiceDraftNotice,
};

/**
 * Appends once to the origin's ordinary draft. Send submits only through the
 * origin's own registered composer, and only if it still shows that draft in
 * the frame that submits; otherwise the text stays saved and a notice says so.
 */
export function deliverVoiceTranscriptToDraft(
  origin: VoiceDraftOrigin,
  text: string,
  send: boolean,
  dependencies: VoiceDraftDeliveryDependencies = defaultDependencies,
): void {
  const endpoint = endpoints.get(origin.key);
  if (endpoint?.acceptsDraftText() && endpoint.insert(text)) {
    if (!send) return;
    dependencies.scheduleFrame(() => {
      if (
        endpoints.get(origin.key) === endpoint &&
        endpoint.acceptsDraftText() &&
        endpoint.canSubmit()
      ) {
        endpoint.submit();
      } else {
        dependencies.notify({ kind: "not-sent", origin });
      }
    });
    return;
  }
  if (!dependencies.appendToStoredDraft(origin.target, text)) {
    dependencies.notify({ kind: "unavailable", text });
    return;
  }
  dependencies.notify({ kind: send ? "not-sent" : "added", origin });
}

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

/** A failure the origin's composer cannot show becomes a notice. */
export function reportVoiceDraftFailure(
  origin: VoiceDraftOrigin,
  message: string,
  showInControl: (message: string) => void,
  notify: (notice: VoiceDraftNotice) => void = showVoiceDraftNotice,
): void {
  if (hasVoiceDraftEndpoint(origin.key)) showInControl(message);
  else notify({ kind: "failed", origin, message });
}

/**
 * Registers the composer as its draft's voice endpoint and returns the origin
 * that a stop click captures. The endpoint reads the latest render through a
 * ref, so its identity stays fixed for the composer's whole mount.
 */
export function useScientVoiceDraftOrigin(input: {
  readonly target: ComposerThreadTarget;
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
  const title = input.title;

  // Layout timing: a job finishing right after a remount finds the endpoint.
  useLayoutEffect(
    () =>
      registerVoiceDraftEndpoint(key, {
        acceptsDraftText: () => latestRef.current.acceptsDraftText,
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
    [key, navigate, target, title],
  );
}
