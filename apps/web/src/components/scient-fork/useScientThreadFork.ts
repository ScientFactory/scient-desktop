import { sha256 } from "@noble/hashes/sha2";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  CommandId,
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type ThreadId,
  type ForkOptions,
  type RunId,
} from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  flushComposerDraftPersistence,
  type ComposerImageAttachment,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { newThreadId } from "~/lib/utils";
import { isImageAttachment, type ChatAttachment } from "~/types";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { readProject, readThreadShell } from "../../state/entities";
import {
  type ForkAcceptanceOutcome,
  readFileAsDataUrl,
  resolveThreadWorkspaceRoot,
} from "../ChatView.logic";
import { restoreForkPdfContinuity, stageForkViewContinuity } from "./forkViewContinuity";
import {
  createForkAttemptStore,
  deliverForkAttempt,
  forkAttemptKey,
  withForkOriginLock,
  subscribeForkOrigins,
  isForkOriginBusy,
} from "./forkAttempt";
import { markForkLanding } from "./forkLanding";
import { toastManager } from "../ui/toast";

const memory = new Map<string, string>();
const attemptStore = createForkAttemptStore(
  typeof localStorage !== "undefined"
    ? localStorage
    : {
        getItem: (key) => memory.get(key) ?? null,
        setItem: (key, value) => {
          memory.set(key, value);
        },
        removeItem: (key) => {
          memory.delete(key);
        },
      },
);

export type ForkSource =
  | {
      readonly kind: "assistant-response";
      readonly messageId: MessageId | null;
      readonly latest?: boolean;
    }
  | {
      readonly kind: "user-message";
      readonly messageId: MessageId;
      readonly prompt: string;
      readonly attachments: ReadonlyArray<ChatAttachment>;
    }
  // The running turn, including the work it has done so far.
  | { readonly kind: "running-turn"; readonly runId: RunId };
const UNSUPPORTED_FORK_MESSAGE =
  "Update Scient on the computer that runs this conversation, then fork again.";
// The fork card's check is reused when its Fork button is pressed soon after.
const CHECKED_FORK_OPTIONS_REUSE_MS = 30_000;

function assertForkEligibility(
  source: ForkSource,
  workspaceMode: "new-worktree" | "local",
  eligibility: ForkOptions,
) {
  if (!eligibility.available)
    throw new Error(eligibility.reason ?? "This fork point is unavailable.");
  // A server that does not know running-turn forks answers for the latest response instead.
  if (source.kind === "running-turn" && eligibility.sourceRunningRunId !== source.runId)
    throw new Error(
      "This server cannot fork while the agent is working. Update Scient, or fork once the turn finishes.",
    );
  if (workspaceMode === "local" && !eligibility.localAvailable)
    throw new Error(eligibility.reason ?? "The original workspace is unavailable.");
  if (workspaceMode === "new-worktree" && !eligibility.newWorktree)
    throw new Error(
      source.kind === "running-turn"
        ? "A new worktree needs this project's Git repository and the original folder. Fork here instead."
        : "This point has no saved Git checkpoint for a new worktree. Fork here, or fork from another point.",
    );
}

function storeFreshForkAttempt(
  key: string,
  attempt: Parameters<typeof attemptStore.set>[1],
  destination: ScopedThreadRef,
) {
  try {
    attemptStore.set(key, attempt);
  } catch (error) {
    // This fresh command has never been dispatched.
    clearStagedUserForkDraft(destination);
    throw error;
  }
}
const sourceKey = (source: ForkSource) =>
  source.kind === "running-turn"
    ? `running-turn:${source.runId}`
    : source.kind === "assistant-response" && source.latest
      ? "latest"
      : `${source.kind}:${source.messageId}`;

