// FILE: forkProvenance.ts
// Purpose: Resolve stable, truthful presentation data for a forked conversation's transcript marker.
// Layer: Web chat presentation helpers

import type { MessageId, ThreadId } from "@synara/contracts";

export interface ForkProvenance {
  sourceThreadId: ThreadId;
  sourceMessageId: MessageId | null;
  sourceTitle: string | null;
  sourceAvailable: boolean;
}

interface ForkProvenanceThread {
  id: ThreadId;
  forkSourceThreadId?: ThreadId | null;
  forkSourceMessageId?: MessageId | null;
  forkTitleBase?: string | null;
  sidechatSourceThreadId?: ThreadId | null;
}

interface ForkSourceThread {
  id: ThreadId;
  title: string;
}

function normalizedTitle(value: string | null | undefined): string | null {
  const title = value?.trim();
  return title ? title : null;
}

/** Uses only fork metadata plus the lightweight source thread summary. */
export function resolveForkProvenance(
  thread: ForkProvenanceThread,
  sourceThread: ForkSourceThread | null | undefined,
): ForkProvenance | null {
  const sourceThreadId = thread.forkSourceThreadId ?? null;
  // Sidechats share fork metadata internally but are presented through their
  // own "Side" identity. Do not mislabel them as user-created conversation forks.
  if (!sourceThreadId || thread.sidechatSourceThreadId) {
    return null;
  }

  const sourceAvailable = sourceThread?.id === sourceThreadId && sourceThreadId !== thread.id;
  return {
    sourceThreadId,
    sourceMessageId: thread.forkSourceMessageId ?? null,
    // `forkTitleBase` is intentionally not a fallback here: for a fork of an
    // automatically titled fork it names the title family (for example,
    // "Experiment"), not necessarily the immediate source ("Experiment (2)").
    // Generic unavailable copy is more truthful than a plausible wrong title.
    sourceTitle: normalizedTitle(sourceAvailable ? sourceThread.title : null),
    sourceAvailable,
  };
}
