import type {
  EnvironmentId,
  ScientSourcesMoveStatus,
  ScientSourcesOverviewResult,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { toastManager } from "../../components/ui/toast";
import { useStableCallback } from "~/hooks/useStableCallback";
import { organizeScientSources, readLibraryMoveStatus } from "./client";
import { scientSourcesErrorMessage } from "./errorMessage";
import { libraryMoveCanGoBack, libraryMoveLine, libraryMoveRunning } from "./libraryMoveStatus";
import { onLibraryWriteSettled } from "./libraryWrites";
import { sourcesCommands, useCanRunSourcesCommand } from "./sourcesCommands";

const ASK_AGAIN_MS = 1_000;
const ASK_AFTER_FAILURE_MS = 5_000;

const message = (error: unknown) => scientSourcesErrorMessage(error, import.meta.env.DEV);

// Outside the hook: the React Compiler does not compile try/finally.
async function settle<A>(work: () => Promise<A>, settled: () => void): Promise<A> {
  try {
    return await work();
  } finally {
    settled();
  }
}

/**
 * The project's move into the personal Library. Asked only on a server that keeps one: when the
 * panel opens, after each Library change, about once a second while the move waits or runs, and
 * every few seconds after a read that failed.
 */
export function useLibraryMoveStatus(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly overview: ScientSourcesOverviewResult | null;
  /** The project's store changed under the panel: a move or a move back finished. */
  readonly onStoreChanged: () => void;
}) {
  const tracked =
    input.overview?.projectState === "initialized" && input.overview.libraryBackend === true;
  const context = `${input.environmentId}\0${input.root}`;
  const [reading, setReading] = useState<{
    readonly context: string;
    /** Null until a read answers; a failed read keeps the last answer. */
    readonly status: ScientSourcesMoveStatus | null;
    readonly failed: boolean;
    /** The ask this answers, so the next timer starts from the answer. */
    readonly ask: number;
  } | null>(null);
  const status = tracked && reading?.context === context ? reading.status : null;
  const [asks, setAsks] = useState(0);
  const [movingBack, setMovingBack] = useState(false);
  const canChange = useCanRunSourcesCommand(sourcesCommands.organize, input.environmentId);
  const lastState = useRef<{ readonly context: string; readonly running: boolean } | null>(null);
  const onStoreChanged = useStableCallback(input.onStoreChanged);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the move's status from the environment server when the panel opens on a library server, and again when asked
  useEffect(() => {
    if (!tracked) return;
    let current = true;
    void readLibraryMoveStatus(input.environmentId, input.root).then(
      (next) => {
        if (!current) return;
        const was = lastState.current?.context === context ? lastState.current.running : false;
        const running = libraryMoveRunning(next);
        lastState.current = { context, running };
        setReading({ context, status: next, failed: false, ask: asks });
        if (was && !running) onStoreChanged();
      },
      () => {
        if (!current) return;
        setReading((previous) => ({
          context,
          status: previous?.context === context ? previous.status : null,
          failed: true,
          ask: asks,
        }));
      },
    );
    return () => {
      current = false;
    };
  }, [tracked, context, input.environmentId, input.root, asks, onStoreChanged]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the environment server again on a timer after each answer while the move waits or runs, and after a failed read; unmounting stops it
  useEffect(() => {
    if (!tracked) return;
    const answered = reading?.context === context ? reading : null;
    const wait =
      movingBack || libraryMoveRunning(answered?.status ?? null)
        ? ASK_AGAIN_MS
        : answered?.failed
          ? ASK_AFTER_FAILURE_MS
          : null;
    if (wait === null) return;
    const timer = window.setTimeout(() => setAsks((value) => value + 1), wait);
    return () => window.clearTimeout(timer);
  }, [tracked, movingBack, reading, context]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a Library change on this environment, landed or refused because the Library is moving, asks for the status again
  useEffect(() => {
    if (!tracked) return;
    return onLibraryWriteSettled((environmentId) => {
      if (environmentId === input.environmentId) setAsks((value) => value + 1);
    });
  }, [tracked, input.environmentId]);

  const dismiss = () =>
    organizeScientSources(input.environmentId, {
      root: input.root,
      change: { action: "dismiss-move-summary" },
    }).catch((cause: unknown) => {
      toastManager.add({
        type: "error",
        title: "The summary was not dismissed",
        description: message(cause),
      });
    });

  const moveBack = () => {
    setMovingBack(true);
    return settle(
      async () => {
        await organizeScientSources(input.environmentId, {
          root: input.root,
          change: { action: "move-back" },
        }).catch(async (cause: unknown) => {
          // The move back goes on after a lost answer; the status line shows it, not an error.
          const after = await readLibraryMoveStatus(input.environmentId, input.root).catch(
            () => null,
          );
          if (after?.state === "restoring" || after?.state === "moved-back") return;
          if (after === null) {
            // Unknown, not failed: the status is asked again until it answers.
            setAsks((value) => value + 1);
            toastManager.add({
              type: "warning",
              title: "Moving back could not be confirmed",
              description:
                "The answer was lost and the Library's status could not be read. It is checked again every few seconds.",
            });
            return;
          }
          toastManager.add({
            type: "error",
            title: "The Library was not moved back",
            description: message(cause),
          });
        });
        onStoreChanged();
      },
      () => setMovingBack(false),
    );
  };

  return {
    line: libraryMoveLine(status, { movingBack }),
    /** Dismiss and Move back need the Library grant; a read-only session sees the line only. */
    canChange,
    canMoveBack: canChange && !movingBack && libraryMoveCanGoBack(status),
    dismiss,
    retry: () => setAsks((value) => value + 1),
    moveBack,
  };
}

export type LibraryMoveStatus = ReturnType<typeof useLibraryMoveStatus>;