function composerFingerprint(ref: ScopedThreadRef): string {
  const draft = useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(ref)];
  const snapshot = JSON.stringify([
    draft?.prompt ?? "",
    draft?.images.map((image) => image.id) ?? [],
    draft?.files.map((file) => file.id) ?? [],
  ]);
  return Array.from(sha256(new TextEncoder().encode(snapshot)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

type ForkOrigin = {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
};

type NavigateToThread = (input: {
  readonly to: "/$environmentId/$threadId";
  readonly params: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  };
}) => Promise<void>;

export function userFacingForkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not a supported image attachment")) {
    return "Editing a fork from a message with file attachments is not supported yet. Fork from a completed response to keep the conversation and its files.";
  }
  if (message.includes("fork draft attachment")) {
    return "One of this message's images could not be prepared for editing. Wait for it to load and try again.";
  }
  if (message.includes("no ready Git checkpoint")) {
    return "This point has no saved Git checkpoint for a new worktree. Fork here, or fork from another point.";
  }
  if (
    message.includes("not a completed conversation boundary") ||
    message.includes("not a terminal completed response") ||
    message.includes("not an available durable request")
  ) {
    return "This message is no longer available as a fork point. Choose another message.";
  }
  return message && message !== "[object Object]"
    ? message
    : "Unable to confirm this fork. Retry to resume the same attempt.";
}

type PreparedDraftAttachment = {
  readonly image: ComposerImageAttachment;
  readonly persisted: PersistedComposerImageAttachment;
};

export async function prepareForkDraftAttachments(
  attachments: ReadonlyArray<ChatAttachment>,
  fetchAsset: typeof fetch = fetch,
  readAsDataUrl: (file: File) => Promise<string> = readFileAsDataUrl,
): Promise<ReadonlyArray<PreparedDraftAttachment>> {
  return Promise.all(
    attachments.map(async (attachment) => {
      if (!isImageAttachment(attachment)) {
        throw new Error(
          `fork draft attachment '${attachment.name}' is not a supported image attachment`,
        );
      }
      if (!attachment.previewUrl) {
        throw new Error(`fork draft attachment '${attachment.name}' has no authorized URL`);
      }
      const response = await fetchAsset(attachment.previewUrl);
      if (!response.ok) {
        throw new Error(
          `fork draft attachment '${attachment.name}' could not be read (${response.status})`,
        );
      }
      const blob = await response.blob();
      const mimeType = blob.type || attachment.mimeType;
      const file = new File([blob], attachment.name, { type: mimeType });
      const dataUrl = await readAsDataUrl(file);
      return {
        image: {
          type: "image" as const,
          id: attachment.id,
          name: attachment.name,
          mimeType,
          sizeBytes: file.size,
          previewUrl: dataUrl,
          file,
        },
        persisted: {
          id: attachment.id,
          name: attachment.name,
          mimeType,
          sizeBytes: file.size,
          dataUrl,
        },
      };
    }),
  );
}

export async function stageUserForkDraft(input: {
  readonly destinationRef: ScopedThreadRef;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly fetchAsset?: typeof fetch;
  readonly readAsDataUrl?: (file: File) => Promise<string>;
  readonly confirmSkippedImages?: (names: ReadonlyArray<string>) => Promise<boolean>;
}): Promise<boolean> {
  // Unsupported files remain an error. Only unreadable images may be omitted,
  // and only after confirmation, before any draft or command is created.
  const unsupported = input.attachments.find((attachment) => !isImageAttachment(attachment));
  if (unsupported) {
    throw new Error(
      `fork draft attachment '${unsupported.name}' is not a supported image attachment`,
    );
  }
  const results = await Promise.all(
    input.attachments.map(async (attachment) => {
      try {
        const prepared = await prepareForkDraftAttachments(
          [attachment],
          input.fetchAsset,
          input.readAsDataUrl,
        );
        return { prepared, skipped: [] as string[] };
      } catch {
        return { prepared: [] as PreparedDraftAttachment[], skipped: [attachment.name] };
      }
    }),
  );
  const skipped = results.flatMap((result) => result.skipped);
  if (skipped.length > 0) {
    // Without someone to ask, omitting an image would be silent: refuse instead.
    if (input.confirmSkippedImages === undefined) {
      throw new Error(
        `These images could not be read: ${skipped.join(", ")}. Fork from another message, or try again when they are available.`,
      );
    }
    if (!(await input.confirmSkippedImages(skipped))) return false;
  }
  const preparedAttachments = results.flatMap((result) => result.prepared);
  const drafts = useComposerDraftStore.getState();
  drafts.setPrompt(input.destinationRef, input.prompt);
  drafts.addImages(
    input.destinationRef,
    preparedAttachments.map((attachment) => attachment.image),
  );
  drafts.syncPersistedAttachments(
    input.destinationRef,
    preparedAttachments.map((attachment) => attachment.persisted),
  );
  // The server command can make the destination visible immediately. Flush
  // before issuing it so a route change or app restart cannot lose the draft.
  flushComposerDraftPersistence();
  return true;
}

