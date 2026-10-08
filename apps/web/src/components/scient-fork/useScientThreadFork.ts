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
const CHECKED_FORK_OPTIONS_REUSE_MS = 30_000;
const sourceKey = (source: ForkSource) =>
  source.kind === "running-turn"
    ? `running-turn:${source.runId}`
    : source.kind === "assistant-response" && source.latest
      ? "latest"
      : `${source.kind}:${source.messageId}`;

// SCIENT-FORK:START — `thread.fork` is a V1-only command, but it rides the
// `orchestration.dispatchCommand` tag that V1 and V2 both register. The client
// resolves that tag to V2's `{ sequence }` result, while the server still
// returns V1's optional attachment receipt, so read it off the raw payload.
function readForkAttachmentIdMap(receipt: object): Readonly<Record<string, string>> | undefined {
  if (!("forkAttachmentIdMap" in receipt)) return undefined;
  const map: unknown = receipt.forkAttachmentIdMap;
  if (map === null || typeof map !== "object" || Array.isArray(map)) return undefined;
  return Object.fromEntries(
    Object.entries(map).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
// SCIENT-FORK:END

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
    /** The fork point the error is about; another point's dialog does not show it. */
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
  // The options the open fork menu just checked. Submitting from it uses them
  // once instead of checking again; the server checks the fork itself anyway.
  const checkedOptions = useRef<{ key: string; options: ForkOptions; at: number } | null>(null);

  const resolveOptions = useCallback(
    async (source: ForkSource): Promise<ForkOptions> => {
      if (!originId || !environmentId) throw new Error("The original conversation is unavailable.");
      if (!supportsRecovery)
        return {
          // Older servers cannot fork a running turn.
          available:
            source.kind === "user-message" ||
            (source.kind === "assistant-response" && source.messageId !== null),
          localAvailable: true,
          reason:
            source.kind === "running-turn"
              ? "Update the server to fork a conversation while the agent is working."
              : null,
          newWorktree: true,
          sourceAssistantMessageId: source.kind === "assistant-response" ? source.messageId : null,
          sourceUserMessageId: source.kind === "user-message" ? source.messageId : null,
        };
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
              sourceRunningRunId: pending.command.sourceRunningRunId ?? null,
            }
          : await resolveOptions(source);
        if (
          sequence === previewSequence.current &&
          mounted.current &&
          activeOrigin.current === originKey
        ) {
          // Only the menu being shown publishes its options for reuse.
          if (!pending) checkedOptions.current = { key, options, at: Date.now() };
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
            key,
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
        /** Complete the source dialog exit before changing the conversation. */
        readonly beforeNavigate?: () => Promise<boolean>;
        readonly confirmSkippedImages?: (names: ReadonlyArray<string>) => Promise<boolean>;
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
              const checked = checkedOptions.current;
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
              if (!eligibility.available)
                throw new Error(eligibility.reason ?? "This fork point is unavailable.");
              // A server that does not know running-turn forks answers for the
              // latest response instead; never fork that under this label.
              if (source.kind === "running-turn" && eligibility.sourceRunningRunId !== source.runId)
                throw new Error(
                  "This server cannot fork while the agent is working. Update Scient, or fork once the turn finishes.",
                );
              if (options.workspaceMode === "local" && !eligibility.localAvailable)
                throw new Error(eligibility.reason ?? "The original workspace is unavailable.");
              if (options.workspaceMode === "new-worktree" && !eligibility.newWorktree)
                throw new Error(
                  "The saved checkpoint is unavailable. Choose the current workspace or another fork point.",
                );
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
                  ...(eligibility.sourceRunningRunId
                    ? { sourceRunningRunId: eligibility.sourceRunningRunId }
                    : eligibility.sourceAssistantMessageId
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
                return readForkAttachmentIdMap(result.value);
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
                  threadId: attempt.command.newThreadId,
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
                key,
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
          key: forkAttemptKey(environmentId, originId, sourceKey(source)),
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
