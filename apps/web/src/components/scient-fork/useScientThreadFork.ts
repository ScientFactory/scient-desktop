import { sha256 } from "@noble/hashes/sha2";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  CommandId,
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type ThreadId,
  type ForkOptions,
} from "@t3tools/contracts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

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
import { type ForkAcceptanceOutcome, readFileAsDataUrl } from "../ChatView.logic";
import { stageForkViewContinuity } from "./forkViewContinuity";
import {
  createForkAttemptStore,
  deliverForkAttempt,
  forkAttemptKey,
  withForkOriginLock,
  subscribeForkOrigins,
  isForkOriginBusy,
} from "./forkAttempt";

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
    };
const sourceKey = (source: ForkSource) =>
  source.kind === "assistant-response" && source.latest
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
    return "This fork point has no saved Git checkpoint for a separate worktree. Choose Same workspace or a checkpointed fork point.";
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
}): Promise<void> {
  // Prepare every image before touching the store. A failed authorized read
  // therefore cannot leave a partial destination draft behind.
  const preparedAttachments = await prepareForkDraftAttachments(
    input.attachments,
    input.fetchAsset,
    input.readAsDataUrl,
  );
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
  supportsRecovery,
}: {
  readonly origin: ForkOrigin | null;
  readonly navigate: NavigateToThread;
  readonly supportsRecovery: boolean;
}) {
  const forkThread = useAtomCommand(threadEnvironment.fork, { reportFailure: false });
  const getForkOptions = useAtomCommand(threadEnvironment.getForkOptions, { reportFailure: false });
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
  useLayoutEffect(() => {
    activeOrigin.current = originKey;
  }, [originKey]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const previewSequence = useRef(0);

  const resolveOptions = useCallback(
    async (source: ForkSource): Promise<ForkOptions> => {
      if (!originId || !environmentId) throw new Error("The original conversation is unavailable.");
      if (!supportsRecovery)
        return {
          available: source.kind === "user-message" || source.messageId !== null,
          localAvailable: true,
          reason: null,
          newWorktree: true,
          sourceAssistantMessageId: source.kind === "assistant-response" ? source.messageId : null,
          sourceUserMessageId: source.kind === "user-message" ? source.messageId : null,
        };
      const result = await getForkOptions({
        environmentId,
        input: {
          originThreadId: originId,
          ...(source.kind === "user-message"
            ? { sourceUserMessageId: source.messageId }
            : source.latest || source.messageId === null
              ? {}
              : { sourceAssistantMessageId: source.messageId }),
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    },
    [originId, environmentId, supportsRecovery, getForkOptions],
  );

  const prepareFork = useCallback(
    async (source: ForkSource) => {
      if (!originId || !environmentId) return;
      const key = forkAttemptKey(environmentId, originId, sourceKey(source));
      const sequence = ++previewSequence.current;
      setErrorUpdate(null);
      setPreview({ key, options: null, checking: true, locked: false });
      try {
        const pending = attemptStore.get(key);
        const options = pending
          ? {
              available: true,
              localAvailable: true,
              reason: null,
              newWorktree: pending.command.workspaceMode === "new-worktree",
              sourceAssistantMessageId: pending.command.sourceAssistantMessageId ?? null,
              sourceUserMessageId: pending.command.sourceUserMessageId ?? null,
            }
          : await resolveOptions(source);
        if (
          sequence === previewSequence.current &&
          mounted.current &&
          activeOrigin.current === originKey
        ) {
          setPreview({
            key,
            options,
            checking: false,
            locked: pending !== null,
            ...(pending?.displayTitle === undefined ? {} : { retryTitle: pending.displayTitle }),
            ...(pending ? { retryWorkspaceMode: pending.command.workspaceMode } : {}),
          });
        }
      } catch (error) {
        if (
          sequence === previewSequence.current &&
          mounted.current &&
          activeOrigin.current === originKey
        ) {
          setPreview({ key, options: null, checking: false, locked: false });
          setErrorUpdate({
            threadId: originId,
            environmentId,
            message: userFacingForkError(error),
          });
        }
      }
    },
    [originId, environmentId, originKey, resolveOptions],
  );

  const forkFromMessage = useCallback(
    async (
      source: ForkSource,
      options: {
        readonly workspaceMode: "new-worktree" | "local";
        readonly titleOverride?: string;
        readonly displayTitle?: string;
        /** Move only portable unsent text/images after the fork command is accepted. */
        readonly composerDraftSource?: ScopedThreadRef;
      },
      originWorkspaceRoot: string | undefined,
    ): Promise<ForkAcceptanceOutcome> => {
      if (!originId || !environmentId) return "not-accepted";
      const outcome = await withForkOriginLock(
        originKey,
        async (): Promise<ForkAcceptanceOutcome> => {
          const key = forkAttemptKey(environmentId, originId, sourceKey(source));
          setErrorUpdate(null);
          try {
            let attempt = attemptStore.get(key);
            if (!attempt) {
              const eligibility = await resolveOptions(source);
              if (!eligibility.available)
                throw new Error(eligibility.reason ?? "This fork point is unavailable.");
              if (options.workspaceMode === "local" && !eligibility.localAvailable)
                throw new Error(eligibility.reason ?? "The original workspace is unavailable.");
              if (options.workspaceMode === "new-worktree" && !eligibility.newWorktree)
                throw new Error(
                  "The saved checkpoint is unavailable. Choose the current workspace or another fork point.",
                );
              const id = newThreadId();
              if (source.kind === "user-message")
                await stageUserForkDraft({
                  destinationRef: scopeThreadRef(environmentId, id),
                  prompt: source.prompt,
                  attachments: source.attachments,
                });
              attempt = {
                environmentId,
                ready: false,
                handoffDone: false,
                ...(options.displayTitle === undefined
                  ? {}
                  : { displayTitle: options.displayTitle }),
                ...(options.composerDraftSource
                  ? { composerDraftFingerprint: composerFingerprint(options.composerDraftSource) }
                  : {}),
                command: {
                  type: "thread.fork",
                  commandId: CommandId.make(`client:thread-fork:${id}`),
                  originThreadId: originId,
                  newThreadId: id,
                  workspaceMode: options.workspaceMode,
                  ...(options.titleOverride === undefined
                    ? {}
                    : { titleOverride: options.titleOverride }),
                  ...(eligibility.sourceAssistantMessageId
                    ? { sourceAssistantMessageId: eligibility.sourceAssistantMessageId }
                    : { sourceUserMessageId: eligibility.sourceUserMessageId! }),
                },
              };
              try {
                attemptStore.set(key, attempt);
              } catch (error) {
                // This fresh command has never been dispatched.
                clearStagedUserForkDraft(scopeThreadRef(environmentId, id));
                throw error;
              }
            }
            const destinationRef = scopeThreadRef(environmentId, attempt.command.newThreadId);
            attempt = await deliverForkAttempt({
              key,
              attempt,
              store: attemptStore,
              discardDraft: () => clearStagedUserForkDraft(destinationRef),
              dispatch: async (current) => {
                const result = await forkThread({ environmentId, input: current.command });
                if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              },
            });
            // Completing in the background must not steal navigation or a composer
            // from the conversation the user has since opened.
            if (!mounted.current || activeOrigin.current !== originKey) return "accepted";
            if (!attempt.handoffDone) {
              if (
                options.composerDraftSource &&
                attempt.composerDraftFingerprint ===
                  composerFingerprint(options.composerDraftSource)
              ) {
                moveAcceptedForkComposerDraft({
                  sourceRef: options.composerDraftSource,
                  destinationRef,
                });
              }
              try {
                stageForkViewContinuity({
                  originRef: scopeThreadRef(environmentId, originId),
                  destinationThreadId: attempt.command.newThreadId,
                  originWorkspaceRoot,
                });
              } catch {
                /* Panel continuity is optional; it cannot undo a ready fork. */
              }
              attempt = { ...attempt, handoffDone: true };
              attemptStore.set(key, attempt);
            }
            await navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: attempt.command.newThreadId },
            });
            attemptStore.delete(key);
            return "accepted";
          } catch (cause) {
            if (mounted.current && activeOrigin.current === originKey) {
              let pending = null;
              try {
                pending = attemptStore.get(key);
              } catch {
                /* Keep corrupt/unavailable storage untouched. */
              }
              setErrorUpdate({
                threadId: originId,
                environmentId,
                message: pending?.ready
                  ? "The fork is ready. Retry to open it; this will not create another conversation."
                  : `${userFacingForkError(cause)}${pending ? " Retry to resume this same fork; your draft is saved." : ""}`,
              });
              setPreview((current) =>
                current?.key === key ? { ...current, locked: pending !== null } : current,
              );
            }
            return "not-accepted";
          }
        },
      );
      if (outcome === null && mounted.current && activeOrigin.current === originKey) {
        setErrorUpdate({
          threadId: originId,
          environmentId,
          message:
            "A fork is already being prepared from this conversation. Wait for it to finish, then retry.",
        });
      }
      return outcome ?? "not-accepted";
    },
    [forkThread, navigate, originId, environmentId, originKey, resolveOptions],
  );

  return { errorUpdate, isForking, forkFromMessage, prepareFork, preview } as const;
}
