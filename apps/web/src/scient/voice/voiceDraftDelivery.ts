// Delivery of committed composer dictation to the draft it was started from.
//
// The origin is fixed at the stop click. Delivery never reads the route or the
// visible composer to choose a destination: it looks up the endpoint that the
// origin's own composer registered, and otherwise writes to the origin's draft
// in the store. Foreground Send happens only through that registered endpoint,
// re-checked in the frame that submits.

import type { EnvironmentId } from "@t3tools/contracts";

import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore.ts";
import { stackedThreadToast, toastManager } from "../../components/ui/toast.tsx";
import { buildVoiceDraftReplacement } from "./voiceComposerInsert.ts";

export interface VoiceDraftOrigin {
  /** `composerTargetKey` of the target: environment-scoped for server threads. */
  readonly key: string;
  readonly target: ComposerThreadTarget;
  /**
   * Environment at the stop click. A new-thread draft keeps its DraftId when
   * its machine changes, so the key alone does not pin the environment.
   */
  readonly environmentId: EnvironmentId;
  readonly title: string | null;
  readonly open: () => void;
}

/** What a mounted composer offers for its own ordinary draft. */
export interface VoiceDraftEndpoint {
  /** False while a question or approval occupies the composer. */
  readonly acceptsDraftText: () => boolean;
  /** The environment the composer would send to now. */
  readonly environmentId: () => EnvironmentId;
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
        endpoint.environmentId() === origin.environmentId &&
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
