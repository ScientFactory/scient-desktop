import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, MessageId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";

import {
  flushComposerDraftPersistence,
  type ComposerImageAttachment,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { newThreadId } from "~/lib/utils";
import type { ChatAttachment } from "~/types";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { readFileAsDataUrl, waitForStartedServerThread } from "../ChatView.logic";
import { stageForkViewContinuity } from "./forkViewContinuity";

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

function userFacingForkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
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
  return "Failed to fork this conversation.";
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

export function useScientThreadFork({
  origin,
  navigate,
}: {
  readonly origin: ForkOrigin | null;
  readonly navigate: NavigateToThread;
}) {
  const forkThread = useAtomCommand(threadEnvironment.fork, { reportFailure: false });
  const [isForking, setIsForking] = useState(false);
  const [errorUpdate, setErrorUpdate] = useState<{
    readonly threadId: ThreadId;
    readonly message: string | null;
  } | null>(null);
  const inFlightRef = useRef(false);

  const forkFromMessage = useCallback(
    async (
      source:
        | { readonly kind: "assistant-response"; readonly messageId: MessageId }
        | {
            readonly kind: "user-message";
            readonly messageId: MessageId;
            readonly prompt: string;
            readonly attachments: ReadonlyArray<ChatAttachment>;
          },
      workspaceMode: "new-worktree" | "local",
      originWorkspaceRoot: string | undefined,
    ) => {
      if (!origin || inFlightRef.current) return;
      const forkThreadId = newThreadId();
      const destinationRef = scopeThreadRef(origin.environmentId, forkThreadId);
      let stagedDraft = false;
      let forkAccepted = false;
      inFlightRef.current = true;
      setIsForking(true);
      setErrorUpdate({ threadId: origin.id, message: null });
      try {
        if (source.kind === "user-message") {
          await stageUserForkDraft({
            destinationRef,
            prompt: source.prompt,
            attachments: source.attachments,
          });
          stagedDraft = true;
        }
        const result = await forkThread({
          environmentId: origin.environmentId,
          input: {
            originThreadId: origin.id,
            newThreadId: forkThreadId,
            ...(source.kind === "assistant-response"
              ? { sourceAssistantMessageId: source.messageId }
              : { sourceUserMessageId: source.messageId }),
            workspaceMode,
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            setErrorUpdate({
              threadId: origin.id,
              message: userFacingForkError(error),
            });
          }
          return;
        }
        forkAccepted = true;
        stageForkViewContinuity({
          originRef: scopeThreadRef(origin.environmentId, origin.id),
          destinationThreadId: forkThreadId,
          originWorkspaceRoot,
        });
        const forkVisible = await waitForStartedServerThread(destinationRef, 5_000);
        if (!forkVisible) {
          setErrorUpdate({
            threadId: origin.id,
            message:
              "The fork was created, but it is not available in the app yet. Open it from the sidebar or try again.",
          });
          return;
        }
        await navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: origin.environmentId, threadId: forkThreadId },
        });
      } catch (cause) {
        setErrorUpdate({
          threadId: origin.id,
          message: userFacingForkError(cause),
        });
      } finally {
        if (stagedDraft && !forkAccepted) {
          clearStagedUserForkDraft(destinationRef);
        }
        inFlightRef.current = false;
        setIsForking(false);
      }
    },
    [forkThread, navigate, origin],
  );

  return { errorUpdate, isForking, forkFromMessage } as const;
}
