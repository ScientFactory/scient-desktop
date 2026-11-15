import type {
  EnvironmentId,
  ScientSourcesBackupStatus,
  ScientSourcesJoinStatus,
  ScientSourcesLibraryCopies,
  ScientSourcesRestoreStatus,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { toastManager } from "../../components/ui/toast";
import { useStableCallback } from "~/hooks/useStableCallback";
import { changeLibraryRestore, organizeScientSources, readLibraryBackupStatus } from "./client";
import { scientSourcesErrorMessage } from "./errorMessage";
import {
  BACKUP_LABELS,
  JOIN_LABELS,
  RESTORE_LABELS,
  backupDoneLabel,
  backupRunningLabel,
  joinDoneLabel,
  joinRunningLabel,
  joinStoppedLabel,
  restoreLine,
  restoreRefusedLabel,
  restoredLabel,
} from "./libraryBackupLabels";

const ASK_AGAIN_MS = 1_000;

/**
 * Environments whose backup this window started or saw running. Kept outside the panel, so the
 * end is announced once in this window also after a switch to another project or a reopened panel.
 */
const following = new Set<EnvironmentId>();
/** The same for adding from another Library. */
const followingJoin = new Set<EnvironmentId>();
/** How restores ended that this window has already said, by environment and restore. */
const said = new Set<string>();

function sayHowBackupEnded(environmentId: EnvironmentId, backup: ScientSourcesBackupStatus) {
  if (backup.state === "running") {
    following.add(environmentId);
    return;
  }
  if (!following.delete(environmentId)) return;
  if (backup.state === "done") {
    toastManager.add({
      type: "success",
      title: BACKUP_LABELS.done,
      description: backupDoneLabel(backup),
    });
  } else if (backup.state === "failed") {
    toastManager.add({ type: "error", title: BACKUP_LABELS.failed, description: backup.reason });
  }
}

function sayHowJoinEnded(environmentId: EnvironmentId, join: ScientSourcesJoinStatus) {
  if (join.state === "running") {
    followingJoin.add(environmentId);
    return;
  }
  if (!followingJoin.delete(environmentId)) return;
  if (join.state === "done") {
    toastManager.add({
      type: "success",
      title: join.added > 0 ? JOIN_LABELS.done : JOIN_LABELS.nothingNew,
      description: joinDoneLabel(join),
    });
  } else if (join.state === "failed") {
    // Some sources may have arrived before it failed: say so, not "nothing was added".
    toastManager.add({
      type: "error",
      title: join.added > 0 ? JOIN_LABELS.stopped : JOIN_LABELS.failed,
      description: join.added > 0 ? joinStoppedLabel(join) : join.reason,
    });
  }
}

/** A restore ends at a start of Scient, so no window saw it running: each says it once. */
function sayHowRestoreEnded(environmentId: EnvironmentId, restore: ScientSourcesRestoreStatus) {
  const once = (id: string) => {
    const key = `${environmentId}\0${id}`;
    if (said.has(key)) return false;
    said.add(key);
    return true;
  };
  if (restore.state === "restored") {
    if (!once(restore.restoreId)) return;
    toastManager.add({
      type: "success",
      title: RESTORE_LABELS.restored,
      description: restoredLabel(restore),
    });
  } else if (restore.state === "failed") {
    if (!once(restore.failedAt)) return;
    toastManager.add({ type: "error", title: RESTORE_LABELS.failed, description: restore.reason });
  } else if (restore.state === "ready" && restore.refused) {
    // Another backup was asked for and refused; the one that was ready still waits.
    if (!once(restore.refused.failedAt)) return;
    toastManager.add({
      type: "error",
      title: RESTORE_LABELS.failed,
      description: restoreRefusedLabel(restore) ?? restore.refused.reason,
    });
  }
}

const NOTHING: ScientSourcesLibraryCopies = {
  backup: { state: "none" },
  restore: { state: "none" },
  join: { state: "none" },
};

/**
 * The Library's backup and restore on this environment. A backup is started into a chosen
 * folder and followed until it ends. A restore is prepared from a chosen backup folder; its
 * copy then waits for the next start of Scient, and can be cancelled until then. Both run on in
 * the server, so a panel that opens meanwhile shows them too.
 */
export function useLibraryBackup(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  /** False where the Library is not kept (a project that keeps its own sources). */
  readonly enabled: boolean;
  /** Called when adding from another Library has put new sources in this one. */
  readonly onAdded?: () => void;
}) {
  const context = `${input.environmentId}\0${input.root}`;
  const [reading, setReading] = useState<{
    readonly context: string;
    readonly copies: ScientSourcesLibraryCopies;
  } | null>(null);
  const copies = input.enabled && reading?.context === context ? reading.copies : null;
  const working =
    copies?.backup.state === "running" ||
    copies?.restore.state === "preparing" ||
    copies?.join.state === "running";
  /** No answer yet for this Library: asked again until one comes. */
  const unread = input.enabled && copies === null;
  /** The context a read is under way for: one read at a time, so a slow one is not restarted. */
  const asking = useRef<string | null>(null);
  /** The context the panel shows now; an answer for another one (a project left) is dropped. */
  const shown = useStableCallback(() => (input.enabled ? context : null));

  const show = (asked: string, next: Partial<ScientSourcesLibraryCopies>) => {
    if (shown() !== asked) return false;
    setReading((previous) => ({
      context: asked,
      copies: { ...(previous?.context === asked ? previous.copies : NOTHING), ...next },
    }));
    return true;
  };

  const load = useStableCallback(async (asked: string) => {
    if (asking.current === asked) return;
    asking.current = asked;
    const next = await readLibraryBackupStatus(input.environmentId, input.root).catch(() => null);
    if (asking.current === asked) asking.current = null;
    // A failed read changes nothing: the last answer stands and the timer asks again.
    if (!next || !show(asked, next)) return;
    sayHowBackupEnded(input.environmentId, next.backup);
    sayHowRestoreEnded(input.environmentId, next.restore);
    const ended = next.join.state !== "running" && followingJoin.has(input.environmentId);
    sayHowJoinEnded(input.environmentId, next.join);
    // New sources are in the Library, also when it stopped part way: the list is read again.
    if (ended && next.join.state !== "none" && next.join.added > 0) input.onAdded?.();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the backup's and the restore's status from the environment server when the panel opens on a Library
  useEffect(() => {
    if (input.enabled) void load(context);
  }, [input.enabled, context, load]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the environment server again on a timer while a backup or a restore's copy runs, or while no answer has come yet, whether or not the last read succeeded; unmounting stops it
  useEffect(() => {
    if (!working && !unread) return;
    const timer = window.setInterval(() => void load(context), ASK_AGAIN_MS);
    return () => window.clearInterval(timer);
  }, [working, unread, context, load]);

  const failed = (title: string) => (cause: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: scientSourcesErrorMessage(cause, import.meta.env.DEV),
    });
  };

  const start = (inFolder: string) => {
    const asked = context;
    return organizeScientSources(input.environmentId, {
      root: input.root,
      change: { action: "back-up-library", inFolder },
    }).then(() => {
      // The server said it runs; shown at once, so the timer asks even if the next read fails.
      following.add(input.environmentId);
      show(asked, { backup: { state: "running", done: 0, total: 0 } });
      return load(asked);
    }, failed(BACKUP_LABELS.failed));
  };

  const changeRestore = (
    change: { action: "prepare"; fromFolder: string } | { action: "cancel" },
  ) => {
    const asked = context;
    return changeLibraryRestore(input.environmentId, { root: input.root, change }).then(
      (restore) => {
        show(asked, { restore });
        sayHowRestoreEnded(input.environmentId, restore);
      },
      failed(RESTORE_LABELS.failed),
    );
  };

  const addFrom = (fromFolder: string) => {
    const asked = context;
    return organizeScientSources(input.environmentId, {
      root: input.root,
      change: { action: "add-from-library", fromFolder },
    }).then(() => {
      followingJoin.add(input.environmentId);
      show(asked, { join: { state: "running", done: 0, total: 0 } });
      return load(asked);
    }, failed(JOIN_LABELS.failed));
  };

  return {
    joinLine: copies ? joinRunningLabel(copies.join) : null,
    /** Adds what a backup, or a Library a restore replaced, holds and this Library lacks. */
    addFrom,
    line: copies ? backupRunningLabel(copies.backup) : null,
    start,
    restoreLine: copies ? restoreLine(copies.restore) : null,
    /** Offered while a checked copy waits for the next start. */
    cancelRestore:
      copies?.restore.state === "ready" ? () => changeRestore({ action: "cancel" }) : undefined,
    restoreFrom: (fromFolder: string) => changeRestore({ action: "prepare", fromFolder }),
  };
}

/** One line beside the store notices while a backup runs, and one while a restore is on its way. */
export function LibraryBackupNotice(props: {
  readonly line: string | null;
  readonly joinLine?: string | null;
  readonly restoreLine?: string | null;
  readonly onCancelRestore?: (() => void) | undefined;
}) {
  return (
    <>
      {props.line ? (
        <div
          role="status"
          className="mx-3 mt-2 text-xs break-words text-muted-foreground tabular-nums"
        >
          {props.line}
        </div>
      ) : null}
      {props.joinLine ? (
        <div
          role="status"
          className="mx-3 mt-2 text-xs break-words text-muted-foreground tabular-nums"
        >
          {props.joinLine}
        </div>
      ) : null}
      {props.restoreLine ? (
        <div className="mx-3 mt-2 flex items-start gap-2 text-xs text-muted-foreground">
          <div role="status" className="min-w-0 flex-1 break-words tabular-nums">
            {props.restoreLine}
          </div>
          {props.onCancelRestore ? (
            <Button size="xs" variant="ghost" onClick={props.onCancelRestore}>
              {RESTORE_LABELS.cancel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
