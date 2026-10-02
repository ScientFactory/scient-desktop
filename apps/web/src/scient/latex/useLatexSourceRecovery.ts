import { useEffect, useState } from "react";
import type { MarkdownPersistenceLease } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { documentWasSaved } from "~/scient/markdownEditor/persistence/documentPublication";
import {
  checkpointVisualDraft,
  confirmVisualDraft,
  discardVisualDraft,
  flushVisualDraft,
} from "./visualDrafts";
import {
  isRecoveryStored,
  journalAppliedRecovery,
  readStartupRecovery,
  readStoredRecovery,
  removeRecovery,
  type LatexVisualRecovery,
} from "./visualRecovery";

/** Accepted Source and Visual edits share the existing, explicitly applied recovery store. */
export function useLatexSourceRecovery(
  lease: MarkdownPersistenceLease | null,
  key: string,
  presentation = "source",
) {
  const [offered, setOffered] = useState<{
    key: string;
    recovery: LatexVisualRecovery | null;
  } | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const recovery = offered?.key === key ? offered.recovery : null;
  useEffect(() => {
    if (lease === null) return;
    let previous = lease.getSnapshot();
    setOffered({
      key,
      recovery: readStartupRecovery(key, { source: previous.draftSource }).recovery,
    });
    let ownDraft: { source: string; baseRevision: string } | null = null;
    const checkpoint = () => {
      const snapshot = lease.getSnapshot();
      if (!snapshot.pending || snapshot.draftSource === snapshot.baselineSource) return;
      ownDraft = { source: snapshot.draftSource, baseRevision: snapshot.baselineRevision };
      checkpointVisualDraft(
        key,
        snapshot.draftSource,
        snapshot.baselineSource,
        snapshot.draftSource,
        snapshot.baselineRevision,
      );
    };
    checkpoint();
    const stop = lease.subscribe(() => {
      const next = lease.getSnapshot();
      const before = previous;
      previous = next;
      if (documentWasSaved(before, next)) {
        confirmVisualDraft(key, next.baselineSource);
        if (ownDraft?.source === next.baselineSource) ownDraft = null;
        if (!next.pending) setStorageFailed(false);
      }
      if (next.pending && next.draftSource !== before.draftSource) checkpoint();
      else if (!next.pending && ownDraft !== null) {
        // Acknowledgement, undo to disk, or an explicit choice of disk retires
        // only the accepted draft observed by this subscriber.
        discardVisualDraft(key, ownDraft);
        ownDraft = null;
      }
    });
    const failed = (event: Event) => {
      if ((event as CustomEvent<string>).detail === key) setStorageFailed(true);
    };
    const flush = () => {
      flushVisualDraft(key);
    };
    window.addEventListener("scient-latex-recovery-error", failed);
    window.addEventListener("pagehide", flush);
    return () => {
      stop();
      flush();
      window.removeEventListener("scient-latex-recovery-error", failed);
      window.removeEventListener("pagehide", flush);
    };
  }, [key, lease]);

  useEffect(() => {
    // Visual can resolve the same offered record while Source is hidden.
    // Refresh parked records on view changes, without parking the live draft.
    setOffered((shown) => {
      if (shown?.key !== key) return shown;
      if (shown.recovery && !shown.recovery.parked && isRecoveryStored(key, shown.recovery))
        return shown;
      const next = readStoredRecovery(key);
      return next?.identity === shown.recovery?.identity ? shown : { key, recovery: next };
    });
  }, [key, presentation]);

  const settle = (shown: LatexVisualRecovery, resolved: boolean) => {
    if (!resolved && isRecoveryStored(key, shown)) return;
    const current = lease?.getSnapshot();
    setOffered({
      key,
      recovery: current
        ? readStartupRecovery(key, { source: current.draftSource }).recovery
        : readStoredRecovery(key),
    });
  };
  return {
    recovery,
    storageFailed,
    blocked: recovery !== null && !recovery.parked,
    apply: (comparedSource: string) => {
      if (lease === null || recovery?.source == null) return false;
      if (!isRecoveryStored(key, recovery)) {
        settle(recovery, false);
        return false;
      }
      const before = lease.getSnapshot();
      if (
        before.draftSource !== comparedSource ||
        !lease.change(recovery.source, before.editVersion)
      )
        return false;
      const resolved = journalAppliedRecovery(
        key,
        { ...recovery, source: recovery.source },
        {
          source: before.draftSource,
          revision: before.baselineRevision,
        },
      );
      settle(recovery, resolved);
      return true;
    },
    discard: () => {
      if (recovery !== null) settle(recovery, removeRecovery(key, recovery));
    },
  };
}
