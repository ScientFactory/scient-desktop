import type { EnvironmentId, ScientSourcesBackupStatus } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { toastManager } from "../../components/ui/toast";
import { useStableCallback } from "~/hooks/useStableCallback";
import { organizeScientSources, readLibraryBackupStatus } from "./client";
import { scientSourcesErrorMessage } from "./errorMessage";
import { BACKUP_LABELS, backupDoneLabel, backupRunningLabel } from "./libraryBackupLabels";

const ASK_AGAIN_MS = 1_000;

/**
 * The Library's backup on this environment: starts one into a chosen folder and follows it
 * until it ends, then says where it is or why it failed. The backup runs on in the server, so a
 * panel that opens while one runs follows it too.
 */
export function useLibraryBackup(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  /** False where the Library is not kept (a project that keeps its own sources). */
  readonly enabled: boolean;
}) {
  const context = `${input.environmentId}\0${input.root}`;
  const [reading, setReading] = useState<{
    readonly context: string;
    readonly status: ScientSourcesBackupStatus;
  } | null>(null);
  const status = input.enabled && reading?.context === context ? reading.status : null;
  /** The backup this panel saw running, so its end is announced once, here. */
  const followed = useRef<string | null>(null);
  const latest = useRef(0);

  const load = useStableCallback(async (asking: string) => {
    latest.current += 1;
    const asked = latest.current;
    const next = await readLibraryBackupStatus(input.environmentId, input.root).catch(() => null);
    if (asked !== latest.current || asking !== context) return;
    if (!next) {
      // The read failed: the last answer stands, and a running backup is asked about again.
      setReading((previous) => (previous ? { ...previous } : previous));
      return;
    }
    setReading({ context, status: next });
    if (next.state === "running") {
      followed.current = context;
      return;
    }
    if (followed.current !== context) return;
    followed.current = null;
    if (next.state === "done") {
      toastManager.add({
        type: "success",
        title: BACKUP_LABELS.done,
        description: backupDoneLabel(next),
      });
    } else if (next.state === "failed") {
      toastManager.add({ type: "error", title: BACKUP_LABELS.failed, description: next.reason });
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the backup's status from the environment server when the panel opens on a Library
  useEffect(() => {
    if (input.enabled) void load(context);
  }, [input.enabled, context, load]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the environment server again on a timer while the backup runs; unmounting stops it
  useEffect(() => {
    if (status?.state !== "running") return;
    const timer = window.setTimeout(() => void load(context), ASK_AGAIN_MS);
    return () => window.clearTimeout(timer);
  }, [status, context, load]);

  const start = (inFolder: string) =>
    organizeScientSources(input.environmentId, {
      root: input.root,
      change: { action: "back-up-library", inFolder },
    }).then(
      () => {
        followed.current = context;
        return load(context);
      },
      (cause: unknown) => {
        toastManager.add({
          type: "error",
          title: BACKUP_LABELS.failed,
          description: scientSourcesErrorMessage(cause, import.meta.env.DEV),
        });
      },
    );

  return { line: status ? backupRunningLabel(status) : null, start };
}

/** One line beside the store notices while a backup runs. */
export function LibraryBackupNotice(props: { readonly line: string | null }) {
  return props.line ? (
    <div role="status" className="mx-3 mt-2 text-xs break-words text-muted-foreground tabular-nums">
      {props.line}
    </div>
  ) : null;
}
