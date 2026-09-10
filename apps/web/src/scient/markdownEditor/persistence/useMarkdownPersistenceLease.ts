import { useCallback, useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import type { ProjectReadFileResult } from "@t3tools/contracts";
import { projectFileOperationKey } from "@t3tools/client-runtime/state/projects";
import {
  markdownPersistenceRegistry,
  type MarkdownPersistenceLease,
  type MarkdownPersistenceTarget,
} from "./markdownPersistenceRegistry";

const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

export function useMarkdownPersistenceLease(input: {
  readonly target: MarkdownPersistenceTarget | null;
  readonly authoritativeSnapshot: ProjectReadFileResult | null;
  readonly workspaceMutationId?: string | null;
}) {
  const key = input.target === null ? null : projectFileOperationKey(input.target);
  const available =
    input.target !== null &&
    (markdownPersistenceRegistry.has(input.target) ||
      (input.authoritativeSnapshot !== null &&
        !input.authoritativeSnapshot.truncated &&
        !input.authoritativeSnapshot.readOnly));
  const [binding, setBinding] = useState<{
    readonly key: string | null;
    readonly attempt: number;
    readonly lease: MarkdownPersistenceLease | null;
    readonly error: unknown | null;
  } | null>(null);
  const [admissionAttempt, setAdmissionAttempt] = useState(0);
  const retryAdmission = useCallback(() => setAdmissionAttempt((attempt) => attempt + 1), []);
  const open = useEffectEvent(() =>
    input.target === null ? null : markdownPersistenceRegistry.open(input.target),
  );
  useEffect(() => {
    // Admission happens only after commit. Abandoned renders never own timers,
    // watchers, cache projections, or a pending draft.
    let cancelled = false;
    let retained: MarkdownPersistenceLease | null = null;
    // oxlint-disable-next-line react/set-state-in-effect -- Ownership must be acquired after commit, never while rendering an external store.
    setBinding({ key, attempt: admissionAttempt, lease: null, error: null });
    if (available) {
      void open()?.then(
        (lease) => {
          if (cancelled) lease.release();
          else {
            retained = lease;
            setBinding({ key, attempt: admissionAttempt, lease, error: null });
          }
        },
        (error: unknown) => {
          if (!cancelled) setBinding({ key, attempt: admissionAttempt, lease: null, error });
        },
      );
    }
    return () => {
      cancelled = true;
      retained?.release();
    };
  }, [key, available, admissionAttempt]);
  const currentBinding =
    binding?.key === key && binding.attempt === admissionAttempt ? binding : null;
  const lease = currentBinding?.lease ?? null;
  useEffect(() => {
    if (input.workspaceMutationId !== null && input.workspaceMutationId !== undefined) {
      lease?.noteFreshnessHint("workspace-mutation");
    }
  }, [lease, input.workspaceMutationId]);
  const snapshot = useSyncExternalStore(
    lease?.subscribe ?? emptySubscribe,
    lease?.getSnapshot ?? emptySnapshot,
    lease?.getSnapshot ?? emptySnapshot,
  );
  return {
    lease,
    snapshot,
    admissionError: currentBinding?.error ?? null,
    retryAdmission,
  };
}

export function useMarkdownPersistenceRegistrySnapshot() {
  return useSyncExternalStore(
    markdownPersistenceRegistry.subscribe,
    markdownPersistenceRegistry.getSnapshot,
    markdownPersistenceRegistry.getSnapshot,
  );
}
