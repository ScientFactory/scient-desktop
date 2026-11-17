import type {
  EnvironmentId,
  ScientSourcesBackupStatus,
  ScientSourcesJoinStatus,
  ScientSourcesLibraryCopies,
  ScientSourcesRestoreStatus,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { useStableCallback } from "~/hooks/useStableCallback";
import { randomUUID } from "../../lib/utils";
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
import type { SourcesActivityItem, SourcesResultContent } from "./sourcesFeedback";

const ASK_AGAIN_MS = 1_000;

type CopyKind = "backup" | "join" | "restore";

/** How a backup, an addition from another Library or a restore ended, said once per window. */
export interface LibraryCopyEnding {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly kind: CopyKind;
  /** The result-slot operation that started it in this window; null for one seen running. */
  readonly operationId: string | null;
  readonly failed: boolean;
  readonly title: string;
  readonly description: string;
}

/**
 * What this window started or saw running, by environment and kind, with the operation that
 * started it. Kept outside the panel, so the end is said once in this window also after a switch
 * to another project or a reopened panel.
 */
const following = new Map<string, string | null>();
/** How restores ended that this window has already said, by environment and restore. */
const said = new Set<string>();

const followKey = (environmentId: EnvironmentId, kind: CopyKind) => `${environmentId}\0${kind}`;

/** Marks work as followed; a later status that shows it ended is then said. */
function follow(environmentId: EnvironmentId, kind: CopyKind, operationId: string | null) {
  const key = followKey(environmentId, kind);
  if (operationId !== null || !following.has(key)) following.set(key, operationId);
}

/** The operation that followed work of this kind, removed; undefined when none did. */
function stopFollowing(environmentId: EnvironmentId, kind: CopyKind): string | null | undefined {
  const key = followKey(environmentId, kind);
  if (!following.has(key)) return undefined;
  const operationId = following.get(key) ?? null;
  following.delete(key);
  return operationId;
}

function backupEnding(
  environmentId: EnvironmentId,
  backup: ScientSourcesBackupStatus,
): LibraryCopyEnding | null {
  if (backup.state === "running") {
    follow(environmentId, "backup", null);
    return null;
  }
  if (backup.state === "none") return null;
  const operationId = stopFollowing(environmentId, "backup");
  if (operationId === undefined) return null;
  const ending = { key: `backup\0${backup.finishedAt}`, environmentId, kind: "backup" as const };
  return backup.state === "done"
    ? {
        ...ending,
        operationId,
        failed: false,
        title: BACKUP_LABELS.done,
        description: backupDoneLabel(backup),
      }
    : {
        ...ending,
        operationId,
        failed: true,
        title: BACKUP_LABELS.failed,
        description: backup.reason,
      };
}

function joinEnding(
  environmentId: EnvironmentId,
  join: ScientSourcesJoinStatus,
): LibraryCopyEnding | null {
  if (join.state === "running") {
    follow(environmentId, "join", null);
    return null;
  }
  if (join.state === "none") return null;
  const operationId = stopFollowing(environmentId, "join");
  if (operationId === undefined) return null;
  if (join.state === "done") {
    return {
      key: `join\0${join.joinId}`,
      environmentId,
      kind: "join",
      operationId,
      failed: false,
      title: join.added > 0 ? JOIN_LABELS.done : JOIN_LABELS.nothingNew,
      description: joinDoneLabel(join),
    };
  }
  // Some sources may have arrived before it failed: say so, not "nothing was added".
  return {
    key: `join\0${join.failedAt}`,
    environmentId,
    kind: "join",
    operationId,
    failed: true,
    title: join.added > 0 ? JOIN_LABELS.stopped : JOIN_LABELS.failed,
    description: join.added > 0 ? joinStoppedLabel(join) : join.reason,
  };
}

/** A restore ends at a start of Scient, so no window saw it running: each says it once. */
function restoreEnding(
  environmentId: EnvironmentId,
  restore: ScientSourcesRestoreStatus,
): LibraryCopyEnding | null {
  const once = (id: string) => {
    const key = `${environmentId}\0${id}`;
    if (said.has(key)) return false;
    said.add(key);
    return true;
  };
  const ending = (id: string, failed: boolean, title: string, description: string) =>
    once(id)
      ? {
          key: `restore\0${id}`,
          environmentId,
          kind: "restore" as const,
          operationId: stopFollowing(environmentId, "restore") ?? null,
          failed,
          title,
          description,
        }
      : null;
  if (restore.state === "restored") {
    return ending(
      restore.restoreId,
      false,
      restore.putBack ? RESTORE_LABELS.putBack : RESTORE_LABELS.restored,
      restoredLabel(restore),
    );
  }
  if (restore.state === "failed") {
    return ending(restore.failedAt, true, RESTORE_LABELS.failed, restore.reason);
  }
  if (restore.state === "ready" && restore.refused) {
    // Another backup was asked for and refused; the one that was ready still waits.
    return ending(
      restore.refused.failedAt,
      true,
      RESTORE_LABELS.failed,
      restoreRefusedLabel(restore) ?? restore.refused.reason,
    );
  }
  return null;
}

const NOTHING: ScientSourcesLibraryCopies = {
  backup: { state: "none" },
  restore: { state: "none" },
  join: { state: "none" },
};

/**
 * The Library's backup, restore and addition from another Library on this environment. Each runs
 * on in the server, so a panel that opens meanwhile shows it too; a ready restore waits for the
 * next start of Scient. How each ended goes to `onEnded`, or waits in `endings` until dismissed.
 */
export function useLibraryBackup(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  /** False where the Library is not kept (a project that keeps its own sources). */
  readonly enabled: boolean;
  /** Called when adding from another Library has put new sources in this one. */
  readonly onAdded?: () => void;
  /** Return true when the ending was shown as the current result; it is then not kept. */
  readonly onEnded?: (ending: LibraryCopyEnding) => boolean;
}) {
  const context = `${input.environmentId}\0${input.root}`;
  const [reading, setReading] = useState<{
    readonly context: string;
    readonly copies: ScientSourcesLibraryCopies;
  } | null>(null);
  const [endings, setEndings] = useState<ReadonlyArray<LibraryCopyEnding>>([]);
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

  const report = useStableCallback((ending: LibraryCopyEnding | null) => {
    if (!ending || input.onEnded?.(ending)) return;
    setEndings((previous) => [...previous.filter((item) => item.key !== ending.key), ending]);
  });

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
    report(backupEnding(input.environmentId, next.backup));
    report(restoreEnding(input.environmentId, next.restore));
    const join = joinEnding(input.environmentId, next.join);
    report(join);
    // New sources are in the Library, also when it stopped part way: the list is read again.
    if (join && next.join.state !== "running" && next.join.state !== "none") {
      if (next.join.added > 0) input.onAdded?.();
    }
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

  /** A request that was refused never ran: said at once, as how the person's action ended. */
  const failed = (kind: CopyKind, title: string, operationId: string | null) => (cause: unknown) =>
    report({
      key: randomUUID(),
      environmentId: input.environmentId,
      kind,
      operationId,
      failed: true,
      title,
      description: scientSourcesErrorMessage(cause, import.meta.env.DEV),
    });

  /** `operationId` names the result-slot operation the backup's ending belongs to. */
  const start = (inFolder: string, operationId: string | null = null) => {
    const asked = context;
    return organizeScientSources(input.environmentId, {
      root: input.root,
      change: { action: "back-up-library", inFolder },
    }).then(
      () => {
        // The server said it runs; shown at once, so the timer asks even if the next read fails.
        follow(input.environmentId, "backup", operationId);
        show(asked, { backup: { state: "running", done: 0, total: 0 } });
        return load(asked);
      },
      failed("backup", BACKUP_LABELS.failed, operationId),
    );
  };

  const changeRestore = (
    change:
      | { action: "prepare"; fromFolder: string }
      | { action: "put-back"; folder: string }
      | { action: "cancel"; restoreId?: string },
    operationId: string | null,
  ) => {
    const asked = context;
    if (change.action !== "cancel") follow(input.environmentId, "restore", operationId);
    return changeLibraryRestore(input.environmentId, { root: input.root, change }).then(
      (restore) => {
        show(asked, { restore });
        report(restoreEnding(input.environmentId, restore));
      },
      failed("restore", RESTORE_LABELS.failed, operationId),
    );
  };

  const addFrom = (fromFolder: string, operationId: string | null = null) => {
    const asked = context;
    return organizeScientSources(input.environmentId, {
      root: input.root,
      change: { action: "add-from-library", fromFolder },
    }).then(
      () => {
        follow(input.environmentId, "join", operationId);
        show(asked, { join: { state: "running", done: 0, total: 0 } });
        return load(asked);
      },
      failed("join", JOIN_LABELS.failed, operationId),
    );
  };

  // Cancel names the restore this window shows: one another window chose since is not dropped.
  const waiting =
    copies?.restore.state === "ready" && !copies.restore.begun ? copies.restore : null;
  return {
    joinLine: copies ? joinRunningLabel(copies.join) : null,
    /** Adds what a backup, or a Library a restore replaced, holds and this Library lacks. */
    addFrom,
    line: copies ? backupRunningLabel(copies.backup) : null,
    start,
    restoreLine: copies ? restoreLine(copies.restore) : null,
    /** True while a copy waits for the next start of Scient, or one is part way through. */
    restoreWaits: copies?.restore.state === "ready",
    /** Offered while a checked copy waits for the next start. */
    cancelRestore:
      waiting === null
        ? undefined
        : () =>
            changeRestore(
              {
                action: "cancel",
                ...(waiting.restoreId ? { restoreId: waiting.restoreId } : {}),
              },
              null,
            ),
    restoreFrom: (fromFolder: string, operationId: string | null = null) =>
      changeRestore({ action: "prepare", fromFolder }, operationId),
    /** Puts a Library a restore kept back in the Library's place at the next start. */
    putBack: (folder: string, operationId: string | null = null) =>
      changeRestore({ action: "put-back", folder }, operationId),
    /** Endings no result slot took, on this environment, until the person dismisses them. */
    endings: endings.filter((ending) => ending.environmentId === input.environmentId),
    acknowledgeEnding: (key: string) =>
      setEndings((previous) => previous.filter((ending) => ending.key !== key)),
  };
}