export function clearStagedUserForkDraft(destinationRef: ScopedThreadRef): void {
  useComposerDraftStore.getState().clearDraftThread(destinationRef);
  flushComposerDraftPersistence();
}

export function moveAcceptedForkComposerDraft(input: {
  readonly sourceRef: ScopedThreadRef;
  readonly destinationRef: ScopedThreadRef;
}): void {
  const drafts = useComposerDraftStore.getState();
  const destination = drafts.draftsByThreadKey[scopedThreadKey(input.destinationRef)];
  if (
    destination &&
    (destination.prompt.length > 0 ||
      destination.images.length > 0 ||
      destination.files.length > 0 ||
      destination.terminalContexts.length > 0)
  )
    return;
  drafts.moveComposerPromptAndImages(input.sourceRef, input.destinationRef);
  flushComposerDraftPersistence();
}

export function useScientThreadFork({
  origin,
  navigate,
  supported,
}: {
  readonly origin: ForkOrigin | null;
  readonly navigate: NavigateToThread;
  /** The server takes Scient's fork options on T3's fork command. */
  readonly supported: boolean;
}) {
  const forkConversation = useAtomCommand(threadEnvironment.fork, { reportFailure: false });
  const awaitFork = useAtomCommand(threadEnvironment.awaitFork, { reportFailure: false });
  const getForkOptions = useAtomCommand(threadEnvironment.getForkOptions, { reportFailure: false });
  // What the open fork card shows: the checked options, and a saved fork to resume.
  const [preview, setPreview] = useState<{
    key: string;
    options: ForkOptions | null;
    checking: boolean;
    locked: boolean;
    retryTitle?: string;
    retryWorkspaceMode?: "local" | "new-worktree";
  } | null>(null);
  const [errorUpdate, setErrorUpdate] = useState<{
    readonly threadId: ThreadId;
    readonly environmentId: EnvironmentId;
    readonly message: string | null;
    /** The fork point the error is about; another point's card does not show it. */
    readonly key: string;
  } | null>(null);
  const originId = origin?.id;
  const environmentId = origin?.environmentId;
  const originKey = JSON.stringify([environmentId, originId]);
  const isForking = useSyncExternalStore(
    subscribeForkOrigins,
    () => isForkOriginBusy(originKey),
    () => false,
  );
  const activeOrigin = useRef(originKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps activeOrigin in step with the origin key for async fork guards
  useLayoutEffect(() => {
    activeOrigin.current = originKey;
  }, [originKey]);
  const mounted = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks mounted state so async fork work stops writing after unmount
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const previewSequence = useRef(0);
  // The options the open fork card just checked. Submitting from it uses them
  // once instead of checking again; the server checks the fork itself anyway.
  const checkedOptions = useRef<{ key: string; options: ForkOptions; at: number } | null>(null);

  const resolveOptions = async (source: ForkSource): Promise<ForkOptions> => {
    if (!originId || !environmentId) throw new Error("The original conversation is unavailable.");
    const result = await getForkOptions({
      environmentId,
      input: {
        originThreadId: originId,
        ...(source.kind === "running-turn"
          ? { sourceRunningRunId: source.runId }
          : source.kind === "user-message"
            ? { sourceUserMessageId: source.messageId }
            : source.latest || source.messageId === null
              ? {}
              : { sourceAssistantMessageId: source.messageId }),
      },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value;
  };

  /** Checks a fork point for the fork card, or finds the saved fork it resumes. */
  const prepareFork = async (source: ForkSource) => {
    if (!originId || !environmentId) return;
    const key = forkAttemptKey(environmentId, originId, sourceKey(source));
    const sequence = ++previewSequence.current;
    setErrorUpdate(null);
    setPreview({ key, options: null, checking: true, locked: false });
    const current = () =>
      sequence === previewSequence.current && mounted.current && activeOrigin.current === originKey;
    if (!supported) {
      if (!current()) return;
      setPreview({ key, options: null, checking: false, locked: false });
      setErrorUpdate({ threadId: originId, environmentId, key, message: UNSUPPORTED_FORK_MESSAGE });
      return;
    }
    try {
      const pending = attemptStore.get(key);
      const boundary = pending?.command.scient.boundary;
      const options: ForkOptions = pending
        ? {
            available: true,
            localAvailable: true,
            reason: null,
            newWorktree: pending.command.scient.workspaceMode === "new-worktree",
            sourceAssistantMessageId:
              boundary?.kind === "assistant-response" ? boundary.messageId : null,
            sourceUserMessageId: boundary?.kind === "user-message" ? boundary.messageId : null,
            sourceRunningRunId: boundary?.kind === "running-turn" ? boundary.runId : null,
            ...(pending.workspaceNotice === undefined
              ? {}
              : { workspaceNotice: pending.workspaceNotice }),
          }
        : await resolveOptions(source);
      if (current()) {
        // Only the card being shown publishes its options for reuse.
        if (!pending) checkedOptions.current = { key, options, at: Date.now() };
        setPreview({
          key,
          options,
          checking: false,
          locked: pending !== null,
          ...(pending?.displayTitle === undefined ? {} : { retryTitle: pending.displayTitle }),
          ...(pending ? { retryWorkspaceMode: pending.command.scient.workspaceMode } : {}),
        });
      }
    } catch (error) {
      if (current()) {
        setPreview({ key, options: null, checking: false, locked: false });
        setErrorUpdate({
          threadId: originId,
          environmentId,
          key,
          message: userFacingForkError(error),
        });
      }
    }
  };

  const forkFromMessage = async (
    source: ForkSource,
    options: {
      readonly workspaceMode: "new-worktree" | "local";
      /** An edited title from the fork card; without one the server numbers the fork. */
      readonly titleOverride?: string;
      /** The title the fork card showed, shown again if the fork is resumed. */
      readonly displayTitle?: string;
      /** Complete the fork card's exit before changing the conversation. */
      readonly beforeNavigate?: () => Promise<boolean>;
      /** The fork card shows errors itself; other forks report them as toasts. */
      readonly fromCard?: boolean;
      readonly confirmSkippedImages?: (names: ReadonlyArray<string>) => Promise<boolean>;
      /** Move only portable unsent text/images after the fork command is accepted. */
      readonly composerDraftSource?: ScopedThreadRef;
    },
    originWorkspaceRoot: string | undefined,
  ): Promise<ForkAcceptanceOutcome> => {
    if (!originId || !environmentId) return "not-accepted";
    const fromCard = options.fromCard === true;
    if (!supported) {
      if (fromCard)
        setErrorUpdate({
          threadId: originId,
          environmentId,
          key: forkAttemptKey(environmentId, originId, sourceKey(source)),
          message: UNSUPPORTED_FORK_MESSAGE,
        });
      else
        toastManager.add({
          type: "error",
          title: "This conversation cannot be forked here",
          description: UNSUPPORTED_FORK_MESSAGE,
        });
      return "not-accepted";
    }
    const outcome = await withForkOriginLock(
      originKey,
      async (): Promise<ForkAcceptanceOutcome> => {
        const key = forkAttemptKey(environmentId, originId, sourceKey(source));
        let workspaceNotice: string | undefined;
        // The notice the fork card already showed, so it is not said twice.
        let cardNotice: string | undefined;
        if (fromCard) setErrorUpdate(null);
        try {
          // A fork already under way from this point resumes with its saved command.
          let attempt = attemptStore.get(key);
          if (attempt) cardNotice = attempt.workspaceNotice;
          if (!attempt) {
            const checked = checkedOptions.current;
            if (checked?.key === key) cardNotice = checked.options.workspaceNotice;
            checkedOptions.current = null;
            // "Latest" names whatever response is newest now, so check it again.
            const eligibility =
              checked !== null &&
              checked.key === key &&
              !(
                source.kind === "assistant-response" &&
                (source.latest || source.messageId === null)
              ) &&
              Date.now() - checked.at < CHECKED_FORK_OPTIONS_REUSE_MS
                ? checked.options
                : await resolveOptions(source);
            assertForkEligibility(source, options.workspaceMode, eligibility);
            const id = newThreadId();
            if (
              source.kind === "user-message" &&
              !(await stageUserForkDraft({
                destinationRef: scopeThreadRef(environmentId, id),
                prompt: source.prompt,
                attachments: source.attachments,
                ...(options.confirmSkippedImages
                  ? { confirmSkippedImages: options.confirmSkippedImages }
                  : {}),
              }))
            )
              return "not-accepted";
            attempt = {
              environmentId,
              ready: false,
              handoffDone: false,
              ...(options.displayTitle === undefined ? {} : { displayTitle: options.displayTitle }),
              ...(options.workspaceMode === "local" && eligibility.workspaceNotice !== undefined
                ? { workspaceNotice: eligibility.workspaceNotice }
                : {}),
              ...(options.composerDraftSource
                ? { composerDraftFingerprint: composerFingerprint(options.composerDraftSource) }
                : {}),
              command: {
                commandId: CommandId.make(`client:thread-fork:${id}`),
                sourceThreadId: originId,
                targetThreadId: id,
                ...(options.titleOverride === undefined ? {} : { title: options.titleOverride }),
                scient: {
                  workspaceMode: options.workspaceMode,
                  boundary: eligibility.sourceRunningRunId
                    ? { kind: "running-turn", runId: eligibility.sourceRunningRunId }
                    : eligibility.sourceAssistantMessageId
                      ? {
                          kind: "assistant-response",
                          messageId: eligibility.sourceAssistantMessageId,
                        }
                      : { kind: "user-message", messageId: eligibility.sourceUserMessageId! },
                },
              },
            };
            storeFreshForkAttempt(key, attempt, scopeThreadRef(environmentId, id));
          }
          workspaceNotice = attempt.workspaceNotice;
          const destinationRef = scopeThreadRef(environmentId, attempt.command.targetThreadId);
          attempt = await deliverForkAttempt({
            key,
            attempt,
            store: attemptStore,
            discardDraft: () => clearStagedUserForkDraft(destinationRef),
            dispatch: async (current) => {
              const accepted = await forkConversation({ environmentId, input: current.command });
              if (accepted._tag === "Failure") throw squashAtomCommandFailure(accepted);
              // A new worktree is set up after acceptance; the fork opens once it is ready.
              const ready = await awaitFork({
                environmentId,
                input: { threadId: current.command.targetThreadId },
              });
              if (ready._tag === "Failure") throw squashAtomCommandFailure(ready);
              return ready.value.forkAttachmentIdMap;
            },
          });
          // Completing in the background must not steal navigation or a composer
          // from the conversation the user has since opened.
          if (!mounted.current || activeOrigin.current !== originKey) return "accepted";
          if (options.beforeNavigate && !(await options.beforeNavigate())) return "accepted";
          if (!mounted.current || activeOrigin.current !== originKey) return "accepted";
          if (!attempt.handoffDone) {
            if (
              options.composerDraftSource &&
              attempt.composerDraftFingerprint === composerFingerprint(options.composerDraftSource)
            ) {
              moveAcceptedForkComposerDraft({
                sourceRef: options.composerDraftSource,
                destinationRef,
              });
            }
            try {
              stageForkViewContinuity({
                originRef: scopeThreadRef(environmentId, originId),
                destinationThreadId: attempt.command.targetThreadId,
                originWorkspaceRoot,
                attachmentIdMap: attempt.attachmentIdMap,
              });
              // The fork is ready, so its folder is usually known: apply the
              // PDF positions now, before any reader in the fork can open.
              // Otherwise the fork applies them when it first knows its folder.
              const destinationShell = readThreadShell(destinationRef);
              const destinationProject =
                destinationShell?.projectId == null
                  ? null
                  : readProject(scopeProjectRef(environmentId, destinationShell.projectId));
              restoreForkPdfContinuity({
                environmentId,
                threadId: attempt.command.targetThreadId,
                destinationWorkspaceRoot: resolveThreadWorkspaceRoot({
                  worktreePath: destinationShell?.worktreePath,
                  projectCwd: destinationProject?.workspaceRoot,
                }),
              });
            } catch {
              /* Panel continuity is optional; it cannot undo a ready fork. */
            }
            attempt = { ...attempt, handoffDone: true };
            attemptStore.set(key, attempt);
          }
          // The fork's messages show once they are in place (forkLanding.ts).
          markForkLanding(scopedThreadKey(destinationRef));
          await navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: attempt.command.targetThreadId },
          });
          attemptStore.delete(key);
          // Said here unless the fork card showed this notice before the fork was made.
          if (workspaceNotice !== undefined && !(fromCard && workspaceNotice === cardNotice))
            toastManager.add({ type: "info", title: "Forked", description: workspaceNotice });
          return "accepted";
        } catch (cause) {
          if (mounted.current && activeOrigin.current === originKey) {
            let pending = null;
            try {
              pending = attemptStore.get(key);
            } catch {
              /* Keep corrupt/unavailable storage untouched. */
            }
            if (fromCard) {
              setErrorUpdate({
                threadId: originId,
                environmentId,
                key,
                message: pending?.ready
                  ? "The fork is ready. Retry to open it; this will not create another conversation."
                  : `${userFacingForkError(cause)}${pending ? " Retry to resume this same fork; your draft is saved." : ""}`,
              });
              setPreview((current) =>
                current?.key === key ? { ...current, locked: pending !== null } : current,
              );
              return "not-accepted";
            }
            toastManager.add({
              type: "error",
              title: pending?.ready ? "The fork is ready" : "The fork did not finish",
              description: pending?.ready
                ? "Fork from the same point again to open it; this will not create another conversation."
                : `${userFacingForkError(cause)}${pending ? " Fork from the same point again to resume it; your draft is saved." : ""}`,
            });
          }
          return "not-accepted";
        }
      },
    );
    if (outcome === null && mounted.current && activeOrigin.current === originKey) {
      if (fromCard) {
        setErrorUpdate({
          threadId: originId,
          environmentId,
          key: forkAttemptKey(environmentId, originId, sourceKey(source)),
          message:
            "A fork is already being prepared from this conversation. Wait for it to finish, then retry.",
        });
        return "not-accepted";
      }
      toastManager.add({
        type: "warning",
        title: "A fork is already being prepared",
        description: "Wait for it to finish, then fork again.",
      });
    }
    return outcome ?? "not-accepted";
  };

  return { errorUpdate, isForking, forkFromMessage, prepareFork, preview } as const;
}
