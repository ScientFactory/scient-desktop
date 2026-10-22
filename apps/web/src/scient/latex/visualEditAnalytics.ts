import type { FinishScientUiOperation } from "../analytics/clientGate";
import { documentWasSaved } from "../markdownEditor/persistence/documentPublication";
import type { MarkdownPersistenceLease } from "../markdownEditor/persistence/markdownPersistenceRegistry";

type SourceLease = Pick<MarkdownPersistenceLease, "getSnapshot" | "subscribe">;

/** One autosave batch per edited source owner, not per keystroke or document.
 * Source is inspected locally by the existing publication predicate only.
 * The analytics boundary accepts an outcome, never source, paths or errors.
 */
export function createVisualEditAnalytics(begin: () => FinishScientUiOperation) {
  const pending = new Map<
    SourceLease,
    { editVersion: number; stop: () => void; finish: FinishScientUiOperation }
  >();
  let refused = false;
  return {
    accepted(lease: SourceLease, beforeEditVersion: number) {
      const initial = lease.getSnapshot();
      if (initial.editVersion <= beforeEditVersion || !initial.pending) return;
      refused = false;
      const existing = pending.get(lease);
      if (existing) {
        existing.editVersion = initial.editVersion;
        return;
      }
      const finish = begin();
      let previous = initial;
      const entry = { editVersion: initial.editVersion, stop: () => {}, finish };
      const complete = (outcome: Parameters<FinishScientUiOperation>[0]) => {
        pending.delete(lease);
        entry.stop();
        finish(outcome);
      };
      const inspect = () => {
        const next = lease.getSnapshot();
        const saved =
          documentWasSaved(previous, next) && next.confirmedEditVersion >= entry.editVersion;
        previous = next;
        // A later Source-only edit must not delay or fail an already saved Visual edit.
        if (saved) {
          complete("completed");
        } else if (next.error !== null || next.conflict !== null) {
          complete("failed");
        } else if (!next.pending) {
          complete("cancelled");
        }
      };
      pending.set(lease, entry);
      const unsubscribe = lease.subscribe(inspect);
      entry.stop = unsubscribe;
      inspect();
    },
    refused() {
      if (refused) return;
      refused = true;
      begin()("failed");
    },
    dispose() {
      // Closing a view is not evidence that a still-owned background save failed.
      for (const entry of pending.values()) {
        entry.stop();
        entry.finish(null);
      }
      pending.clear();
    },
  };
}