/** A backup's, an addition's or a restore's running line; a waiting restore offers Cancel. */
function LibraryBackupNotice(props: {
  readonly line?: string | null;
  readonly joinLine?: string | null;
  readonly restoreLine?: string | null;
  readonly onCancelRestore?: (() => void) | undefined;
}) {
  return (
    <>
      {props.line ? (
        <div role="status" className="text-xs break-words text-muted-foreground tabular-nums">
          {props.line}
        </div>
      ) : null}
      {props.joinLine ? (
        <div role="status" className="text-xs break-words text-muted-foreground tabular-nums">
          {props.joinLine}
        </div>
      ) : null}
      {props.restoreLine ? (
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
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

/** An ending in the result slot: the title, and the details in Activity. */
export function libraryCopyEndingResult(ending: LibraryCopyEnding): SourcesResultContent {
  return {
    tone: ending.failed ? "error" : "success",
    summary: `${ending.title}. ${ending.description}`,
    details: <p>{ending.description}</p>,
  };
}

/** What `libraryBackupActivity` reads; `useLibraryBackup`'s answer has it. */
export interface LibraryBackupActivityInput {
  readonly line: string | null;
  readonly joinLine: string | null;
  readonly restoreLine: string | null;
  readonly restoreWaits: boolean;
  readonly cancelRestore: (() => void) | undefined;
  readonly endings: ReadonlyArray<LibraryCopyEnding>;
  readonly acknowledgeEnding: (key: string) => void;
}

/** The backup's, addition's and restore's running work, waiting restore and unseen endings. */
export function libraryBackupActivity(
  backup: LibraryBackupActivityInput,
): ReadonlyArray<SourcesActivityItem> {
  const items: SourcesActivityItem[] = [];
  if (backup.line) {
    items.push({
      key: "library-backup",
      tone: "running",
      label: "Backing up the Library",
      body: <LibraryBackupNotice line={backup.line} />,
    });
  }
  if (backup.joinLine) {
    items.push({
      key: "library-join",
      tone: "running",
      label: "Adding from another Library",
      body: <LibraryBackupNotice joinLine={backup.joinLine} />,
    });
  }
  if (backup.restoreLine) {
    items.push({
      key: "library-restore",
      // A ready copy needs the person to restart Scient, or to cancel it.
      tone: backup.restoreWaits ? "decision" : "running",
      label: backup.restoreWaits ? "A restore waits for the next start" : "Checking a backup",
      body: (
        <LibraryBackupNotice
          restoreLine={backup.restoreLine}
          onCancelRestore={backup.cancelRestore}
        />
      ),
    });
  }
  for (const ending of backup.endings) {
    items.push({
      key: ending.key,
      tone: ending.failed ? "error" : "advisory",
      label: ending.title,
      body: (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="font-medium">{ending.title}</p>
            <p className="text-muted-foreground">{ending.description}</p>
          </div>
          <Button size="xs" variant="ghost" onClick={() => backup.acknowledgeEnding(ending.key)}>
            Dismiss
          </Button>
        </div>
      ),
    });
  }
  return items;
}
