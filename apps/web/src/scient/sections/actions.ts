import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, type ScopedThreadRef, ThreadId, ThreadSectionId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { showThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import * as ThreadUndo from "../../hooks/threadUndo";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThreadShell } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { SectionRef } from "./logic";

export class ThreadSectionsUnsupportedError extends Schema.TaggedError<ThreadSectionsUnsupportedError>()(
  "ThreadSectionsUnsupportedError",
  { environmentId: EnvironmentId, threadId: ThreadId },
) {
  override get message(): string {
    return "This environment's server does not support thread sections yet. Update it to use sections.";
  }
}

export class ThreadSectionElsewhereError extends Schema.TaggedError<ThreadSectionElsewhereError>()(
  "ThreadSectionElsewhereError",
  { environmentId: EnvironmentId, threadId: ThreadId },
) {
  override get message(): string {
    return "That section belongs to another machine. A thread can only join sections on its own machine.";
  }
}

/** Whether the thread's server accepts thread.section.set. */
export function readEnvironmentSupportsSections(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSections === true
  );
}

/** Whether the thread's server accepts order-key writes for pinned or active rows. */
export function readEnvironmentSupportsThreadReorder(
  environmentId: EnvironmentId,
  group: "pinned" | "active",
): boolean {
  const capabilities = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)
    ?.environment.capabilities;
  return (
    (group === "pinned" ? capabilities?.threadPinReorder : capabilities?.threadActiveReorder) ===
    true
  );
}

/**
 * Membership writes. A thread joins only sections of its own environment's
 * catalog, so every write names the section's environment and is refused
 * for any other. Section moves are undoable from the sidebar notice (⌘Z).
 */
export function useThreadSectionActions() {
  const setSectionMutation = useAtomCommand(threadEnvironment.setSection, {
    reportFailure: false,
  });

  /** One write, no notice. Skips threads already in the target section; null files in General. */
  const setThreadSection = useCallback(
    async (target: ScopedThreadRef, section: SectionRef | null) => {
      const sectionId = section === null ? null : ThreadSectionId.make(section.sectionId);
      if ((readThreadShell(target)?.sectionId ?? null) === sectionId) {
        return AsyncResult.success(undefined);
      }
      if (section !== null && section.environmentId !== target.environmentId) {
        return AsyncResult.failure(
          Cause.fail(
            new ThreadSectionElsewhereError({
              environmentId: target.environmentId,
              threadId: target.threadId,
            }),
          ),
        );
      }
      if (!readEnvironmentSupportsSections(target.environmentId)) {
        return AsyncResult.failure(
          Cause.fail(
            new ThreadSectionsUnsupportedError({
              environmentId: target.environmentId,
              threadId: target.threadId,
            }),
          ),
        );
      }
      return setSectionMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, sectionId },
      });
    },
    [setSectionMutation],
  );

  /** Files threads into a section (null: General) and offers Undo. */
  const moveThreadsToSection = useCallback(
    async (targets: readonly ScopedThreadRef[], section: SectionRef | null) => {
      const moves = targets.flatMap((target) => {
        const previous = readThreadShell(target)?.sectionId ?? null;
        return previous === (section?.sectionId ?? null) ? [] : [{ target, previous }];
      });
      const results = await Promise.all(
        moves.map(async ({ target, previous }) => {
          const claim = ThreadUndo.begin("section", scopedThreadKey(target));
          const result = await setThreadSection(target, section);
          if (result._tag === "Failure") {
            claim.finish();
            return result;
          }
          showThreadUndoNotice({
            action: "Moved",
            claim,
            undo: () =>
              setThreadSection(
                target,
                previous === null
                  ? null
                  : { environmentId: target.environmentId, sectionId: previous },
              ),
            failureTitle: "Failed to undo section move",
          });
          return result;
        }),
      );
      const failures = results.filter(
        (result) => result._tag === "Failure" && !isAtomCommandInterrupted(result),
      );
      const firstFailure = failures[0];
      if (firstFailure !== undefined && firstFailure._tag === "Failure") {
        const error = squashAtomCommandFailure(firstFailure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title:
              moves.length === 1
                ? "Failed to move thread to section"
                : `Failed to move ${failures.length} of ${moves.length} threads`,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return results.every((result) => result._tag === "Success");
    },
    [setThreadSection],
  );

  return { setThreadSection, moveThreadsToSection };
}
